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
const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');

let eventSource = null;
let username = null;
let messagesStore = [];
let selectedConversation = 'all';
let contacts = [];

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
    await fetch('/logout', { method: 'POST' });
  } finally {
    disconnectStream();
    username = null;
    messagesStore = [];
    contacts = [];
    messagesEl.innerHTML = '';
    conversationsEl.innerHTML = '';
    chat.hidden = true;
    auth.hidden = false;
  }
});

messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = '';
  try {
    const res = await fetch('/message', {
      method: 'POST',
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
  eventSource = new EventSource('/stream');
  eventSource.addEventListener('history', (ev) => {
    const hist = JSON.parse(ev.data);
    messagesStore = hist;
    renderThread();
  });
  eventSource.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    messagesStore.push(msg);
    if (selectedConversation === 'all' || msg.user === selectedConversation) {
      renderMessage(msg);
      scrollToBottom();
    }
  });
  eventSource.onerror = () => {
  };
}

function disconnectStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

async function loadContacts() {
  try {
    const res = await fetch('/users');
    const data = await res.json();
    if (res.ok && Array.isArray(data.users)) {
      contacts = data.users.filter(u => u && u !== username);
    } else {
      contacts = [];
    }
  } catch {
    contacts = [];
  }
}

function renderConversations() {
  conversationsEl.innerHTML = '';
  const allLi = document.createElement('li');
  allLi.textContent = 'All Messages';
  allLi.className = selectedConversation === 'all' ? 'active' : '';
  allLi.addEventListener('click', () => setConversation('all', 'All Messages'));
  conversationsEl.appendChild(allLi);
  contacts.forEach(u => {
    const li = document.createElement('li');
    li.textContent = u;
    li.className = selectedConversation === u ? 'active' : '';
    li.addEventListener('click', () => setConversation(u, u));
    conversationsEl.appendChild(li);
  });
}

function setConversation(id, title) {
  selectedConversation = id;
  conversationTitle.textContent = title;
  renderConversations();
  renderThread();
}

function renderThread() {
  messagesEl.innerHTML = '';
  const list = selectedConversation === 'all'
    ? messagesStore
    : messagesStore.filter(m => m.user === selectedConversation || m.user === username);
  list.forEach(renderMessage);
  scrollToBottom();
}

function renderMessage({ user, text, ts }) {
  const li = document.createElement('li');
  const time = new Date(ts).toLocaleTimeString();
  li.className = user === username ? 'me' : 'other';
  li.innerHTML = `<div class="bubble"><span class="meta">${user} • ${time}</span><span class="text">${escapeHTML(text)}</span></div>`;
  messagesEl.appendChild(li);
}

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
}
