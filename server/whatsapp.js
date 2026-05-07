import fs from 'fs/promises';
import path from 'path';
import mime from 'mime-types';
import QRCode from 'qrcode';
import whatsappWeb from 'whatsapp-web.js';
import { createPublicId, uploadBuffer, uploadLocalFile } from './cloudinary-storage.js';
import { assertAllowed, safety } from './safety.js';
import { emitSocket } from './socket.js';
import { authDir, avatarDir, uploadDir } from './storage-paths.js';

const { Client, LocalAuth, MessageMedia } = whatsappWeb;

const EMPTY_HISTORY_SYNC = {
  active: false,
  progress: null,
  chats: 0,
  contacts: 0,
  messages: 0,
  lastSyncType: null
};

export class WhatsAppService {
  constructor(database) {
    this.db = database;
    this.client = null;
    this.status = {
      connected: false,
      connecting: false,
      qr: '',
      qrDataUrl: '',
      me: null,
      lastDisconnect: '',
      historySync: { ...EMPTY_HISTORY_SYNC }
    };
    this.reconnectTimer = null;
    this.avatarCache = new Map();
    this.presence = {};
    this.stopping = false;
  }

  getStatus() {
    return {
      connected: this.status.connected,
      connecting: this.status.connecting,
      qr: this.status.qr,
      qrDataUrl: this.status.qrDataUrl,
      me: this.status.me,
      lastDisconnect: this.status.lastDisconnect,
      historySync: this.status.historySync
    };
  }

