const socket = io();

const state = {
  connected: false,
  view: 'chats',
  chats: [],
  statuses: [],
  activeJid: '',
  activeStatusJid: '',
  messages: new Map(),
  unread: new Map(),
  chatFilter: 'all',
  chatSearch: '',
  presence: {},
  uploadQueue: []
};

const loginScreen = document.getElementById('loginScreen');
const chatApp = document.getElementById('chatApp');
const loginText = document.getElementById('loginText');
const qrImage = document.getElementById('qrImage');
const qrPlaceholder = document.getElementById('qrPlaceholder');
const refreshStatusBtn = document.getElementById('refreshStatusBtn');
const accountName = document.getElementById('accountName');
const syncStatus = document.getElementById('syncStatus');
const chatList = document.getElementById('chatList');
const chatsTabBtn = document.getElementById('chatsTabBtn');
const statusTabBtn = document.getElementById('statusTabBtn');
const searchInput = document.getElementById('searchInput');
const allFilterBtn = document.getElementById('allFilterBtn');
const unreadFilterBtn = document.getElementById('unreadFilterBtn');
const groupsFilterBtn = document.getElementById('groupsFilterBtn');
const archiveFilterBtn = document.getElementById('archiveFilterBtn');
const notifyBtn = document.getElementById('notifyBtn');
const themeBtn = document.getElementById('themeBtn');
const soundBtn = document.getElementById('soundBtn');
const mainMenuBtn = document.getElementById('mainMenuBtn');
const mainMenu = document.getElementById('mainMenu');
const logoutBtn = document.getElementById('logoutBtn');
const backBtn = document.getElementById('backBtn');
const chatTitle = document.getElementById('chatTitle');
const chatSubtitle = document.getElementById('chatSubtitle');
const chatAvatar = document.getElementById('chatAvatar');
const messagesEl = document.getElementById('messages');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('messageInput');
const mediaInput = document.getElementById('mediaInput');
const sendBtn = document.getElementById('sendBtn');
const chatSearchInput = document.getElementById('chatSearchInput');
const chatMenuBtn = document.getElementById('chatMenuBtn');
const chatMenu = document.getElementById('chatMenu');
const pinChatBtn = document.getElementById('pinChatBtn');
const archiveChatBtn = document.getElementById('archiveChatBtn');
const markUnreadBtn = document.getElementById('markUnreadBtn');
const galleryBtn = document.getElementById('galleryBtn');
const infoBtn = document.getElementById('infoBtn');
const labelBtn = document.getElementById('labelBtn');
const reminderBtn = document.getElementById('reminderBtn');
const backupBtn = document.getElementById('backupBtn');
const lockBtn = document.getElementById('lockBtn');
const exportTxtBtn = document.getElementById('exportTxtBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const uploadQueue = document.getElementById('uploadQueue');
const mediaViewer = document.getElementById('mediaViewer');
const viewerContent = document.getElementById('viewerContent');
const closeViewerBtn = document.getElementById('closeViewerBtn');
const toastStack = document.getElementById('toastStack');
const detailPanel = document.getElementById('detailPanel');
const detailTitle = document.getElementById('detailTitle');
const detailContent = document.getElementById('detailContent');
const closeDetailBtn = document.getElementById('closeDetailBtn');
const lockScreen = document.getElementById('lockScreen');
const pinInput = document.getElementById('pinInput');
const unlockBtn = document.getElementById('unlockBtn');

refreshStatusBtn.addEventListener('click', loadStatus);
mainMenuBtn.addEventListener('click', (event) => toggleDropdown(event, mainMenu));
chatMenuBtn.addEventListener('click', (event) => toggleDropdown(event, chatMenu));
chatsTabBtn.addEventListener('click', () => setSidebarView('chats'));
statusTabBtn.addEventListener('click', () => setSidebarView('statuses'));
searchInput.addEventListener('input', renderSidebarList);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && state.view === 'chats' && searchInput.value.trim()) {
    event.preventDefault();
    renderGlobalSearchResults(searchInput.value.trim());
  }
});
chatSearchInput.addEventListener('input', () => {
  state.chatSearch = chatSearchInput.value.trim().toLowerCase();
  renderMessages();
});
allFilterBtn.addEventListener('click', () => setChatFilter('all'));
unreadFilterBtn.addEventListener('click', () => setChatFilter('unread'));
groupsFilterBtn.addEventListener('click', () => setChatFilter('groups'));
archiveFilterBtn.addEventListener('click', () => setChatFilter('archive'));
notifyBtn.addEventListener('click', enableNotifications);
themeBtn.addEventListener('click', toggleTheme);
soundBtn.addEventListener('click', toggleSound);
logoutBtn.addEventListener('click', logout);
pinChatBtn.addEventListener('click', () => toggleChatMeta('pinned'));
archiveChatBtn.addEventListener('click', () => toggleChatMeta('archived'));
markUnreadBtn.addEventListener('click', markActiveUnread);
galleryBtn.addEventListener('click', showGalleryPanel);
infoBtn.addEventListener('click', showInfoPanel);
labelBtn.addEventListener('click', showLabelPanel);
reminderBtn.addEventListener('click', addReminderForChat);
backupBtn.addEventListener('click', createBackup);
lockBtn.addEventListener('click', lockApp);
exportTxtBtn.addEventListener('click', () => exportChat('txt'));
exportJsonBtn.addEventListener('click', () => exportChat('json'));
closeDetailBtn.addEventListener('click', () => detailPanel.classList.add('hidden'));
unlockBtn.addEventListener('click', unlockApp);
backBtn.addEventListener('click', () => chatApp.classList.remove('chat-open'));
composer.addEventListener('submit', sendMessage);
mediaInput.addEventListener('change', sendMedia);
messageInput.addEventListener('input', () => sendTypingPresence('composing'));
messageInput.addEventListener('blur', () => sendTypingPresence('paused'));
closeViewerBtn.addEventListener('click', closeViewer);
mediaViewer.addEventListener('click', (event) => {
  if (event.target === mediaViewer) closeViewer();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeViewer();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.header-actions')) mainMenu.classList.add('hidden');
  if (!event.target.closest('.chat-tools')) chatMenu.classList.add('hidden');
});

