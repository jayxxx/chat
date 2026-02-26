const loginForm = document.getElementById('loginForm');
const authError = document.getElementById('authError');
const chat = document.getElementById('chat');
const auth = document.getElementById('auth');
const welcome = document.getElementById('welcome');
const avatar = document.getElementById('avatar');
const conversationsEl = document.getElementById('conversations');
const conversationTitle = document.getElementById('conversationTitle');
const searchInput = document.getElementById('search');
const logoutBtn = document.getElementById('logoutBtn');
const themeBtn = document.getElementById('themeBtn');
const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const typingIndicatorEl = document.getElementById('typingIndicator');
const menuBtn = document.getElementById('menuBtn');
const sidebar = document.querySelector('.sidebar');
const scrollBtn = document.getElementById('scrollBtn');

let eventSource = null;
let username = null;
let messagesStore = [];
let selectedConversation = 'all';
let contacts = [];
let onlineUsers = new Set();
let typingUsers = new Set();
let typingTimeout = null;
let unreadCounts = {};
let currentTheme = 'dark';

// load cached data immediately so UI is not blank while we contact the server
try {
  const cached = localStorage.getItem('messages');
  if (cached) {
    const arr = JSON.parse(cached);
    if (Array.isArray(arr)) {
      messagesStore = arr;
    }
  }
} catch {}

async function checkSession() {
  // restore username from local cache if available before /me
  const cachedName = localStorage.getItem('username');
  if (cachedName && !username) {
    username = cachedName;
    welcome.textContent = username;
    avatar.textContent = username.slice(0,1).toUpperCase();
  }
  try {
    const res = await fetch('/me', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    username = data.username;
    welcome.textContent = username;
    avatar.textContent = username.slice(0, 1).toUpperCase();
    auth.hidden = true;
    chat.hidden = false;
    // render any cached messages right away before streaming
    renderThread();
    connectStream();
    startPolling();
    await loadContacts();
    renderConversations();
    setConversation('all', 'All Messages');
  } catch (e) {
    // ignore; not logged in
  }
}

// perform the check right away
checkSession();

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.hidden = true;
  const formData = new FormData(loginForm);
  const payload = {
    username: formData.get('username'),
    password: formData.get('password'),
  };
  try {
    const res = await fetch('/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      authError.textContent = data.error || 'Login failed';
      authError.hidden = false;
      return;
    }
    username = data.username;
    localStorage.setItem('username', username);
    welcome.textContent = username;
    avatar.textContent = username.slice(0, 1).toUpperCase();
    auth.hidden = true;
    chat.hidden = false;
    connectStream();
    await loadContacts();
    renderConversations();
    setConversation('all', 'All Messages');
  } catch (err) {
    authError.textContent = 'Network error';
    authError.hidden = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/logout', { method: 'POST', credentials: 'include' });
  } finally {
    disconnectStream();
    stopPolling();
    username = null;
    messagesStore = [];
    contacts = [];
    onlineUsers.clear();
    messagesEl.innerHTML = '';
    conversationsEl.innerHTML = '';
    chat.hidden = true;
    auth.hidden = false;
    localStorage.removeItem('username');
    localStorage.removeItem('messages');
  }
});

messageForm.addEventListener('submit', async (e) => {
  // user finished typing
  notifyTyping(false);
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = '';
  try {
    const res = await fetch('/message', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      alert('Failed to send message');
    }
  } catch {
    alert('Network error');
  }
});

function connectStream() {
  // when new messages arrive and user is scrolled up, show scroll button
  messagesEl.addEventListener('scroll', () => {
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop <= messagesEl.clientHeight + 20;
    if (atBottom) scrollBtn.hidden = true;
  });
  // attach mobile menu button listener
  if (menuBtn && sidebar) {
    menuBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }
  // use SSE locally but poll on failure
  eventSource = new EventSource('/stream');
  eventSource.addEventListener('history', (ev) => {
    const hist = JSON.parse(ev.data);
    messagesStore = hist;
    persistMessages();
    renderThread();
  });
  eventSource.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    messagesStore.push(msg);
    persistMessages();
    if (selectedConversation === 'all' || msg.user === selectedConversation) {
      const wasAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop <= messagesEl.clientHeight + 20;
      renderMessage(msg, true);
      if (wasAtBottom) scrollToBottom();
      else scrollBtn.hidden = false;
    } else {
      unreadCounts[msg.user] = (unreadCounts[msg.user] || 0) + 1;
      renderConversations();
    }
  });
  eventSource.addEventListener('presence', (ev) => {
    const info = JSON.parse(ev.data);
    if (info && info.user) {
      if (info.online) {
        onlineUsers.add(info.user);
      } else {
        onlineUsers.delete(info.user);
      }
      renderConversations();
    }
  });
  eventSource.addEventListener('typing', (ev) => {
    const info = JSON.parse(ev.data);
    if (info && info.user && info.user !== username) {
      if (info.typing) typingUsers.add(info.user);
      else typingUsers.delete(info.user);
      updateTypingIndicator();
    }
  });
  eventSource.onerror = () => {
    // fallback to polling
    console.warn('stream failed, switching to polling');
    disconnectStream();
    startPolling();
  };
}

