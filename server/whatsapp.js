import fs from 'fs/promises';
import path from 'path';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import mime from 'mime-types';
import pino from 'pino';
import QRCode from 'qrcode';
import { createPublicId, uploadBuffer, uploadLocalFile } from './cloudinary-storage.js';
import { assertAllowed, safety } from './safety.js';
import { emitSocket } from './socket.js';
import { authDir, avatarDir, uploadDir } from './storage-paths.js';

export class WhatsAppService {
  constructor(database) {
    this.db = database;
    this.sock = null;
    this.status = {
      connected: false,
      connecting: false,
      qr: '',
      qrDataUrl: '',
      me: null,
      lastDisconnect: '',
      historySync: {
        active: false,
        progress: null,
        chats: 0,
        contacts: 0,
        messages: 0,
        lastSyncType: null
      }
    };
    this.reconnectTimer = null;
    this.groupNameCache = new Map();
    this.avatarCache = new Map();
    this.presence = {};
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
    if (this.status.connecting) return;

    this.status.connecting = true;
    await fs.mkdir(authDir, { recursive: true });
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(avatarDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['Personal WhatsApp Web System', 'Chrome', '1.0.0'],
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: safety.syncFullHistory,
      shouldSyncHistoryMessage: () => safety.syncFullHistory
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('messaging-history.set', (payload) => this.handleHistorySet(payload));
    this.sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(update));
    this.sock.ev.on('messages.upsert', (payload) => this.handleMessagesUpsert(payload));
    this.sock.ev.on('messages.update', (updates) => this.handleMessagesUpdate(updates));
    this.sock.ev.on('messages.reaction', (updates) => this.handleReactionsUpdate(updates));
    this.sock.ev.on('message-receipt.update', (updates) => this.handleReceiptUpdate(updates));
    this.sock.ev.on('presence.update', (update) => this.handlePresenceUpdate(update));
    this.sock.ev.on('chats.upsert', (chats) => this.handleChatsUpsert(chats));
    this.sock.ev.on('contacts.upsert', (contacts) => this.handleContactsUpsert(contacts));
    this.sock.ev.on('groups.update', (updates) => this.handleGroupsUpdate(updates));
  }

  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.status.qr = qr;
      const qrDataUrl = await QRCode.toDataURL(qr, {
        margin: 1,
        width: 280,
        color: {
          dark: '#111b21',
          light: '#ffffff'
        }
      });
      emitSocket('qr', { qr, qrDataUrl });
      this.status.qrDataUrl = qrDataUrl;
    }

    if (connection === 'open') {
      this.status.connected = true;
      this.status.connecting = false;
      this.status.qr = '';
      this.status.qrDataUrl = '';
      this.status.me = this.sock?.user || null;
      this.status.lastDisconnect = '';
      emitSocket('connected', this.getStatus());
      emitSocket('chats', await this.db.getChats());
      emitSocket('statuses', await this.db.getStatuses());
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      this.status.connected = false;
      this.status.connecting = false;
      this.status.qr = '';
      this.status.qrDataUrl = '';
      this.status.lastDisconnect = loggedOut ? 'Logged out' : 'Connection closed';
      emitSocket('disconnected', this.getStatus());

      if (loggedOut) {
        await this.clearAuthSession();
        return;
      }

      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (!safety.autoStartWhatsApp) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.start().catch((error) => {
        console.error('Reconnect failed:', error);
        this.scheduleReconnect();
      });
    }, 3000);
  }

  async clearAuthSession() {
    try {
      await fs.rm(authDir, { recursive: true, force: true });
      await fs.mkdir(authDir, { recursive: true });
    } catch (error) {
      console.error('Failed to clear auth session:', error);
    }
  }

  async handleChatsUpsert(chats = []) {
    for (const chat of chats) {
      const isGroup = chat.id?.endsWith('@g.us');
      await this.db.upsertChat({
        jid: chat.id,
        name: isGroup ? await this.getGroupName(chat.id, chat.subject || chat.name) : chat.name || chat.subject,
        isGroup,
        avatarUrl: await this.getAvatarUrl(chat.id),
        lastTimestamp: Number(chat.conversationTimestamp || Date.now())
      });
    }
    emitSocket('chats', await this.db.getChats());
  }

  async handleContactsUpsert(contacts = []) {
    for (const contact of contacts) {
      const isGroup = contact.id?.endsWith('@g.us');
      await this.db.upsertChat({
        jid: contact.id,
        name: isGroup
          ? await this.getGroupName(contact.id, contact.notify || contact.name || contact.verifiedName)
          : contact.notify || contact.name || contact.verifiedName,
        isGroup,
        avatarUrl: await this.getAvatarUrl(contact.id)
      });
    }
    emitSocket('chats', await this.db.getChats());
  }

  async handleHistorySet({ chats = [], contacts = [], messages = [], isLatest, progress, syncType }) {
    this.status.historySync = {
      active: !isLatest,
      progress: progress ?? this.status.historySync.progress,
      chats: this.status.historySync.chats + chats.length,
      contacts: this.status.historySync.contacts + contacts.length,
      messages: this.status.historySync.messages + messages.length,
      lastSyncType: syncType ?? this.status.historySync.lastSyncType
    };
    emitSocket('history-sync', this.status.historySync);

    for (const contact of contacts) {
      const isGroup = contact.id?.endsWith('@g.us');
      await this.db.upsertChat({
        jid: contact.id,
        name: isGroup
          ? await this.getGroupName(contact.id, contact.notify || contact.name || contact.verifiedName)
          : contact.notify || contact.name || contact.verifiedName,
        isGroup,
        avatarUrl: await this.getAvatarUrl(contact.id)
      });
    }

    for (const chat of chats) {
      const jid = chat.id;
      if (!jid || jid === 'status@broadcast') continue;

      const isGroup = jid.endsWith('@g.us');
      await this.db.upsertChat({
        jid,
        name: isGroup ? await this.getGroupName(jid, chat.subject || chat.name) : chat.name || chat.subject,
        isGroup,
        avatarUrl: await this.getAvatarUrl(jid),
        lastMessage: chat.messages?.[0]?.message ? '' : undefined,
        lastTimestamp: Number(chat.conversationTimestamp || chat.t || Date.now())
      });
    }

    let inserted = 0;
    for (const rawMessage of [...messages].reverse()) {
      if (!rawMessage?.message) continue;

      try {
        if (rawMessage.key?.remoteJid === 'status@broadcast') {
          await this.handleStatusMessage(rawMessage);
          continue;
        }

        const parsed = await this.parseMessage(rawMessage, { downloadMedia: false });
        if (parsed.event === 'ignore') continue;
        if (parsed.event === 'message-deleted') {
          await this.handleDeletedMessage(parsed);
          continue;
        }

        const result = await this.db.saveMessage(parsed);
        if (result.inserted) inserted += 1;
      } catch (error) {
        console.error('Failed to import history message:', error);
      }
    }

    const latestChats = await this.db.getChats();
    emitSocket('chats', latestChats);
    emitSocket('history-sync', {
      ...this.status.historySync,
      inserted,
      active: !isLatest
    });

    if (isLatest) {
      this.status.historySync.active = false;
    }
  }

  async handleGroupsUpdate(updates = []) {
    for (const update of updates) {
      const jid = update.id;
      if (!jid?.endsWith('@g.us')) continue;

      if (update.subject) {
        this.groupNameCache.set(jid, update.subject);
      }

      await this.db.upsertChat({
        jid,
        name: await this.getGroupName(jid, update.subject),
        isGroup: true,
        avatarUrl: await this.getAvatarUrl(jid, { force: true })
      });
    }

    emitSocket('chats', await this.db.getChats());
  }

  async getGroupName(jid, fallback = '') {
    if (!jid?.endsWith('@g.us')) return fallback || '';

    const cached = this.groupNameCache.get(jid);
    if (cached) return cached;

    if (fallback && !fallback.includes('@g.us')) {
      this.groupNameCache.set(jid, fallback);
      return fallback;
    }

    try {
      const metadata = await this.sock.groupMetadata(jid);
      const subject = metadata?.subject || fallback || jid;
      this.groupNameCache.set(jid, subject);
      return subject;
    } catch (error) {
      console.warn(`Could not fetch group metadata for ${jid}:`, error.message);
      return fallback || jid;
    }
  }

  async getAvatarUrl(jid, options = {}) {
    if (!jid || jid === 'status@broadcast') return '';
    if (!options.force && this.avatarCache.has(jid)) return this.avatarCache.get(jid);

    try {
      const remoteUrl = await this.sock.profilePictureUrl(jid, 'image');
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
    } catch (error) {
      this.avatarCache.set(jid, '');
      return '';
    }
  }

  async handleMessagesUpsert({ messages = [], type }) {
    if (type !== 'notify' && type !== 'append') return;

    for (const rawMessage of messages) {
      if (!rawMessage.message) continue;

      try {
        if (rawMessage.key.remoteJid === 'status@broadcast') {
          await this.handleStatusMessage(rawMessage);
          continue;
        }

        const parsed = await this.parseMessage(rawMessage);
        if (parsed.event === 'ignore') {
          continue;
        }

        if (parsed.event === 'message-deleted') {
          await this.handleDeletedMessage(parsed);
          continue;
        }

        const result = await this.db.saveMessage(parsed);

        if (result.inserted) {
          emitSocket('new-message', result.message);
          emitSocket('chats', await this.db.getChats());
        }
      } catch (error) {
        console.error('Failed to process message:', error);
      }
    }
  }

  async handleStatusMessage(rawMessage) {
    const content = unwrapMessage(rawMessage.message);
    const type = getContentType(content) || 'unsupported';
    if (type === 'protocolMessage') return;

    const senderJid = rawMessage.key.participant || rawMessage.participant || rawMessage.key.remoteJid;
    if (!senderJid || senderJid === 'status@broadcast') return;

    const timestamp = Number(rawMessage.messageTimestamp || Date.now() / 1000) * 1000;
    const normalizedType = normalizeType(type);
    const status = {
      id: rawMessage.key.id,
      senderJid,
      senderName: rawMessage.pushName || '',
      avatarUrl: await this.getAvatarUrl(senderJid),
      type: normalizedType,
      text: extractText(content, type),
      mediaUrl: '',
      fileName: '',
      mimeType: '',
      timestamp
    };

    if (safety.downloadIncomingMedia && ['imageMessage', 'videoMessage', 'audioMessage'].includes(type)) {
      const media = await this.saveIncomingMedia(rawMessage, content[type], normalizedType, {
        folder: 'status-media'
      });
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

  async handleMessagesUpdate(updates = []) {
    for (const item of updates) {
      try {
        const protocolMessage = item.update?.message?.protocolMessage
          || item.message?.protocolMessage
          || item.update?.protocolMessage;

        if (!isRevokeMessage(protocolMessage)) continue;

        const targetKey = protocolMessage.key || item.key || {};
        await this.handleDeletedMessage({
          event: 'message-deleted',
          jid: targetKey.remoteJid || item.key?.remoteJid,
          messageId: targetKey.id,
          deletedAt: Date.now()
        });
      } catch (error) {
        console.error('Failed to process message update:', error);
      }
    }
  }

  async handleDeletedMessage(payload) {
    const result = await this.db.markMessageDeleted(payload);
    if (result.updated) {
      emitSocket('message-updated', result.message);
      emitSocket('chats', await this.db.getChats());
    }
  }

  async handleReactionsUpdate(updates = []) {
    for (const item of updates) {
      try {
        const key = item.key || {};
        const reaction = item.reaction || {};
        const jid = key.remoteJid;
        const messageId = key.id;
        if (!jid || !messageId) continue;

        const message = await this.db.setMessageReaction(jid, messageId, {
          senderJid: reaction.key?.participant || reaction.key?.remoteJid || '',
          text: reaction.text || '',
          timestamp: Date.now()
        });

        if (message) emitSocket('message-updated', message);
      } catch (error) {
        console.error('Failed to process reaction:', error);
      }
    }
  }

  async handleReceiptUpdate(updates = []) {
    for (const item of updates) {
      try {
        const jid = item.key?.remoteJid;
        const messageId = item.key?.id;
        if (!jid || !messageId) continue;

        const receipt = item.receipt?.readTimestamp || item.userReceipt?.some?.((receiptItem) => receiptItem.readTimestamp)
          ? 'read'
          : 'delivered';
        const message = await this.db.updateMessageReceipt(jid, messageId, receipt);
        if (message) emitSocket('message-updated', message);
      } catch (error) {
        console.error('Failed to process receipt:', error);
      }
    }
  }

  handlePresenceUpdate(update) {
    this.presence[update.id] = update.presences || {};
    emitSocket('presence-update', update);
  }

  async parseMessage(rawMessage, options = {}) {
    const jid = rawMessage.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const fromMe = Boolean(rawMessage.key.fromMe) || this.isOwnMessage(rawMessage);
    const content = unwrapMessage(rawMessage.message);
    const type = getContentType(content) || 'unsupported';
    const timestamp = Number(rawMessage.messageTimestamp || Date.now() / 1000) * 1000;
    const protocolMessage = content.protocolMessage;
    if (type === 'protocolMessage' && isRevokeMessage(protocolMessage)) {
      const targetKey = protocolMessage.key || {};
      return {
        event: 'message-deleted',
        jid: targetKey.remoteJid || jid,
        messageId: targetKey.id,
        deletedAt: timestamp
      };
    }

    if (type === 'protocolMessage') {
      return { event: 'ignore' };
    }

    const senderJid = isGroup
      ? rawMessage.key.participant || jid
      : fromMe
        ? this.sock?.user?.id || ''
        : jid;

    const parsed = {
      id: rawMessage.key.id,
      jid,
      senderJid,
      receiverJid: fromMe ? jid : this.sock?.user?.id || '',
      fromMe,
      senderName: rawMessage.pushName || '',
      type: normalizeType(type),
      text: extractText(content, type),
      mediaUrl: '',
      fileName: '',
      mimeType: '',
      quoted: extractQuotedMessage(content, type, {
        currentJid: jid,
        currentSenderName: rawMessage.pushName || ''
      }),
      timestamp
    };

    if (isGroup) {
      const groupName = await this.getGroupName(jid);
      const groupAvatarUrl = await this.getAvatarUrl(jid);
      parsed.chatName = groupName;
      parsed.chatAvatarUrl = groupAvatarUrl;
      await this.db.upsertChat({
        jid,
        name: groupName,
        isGroup: true,
        avatarUrl: groupAvatarUrl,
        lastTimestamp: timestamp
      });
    } else if (!fromMe) {
      const avatarUrl = await this.getAvatarUrl(jid);
      parsed.chatAvatarUrl = avatarUrl;
      if (avatarUrl) {
        await this.db.upsertChat({
          jid,
          name: rawMessage.pushName || '',
          isGroup: false,
          avatarUrl,
          lastTimestamp: timestamp
        });
      }
    }

    if (options.downloadMedia !== false && safety.downloadIncomingMedia && ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage'].includes(type)) {
      const media = await this.saveIncomingMedia(rawMessage, content[type], parsed.type);
      parsed.mediaUrl = media.mediaUrl;
      parsed.fileName = media.fileName;
      parsed.mimeType = media.mimeType;
    }

    return parsed;
  }

  async saveIncomingMedia(rawMessage, mediaMessage, normalizedType, options = {}) {
    try {
      const buffer = await downloadMediaMessage(rawMessage, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: this.sock.updateMediaMessage
      });
      const mimeType = mediaMessage?.mimetype || 'application/octet-stream';
      const extension = mime.extension(mimeType) || 'bin';
      const fileName = mediaMessage?.fileName || `${Date.now()}-${rawMessage.key.id}.${extension}`;
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = `${normalizedType}-${Date.now()}-${safeName}`;
      await fs.writeFile(path.join(uploadDir, finalName), buffer);
      const localUrl = `/uploads/${finalName}`;
      let cloudinaryUrl = '';

      try {
        const uploaded = await uploadBuffer(buffer, {
          folder: options.folder || 'chat-media',
          publicId: createPublicId(normalizedType, rawMessage.key.remoteJid, rawMessage.key.id, finalName),
          resourceType: normalizedType === 'video' ? 'video' : normalizedType === 'image' ? 'image' : 'auto',
          context: `message_id=${rawMessage.key.id}|jid=${rawMessage.key.remoteJid || ''}|type=${normalizedType}`
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
        fileName: mediaMessage?.fileName || '',
        mimeType: mediaMessage?.mimetype || ''
      };
    }
  }

  async sendText(jid, text) {
    assertAllowed(safety.allowWriteActions, 'WhatsApp write actions are disabled in safe mode.');
    this.assertConnected();
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('Message text is required.');

    const sent = await this.sock.sendMessage(jid, { text: trimmed });
    const saved = await this.db.saveMessage({
      id: sent.key.id,
      jid,
      senderJid: this.sock.user?.id || '',
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

  isOwnMessage(rawMessage) {
    const participant = rawMessage.key?.participant || rawMessage.participant || '';
    const sender = participant || rawMessage.key?.remoteJid || '';
    const me = this.sock?.user || {};
    const ownIds = [
      me.id,
      me.lid,
      me.jid
    ].filter(Boolean);

    return ownIds.some((id) => sameBareJid(id, sender));
  }

  async sendMedia(jid, file, caption = '') {
    assertAllowed(safety.allowWriteActions, 'WhatsApp media sending is disabled in safe mode.');
    this.assertConnected();
    if (!file) throw new Error('Media file is required.');

    const mimeType = file.mimetype || mime.lookup(file.originalname) || 'application/octet-stream';
    const messageContent = buildMediaMessage(file, mimeType, caption);
    const sent = await this.sock.sendMessage(jid, messageContent);
    const normalizedType = mimeType.startsWith('image/')
      ? 'image'
      : mimeType.startsWith('video/')
        ? 'video'
        : mimeType.startsWith('audio/')
          ? 'audio'
          : 'document';

    const saved = await this.db.saveMessage({
      id: sent.key.id,
      jid,
      senderJid: this.sock.user?.id || '',
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

    await this.sock.sendMessage(jid, {
      react: {
        text,
        key: {
          remoteJid: jid,
          id: messageId,
          fromMe: target.fromMe,
          participant: target.senderJid || undefined
        }
      }
    });

    const updated = await this.db.setMessageReaction(jid, messageId, {
      senderJid: this.sock.user?.id || 'me',
      text,
      timestamp: Date.now()
    });
    emitSocket('message-updated', updated);
    return updated;
  }

  async sendPresence(jid, type) {
    assertAllowed(safety.allowPresenceActions, 'WhatsApp presence updates are disabled in safe mode.');
    this.assertConnected();
    await this.sock.sendPresenceUpdate(type, jid);
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

    if (jid.endsWith('@g.us') && this.sock) {
      try {
        const metadata = await this.sock.groupMetadata(jid);
        info.subject = metadata.subject;
        info.owner = metadata.owner;
        info.desc = metadata.desc || '';
        info.participants = (metadata.participants || []).map((participant) => ({
          id: participant.id,
          admin: participant.admin || ''
        }));
      } catch (error) {
        info.groupError = error.message;
      }
    }

    return info;
  }

  async logout() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (error) {
        console.warn('Socket logout failed, clearing local auth anyway:', error.message);
      }
    }

    await this.clearAuthSession();
    this.status = {
      connected: false,
      connecting: false,
      qr: '',
      qrDataUrl: '',
      me: null,
      lastDisconnect: 'Logged out',
      historySync: {
        active: false,
        progress: null,
        chats: 0,
        contacts: 0,
        messages: 0,
        lastSyncType: null
      }
    };
    emitSocket('disconnected', this.getStatus());
  }

  async stop() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.sock?.end) {
      try {
        this.sock.end(new Error('WhatsApp connection disabled from admin panel.'));
      } catch (error) {
        console.warn('Socket stop failed:', error.message);
      }
    }

    this.sock = null;
    this.status.connected = false;
    this.status.connecting = false;
    this.status.qr = '';
    this.status.qrDataUrl = '';
    this.status.lastDisconnect = 'WhatsApp connection disabled';
    emitSocket('disconnected', this.getStatus());
  }

  assertConnected() {
    if (!this.sock || !this.status.connected) {
      throw new Error('WhatsApp is not connected.');
    }
  }
}

function unwrapMessage(message) {
  if (message?.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message?.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message?.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  return message || {};
}

function normalizeType(type) {
  if (type === 'conversation' || type === 'extendedTextMessage') return 'text';
  if (type === 'imageMessage') return 'image';
  if (type === 'videoMessage') return 'video';
  if (type === 'documentMessage') return 'document';
  if (type === 'audioMessage') return 'audio';
  if (type === 'protocolMessage') return 'system';
  return 'unsupported';
}

function extractText(content, type) {
  if (type === 'conversation') return content.conversation || '';
  if (type === 'extendedTextMessage') return content.extendedTextMessage?.text || '';
  if (type === 'imageMessage') return content.imageMessage?.caption || '';
  if (type === 'videoMessage') return content.videoMessage?.caption || '';
  if (type === 'documentMessage') return content.documentMessage?.caption || content.documentMessage?.fileName || '';
  if (type === 'audioMessage') return '';
  if (type === 'protocolMessage') return '';
  return 'Unsupported message type';
}

function extractQuotedMessage(content, type, fallback = {}) {
  const body = getMessageBody(content, type);
  const contextInfo = body?.contextInfo;
  if (!contextInfo?.stanzaId && !contextInfo?.quotedMessage) return null;

  const quotedContent = unwrapMessage(contextInfo.quotedMessage || {});
  const quotedType = getContentType(quotedContent) || 'text';
  const participant = contextInfo.participant || contextInfo.remoteJid || '';

  return {
    id: contextInfo.stanzaId || '',
    jid: contextInfo.remoteJid || fallback.currentJid || '',
    participant,
    senderName: contextInfo.pushName || fallback.currentSenderName || '',
    fromMe: Boolean(contextInfo.fromMe),
    type: normalizeType(quotedType),
    text: extractText(quotedContent, quotedType) || quotedMediaLabel(quotedType),
    fileName: getMessageBody(quotedContent, quotedType)?.fileName || ''
  };
}

function getMessageBody(content, type) {
  if (type === 'conversation') {
    return { conversation: content.conversation };
  }

  return content?.[type] || null;
}

function quotedMediaLabel(type) {
  if (type === 'imageMessage') return 'Image';
  if (type === 'videoMessage') return 'Video';
  if (type === 'audioMessage') return 'Audio';
  if (type === 'documentMessage') return 'Document';
  return '';
}

function isRevokeMessage(protocolMessage) {
  const revokeType = protocolMessage?.type;
  return Boolean(protocolMessage?.key?.id)
    && (revokeType === 0 || revokeType === 'REVOKE' || String(revokeType).toLowerCase() === 'revoke');
}

function buildMediaMessage(file, mimeType, caption) {
  const payload = {
    url: file.path
  };

  if (mimeType.startsWith('image/')) {
    return {
      image: payload,
      caption: caption || '',
      mimetype: mimeType
    };
  }

  if (mimeType.startsWith('video/')) {
    return {
      video: payload,
      caption: caption || '',
      mimetype: mimeType
    };
  }

  if (mimeType.startsWith('audio/')) {
    return {
      audio: payload,
      mimetype: mimeType
    };
  }

  return {
    document: payload,
    fileName: file.originalname,
    mimetype: mimeType,
    caption: caption || ''
  };
}

function sameBareJid(a = '', b = '') {
  return bareJid(a) === bareJid(b);
}

function bareJid(jid = '') {
  const [user, server = ''] = String(jid).split('@');
  return `${user.split(':')[0]}@${server}`;
}