socket.on('qr', ({ qrDataUrl }) => {
  state.connected = false;
  showLogin();
  loginText.textContent = 'Scan this QR with WhatsApp on your phone.';
  qrImage.src = qrDataUrl;
  qrImage.classList.remove('hidden');
  qrPlaceholder.classList.add('hidden');
});

socket.on('connected', (status) => {
  applyStatus(status);
  loadChats();
  loadStatuses();
});

socket.on('disconnected', (status) => {
  applyStatus(status);
});

socket.on('chats', (chats) => {
  state.chats = chats || [];
  renderSidebarList();
  refreshActiveChatHeader();
});

socket.on('statuses', (statuses) => {
  state.statuses = statuses || [];
  renderSidebarList();
});

socket.on('status-update', (status) => {
  upsertStatus(status);
  renderSidebarList();
  if (state.activeStatusJid === status.senderJid) renderStatusesViewer(status.senderJid);
});

socket.on('history-sync', (sync) => {
  renderHistorySync(sync);
});

socket.on('new-message', (message) => {
  addMessageToState(message);
  trackIncomingMessage(message);
  if (message.jid === state.activeJid) renderMessages();
  showIncomingNotification(message);
});

socket.on('message-sent', (message) => {
  addMessageToState(message);
  if (message.jid === state.activeJid) renderMessages();
});

socket.on('message-updated', (message) => {
  updateMessageInState(message);
  if (message.jid === state.activeJid) renderMessages();
});

socket.on('presence-update', (presence) => {
  state.presence[presence.id] = presence.presences || {};
  refreshActiveChatHeader();
});

loadStatus();
updateNotificationButton();
applySavedTheme();
updateSoundButton();
restoreLockIfNeeded();

async function loadStatus() {
  try {
    loginText.textContent = 'Checking connection...';
    const status = await api('/api/status');
    applyStatus(status);
    if (status.connected) {
      await loadChats();
      await loadStatuses();
    }
  } catch (error) {
    loginText.textContent = 'Server is not ready yet.';
  }
}

function applyStatus(status) {
  state.connected = Boolean(status.connected);

  if (state.connected) {
    accountName.textContent = status.me?.name || status.me?.id || 'WhatsApp';
    renderHistorySync(status.historySync);
    showApp();
    setComposerEnabled(Boolean(state.activeJid));
    return;
  }

  showLogin();
  setComposerEnabled(false);
  if (status.qrDataUrl) {
    qrImage.src = status.qrDataUrl;
    qrImage.classList.remove('hidden');
    qrPlaceholder.classList.add('hidden');
    loginText.textContent = 'Scan this QR with WhatsApp on your phone.';
  } else {
    qrImage.classList.add('hidden');
    qrPlaceholder.classList.remove('hidden');
    loginText.textContent = status.lastDisconnect || 'Waiting for WhatsApp QR...';
  }
}

function renderHistorySync(sync) {
  if (!syncStatus || !sync) return;

  if (sync.active || sync.progress != null) {
    const value = Number(sync.progress);
    const percent = Number.isFinite(value) ? Math.round(value <= 1 ? value * 100 : value) : null;
    const progress = percent != null ? `${percent}%` : 'syncing';
    syncStatus.textContent = `Syncing history ${progress} · ${sync.messages || 0} messages`;
    return;
  }

  if (sync.messages) {
    syncStatus.textContent = `History synced · ${sync.messages} messages`;
    window.setTimeout(() => {
      if (syncStatus.textContent.startsWith('History synced')) syncStatus.textContent = '';
    }, 6000);
  }
}

function toggleDropdown(event, menu) {
  event.stopPropagation();
  const shouldOpen = menu.classList.contains('hidden');
  mainMenu.classList.add('hidden');
  chatMenu.classList.add('hidden');
  menu.classList.toggle('hidden', !shouldOpen);
}

async function loadChats() {
  const chats = await api('/api/chats');
  state.chats = chats || [];
  renderSidebarList();
}

async function loadStatuses() {
  const statuses = await api('/api/statuses');
  state.statuses = statuses || [];
  renderSidebarList();
}

async function openChat(jid) {
  state.view = 'chats';
  state.activeJid = jid;
  state.activeStatusJid = '';
  state.chatSearch = '';
  chatSearchInput.value = '';
  state.unread.delete(jid);
  api('/api/chat-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid, updates: { manualUnread: false } })
  }).catch(() => {});
  chatApp.classList.remove('status-view-mode');
  const chat = state.chats.find((item) => item.jid === jid);
  if (chat) chat.manualUnread = false;
  chatTitle.textContent = chat?.name || fallbackName(jid);
  chatSubtitle.textContent = chat?.isGroup ? 'Group chat' : jid;
  renderHeaderAvatar(chat);
  setComposerEnabled(true);
  chatApp.classList.add('chat-open');
  renderSidebarList();

  if (!state.messages.has(jid)) {
    const messages = await api(`/api/messages/${encodeURIComponent(jid)}`);
    state.messages.set(jid, messages || []);
  }

  renderMessages();
}

