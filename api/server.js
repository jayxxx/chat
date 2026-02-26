const crypto = require('crypto');

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
    sendJSON(res, 401, { error: 'Unauthorized' }, corsHeaders(req));
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
      const sid = crypto.randomUUID();
      sessions.set(sid, { username, createdAt: Date.now() });
      sendJSON(res, 200, { ok: true, username }, {
        ...corsHeaders(req),
        'Set-Cookie': `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/`,
      });
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid request' }, corsHeaders(req));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/logout') {
    const cookies = parseCookies(req);
    const sid = cookies.sid;
    if (sid) sessions.delete(sid);
    sendJSON(res, 200, { ok: true }, {
      ...corsHeaders(req),
      'Set-Cookie': `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/users') {
    const session = requireSession(req, res);
    if (!session) return;
    const list = Array.from(users.keys());
    sendJSON(res, 200, { users: list }, corsHeaders(req));
    return;
  }

  if (req.method === 'GET' && pathname === '/stream') {
    const session = requireSession(req, res);
    if (!session) return;
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

  sendJSON(res, 404, { error: 'Not found' }, corsHeaders(req));
};
