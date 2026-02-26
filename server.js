const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// the app will read PORT from environment; fall back to 4444 for local testing
const PORT = process.env.PORT ? Number(process.env.PORT) : 4444;
const PUBLIC_DIR = path.join(__dirname, 'public');

const users = new Map();
users.set('user2', hash('112233'));
users.set('user1', hash('12345'));

// session map removed - use signed cookie instead
const subscribers = new Set();
// track which users currently have an active connection (will not persist between invocations)
const onlineUsers = new Set();
// hold chat history; will be loaded from disk if available
const messages = [];

function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function sendJSON(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function parseCookies(req) {
  const header = req.headers['cookie'];
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const [k, v] = part.trim().split('=');
    acc[k] = decodeURIComponent(v || '');
    return acc;
  }, {});
}

function requireSession(req, res) {
  const cookies = parseCookies(req);
  const user = cookies.username;
  if (!user || !users.has(user)) {
    sendJSON(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return { username: user };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Body too large'));
        req.connection.destroy();
      }
    });
    req.on('end', () => {
      try {
        if (data) {
          resolve(JSON.parse(data));
        } else {
          resolve({});
        }
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJSON(res, 404, { error: 'Not found' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === '.html' ? 'text/html' :
      ext === '.js' ? 'application/javascript' :
      ext === '.css' ? 'text/css' :
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    res.write(payload);
  }
}

const DATA_FILE = path.join(__dirname, 'messages.json');

// load previously saved messages (if any)
try {
  const disk = fs.readFileSync(DATA_FILE, 'utf8');
  const parsed = JSON.parse(disk);
  if (Array.isArray(parsed)) {
    messages.push(...parsed);
  }
} catch (e) {
  // ignore missing or invalid file
}

function saveMessages() {
  // use async write so the main thread isn't blocked on disk
  fs.writeFile(DATA_FILE, JSON.stringify(messages, null, 2), (err) => {
    if (err) console.error('failed to write messages file', err);
  });
}

const server = http.createServer(async (req, res) => {
  const base = `http://${req.headers.host || 'localhost'}`;
  const { pathname } = new URL(req.url, base);

  if (req.method === 'POST' && pathname === '/register') {
    try {
      const body = await readBody(req);
      const { username, password } = body;
      if (!username || !password) {
        sendJSON(res, 400, { error: 'Missing credentials' });
        return;
      }
      if (users.has(username)) {
        sendJSON(res, 409, { error: 'User exists' });
        return;
      }
      users.set(username, hash(password));
      sendJSON(res, 200, { ok: true, username });
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid request' });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/login') {
    try {
      const body = await readBody(req);
      const { username, password } = body;
      if (!username || !password) {
        sendJSON(res, 400, { error: 'Missing credentials' });
        return;
      }
      const stored = users.get(username);
      if (!stored || stored !== hash(password)) {
        sendJSON(res, 401, { error: 'Invalid credentials' });
        return;
      }
      const sid = crypto.randomUUID();
      sessions.set(sid, { username, createdAt: Date.now() });
      // mark as online immediately
      onlineUsers.add(username);
      broadcast('presence', { user: username, online: true });
      // make cookie persistent for a day so it survives browser restarts
      sendJSON(res, 200, { ok: true, username }, {
        'Set-Cookie': `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
      });
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid request' });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/logout') {
    const cookies = parseCookies(req);
    const user = cookies.username;
    if (user) {
      onlineUsers.delete(user);
      broadcast('presence', { user, online: false });
    }
    sendJSON(res, 200, { ok: true }, {
      'Set-Cookie': `username=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
    return;
  }

  // return info about current session (used by client to persist login)
  if (req.method === 'GET' && pathname === '/me') {
    const session = requireSession(req, res);
    if (!session) return;
    sendJSON(res, 200, { username: session.username });
    return;
  }

  // streaming not reliably supported on serverless platforms; keep for local
  if (req.method === 'GET' && pathname === '/stream') {
    const session = requireSession(req, res);
    if (!session) return;
    onlineUsers.add(session.username);
    broadcast('presence', { user: session.username, online: true });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 5000\n\n');
    subscribers.add(res);
    res.write(`event: history\ndata: ${JSON.stringify(messages)}\n\n`);
    req.on('close', () => {
      subscribers.delete(res);
      onlineUsers.delete(session.username);
      broadcast('presence', { user: session.username, online: false });
    });
    return;
  }

  // additional endpoints for polling
  if (req.method === 'GET' && pathname === '/messages') {
    const session = requireSession(req, res);
    if (!session) return;
    sendJSON(res, 200, { messages });
    return;
  }

  if (req.method === 'GET' && pathname === '/online') {
    const session = requireSession(req, res);
    if (!session) return;
    sendJSON(res, 200, { online: Array.from(onlineUsers) });
    return;
  }

  if (req.method === 'POST' && pathname === '/typing') {
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const body = await readBody(req);
      const { typing } = body;
      broadcast('typing', { user: session.username, typing: !!typing });
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid request' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/users') {
    const session = requireSession(req, res);
    if (!session) return;
    const list = Array.from(users.keys());
    sendJSON(res, 200, { users: list, online: Array.from(onlineUsers) });
    return;
  }

  if (req.method === 'POST' && pathname === '/message') {
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) {
        sendJSON(res, 400, { error: 'Message cannot be empty' });
        return;
      }
      const msg = { user: session.username, text, ts: Date.now() };
      messages.push(msg);
      // persist right away so history survives restarts/logouts
      saveMessages();
      broadcast('message', msg);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid request' });
    }
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}/`);
  console.log(`Seeded users: user2, user1`);
});