function setSidebarView(view) {
  state.view = view;
  searchInput.value = '';
  chatsTabBtn.classList.toggle('active', view === 'chats');
  statusTabBtn.classList.toggle('active', view === 'statuses');
  searchInput.placeholder = view === 'chats' ? 'Search or start new chat' : 'Search status';
  chatApp.classList.toggle('status-view-mode', view === 'statuses');
  renderSidebarList();
}

function renderSidebarList() {
  if (state.view === 'statuses') {
    renderStatusList();
    return;
  }

  renderChats();
}

function renderChats() {
  const query = searchInput.value.trim().toLowerCase();
  const chats = state.chats.filter((chat) => {
    const haystack = `${chat.name || ''} ${chat.jid || ''} ${chat.lastMessage || ''}`.toLowerCase();
    if (!haystack.includes(query)) return false;
    if (state.chatFilter === 'unread') return Boolean(state.unread.get(chat.jid) || chat.manualUnread);
    if (state.chatFilter === 'groups') return Boolean(chat.isGroup);
    if (state.chatFilter === 'archive') return Boolean(chat.archived);
    return !chat.archived;
  });

  if (!chats.length) {
    chatList.innerHTML = '<div class="empty-state"><p>No chats found</p></div>';
    return;
  }

  chatList.innerHTML = chats.map((chat) => `
    <button class="chat-item ${chat.jid === state.activeJid ? 'active' : ''}" data-jid="${escapeAttr(chat.jid)}" type="button">
      ${renderAvatar(chat)}
      <div class="chat-main">
        <div class="chat-name">${escapeHtml(chat.name || fallbackName(chat.jid))}</div>
        <div class="chat-last">${chat.pinned ? '<span class="meta-chip">PIN</span>' : ''}${chat.manualUnread ? '<span class="meta-chip">UNREAD</span>' : ''}${escapeHtml(chat.lastMessage || '')}</div>
      </div>
      <div class="chat-side">
        <div class="chat-time">${formatTime(chat.lastTimestamp)}</div>
        ${renderUnreadBadge(chat.jid)}
      </div>
    </button>
  `).join('');

  chatList.querySelectorAll('.chat-item').forEach((button) => {
    button.addEventListener('click', () => openChat(button.dataset.jid));
  });
}

async function renderGlobalSearchResults(query) {
  const results = await api(`/api/search?q=${encodeURIComponent(query)}`);
  if (!results.length) {
    chatList.innerHTML = '<div class="empty-state"><p>No message results</p></div>';
    return;
  }

  chatList.innerHTML = results.map((item) => `
    <button class="chat-item" data-jid="${escapeAttr(item.jid)}" data-message-id="${escapeAttr(item.id)}" type="button">
      ${renderAvatar({ name: item.chatName, jid: item.jid, avatarUrl: item.avatarUrl })}
      <div class="chat-main">
        <div class="chat-name">${escapeHtml(item.chatName)}</div>
        <div class="chat-last">${escapeHtml(item.text || item.fileName || mediaLabel(item.type))}</div>
      </div>
      <div class="chat-time">${formatTime(item.timestamp)}</div>
    </button>
  `).join('');

  chatList.querySelectorAll('.chat-item').forEach((button) => {
    button.addEventListener('click', async () => {
      await openChat(button.dataset.jid);
      window.setTimeout(() => scrollToMessage(button.dataset.messageId), 150);
    });
  });
}

function setChatFilter(filter) {
  state.chatFilter = filter;
  [allFilterBtn, unreadFilterBtn, groupsFilterBtn, archiveFilterBtn].forEach((button) => button.classList.remove('active'));
  const active = { all: allFilterBtn, unread: unreadFilterBtn, groups: groupsFilterBtn, archive: archiveFilterBtn }[filter];
  active?.classList.add('active');
  renderChats();
}

function renderUnreadBadge(jid) {
  const count = state.unread.get(jid) || 0;
  if (!count) return '';

  return `<span class="unread-badge">${count > 99 ? '99+' : count}</span>`;
}

function renderStatusList() {
  const query = searchInput.value.trim().toLowerCase();
  const statuses = state.statuses.filter((item) => {
    const haystack = `${item.senderName || ''} ${item.senderJid || ''}`.toLowerCase();
    return haystack.includes(query);
  });

  if (!statuses.length) {
    chatList.innerHTML = '<div class="empty-state"><p>No recent statuses</p></div>';
    return;
  }

  chatList.innerHTML = statuses.map((item) => `
    <button class="chat-item ${item.senderJid === state.activeStatusJid ? 'active' : ''}" data-jid="${escapeAttr(item.senderJid)}" type="button">
      ${renderAvatar({ name: item.senderName, jid: item.senderJid, avatarUrl: item.avatarUrl })}
      <div class="chat-main">
        <div class="chat-name">${escapeHtml(item.senderName || fallbackName(item.senderJid))}</div>
        <div class="chat-last">${escapeHtml(statusSummary(item.statuses?.at(-1)))}</div>
      </div>
      <div class="status-count">${item.count}</div>
    </button>
  `).join('');

  chatList.querySelectorAll('.chat-item').forEach((button) => {
    button.addEventListener('click', () => openStatusGroup(button.dataset.jid));
  });
}

