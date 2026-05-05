import fs from 'fs/promises';
import path from 'path';

const DEFAULT_DATA = {
  chats: {},
  messages: {},
  statuses: {},
  labels: [],
  reminders: [],
  aliases: {}
};

export class JsonDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = structuredClone(DEFAULT_DATA);
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.reload();
  }

  async reload() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.data = { ...structuredClone(DEFAULT_DATA), ...JSON.parse(raw) };
      this.data.chats ||= {};
      this.data.messages ||= {};
      this.data.statuses ||= {};
      this.data.labels ||= [];
      this.data.reminders ||= [];
      this.data.aliases ||= {};
      await this.migrate();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Could not read database, starting with a clean store:', error.message);
      }
      await this.persist();
    }
  }

  async persist() {
    this.writeQueue = this.writeQueue.then(() =>
      fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2))
    );
    return this.writeQueue;
  }

  async upsertChat(chat) {
    if (!chat?.jid) return null;

    const jid = this.resolveJid(this.findCanonicalJid(chat));
    if (jid !== chat.jid) {
      await this.addAlias(chat.jid, jid);
    }

    const previous = this.data.chats[jid] || {};
    const next = {
      jid,
      name: chat.name || previous.name || formatFallbackName(chat.jid),
      isGroup: Boolean(chat.isGroup ?? previous.isGroup),
      avatarUrl: chat.avatarUrl || previous.avatarUrl || '',
      pinned: Boolean(chat.pinned ?? previous.pinned),
      archived: Boolean(chat.archived ?? previous.archived),
      muted: Boolean(chat.muted ?? previous.muted),
      manualUnread: Boolean(chat.manualUnread ?? previous.manualUnread),
      note: chat.note ?? previous.note ?? '',
      labels: Array.isArray(chat.labels) ? chat.labels : previous.labels || [],
      lastMessage: chat.lastMessage ?? previous.lastMessage ?? '',
      lastTimestamp: Number(chat.lastTimestamp ?? previous.lastTimestamp ?? Date.now()),
      unreadCount: Number(chat.unreadCount ?? previous.unreadCount ?? 0),
      updatedAt: Date.now()
    };

    this.data.chats[jid] = next;
    await this.persist();
    return next;
  }

  async saveMessage(message) {
    if (!message?.id || !message?.jid) return { inserted: false, message: null };

    const duplicateJid = this.findJidByMessageId(message.id);
    if (duplicateJid && duplicateJid !== message.jid) {
      await this.addAlias(message.jid, duplicateJid);
    }

    const jid = this.resolveJid(duplicateJid || this.findCanonicalJid(message));
    if (jid !== message.jid) {
      await this.addAlias(message.jid, jid);
    }

    this.data.messages[jid] ||= [];
    const exists = this.data.messages[jid].some((item) => item.id === message.id);
    if (exists) return { inserted: false, message: this.data.messages[jid].find((item) => item.id === message.id) };

    const saved = {
      id: message.id,
      jid,
      senderJid: message.senderJid || '',
      receiverJid: message.receiverJid || '',
      fromMe: Boolean(message.fromMe),
      senderName: message.senderName || '',
      type: message.type || 'unsupported',
      text: message.text || '',
      mediaUrl: message.mediaUrl || '',
      fileName: message.fileName || '',
      mimeType: message.mimeType || '',
      quoted: normalizeQuoted(message.quoted),
      starred: Boolean(message.starred),
      reactions: Array.isArray(message.reactions) ? message.reactions : [],
      receipt: message.receipt || '',
      deleted: Boolean(message.deleted),
      deletedAt: message.deletedAt || null,
      timestamp: Number(message.timestamp || Date.now())
    };

    this.data.messages[jid].push(saved);
    this.data.messages[jid].sort((a, b) => a.timestamp - b.timestamp);
    await this.upsertChat({
      jid: saved.jid,
      name: !saved.jid.endsWith('@g.us') && !saved.fromMe ? saved.senderName : message.chatName,
      avatarUrl: message.chatAvatarUrl,
      isGroup: saved.jid.endsWith('@g.us'),
      lastMessage: createLastMessage(saved),
      lastTimestamp: saved.timestamp
    });
    await this.persist();
    return { inserted: true, message: saved };
  }

  async markMessageDeleted({ jid, messageId, deletedAt = Date.now() }) {
    const resolvedJid = this.resolveJid(jid);
    const candidateJids = [
      resolvedJid,
      ...Object.entries(this.data.aliases)
        .filter(([, target]) => target === resolvedJid)
        .map(([alias]) => alias)
    ].filter(Boolean);

    for (const candidateJid of candidateJids) {
      const canonicalJid = this.resolveJid(candidateJid);
      const messages = this.data.messages[canonicalJid] || [];
      const message = messages.find((item) => item.id === messageId);
      if (!message) continue;

      message.deleted = true;
      message.deletedAt = deletedAt;

      if (message.mediaUrl) {
        message.mediaUrl = '';
      }

      const last = this.getLastVisibleMessage(canonicalJid);
      await this.upsertChat({
        jid: canonicalJid,
        isGroup: canonicalJid.endsWith('@g.us'),
        lastMessage: last ? createLastMessage(last) : 'Message deleted',
        lastTimestamp: last?.timestamp || message.timestamp || deletedAt
      });
      await this.persist();
      return { updated: true, message };
    }

    return { updated: false, message: null };
  }

  async getChats() {
    await this.migrate();
    return Object.values(this.data.chats)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0));
  }

  async getMessages(jid) {
    return this.data.messages[this.resolveJid(jid)] || [];
  }

  async updateChatMeta(jid, updates = {}) {
    const resolvedJid = this.resolveJid(jid);
    const previous = this.data.chats[resolvedJid];
    if (!previous) return null;

    const allowed = ['pinned', 'archived', 'muted', 'manualUnread', 'note', 'labels'];
    for (const key of allowed) {
      if (Object.hasOwn(updates, key)) previous[key] = updates[key];
    }
    previous.updatedAt = Date.now();
    await this.persist();
    return previous;
  }

  async setMessageStarred(jid, messageId, starred) {
    const messages = this.data.messages[this.resolveJid(jid)] || [];
    const message = messages.find((item) => item.id === messageId);
    if (!message) return null;

    message.starred = Boolean(starred);
    await this.persist();
    return message;
  }

  async setMessageReaction(jid, messageId, reaction) {
    const message = this.findMessage(jid, messageId);
    if (!message) return null;

    message.reactions ||= [];
    const sender = reaction.senderJid || 'unknown';
    message.reactions = message.reactions.filter((item) => item.senderJid !== sender);
    if (reaction.text) {
      message.reactions.push({
        senderJid: sender,
        text: reaction.text,
        timestamp: Number(reaction.timestamp || Date.now())
      });
    }

    await this.persist();
    return message;
  }

  async updateMessageReceipt(jid, messageId, receipt) {
    const message = this.findMessage(jid, messageId);
    if (!message) return null;

    message.receipt = receipt;
    await this.persist();
    return message;
  }

  async upsertLabel(label) {
    const id = label.id || `label-${Date.now()}`;
    const existing = this.data.labels.find((item) => item.id === id);
    const next = {
      id,
      name: label.name || 'Label',
      color: label.color || '#00a884'
    };

    if (existing) Object.assign(existing, next);
    else this.data.labels.push(next);

    await this.persist();
    return next;
  }

  async getLabels() {
    return this.data.labels;
  }

  async addReminder(reminder) {
    const saved = {
      id: `reminder-${Date.now()}`,
      jid: this.resolveJid(reminder.jid),
      messageId: reminder.messageId || '',
      text: reminder.text || '',
      dueAt: Number(reminder.dueAt || Date.now()),
      done: false,
      createdAt: Date.now()
    };
    this.data.reminders.push(saved);
    await this.persist();
    return saved;
  }

  async getReminders() {
    return [...this.data.reminders].sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
  }

  findMessage(jid, messageId) {
    const messages = this.data.messages[this.resolveJid(jid)] || [];
    return messages.find((item) => item.id === messageId);
  }

  async searchMessages(query, jid = '') {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) return [];

    const entries = jid
      ? [[this.resolveJid(jid), this.data.messages[this.resolveJid(jid)] || []]]
      : Object.entries(this.data.messages);

    return entries.flatMap(([chatJid, messages]) => {
      const chat = this.data.chats[chatJid] || {};
      return messages
        .filter((message) => [
          message.text,
          message.fileName,
          message.senderName,
          message.quoted?.text
        ].filter(Boolean).join(' ').toLowerCase().includes(normalized))
        .map((message) => ({ ...message, chatName: chat.name || formatFallbackName(chatJid), avatarUrl: chat.avatarUrl || '' }));
    }).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)).slice(0, 200);
  }

  async getChatAssets(jid) {
    const messages = await this.getMessages(jid);
    return {
      media: messages.filter((message) => ['image', 'video', 'audio'].includes(message.type) && message.mediaUrl),
      documents: messages.filter((message) => message.type === 'document' && message.mediaUrl),
      links: messages.flatMap((message) => extractLinks(message.text).map((url) => ({ ...message, url }))),
      starred: messages.filter((message) => message.starred)
    };
  }

  async saveStatus(status) {
    if (!status?.id || !status?.senderJid) return { inserted: false, status: null };

    const senderJid = this.resolveJid(status.senderJid);
    this.data.statuses[senderJid] ||= [];

    const exists = this.data.statuses[senderJid].some((item) => item.id === status.id);
    if (exists) {
      return {
        inserted: false,
        status: this.data.statuses[senderJid].find((item) => item.id === status.id)
      };
    }

    const saved = {
      id: status.id,
      senderJid,
      senderName: status.senderName || formatFallbackName(senderJid),
      avatarUrl: status.avatarUrl || '',
      type: status.type || 'unsupported',
      text: status.text || '',
      mediaUrl: status.mediaUrl || '',
      fileName: status.fileName || '',
      mimeType: status.mimeType || '',
      timestamp: Number(status.timestamp || Date.now())
    };

    this.data.statuses[senderJid].push(saved);
    this.data.statuses[senderJid].sort((a, b) => a.timestamp - b.timestamp);
    await this.persist();
    return { inserted: true, status: saved };
  }

  async getStatuses() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    return Object.entries(this.data.statuses)
      .map(([senderJid, items]) => {
        const statuses = items
          .filter((item) => Number(item.timestamp || 0) >= cutoff)
          .sort((a, b) => a.timestamp - b.timestamp);
        const latest = statuses.at(-1);

        return latest ? {
          senderJid,
          senderName: latest.senderName || formatFallbackName(senderJid),
          avatarUrl: latest.avatarUrl || '',
          lastTimestamp: latest.timestamp,
          count: statuses.length,
          statuses
        } : null;
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0));
  }

  async clear() {
    this.data = structuredClone(DEFAULT_DATA);
    await this.persist();
  }

  resolveJid(jid) {
    let current = jid;
    const seen = new Set();

    while (this.data.aliases[current] && !seen.has(current)) {
      seen.add(current);
      current = this.data.aliases[current];
    }

    return current;
  }

  async addAlias(aliasJid, canonicalJid) {
    const alias = this.resolveJid(aliasJid);
    const canonical = this.resolveJid(canonicalJid);
    if (!alias || !canonical || alias === canonical) return canonical;

    this.data.aliases[alias] = canonical;
    this.mergeChat(alias, canonical);
    await this.persist();
    return canonical;
  }

  async migrate() {
    let changed = false;
    this.data.aliases ||= {};

    for (const [jid, chat] of Object.entries(this.data.chats)) {
      if (this.isArtifactChat(jid)) {
        delete this.data.chats[jid];
        delete this.data.messages[jid];
        changed = true;
        continue;
      }

      const canonical = this.findCanonicalJid(chat);
      if (canonical !== jid) {
        this.data.aliases[jid] = canonical;
        this.mergeChat(jid, canonical);
        changed = true;
      }
    }

    for (const [jid, messages] of Object.entries(this.data.messages)) {
      for (const message of messages) {
        if (isLegacyUnsupportedPlaceholder(message)) {
          message.deleted = true;
          message.deletedAt ||= message.timestamp || Date.now();
          message.text = '';
          changed = true;
        }

        const duplicateJid = this.findJidByMessageId(message.id, jid);
        if (duplicateJid) {
          this.data.aliases[jid] = duplicateJid;
          this.mergeChat(jid, duplicateJid);
          changed = true;
          break;
        }
      }
    }

    for (const jid of Object.keys(this.data.messages)) {
      const chat = this.data.chats[jid];
      const last = this.getLastVisibleMessage(jid);
      if (chat && last) {
        chat.lastMessage = createLastMessage(last);
        chat.lastTimestamp = last.timestamp;
      }
    }

    if (changed) await this.persist();
  }

  isArtifactChat(jid) {
    if (jid.endsWith('@g.us')) return false;

    const messages = this.data.messages[jid] || [];
    if (!messages.length) return false;

    return messages.every((message) => {
      const base = jid.split('@')[0];
      const senderBase = String(message.senderJid || '').split('@')[0].split(':')[0];
      const receiverBase = String(message.receiverJid || '').split('@')[0].split(':')[0];
      const unsupportedProtocol = message.type === 'unsupported' && message.text === 'Unsupported message type';
      return unsupportedProtocol && message.fromMe && senderBase === base && receiverBase === base;
    });
  }

  findCanonicalJid(item) {
    const jid = this.resolveJid(item.jid);
    if (jid.endsWith('@g.us')) return jid;

    const name = normalizeName(item.name || item.senderName);
    if (!name) return jid;

    const sameNamedChat = Object.values(this.data.chats).find((chat) => {
      if (!chat?.jid || chat.jid === jid || chat.isGroup) return false;
      return normalizeName(chat.name) === name && shouldMergeNamedChats(chat.jid, jid);
    });

    if (sameNamedChat) {
      return preferPhoneJid(sameNamedChat.jid, jid);
    }

    return jid;
  }

  findJidByMessageId(messageId, exceptJid = '') {
    for (const [jid, messages] of Object.entries(this.data.messages)) {
      if (jid === exceptJid) continue;
      if (messages.some((message) => message.id === messageId)) {
        return this.resolveJid(jid);
      }
    }

    return '';
  }

  mergeChat(fromJid, toJid) {
    if (!fromJid || !toJid || fromJid === toJid) return;

    const fromChat = this.data.chats[fromJid];
    const toChat = this.data.chats[toJid];

    if (fromChat || toChat) {
      this.data.chats[toJid] = pickNewestChat(toChat, fromChat, toJid);
      delete this.data.chats[fromJid];
    }

    const fromMessages = this.data.messages[fromJid] || [];
    if (fromMessages.length) {
      this.data.messages[toJid] ||= [];
      const existingIds = new Set(this.data.messages[toJid].map((message) => message.id));
      for (const message of fromMessages) {
        if (existingIds.has(message.id)) continue;
        this.data.messages[toJid].push({ ...message, jid: toJid });
      }
      this.data.messages[toJid].sort((a, b) => a.timestamp - b.timestamp);
      delete this.data.messages[fromJid];
    }
  }

  getLastVisibleMessage(jid) {
    const messages = this.data.messages[this.resolveJid(jid)] || [];
    return [...messages].reverse().find((message) => !message.deleted) || messages.at(-1);
  }
}

