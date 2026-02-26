const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const users = new Map();
users.set('user2', hash('112233'));
users.set('user1', hash('12345'));

const sessions = new Map();
const subscribers = new Set();
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
  const sid = cookies.sid;
  if (!sid || !sessions.has(sid)) {
    sendJSON(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return sessions.get(sid);
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
      sendJSON(res, 200, { ok: true, username }, {
        'Set-Cookie': `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/`,
      });
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid request' });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/logout') {
    const cookies = parseCookies(req);
    const sid = cookies.sid;
    if (sid) sessions.delete(sid);
    sendJSON(res, 200, { ok: true }, {
      'Set-Cookie': `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/stream') {
    const session = requireSession(req, res);
    if (!session) return;
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
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/users') {
    const session = requireSession(req, res);
    if (!session) return;
    const list = Array.from(users.keys());
    sendJSON(res, 200, { users: list });
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