function openStatusGroup(senderJid) {
  state.activeStatusJid = senderJid;
  state.activeJid = '';
  chatApp.classList.add('chat-open', 'status-view-mode');
  const group = state.statuses.find((item) => item.senderJid === senderJid);
  chatTitle.textContent = group?.senderName || fallbackName(senderJid);
  chatSubtitle.textContent = `${group?.count || 0} status update${group?.count === 1 ? '' : 's'}`;
  renderHeaderAvatar({ name: group?.senderName, jid: senderJid, avatarUrl: group?.avatarUrl });
  setComposerEnabled(false);
  renderSidebarList();
  renderStatusesViewer(senderJid);
}

function renderStatusesViewer(senderJid) {
  const group = state.statuses.find((item) => item.senderJid === senderJid);
  const statuses = group?.statuses || [];

  if (!statuses.length) {
    messagesEl.innerHTML = '<div class="empty-state"><h3>No recent statuses</h3><p>Status updates appear here.</p></div>';
    return;
  }

  messagesEl.innerHTML = `<div class="status-viewer">${statuses.map(renderStatusCard).join('')}</div>`;
  messagesEl.scrollTop = messagesEl.scrollHeight;

  messagesEl.querySelectorAll('[data-view-media]').forEach((item) => {
    item.addEventListener('click', () => openViewer(item.dataset.viewMedia, item.dataset.mediaType));
  });
}

function renderStatusCard(status) {
  return `
    <article class="status-card">
      ${renderStatusBody(status)}
      <div class="status-meta">${formatTime(status.timestamp)}</div>
    </article>
  `;
}

function renderStatusBody(status) {
  if (status.type === 'image' && status.mediaUrl) {
    return `<img src="${escapeAttr(status.mediaUrl)}" alt="Status image" data-view-media="${escapeAttr(status.mediaUrl)}" data-media-type="image">`;
  }

  if (status.type === 'video' && status.mediaUrl) {
    return `<video src="${escapeAttr(status.mediaUrl)}" controls preload="metadata"></video>`;
  }

  if (status.type === 'audio' && status.mediaUrl) {
    return `<audio src="${escapeAttr(status.mediaUrl)}" controls preload="metadata"></audio>`;
  }

  return `<div class="status-card-text">${escapeHtml(status.text || statusSummary(status))}</div>`;
}

function refreshActiveChatHeader() {
  if (!state.activeJid) return;
  const chat = state.chats.find((item) => item.jid === state.activeJid);
  if (!chat) return;

  chatTitle.textContent = chat.name || fallbackName(chat.jid);
  chatSubtitle.textContent = presenceText(chat.jid, chat.isGroup ? 'Group chat' : chat.jid);
  renderHeaderAvatar(chat);
}

function renderMessages() {
  const allMessages = state.messages.get(state.activeJid) || [];
  const messages = state.chatSearch
    ? allMessages.filter((message) => `${message.text || ''} ${message.fileName || ''} ${message.senderName || ''}`.toLowerCase().includes(state.chatSearch))
    : allMessages;

  if (!messages.length) {
    messagesEl.innerHTML = state.chatSearch
      ? '<div class="empty-state"><h3>No search results</h3><p>Clear the chat search to see all messages.</p></div>'
      : '<div class="empty-state"><h3>No messages</h3><p>Send a message to start this chat.</p></div>';
    return;
  }

  const activeChat = state.chats.find((chat) => chat.jid === state.activeJid);
  messagesEl.innerHTML = messages.map((message) => renderMessage(message, Boolean(activeChat?.isGroup))).join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;

  messagesEl.querySelectorAll('[data-view-media]').forEach((item) => {
    item.addEventListener('click', () => openViewer(item.dataset.viewMedia, item.dataset.mediaType));
  });

  messagesEl.querySelectorAll('[data-quoted-id]').forEach((item) => {
    item.addEventListener('click', () => scrollToMessage(item.dataset.quotedId));
  });

  messagesEl.querySelectorAll('[data-copy-id]').forEach((item) => {
    item.addEventListener('click', () => copyMessage(item.dataset.copyId));
  });

  messagesEl.querySelectorAll('[data-star-id]').forEach((item) => {
    item.addEventListener('click', () => toggleStarMessage(item.dataset.starId));
  });

  messagesEl.querySelectorAll('[data-react-id]').forEach((item) => {
    item.addEventListener('click', () => sendReaction(item.dataset.reactId, item.dataset.reaction));
  });
}

function renderMessage(message, isGroup) {
  const direction = message.fromMe ? 'out' : 'in';
  const sender = isGroup && !message.fromMe
    ? `<div class="sender-name">${escapeHtml(message.senderName || fallbackName(message.senderJid))}</div>`
    : '';

  return `
    <div class="message-row ${direction}" data-message-id="${escapeAttr(message.id)}">
      <div class="bubble">
        ${sender}
        ${renderQuotedPreview(message.quoted)}
        ${renderMessageBody(message)}
        ${renderReactions(message)}
        <div class="message-actions">
          <button type="button" data-copy-id="${escapeAttr(message.id)}">Copy</button>
          <button type="button" data-star-id="${escapeAttr(message.id)}">${message.starred ? 'Unstar' : 'Star'}</button>
          <button type="button" data-react-id="${escapeAttr(message.id)}" data-reaction="👍">👍</button>
          <button type="button" data-react-id="${escapeAttr(message.id)}" data-reaction="❤️">❤️</button>
          <button type="button" data-react-id="${escapeAttr(message.id)}" data-reaction="😂">😂</button>
        </div>
        ${message.deleted ? '<div class="deleted-marker"><span>DEL</span> Deleted for everyone</div>' : ''}
        <div class="message-time">${formatTime(message.timestamp)} ${message.fromMe ? receiptIcon(message.receipt) : ''}</div>
      </div>
    </div>
  `;
}

