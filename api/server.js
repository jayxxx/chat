const crypto = require('crypto');

const users = new Map();
users.set('user2', hash('112233'));
users.set('user1', hash('12345'));

// sessions map removed; auth done via cookie username
const subscribers = new Set();
const onlineUsers = new Set();
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
    sendJSON(res, 401, { error: 'Unauthorized' }, corsHeaders(req));
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

function corsHeaders(req) {
  const origin = req.headers.origin || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    res.write(payload);
  }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const base = `https://${req.headers.host}`;
  const { pathname } = new URL(req.url, base);

  if (req.method === 'POST' && pathname === '/login') {
    try {
      const body = await readBody(req);
      const { username, password } = body;
      if (!username || !password) {
        sendJSON(res, 400, { error: 'Missing credentials' }, corsHeaders(req));
        return;
      }
      const stored = users.get(username);
      if (!stored || stored !== hash(password)) {
        sendJSON(res, 401, { error: 'Invalid credentials' }, corsHeaders(req));
        return;
      }
      // no session map – use cookie to remember username
      onlineUsers.add(username);
      broadcast('presence', { user: username, online: true });
      sendJSON(res, 200, { ok: true, username }, {
        ...corsHeaders(req),
        'Set-Cookie': `username=${encodeURIComponent(username)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
      });
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid request' }, corsHeaders(req));
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
      ...corsHeaders(req),
      'Set-Cookie': `username=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/users') {
    const session = requireSession(req, res);
    if (!session) return;
    const list = Array.from(users.keys());
    sendJSON(res, 200, { users: list, online: Array.from(onlineUsers) }, corsHeaders(req));
    return;
  }

  if (req.method === 'GET' && pathname === '/stream') {
    const session = requireSession(req, res);
    if (!session) return;
    // streaming kept for local; serverless may not support
    onlineUsers.add(session.username);
    broadcast('presence', { user: session.username, online: true });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders(req),
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

  if (req.method === 'POST' && pathname === '/message') {
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) {
        sendJSON(res, 400, { error: 'Message cannot be empty' }, corsHeaders(req));
        return;
      }
      const msg = { user: session.username, text, ts: Date.now() };
      messages.push(msg);
      broadcast('message', msg);
      sendJSON(res, 200, { ok: true }, corsHeaders(req));
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid request' }, corsHeaders(req));
    }
    return;
  }

  // polling endpoints
  if (req.method === 'GET' && pathname === '/messages') {
    const session = requireSession(req, res);
    if (!session) return;
    sendJSON(res, 200, { messages }, corsHeaders(req));
    return;
  }
  if (req.method === 'GET' && pathname === '/online') {
    const session = requireSession(req, res);
    if (!session) return;
    sendJSON(res, 200, { online: Array.from(onlineUsers) }, corsHeaders(req));
    return;
  }

  sendJSON(res, 404, { error: 'Not found' }, corsHeaders(req));
};
