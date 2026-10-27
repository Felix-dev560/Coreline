'use strict';

/**
 * Ringline server
 * - Express serves the static client and a small JSON API (accounts, user list, ICE config).
 * - A WebSocket endpoint (/ws) does call signaling only. Audio never touches this server;
 *   it flows peer to peer over WebRTC (or through your TURN relay if you configure one).
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { parse: parseCookie } = require('cookie');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'ringline.db');
const SESSION_COOKIE = 'ringline_session';
const SESSION_DAYS = 7;
const RING_TIMEOUT_MS = 40_000; // how long a call rings before it is marked unanswered
const BCRYPT_ROUNDS = 12;

let JWT_SECRET = process.env.JWT_SECRET || '';
if (JWT_SECRET.length < 32) {
  if (isProd) {
    console.error('JWT_SECRET must be set to at least 32 characters when NODE_ENV=production.');
    process.exit(1);
  }
  // Development only: a random secret means sessions reset on every restart.
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[dev] JWT_SECRET missing or short. Using a temporary secret.');
}

const COOKIE_SECURE =
  process.env.COOKIE_SECURE === undefined || process.env.COOKIE_SECURE === ''
    ? isProd
    : process.env.COOKIE_SECURE === 'true';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Prepared statements are parameterized, so user input is never concatenated into SQL.
const stmts = {
  byName: db.prepare('SELECT username, password_hash FROM users WHERE username = ?'),
  exists: db.prepare('SELECT 1 FROM users WHERE username = ?'),
  insert: db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)'),
  search: db.prepare(
    `SELECT username FROM users
     WHERE username != @me AND username LIKE @pattern ESCAPE '\\'
     ORDER BY username LIMIT 200`
  ),
};

// Compared against when the username does not exist, so "unknown user" and
// "wrong password" take about the same time and reveal nothing.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

function cleanUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** bcrypt only reads the first 72 bytes, so reject longer input instead of silently truncating. */
function passwordProblem(value) {
  if (typeof value !== 'string') return 'Enter a password.';
  if (value.length < 8) return 'Password must be at least 8 characters.';
  if (Buffer.byteLength(value, 'utf8') > 72) return 'Password is too long. Use 72 bytes or fewer.';
  return null;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

function signSession(username) {
  return jwt.sign({ sub: username }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${SESSION_DAYS}d`,
  });
}

/** Returns the username if the token is valid and the account still exists, else null. */
function readSession(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const name = cleanUsername(payload.sub);
    return name && stmts.exists.get(name) ? name : null;
  } catch {
    return null;
  }
}

function setSessionCookie(res, username) {
  res.cookie(SESSION_COOKIE, signSession(username), {
    httpOnly: true, // not readable by page scripts
    sameSite: 'strict', // not sent on cross-site requests, which blocks CSRF
    secure: COOKIE_SECURE,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

/* ------------------------------------------------------------------ */
/* Express app                                                         */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 0);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:'],
        'media-src': ["'self'", 'blob:'],
        // Some browsers do not treat 'self' as covering ws://, so list the schemes.
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'frame-ancestors': ["'none'"],
        // Lets you test over plain http on localhost. Real hosting should use https anyway.
        'upgrade-insecure-requests': isProd ? [] : null,
      },
    },
  })
);

// helmet does not set Permissions-Policy. Allow the microphone for this site only.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '2kb' }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Wait a few minutes and try again.' },
});

function requireAuth(req, res, next) {
  const username = readSession(req.cookies[SESSION_COOKIE]);
  if (!username) return res.status(401).json({ error: 'Please sign in.' });
  req.username = username;
  next();
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const username = cleanUsername(req.body?.username);
    const password = req.body?.password;

    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({
        error: 'Username must be 3 to 20 characters: letters, numbers or underscore.',
      });
    }
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    try {
      stmts.insert.run(username, hash);
    } catch (err) {
      if (err && String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: 'That username is taken. Try another one.' });
      }
      throw err;
    }
    setSessionCookie(res, username);
    res.status(201).json({ username });
  } catch (err) {
    console.error('register failed:', err);
    res.status(500).json({ error: 'Could not create the account. Try again.' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const username = cleanUsername(req.body?.username);
    const password = req.body?.password;
    if (!username || typeof password !== 'string' || password.length > 200) {
      return res.status(400).json({ error: 'Enter your username and password.' });
    }
    const row = stmts.byName.get(username);
    const ok = await bcrypt.compare(password, row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) return res.status(401).json({ error: 'Wrong username or password.' });

    setSessionCookie(res, row.username);
    res.json({ username: row.username });
  } catch (err) {
    console.error('login failed:', err);
    res.status(500).json({ error: 'Could not sign in. Try again.' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ username: req.username }));

app.get('/api/users', requireAuth, (req, res) => {
  try {
    // Keep only characters a username can contain, then escape "_" because it is a LIKE wildcard.
    const q = String(req.query.q ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 20)
      .replace(/_/g, '\\_');
    const rows = stmts.search.all({ me: req.username, pattern: `%${q}%` });
    res.json({ users: rows.map((r) => r.username) });
  } catch (err) {
    console.error('user list failed:', err);
    res.status(500).json({ error: 'Could not load users.' });
  }
});

/**
 * ICE servers for WebRTC. STUN is free and works for most home networks.
 * TURN relays audio when two networks cannot connect directly.
 * TURN_SECRET follows coturn's "use-auth-secret" REST scheme: username = "<expiry>:<user>",
 * credential = base64(HMAC-SHA1(secret, username)). Credentials expire after 12 hours.
 */
app.get('/api/ice', requireAuth, (req, res) => {
  const stun = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const iceServers = [];
  if (stun.length) iceServers.push({ urls: stun });

  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (turnUrls.length) {
    if (process.env.TURN_SECRET) {
      const expiry = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
      const username = `${expiry}:${req.username}`;
      const credential = crypto
        .createHmac('sha1', process.env.TURN_SECRET)
        .update(username)
        .digest('base64');
      iceServers.push({ urls: turnUrls, username, credential });
    } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      iceServers.push({
        urls: turnUrls,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      });
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ iceServers });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));

// Unknown API routes get JSON, not the HTML page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Last-resort error handler (for example, malformed JSON bodies).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large.' });
  }
  console.error('unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

/* ------------------------------------------------------------------ */
/* WebSocket signaling                                                 */
/* ------------------------------------------------------------------ */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

/** username -> live socket. One socket per user keeps call state simple. */
const sockets = new Map();

const MSG_WINDOW_MS = 10_000;
const MSG_LIMIT = 300; // ICE candidates arrive in bursts, so this is generous

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastPresence(username, online) {
  const payload = JSON.stringify({ type: 'presence', username, online });
  for (const ws of sockets.values()) {
    if (ws.user !== username && ws.readyState === ws.OPEN) ws.send(payload);
  }
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false; // browsers always send Origin on WebSocket upgrades
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, code) {
  socket.write(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws') return rejectUpgrade(socket, 404);
    if (!originAllowed(req)) return rejectUpgrade(socket, 403);

    const cookies = parseCookie(req.headers.cookie || '');
    const username = readSession(cookies[SESSION_COOKIE]);
    if (!username) return rejectUpgrade(socket, 401);

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = username;
      wss.emit('connection', ws, req);
    });
  } catch {
    rejectUpgrade(socket, 400);
  }
});

/* Call state lives on each socket: state is idle | calling | ringing | active, peer is a username. */

function resetCall(ws) {
  clearTimeout(ws.ringTimer);
  ws.ringTimer = null;
  ws.peer = null;
  ws.state = 'idle';
}

/**
 * Ends the call that `ws` is in and tells the other side what happened.
 * `type` is the message the other side receives: cancelled | declined | ended | missed.
 */
function endCallFor(ws, type) {
  if (!ws.peer) return resetCall(ws);
  const other = sockets.get(ws.peer);
  const wasPeered = other && other.peer === ws.user;
  resetCall(ws);
  if (wasPeered) {
    resetCall(other);
    send(other, { type, from: ws.user });
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Checks that a relayed WebRTC payload has the expected shape and size before it is forwarded. */
function validSignal(kind, payload) {
  if (!isPlainObject(payload)) return false;
  if (kind === 'offer' || kind === 'answer') {
    return payload.type === kind && typeof payload.sdp === 'string' && payload.sdp.length < 24_000;
  }
  if (kind === 'candidate') {
    return typeof payload.candidate === 'string' && payload.candidate.length < 2_000;
  }
  return false;
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'call': {
      const to = cleanUsername(msg.to);
      if (ws.state !== 'idle') return send(ws, { type: 'call-failed', reason: 'busy-self' });
      if (!USERNAME_RE.test(to) || to === ws.user) return send(ws, { type: 'call-failed', reason: 'invalid' });

      const target = sockets.get(to);
      if (!target) return send(ws, { type: 'call-failed', reason: 'offline', to });
      if (target.state !== 'idle') return send(ws, { type: 'call-failed', reason: 'busy', to });

      ws.state = 'calling';
      ws.peer = to;
      target.state = 'ringing';
      target.peer = ws.user;
      send(target, { type: 'incoming', from: ws.user });

      // If nobody answers in time, stop ringing on both ends.
      ws.ringTimer = setTimeout(() => {
        if (ws.state !== 'calling') return;
        const callee = sockets.get(to);
        const name = ws.peer;
        resetCall(ws);
        send(ws, { type: 'call-failed', reason: 'no-answer', to: name });
        if (callee && callee.peer === ws.user) {
          resetCall(callee);
          send(callee, { type: 'missed', from: ws.user });
        }
      }, RING_TIMEOUT_MS);
      return;
    }

    case 'accept': {
      if (ws.state !== 'ringing') return;
      const caller = sockets.get(ws.peer);
      if (!caller || caller.state !== 'calling' || caller.peer !== ws.user) {
        resetCall(ws);
        return send(ws, { type: 'cancelled', from: ws.peer });
      }
      clearTimeout(caller.ringTimer);
      caller.ringTimer = null;
      caller.state = 'active';
      ws.state = 'active';
      send(caller, { type: 'accepted', from: ws.user });
      return;
    }

    case 'end': {
      // One message covers cancel (caller), decline (callee) and hang up (either side).
      const typeFor = { calling: 'cancelled', ringing: 'declined', active: 'ended' };
      if (ws.state === 'idle') return;
      endCallFor(ws, typeFor[ws.state]);
      return;
    }

    case 'signal': {
      if (ws.state !== 'active') return;
      const other = sockets.get(ws.peer);
      if (!other || other.state !== 'active' || other.peer !== ws.user) return;
      if (!validSignal(msg.kind, msg.payload)) return;
      send(other, { type: 'signal', kind: msg.kind, payload: msg.payload });
      return;
    }

    default:
      return;
  }
}

wss.on('connection', (ws) => {
  ws.state = 'idle';
  ws.peer = null;
  ws.ringTimer = null;
  ws.isAlive = true;
  ws.windowStart = Date.now();
  ws.windowCount = 0;

  // A second tab or device replaces the first so a user is only ever in one place.
  const existing = sockets.get(ws.user);
  if (existing) {
    endCallFor(existing, 'ended');
    existing.close(4000, 'Signed in somewhere else');
  }
  sockets.set(ws.user, ws);

  send(ws, { type: 'ready', online: [...sockets.keys()].filter((n) => n !== ws.user) });
  broadcastPresence(ws.user, true);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;

    const now = Date.now();
    if (now - ws.windowStart > MSG_WINDOW_MS) {
      ws.windowStart = now;
      ws.windowCount = 0;
    }
    if (++ws.windowCount > MSG_LIMIT) return ws.close(1008, 'Too many messages');

    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (!isPlainObject(msg) || typeof msg.type !== 'string') return;

    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('signaling error:', err);
    }
  });

  ws.on('close', () => {
    endCallFor(ws, 'ended');
    // A replaced socket must not remove the newer one from the map.
    if (sockets.get(ws.user) === ws) {
      sockets.delete(ws.user);
      broadcastPresence(ws.user, false);
    }
  });

  ws.on('error', (err) => console.error('socket error:', err.message));
});

// Ping every 30 seconds. A client that does not answer by the next round is dropped,
// which also frees its call and flips it to offline for everyone else.
const heartbeat = setInterval(() => {
  for (const ws of sockets.values()) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

/* ------------------------------------------------------------------ */
/* Start and shut down                                                 */
/* ------------------------------------------------------------------ */

server.listen(PORT, () => {
  console.log(`Ringline listening on port ${PORT} (${isProd ? 'production' : 'development'})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