function renderReactions(message) {
  if (!message.reactions?.length) return '';
  return `<div class="reaction-row">${message.reactions.map((item) => `<span>${escapeHtml(item.text)}</span>`).join('')}</div>`;
}

function receiptIcon(receipt = '') {
  if (receipt === 'read') return '✓✓';
  if (receipt === 'delivered') return '✓';
  return '';
}

function renderHeaderAvatar(chat) {
  chatAvatar.innerHTML = chat?.avatarUrl
    ? `<img src="${escapeAttr(chat.avatarUrl)}" alt="${escapeAttr(chat.name || 'Avatar')}">`
    : escapeHtml(initials(chat?.name || chat?.jid || '?'));
}

function renderAvatar(chat) {
  const label = chat?.name || chat?.jid || '?';
  const content = chat?.avatarUrl
    ? `<img src="${escapeAttr(chat.avatarUrl)}" alt="${escapeAttr(label)}">`
    : escapeHtml(initials(label));

  return `<div class="avatar">${content}</div>`;
}

function renderMessageBody(message) {
  if (message.deleted) {
    return '<div class="message-text deleted-text">This message was deleted</div>';
  }

  if (message.type === 'image' && message.mediaUrl) {
    return `
      <img src="${escapeAttr(message.mediaUrl)}" alt="${escapeAttr(message.fileName || 'Image')}" data-view-media="${escapeAttr(message.mediaUrl)}" data-media-type="image">
      ${message.text ? `<div class="message-text">${escapeHtml(message.text)}</div>` : ''}
    `;
  }

  if (message.type === 'video' && message.mediaUrl) {
    return `
      <video src="${escapeAttr(message.mediaUrl)}" controls preload="metadata" data-view-media="${escapeAttr(message.mediaUrl)}" data-media-type="video"></video>
      ${message.text ? `<div class="message-text">${escapeHtml(message.text)}</div>` : ''}
    `;
  }

  if (message.type === 'audio' && message.mediaUrl) {
    return `
      <audio src="${escapeAttr(message.mediaUrl)}" controls preload="metadata"></audio>
      ${message.text ? `<div class="message-text">${escapeHtml(message.text)}</div>` : ''}
    `;
  }

  if (message.type === 'document' && message.mediaUrl) {
    const label = message.fileName || 'Document';
    return `
      <div class="file-chip">
        <span>DOC</span>
        <a href="${escapeAttr(message.mediaUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>
      </div>
      ${message.text ? `<div class="message-text">${escapeHtml(message.text)}</div>` : ''}
    `;
  }

  return `<div class="message-text">${escapeHtml(message.text || 'Unsupported message')}</div>`;
}

async function toggleChatMeta(key) {
  if (!state.activeJid) return;
  const chat = state.chats.find((item) => item.jid === state.activeJid);
  if (!chat) return;
  const updates = { [key]: !chat[key] };
  const result = await api('/api/chat-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid: state.activeJid, updates })
  });
  Object.assign(chat, result.chat);
  renderSidebarList();
  refreshActiveChatHeader();
}

async function markActiveUnread() {
  if (!state.activeJid) return;
  state.unread.set(state.activeJid, Math.max(1, state.unread.get(state.activeJid) || 0));
  await api('/api/chat-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid: state.activeJid, updates: { manualUnread: true } })
  });
  renderSidebarList();
}

async function copyMessage(messageId) {
  const message = (state.messages.get(state.activeJid) || []).find((item) => item.id === messageId);
  if (!message) return;
  await navigator.clipboard.writeText(message.text || message.fileName || message.mediaUrl || '');
}

async function toggleStarMessage(messageId) {
  const list = state.messages.get(state.activeJid) || [];
  const message = list.find((item) => item.id === messageId);
  if (!message) return;
  const starred = !message.starred;
  const result = await api('/api/star-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid: state.activeJid, messageId, starred })
  });
  Object.assign(message, result.message || { starred });
  renderMessages();
}

async function sendReaction(messageId, text) {
  const result = await api('/api/send-reaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid: state.activeJid, messageId, text })
  });
  updateMessageInState(result.message);
  renderMessages();
}

function exportChat(format) {
  if (!state.activeJid) return;
  window.open(`/api/export/${format}/${encodeURIComponent(state.activeJid)}`, '_blank');
}