let pollInterval = null;
function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    try {
      const res = await fetch('/messages', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        messagesStore = data.messages;
        persistMessages();
        renderThread();
      }
      const on = await fetch('/online', { credentials: 'include' });
      if (on.ok) {
        const d = await on.json();
        onlineUsers = new Set(d.online);
        renderConversations();
      }
    } catch(e) {
      console.error('poll error', e);
    }
  }, 2000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function disconnectStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

async function loadContacts() {
  typingUsers.clear();
  try {
    const res = await fetch('/users', { credentials: 'include' });
    const data = await res.json();
    if (res.ok && Array.isArray(data.users)) {
      contacts = data.users.filter(u => u && u !== username);
      if (Array.isArray(data.online)) {
        onlineUsers = new Set(data.online);
      }
    } else {
      contacts = [];
      onlineUsers = new Set();
    }
  } catch {
    contacts = [];
    onlineUsers = new Set();
  }
}

function renderConversations() {
  // clear typing indicator when switching conversation
  typingUsers.clear();
  updateTypingIndicator();
  conversationsEl.innerHTML = '';
  const allLi = document.createElement('li');
  allLi.textContent = 'All Messages';
  allLi.className = selectedConversation === 'all' ? 'active' : '';
  allLi.addEventListener('click', () => setConversation('all', 'All Messages'));
  conversationsEl.appendChild(allLi);
  contacts
    .filter(u => filterString ? u.toLowerCase().includes(filterString) : true)
    .forEach(u => {
    const li = document.createElement('li');
    const av = document.createElement('div');
    av.className = 'avatar small';
    av.textContent = u.slice(0,1).toUpperCase();
    li.appendChild(av);
    const span = document.createElement('span');
    span.textContent = u;
    li.appendChild(span);
    li.className = '';
    if (selectedConversation === u) li.classList.add('active');
    if (onlineUsers.has(u)) li.classList.add('online');
    const count = unreadCounts[u] || 0;
    if (count) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = count;
      li.appendChild(badge);
    }
    li.addEventListener('click', () => setConversation(u, u));
    conversationsEl.appendChild(li);
  });
}

let filterString = '';

function setConversation(id, title) {
  // clear unread for this convo
  if (id !== 'all') delete unreadCounts[id];
  selectedConversation = id;
  conversationTitle.textContent = title;
  renderConversations();
  renderThread();

  // close mobile sidebar when a conversation is chosen
  if (window.innerWidth <= 700 && sidebar) {
    sidebar.classList.remove('open');
  }
}

function renderThread() {
  updateTypingIndicator();
  messagesEl.innerHTML = '';
  const list = selectedConversation === 'all'
    ? messagesStore
    : messagesStore.filter(m => m.user === selectedConversation || m.user === username);
  list.forEach(renderMessage);
  scrollToBottom();
}

function renderMessage({ user, text, ts }, addEffect) {
  const li = document.createElement('li');
  const time = new Date(ts).toLocaleTimeString();
  li.className = user === username ? 'me' : 'other';
  li.innerHTML = `<div class="bubble${addEffect ? ' new' : ''}"><span class="meta">${user} • ${time}</span><span class="text">${escapeHTML(text)}</span></div>`;
  messagesEl.appendChild(li);
}

function persistMessages() {
  try {
    localStorage.setItem('messages', JSON.stringify(messagesStore));
  } catch {}
}

function updateTypingIndicator() {
  // also hide indicator if input is focused so not overflown

  if (typingUsers.size === 0) {
    typingIndicatorEl.hidden = true;
    return;
  }
  const names = Array.from(typingUsers).join(', ');
  typingIndicatorEl.textContent = `${names} typing…`;
  typingIndicatorEl.hidden = false;
}

function notifyTyping(state) {
  // existing
  if (!username) return;
  fetch('/typing', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ typing: state }),
  }).catch(() => {});
}

searchInput.addEventListener('input', () => {
  filterString = searchInput.value.trim().toLowerCase();
  renderConversations();
});

messageInput.addEventListener('input', () => {
  // also ensure composer input is focused when typing
  messageInput.focus();
  notifyTyping(true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => notifyTyping(false), 1500);
});

function escapeHTML(str) {
  return str.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  scrollBtn.hidden = true;
}

// theme toggle
function applyTheme(theme) {
  document.body.classList.remove('light','dark');
  document.body.classList.add(theme);
  currentTheme = theme;
  themeBtn.textContent = theme === 'dark' ? '🌙' : '☀️';
  localStorage.setItem('theme', theme);
}

themeBtn.addEventListener('click', () => {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

// on load, restore theme
(function(){
  const stored = localStorage.getItem('theme');
  if (stored) applyTheme(stored);
  else applyTheme('dark');
})();

scrollBtn.addEventListener('click', () => scrollToBottom());