  async start() {
    if (this.status.connecting || this.status.connected) return;

    this.stopping = false;
    this.status.connecting = true;
    this.status.lastDisconnect = '';

    await fs.mkdir(authDir, { recursive: true });
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(avatarDir, { recursive: true });

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: authDir
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote'
        ]
      }
    });

    this.bindClientEvents(this.client);
    this.client.initialize().catch((error) => {
      console.error('Failed to initialize whatsapp-web.js:', error);
      this.status.connecting = false;
      this.status.lastDisconnect = error.message || 'Connection failed';
      emitSocket('disconnected', this.getStatus());
      this.scheduleReconnect();
    });
  }

  bindClientEvents(client) {
    client.on('qr', async (qr) => {
      this.status.qr = qr;
      this.status.qrDataUrl = await QRCode.toDataURL(qr, {
        margin: 1,
        width: 280,
        color: {
          dark: '#111b21',
          light: '#ffffff'
        }
      });
      this.status.connecting = true;
      emitSocket('qr', { qr, qrDataUrl: this.status.qrDataUrl });
    });

    client.on('authenticated', () => {
      this.status.lastDisconnect = '';
    });

    client.on('auth_failure', (message) => {
      this.status.connected = false;
      this.status.connecting = false;
      this.status.lastDisconnect = `Authentication failed: ${message || ''}`.trim();
      emitSocket('disconnected', this.getStatus());
    });

    client.on('ready', async () => {
      this.status.connected = true;
      this.status.connecting = false;
      this.status.qr = '';
      this.status.qrDataUrl = '';
      this.status.me = this.normalizeMe(client.info);
      this.status.lastDisconnect = '';
      emitSocket('connected', this.getStatus());
      await this.refreshChats();
      emitSocket('statuses', await this.db.getStatuses());
    });

    client.on('disconnected', (reason) => {
      this.status.connected = false;
      this.status.connecting = false;
      this.status.qr = '';
      this.status.qrDataUrl = '';
      this.status.lastDisconnect = reason || 'Disconnected';
      this.client = null;
      emitSocket('disconnected', this.getStatus());
      if (!this.stopping) this.scheduleReconnect();
    });

    client.on('message', (message) => this.handleMessage(message));
    client.on('message_create', (message) => {
      if (message.fromMe) this.handleMessage(message);
    });
    client.on('message_revoke_everyone', (message, revokedMessage) => {
      this.handleDeletedMessage({
        jid: message?.from || revokedMessage?.from,
        messageId: revokedMessage?.id?._serialized || message?.id?._serialized,
        deletedAt: Date.now()
      }).catch((error) => console.error('Failed to process message revoke:', error));
    });
    client.on('message_reaction', (reaction) => this.handleReaction(reaction));
    client.on('message_ack', (message, ack) => this.handleAck(message, ack));
  }

  normalizeMe(info = {}) {
    return {
      id: info.wid?._serialized || info.wid?.user || '',
      name: info.pushname || info.me?.pushname || info.platform || 'WhatsApp'
    };
  }

  scheduleReconnect() {
    if (!safety.autoStartWhatsApp) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.start().catch((error) => {
        console.error('Reconnect failed:', error);
        this.scheduleReconnect();
      });
    }, 5000);
  }

  async refreshChats() {
    if (!this.client) return;
    try {
      const chats = await this.client.getChats();
      for (const chat of chats) {
        if (!chat?.id?._serialized || chat.id._serialized === 'status@broadcast') continue;
        await this.db.upsertChat({
          jid: chat.id._serialized,
          name: chat.name || chat.formattedTitle || chat.id.user || chat.id._serialized,
          isGroup: Boolean(chat.isGroup),
          avatarUrl: await this.getAvatarUrl(chat.id._serialized),
          lastMessage: chat.lastMessage ? extractWwebText(chat.lastMessage) || mediaLabel(normalizeWwebType(chat.lastMessage.type)) : undefined,
          lastTimestamp: Number(chat.timestamp || Date.now() / 1000) * 1000,
          unreadCount: Number(chat.unreadCount || 0)
        });
      }
      emitSocket('chats', await this.db.getChats());
    } catch (error) {
      console.warn('Could not refresh chats:', error.message);
    }
  }

  async handleMessage(message) {
    if (!message) return;

    try {
      if (message.from === 'status@broadcast') {
        await this.handleStatusMessage(message);
        return;
      }

      const parsed = await this.parseMessage(message);
      const result = await this.db.saveMessage(parsed);
      if (result.inserted) {
        emitSocket(message.fromMe ? 'message-sent' : 'new-message', result.message);
        if (message.fromMe) emitSocket('new-message', result.message);
        emitSocket('chats', await this.db.getChats());
      }
    } catch (error) {
      console.error('Failed to process message:', error);
    }
  }

  async handleStatusMessage(message) {
    const senderJid = message.author || message.from || '';
    if (!senderJid || senderJid === 'status@broadcast') return;

    const status = {
      id: message.id?._serialized || message.id?.id || `${Date.now()}`,
      senderJid,
      senderName: message._data?.notifyName || '',
      avatarUrl: await this.getAvatarUrl(senderJid),
      type: normalizeWwebType(message.type),
      text: extractWwebText(message),
      mediaUrl: '',
      fileName: '',
      mimeType: '',
      timestamp: Number(message.timestamp || Date.now() / 1000) * 1000
    };

    if (safety.downloadIncomingMedia && message.hasMedia) {
      const media = await this.saveIncomingMedia(message, status.type, { folder: 'status-media' });
      status.mediaUrl = media.mediaUrl;
      status.fileName = media.fileName;
      status.mimeType = media.mimeType;
    }

    const result = await this.db.saveStatus(status);
    if (result.inserted) {
      emitSocket('status-update', result.status);
      emitSocket('statuses', await this.db.getStatuses());
    }
  }

  async parseMessage(message) {
    const chat = await safeCall(() => message.getChat(), null);
    const contact = await safeCall(() => message.getContact(), null);
    const jid = message.fromMe ? message.to : message.from;
    const isGroup = Boolean(chat?.isGroup || jid?.endsWith('@g.us'));
    const senderJid = isGroup
      ? message.author || contact?.id?._serialized || jid
      : message.fromMe
        ? this.status.me?.id || ''
        : jid;
    const timestamp = Number(message.timestamp || Date.now() / 1000) * 1000;
    const normalizedType = normalizeWwebType(message.type);

    const parsed = {
      id: message.id?._serialized || message.id?.id || `${Date.now()}`,
      jid,
      senderJid,
      receiverJid: message.fromMe ? jid : this.status.me?.id || '',
      fromMe: Boolean(message.fromMe),
      senderName: message._data?.notifyName || contact?.pushname || contact?.name || '',
      type: normalizedType,
      text: extractWwebText(message),
      mediaUrl: '',
      fileName: '',
      mimeType: '',
      quoted: await this.extractQuotedMessage(message),
      timestamp
    };

    await this.db.upsertChat({
      jid,
      name: chat?.name || contact?.pushname || contact?.name || fallbackName(jid),
      isGroup,
      avatarUrl: await this.getAvatarUrl(jid),
      lastTimestamp: timestamp
    });

    if (safety.downloadIncomingMedia && message.hasMedia) {
      const media = await this.saveIncomingMedia(message, normalizedType);
      parsed.mediaUrl = media.mediaUrl;
      parsed.fileName = media.fileName;
      parsed.mimeType = media.mimeType;
    }

    return parsed;
  }

  async extractQuotedMessage(message) {
    if (!message.hasQuotedMsg) return null;
    const quoted = await safeCall(() => message.getQuotedMessage(), null);
    if (!quoted) return null;

    return {
      id: quoted.id?._serialized || quoted.id?.id || '',
      jid: quoted.from || '',
      participant: quoted.author || '',
      senderName: quoted._data?.notifyName || '',
      fromMe: Boolean(quoted.fromMe),
      type: normalizeWwebType(quoted.type),
      text: extractWwebText(quoted) || mediaLabel(normalizeWwebType(quoted.type)),
      mediaUrl: '',
      fileName: quoted._data?.filename || ''
    };
  }

  async saveIncomingMedia(message, normalizedType, options = {}) {
    try {
      const media = await message.downloadMedia();
      if (!media?.data) throw new Error('No media data returned.');

      const buffer = Buffer.from(media.data, 'base64');
      const mimeType = media.mimetype || 'application/octet-stream';
      const extension = mime.extension(mimeType) || 'bin';
      const fileName = media.filename || message._data?.filename || `${Date.now()}-${message.id?.id || 'media'}.${extension}`;
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = `${normalizedType}-${Date.now()}-${safeName}`;
      await fs.writeFile(path.join(uploadDir, finalName), buffer);
      const localUrl = `/uploads/${finalName}`;
      let cloudinaryUrl = '';

      try {
        const uploaded = await uploadBuffer(buffer, {
          folder: options.folder || 'chat-media',
          publicId: createPublicId(normalizedType, message.from, message.id?.id, finalName),
          resourceType: normalizedType === 'video' ? 'video' : normalizedType === 'image' ? 'image' : 'auto',
          context: `message_id=${message.id?._serialized || ''}|jid=${message.from || ''}|type=${normalizedType}`
        });
        cloudinaryUrl = uploaded?.url || '';
      } catch (error) {
        console.warn('Cloudinary media upload failed:', error.message);
      }

      return {
        mediaUrl: cloudinaryUrl || localUrl,
        fileName,
        mimeType
      };
    } catch (error) {
      console.warn('Could not download incoming media:', error.message);
      return {
        mediaUrl: '',
        fileName: message._data?.filename || '',
        mimeType: message._data?.mimetype || ''
      };
    }
  }

  async getAvatarUrl(jid, options = {}) {
    if (!jid || jid === 'status@broadcast') return '';
    if (!options.force && this.avatarCache.has(jid)) return this.avatarCache.get(jid);

    try {
      const remoteUrl = await this.client.getProfilePicUrl(jid);
      if (!remoteUrl) {
        this.avatarCache.set(jid, '');
        return '';
      }

      const response = await fetch(remoteUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const extension = mime.extension(contentType) || 'jpg';
      const safeName = jid.replace(/[^a-zA-Z0-9._-]/g, '_');
      const fileName = `${safeName}.${extension}`;
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(path.join(avatarDir, fileName), buffer);

      const localUrl = `/uploads/avatars/${fileName}`;
      this.avatarCache.set(jid, localUrl);
      return localUrl;
    } catch (_error) {
      this.avatarCache.set(jid, '');
      return '';
    }
  }

  async sendText(jid, text) {
    assertAllowed(safety.allowWriteActions, 'WhatsApp write actions are disabled in safe mode.');
    this.assertConnected();
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('Message text is required.');

    const sent = await this.client.sendMessage(jid, trimmed);
    const saved = await this.db.saveMessage({
      id: sent.id?._serialized || sent.id?.id || `${Date.now()}`,
      jid,
      senderJid: this.status.me?.id || '',
      receiverJid: jid,
      fromMe: true,
      type: 'text',
      text: trimmed,
      timestamp: Date.now()
    });

    emitSocket('message-sent', saved.message);
    emitSocket('new-message', saved.message);
    emitSocket('chats', await this.db.getChats());
    return saved.message;
  }

  async sendMedia(jid, file, caption = '') {
    assertAllowed(safety.allowWriteActions, 'WhatsApp media sending is disabled in safe mode.');
    this.assertConnected();
    if (!file) throw new Error('Media file is required.');

    const mimeType = file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream';
    const media = MessageMedia.fromFilePath(file.path);
    media.mimetype = mimeType;
    media.filename = file.originalname;
    const sent = await this.client.sendMessage(jid, media, {
      caption: caption || '',
      sendMediaAsDocument: !mimeType.startsWith('image/') && !mimeType.startsWith('video/') && !mimeType.startsWith('audio/')
    });
    const normalizedType = normalizeMimeType(mimeType);

    const saved = await this.db.saveMessage({
      id: sent.id?._serialized || sent.id?.id || `${Date.now()}`,
      jid,
      senderJid: this.status.me?.id || '',
      receiverJid: jid,
      fromMe: true,
      type: normalizedType,
      text: caption,
      mediaUrl: await this.getSentMediaUrl(file, normalizedType),
      fileName: file.originalname,
      mimeType,
      timestamp: Date.now()
    });

    emitSocket('message-sent', saved.message);
    emitSocket('new-message', saved.message);
    emitSocket('chats', await this.db.getChats());
    return saved.message;
  }

  async getSentMediaUrl(file, normalizedType) {
    const localUrl = `/uploads/${path.basename(file.path)}`;

    try {
      const uploaded = await uploadLocalFile(file.path, {
        folder: 'chat-media',
        publicId: createPublicId(normalizedType, Date.now(), file.originalname),
        resourceType: normalizedType === 'video' ? 'video' : normalizedType === 'image' ? 'image' : 'auto',
        context: `type=${normalizedType}|original_name=${file.originalname || ''}`
      });
      return uploaded?.url || localUrl;
    } catch (error) {
      console.warn('Cloudinary sent media upload failed:', error.message);
      return localUrl;
    }
  }

  async sendReaction(jid, messageId, text) {
    assertAllowed(safety.allowWriteActions, 'WhatsApp reactions are disabled in safe mode.');
    this.assertConnected();
    const messages = await this.db.getMessages(jid);
    const target = messages.find((message) => message.id === messageId);
    if (!target) throw new Error('Message not found.');

    const chat = await this.client.getChatById(jid);
    const fetched = await chat.fetchMessages({ limit: 50 });
    const message = fetched.find((item) => item.id?._serialized === messageId);
    if (message?.react) await message.react(text || '');

    const updated = await this.db.setMessageReaction(jid, messageId, {
      senderJid: this.status.me?.id || 'me',
      text,
      timestamp: Date.now()
    });
    emitSocket('message-updated', updated);
    return updated;
  }

  async sendPresence(jid, type) {
    assertAllowed(safety.allowPresenceActions, 'WhatsApp presence updates are disabled in safe mode.');
    this.assertConnected();
    const chat = await this.client.getChatById(jid);
    if (type === 'composing' && chat.sendStateTyping) {
      await chat.sendStateTyping();
      return;
    }
    if (chat.clearState) await chat.clearState();
  }

  async handleDeletedMessage(payload) {
    const result = await this.db.markMessageDeleted(payload);
    if (result.updated) {
      emitSocket('message-updated', result.message);
      emitSocket('chats', await this.db.getChats());
    }
  }

  async handleReaction(reaction = {}) {
    try {
      const messageId = reaction.msgId?._serialized || reaction.id?._serialized || '';
      const jid = reaction.msgId?.remote || reaction.id?.remote || '';
      if (!jid || !messageId) return;

      const message = await this.db.setMessageReaction(jid, messageId, {
        senderJid: reaction.senderId || '',
        text: reaction.reaction || '',
        timestamp: Date.now()
      });
      if (message) emitSocket('message-updated', message);
    } catch (error) {
      console.error('Failed to process reaction:', error);
    }
  }

  async handleAck(message, ack) {
    try {
      const jid = message.fromMe ? message.to : message.from;
      const messageId = message.id?._serialized;
      if (!jid || !messageId) return;
      const receipt = Number(ack) >= 3 ? 'read' : Number(ack) >= 2 ? 'delivered' : '';
      if (!receipt) return;
      const updated = await this.db.updateMessageReceipt(jid, messageId, receipt);
      if (updated) emitSocket('message-updated', updated);
    } catch (error) {
      console.error('Failed to process ack:', error);
    }
  }

  async getChatInfo(jid) {
    const chats = await this.db.getChats();
    const chat = chats.find((item) => item.jid === this.db.resolveJid(jid) || item.jid === jid) || null;
    const messages = await this.db.getMessages(jid);
    const info = {
      chat,
      messageCount: messages.length,
      mediaCount: messages.filter((message) => ['image', 'video', 'audio'].includes(message.type)).length,
      documentCount: messages.filter((message) => message.type === 'document').length,
      linkCount: messages.reduce((count, message) => count + (String(message.text || '').match(/https?:\/\/[^\s<>"']+/g) || []).length, 0),
      participants: []
    };

    if (jid.endsWith('@g.us') && this.client) {
      try {
        const groupChat = await this.client.getChatById(jid);
        info.subject = groupChat.name;
        info.desc = groupChat.description || '';
        info.participants = (groupChat.participants || []).map((participant) => ({
          id: participant.id?._serialized || participant.id?.user || '',
          admin: participant.isSuperAdmin ? 'superadmin' : participant.isAdmin ? 'admin' : ''
        }));
      } catch (error) {
        info.groupError = error.message;
      }
    }

    return info;
  }

  async logout() {
    if (this.client) {
      try {
        await this.client.logout();
      } catch (error) {
        console.warn('whatsapp-web.js logout failed, clearing local auth anyway:', error.message);
      }
    }

    await this.clearAuthSession();
    this.client = null;
    this.status = {
      connected: false,
      connecting: false,
      qr: '',
      qrDataUrl: '',
      me: null,
      lastDisconnect: 'Logged out',
      historySync: { ...EMPTY_HISTORY_SYNC }
    };
    emitSocket('disconnected', this.getStatus());
  }

  async stop() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopping = true;

    if (this.client) {
      try {
        await this.client.destroy();
      } catch (error) {
        console.warn('Client stop failed:', error.message);
      }
    }

    this.client = null;
    this.status.connected = false;
    this.status.connecting = false;
    this.status.qr = '';
    this.status.qrDataUrl = '';
    this.status.lastDisconnect = 'WhatsApp connection disabled';
    emitSocket('disconnected', this.getStatus());
  }

  async clearAuthSession() {
    try {
      await fs.rm(authDir, { recursive: true, force: true });
      await fs.mkdir(authDir, { recursive: true });
    } catch (error) {
      console.error('Failed to clear auth session:', error);
    }
  }

  assertConnected() {
    if (!this.client || !this.status.connected) {
      throw new Error('WhatsApp is not connected.');
    }
  }
}

function normalizeWwebType(type = '') {
  if (type === 'chat') return 'text';
  if (type === 'image') return 'image';
  if (type === 'video') return 'video';
  if (type === 'ptt' || type === 'audio') return 'audio';
  if (type === 'document') return 'document';
  return type || 'unsupported';
}

function normalizeMimeType(mimeType = '') {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

function extractWwebText(message = {}) {
  return message.body || message.caption || message._data?.caption || '';
}

function mediaLabel(type) {
  if (type === 'image') return 'Image';
  if (type === 'video') return 'Video';
  if (type === 'audio') return 'Audio';
  if (type === 'document') return 'Document';
  return '';
}

function fallbackName(jid = '') {
  return String(jid).split('@')[0].replace(/[^0-9A-Za-z+_-]/g, '');
}

async function safeCall(fn, fallback) {
  try {
    return await fn();
  } catch (_error) {
    return fallback;
  }
}