async function showGalleryPanel() {
  if (!state.activeJid) return;
  const assets = await api(`/api/chat-assets/${encodeURIComponent(state.activeJid)}`);
  detailTitle.textContent = 'Gallery';
  detailContent.innerHTML = `
    <section class="detail-section">
      <h3>Media</h3>
      <div class="asset-grid">${assets.media.map(renderAsset).join('') || '<p>No media</p>'}</div>
    </section>
    <section class="detail-section">
      <h3>Documents</h3>
      <div class="asset-list">${assets.documents.map(renderDocumentAsset).join('') || '<p>No documents</p>'}</div>
    </section>
    <section class="detail-section">
      <h3>Links</h3>
      <div class="asset-list">${assets.links.map((item) => `<a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a>`).join('') || '<p>No links</p>'}</div>
    </section>
    <section class="detail-section">
      <h3>Starred</h3>
      <div class="asset-list">${assets.starred.map((item) => `<p>${escapeHtml(item.text || item.fileName || mediaLabel(item.type))}</p>`).join('') || '<p>No starred messages</p>'}</div>
    </section>
  `;
  detailPanel.classList.remove('hidden');
}

async function showInfoPanel() {
  if (!state.activeJid) return;
  const info = await api(`/api/chat-info/${encodeURIComponent(state.activeJid)}`);
  const chat = info.chat || {};
  detailTitle.textContent = 'Chat Info';
  detailContent.innerHTML = `
    <section class="detail-section">
      ${renderAvatar(chat)}
      <h3>${escapeHtml(chat.name || fallbackName(state.activeJid))}</h3>
      <p>${escapeHtml(state.activeJid)}</p>
      <p>${info.messageCount} messages · ${info.mediaCount} media · ${info.documentCount} documents · ${info.linkCount} links</p>
    </section>
    ${chat.isGroup ? `
      <section class="detail-section">
        <h3>Participants (${info.participants?.length || 0})</h3>
        <div class="asset-list">${(info.participants || []).map((item) => `<p>${escapeHtml(item.id)} ${item.admin ? `(${escapeHtml(item.admin)})` : ''}</p>`).join('')}</div>
      </section>
    ` : ''}
  `;
  detailPanel.classList.remove('hidden');
}

function renderAsset(item) {
  if (item.type === 'image') return `<img src="${escapeAttr(item.mediaUrl)}" alt="Media" data-view-media="${escapeAttr(item.mediaUrl)}" data-media-type="image">`;
  if (item.type === 'video') return `<video src="${escapeAttr(item.mediaUrl)}" controls preload="metadata"></video>`;
  if (item.type === 'audio') return `<audio src="${escapeAttr(item.mediaUrl)}" controls preload="metadata"></audio>`;
  return '';
}

function renderDocumentAsset(item) {
  return `<a href="${escapeAttr(item.mediaUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.fileName || 'Document')}</a>`;
}

async function showLabelPanel() {
  const labels = await api('/api/labels');
  detailTitle.textContent = 'Labels';
  detailContent.innerHTML = `
    <section class="detail-section">
      <input id="newLabelName" class="chat-search" type="text" placeholder="New label">
      <button id="createLabelBtn" class="tool-button" type="button">Create</button>
    </section>
    <section class="detail-section asset-list">
      ${labels.map((label) => `<button class="tool-button" data-label-id="${escapeAttr(label.id)}">${escapeHtml(label.name)}</button>`).join('') || '<p>No labels</p>'}
    </section>
  `;
  detailPanel.classList.remove('hidden');
  document.getElementById('createLabelBtn').addEventListener('click', async () => {
    const name = document.getElementById('newLabelName').value.trim();
    if (!name) return;
    await api('/api/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    showLabelPanel();
  });
  detailContent.querySelectorAll('[data-label-id]').forEach((button) => {
    button.addEventListener('click', () => toggleLabelOnChat(button.dataset.labelId));
  });
}

async function toggleLabelOnChat(labelId) {
  const chat = state.chats.find((item) => item.jid === state.activeJid);
  if (!chat) return;
  const labels = new Set(chat.labels || []);
  if (labels.has(labelId)) labels.delete(labelId);
  else labels.add(labelId);
  const result = await api('/api/chat-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid: state.activeJid, updates: { labels: [...labels] } })
  });
  Object.assign(chat, result.chat);
  renderSidebarList();
}

async function addReminderForChat() {
  if (!state.activeJid) return;
  const minutes = Number(prompt('Remind in how many minutes?', '30'));
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  await api('/api/reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jid: state.activeJid,
      text: `Follow up ${chatTitle.textContent}`,
      dueAt: Date.now() + minutes * 60 * 1000
    })
  });
  alert('Reminder saved locally.');
}

async function createBackup() {
  const result = await api('/api/backup', { method: 'POST' });
  alert(`Backup created: ${result.file}`);
}

function renderQuotedPreview(quoted) {
  if (!quoted?.id) return '';

  const title = quoted.fromMe
    ? 'You'
    : quoted.senderName || fallbackName(quoted.participant || quoted.jid);
  const text = quoted.text || quoted.fileName || mediaLabel(quoted.type) || 'Message';

  return `
    <button class="quoted-preview" type="button" data-quoted-id="${escapeAttr(quoted.id)}">
      <span class="quoted-bar"></span>
      <span class="quoted-content">
        <span class="quoted-title">${escapeHtml(title)}</span>
        <span class="quoted-text">${escapeHtml(text)}</span>
      </span>
    </button>
  `;
}

async function sendMessage(event) {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!state.activeJid || !text) return;

  state.chatSearch = '';
  chatSearchInput.value = '';
  setComposerEnabled(false);
  try {
    const result = await api('/api/send-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: state.activeJid, text })
    });
    messageInput.value = '';
    addMessageToState(result.message);
    renderMessages();
  } catch (error) {
    alert(error.message);
  } finally {
    setComposerEnabled(true);
    messageInput.focus();
  }
}