function createLastMessage(message) {
  if (message.deleted) return 'Message deleted';
  if (message.text) return message.text;
  if (message.type === 'image') return 'Image';
  if (message.type === 'video') return 'Video';
  if (message.type === 'document') return message.fileName || 'Document';
  if (message.type === 'audio') return 'Audio';
  return 'Unsupported message';
}

function formatFallbackName(jid) {
  return jid.split('@')[0].replace(/[^0-9A-Za-z+_-]/g, '');
}

function normalizeName(name = '') {
  const value = String(name).trim().toLowerCase();
  if (!value || /^[0-9+\s-]+$/.test(value)) return '';
  return value;
}

function shouldMergeNamedChats(a, b) {
  return [a, b].some((jid) => jid.endsWith('@lid')) || a.split('@')[0] === b.split('@')[0];
}

function preferPhoneJid(a, b) {
  if (a.endsWith('@s.whatsapp.net')) return a;
  if (b.endsWith('@s.whatsapp.net')) return b;
  return a;
}

function pickNewestChat(a, b, jid) {
  const chats = [a, b].filter(Boolean);
  const newest = chats.sort((left, right) => Number(right.lastTimestamp || 0) - Number(left.lastTimestamp || 0))[0] || {};
  const named = chats.find((chat) => normalizeName(chat.name));

  return {
    ...newest,
    jid,
    name: named?.name || newest.name || formatFallbackName(jid),
    isGroup: Boolean(newest.isGroup || jid.endsWith('@g.us')),
    avatarUrl: newest.avatarUrl || '',
    updatedAt: Date.now()
  };
}

function isLegacyUnsupportedPlaceholder(message) {
  return message.type === 'unsupported'
    && message.text === 'Unsupported message type'
    && !message.mediaUrl
    && !message.deleted;
}

function normalizeQuoted(quoted) {
  if (!quoted?.id) return null;

  return {
    id: quoted.id,
    jid: quoted.jid || '',
    participant: quoted.participant || '',
    senderName: quoted.senderName || '',
    fromMe: Boolean(quoted.fromMe),
    type: quoted.type || 'text',
    text: quoted.text || '',
    mediaUrl: quoted.mediaUrl || '',
    fileName: quoted.fileName || ''
  };
}

function extractLinks(text = '') {
  return String(text).match(/https?:\/\/[^\s<>"']+/g) || [];
}