async function sendMedia() {
  const files = [...mediaInput.files];
  if (!state.activeJid || !files.length) return;

  for (const file of files) {
    state.uploadQueue.push({ file, status: 'queued' });
  }
  mediaInput.value = '';
  renderUploadQueue();
  processUploadQueue();
}

async function processUploadQueue() {
  if (state.uploading) return;
  state.uploading = true;

  while (state.uploadQueue.some((item) => item.status === 'queued')) {
    const item = state.uploadQueue.find((entry) => entry.status === 'queued');
    item.status = 'sending';
    renderUploadQueue();

    const formData = new FormData();
    formData.append('jid', state.activeJid);
    formData.append('caption', messageInput.value.trim());
    formData.append('media', item.file);

    try {
      const result = await api('/api/send-media', { method: 'POST', body: formData });
      item.status = 'sent';
      addMessageToState(result.message);
      renderMessages();
    } catch (error) {
      item.status = 'failed';
      item.error = error.message;
    }
    renderUploadQueue();
  }

  messageInput.value = '';
  window.setTimeout(() => {
    state.uploadQueue = state.uploadQueue.filter((item) => item.status === 'failed');
    renderUploadQueue();
  }, 2500);
  state.uploading = false;
}

function renderUploadQueue() {
  if (!uploadQueue) return;
  if (!state.uploadQueue.length) {
    uploadQueue.classList.add('hidden');
    uploadQueue.innerHTML = '';
    return;
  }
  uploadQueue.classList.remove('hidden');
  uploadQueue.innerHTML = state.uploadQueue.map((item) => `${escapeHtml(item.file.name)} · ${item.status}`).join('<br>');
}

async function logout() {
  if (!confirm('Log out this WhatsApp session?')) return;
  await api('/api/logout', { method: 'POST' });
  state.activeJid = '';
  state.chats = [];
  state.messages.clear();
  applyStatus({ connected: false, lastDisconnect: 'Logged out' });
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function addMessageToState(message) {
  if (!message?.jid || !message?.id) return;
  const list = state.messages.get(message.jid) || [];
  if (!list.some((item) => item.id === message.id)) {
    list.push(message);
    list.sort((a, b) => a.timestamp - b.timestamp);
    state.messages.set(message.jid, list);
  }
}

function trackIncomingMessage(message) {
  if (!message || message.fromMe) return;
  playNotificationSound();

  if (message.jid !== state.activeJid) {
    state.unread.set(message.jid, (state.unread.get(message.jid) || 0) + 1);
    renderSidebarList();
    showInAppToast(message);
  }
}

function showInAppToast(message) {
  if (!toastStack || message.fromMe) return;

  const chat = state.chats.find((item) => item.jid === message.jid);
  const title = chat?.name || message.senderName || fallbackName(message.jid);
  const toast = document.createElement('button');
  toast.type = 'button';
  toast.className = 'message-toast';
  toast.innerHTML = `
    ${renderAvatar({ name: title, jid: message.jid, avatarUrl: chat?.avatarUrl })}
    <span class="toast-copy">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(notificationBody(message))}</span>
    </span>
  `;

  toast.addEventListener('click', () => {
    toast.remove();
    setSidebarView('chats');
    openChat(message.jid);
  });

  toastStack.appendChild(toast);
  window.setTimeout(() => toast.remove(), 6000);
}

function updateMessageInState(message) {
  if (!message?.jid || !message?.id) return;
  const list = state.messages.get(message.jid) || [];
  const index = list.findIndex((item) => item.id === message.id);

  if (index >= 0) {
    list[index] = { ...list[index], ...message };
  } else {
    list.push(message);
  }

  list.sort((a, b) => a.timestamp - b.timestamp);
  state.messages.set(message.jid, list);
}

function upsertStatus(status) {
  if (!status?.senderJid || !status?.id) return;
  let group = state.statuses.find((item) => item.senderJid === status.senderJid);

  if (!group) {
    group = {
      senderJid: status.senderJid,
      senderName: status.senderName || fallbackName(status.senderJid),
      avatarUrl: status.avatarUrl || '',
      lastTimestamp: status.timestamp,
      count: 0,
      statuses: []
    };
    state.statuses.unshift(group);
  }

  if (!group.statuses.some((item) => item.id === status.id)) {
    group.statuses.push(status);
  }

  group.statuses.sort((a, b) => a.timestamp - b.timestamp);
  group.count = group.statuses.length;
  group.lastTimestamp = group.statuses.at(-1)?.timestamp || group.lastTimestamp;
  group.senderName = status.senderName || group.senderName;
  group.avatarUrl = status.avatarUrl || group.avatarUrl;
  state.statuses.sort((a, b) => Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0));
}

function showLogin() {
  loginScreen.classList.remove('hidden');
  chatApp.classList.add('hidden');
}

function showApp() {
  loginScreen.classList.add('hidden');
  chatApp.classList.remove('hidden');
}

function setComposerEnabled(enabled) {
  messageInput.disabled = !enabled;
  mediaInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
}

function openViewer(url, type) {
  if (!url) return;
  viewerContent.innerHTML = type === 'video'
    ? `<video src="${escapeAttr(url)}" controls autoplay></video>`
    : `<img src="${escapeAttr(url)}" alt="Media preview">`;
  mediaViewer.classList.remove('hidden');
}

function closeViewer() {
  mediaViewer.classList.add('hidden');
  viewerContent.innerHTML = '';
}

async function enableNotifications() {
  if (!('Notification' in window)) {
    alert('This browser does not support desktop notifications.');
    return;
  }

  if (Notification.permission === 'granted') {
    localStorage.setItem('notificationsEnabled', 'true');
    updateNotificationButton();
    return;
  }

  const permission = await Notification.requestPermission();
  localStorage.setItem('notificationsEnabled', permission === 'granted' ? 'true' : 'false');
  updateNotificationButton();
}

function updateNotificationButton() {
  if (!notifyBtn) return;

  const supported = 'Notification' in window;
  const enabled = supported
    && Notification.permission === 'granted'
    && localStorage.getItem('notificationsEnabled') === 'true';
  const blocked = supported && Notification.permission === 'denied';

  notifyBtn.textContent = enabled ? 'On' : blocked ? 'Blocked' : 'Notify';
  notifyBtn.classList.toggle('enabled', enabled);
  notifyBtn.classList.toggle('blocked', blocked);
  notifyBtn.disabled = !supported || blocked;
  notifyBtn.title = enabled
    ? 'Notifications enabled'
    : blocked
      ? 'Notifications are blocked in browser settings'
      : 'Enable notifications';
}

function showIncomingNotification(message) {
  if (!shouldNotify(message)) return;

  const chat = state.chats.find((item) => item.jid === message.jid);
  const title = chat?.name || message.senderName || fallbackName(message.jid);
  const body = notificationBody(message);

  const notification = new Notification(title, {
    body,
    tag: message.jid,
    icon: '/favicon.svg',
    silent: false
  });

  notification.onclick = () => {
    window.focus();
    openChat(message.jid);
    notification.close();
  };
}

function shouldNotify(message) {
  return Boolean(
    message
    && !message.fromMe
    && 'Notification' in window
    && Notification.permission === 'granted'
    && localStorage.getItem('notificationsEnabled') === 'true'
  );
}

function toggleTheme() {
  const current = document.body.dataset.theme || localStorage.getItem('theme') || 'auto';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applySavedTheme();
}

function applySavedTheme() {
  const theme = localStorage.getItem('theme') || 'auto';
  document.body.dataset.theme = theme;
  themeBtn.textContent = theme === 'dark' ? 'Dark' : 'Light';
}

function toggleSound() {
  const enabled = localStorage.getItem('soundEnabled') !== 'false';
  localStorage.setItem('soundEnabled', enabled ? 'false' : 'true');
  updateSoundButton();
}

function updateSoundButton() {
  const enabled = localStorage.getItem('soundEnabled') !== 'false';
  soundBtn.textContent = enabled ? 'Sound' : 'Muted';
  soundBtn.classList.toggle('blocked', !enabled);
}

function playNotificationSound() {
  if (localStorage.getItem('soundEnabled') === 'false') return;
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.04;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.08);
  } catch (_error) {
    // Browser may block audio until the page has received a user gesture.
  }
}

let typingTimer = null;
function sendTypingPresence(type) {
  if (!state.activeJid) return;
  clearTimeout(typingTimer);
  api('/api/presence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jid: state.activeJid, type })
  }).catch(() => {});

  if (type === 'composing') {
    typingTimer = window.setTimeout(() => sendTypingPresence('paused'), 1800);
  }
}

function presenceText(jid, fallback) {
  const presences = state.presence[jid] || {};
  const values = Object.values(presences);
  if (values.some((item) => item.lastKnownPresence === 'composing')) return 'typing...';
  if (values.some((item) => item.lastKnownPresence === 'recording')) return 'recording audio...';
  if (values.some((item) => item.lastKnownPresence === 'available')) return 'online';
  return fallback;
}

function lockApp() {
  const existing = localStorage.getItem('appPin');
  if (!existing) {
    const pin = prompt('Set a local app PIN');
    if (!pin) return;
    localStorage.setItem('appPin', pin);
  }
  localStorage.setItem('appLocked', 'true');
  lockScreen.classList.remove('hidden');
}

function unlockApp() {
  if (pinInput.value === localStorage.getItem('appPin')) {
    localStorage.setItem('appLocked', 'false');
    lockScreen.classList.add('hidden');
    pinInput.value = '';
  } else {
    alert('Wrong PIN');
  }
}

function restoreLockIfNeeded() {
  if (localStorage.getItem('appLocked') === 'true') {
    lockScreen.classList.remove('hidden');
  }
}

function notificationBody(message) {
  if (message.deleted) return 'Message deleted';
  if (message.text) return message.text.slice(0, 120);
  return mediaLabel(message.type) || 'New message';
}

function statusSummary(status) {
  if (!status) return 'Status';
  if (status.text) return status.text;
  return mediaLabel(status.type) || 'Status';
}

function scrollToMessage(messageId) {
  const target = [...messagesEl.querySelectorAll('[data-message-id]')]
    .find((item) => item.dataset.messageId === messageId);
  if (!target) return;

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('message-highlight');
  window.setTimeout(() => target.classList.remove('message-highlight'), 1300);
}

function mediaLabel(type) {
  if (type === 'image') return 'Image';
  if (type === 'video') return 'Video';
  if (type === 'audio') return 'Audio';
  if (type === 'document') return 'Document';
  return '';
}

function fallbackName(jid = '') {
  return jid.split('@')[0];
}

function initials(value = '?') {
  const clean = fallbackName(value).trim();
  return clean.slice(0, 1).toUpperCase() || '?';
}

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(Number(value)));
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value = '') {
  return escapeHtml(value);
}
