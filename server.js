// Hearth — chat server: REST for auth/uploads, Socket.IO for everything realtime,
// WebRTC signaling for voice/video, and an optional Claude-powered AI bot.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const AI_MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const AI_ID = 'ai-bot';
const MAX_MESSAGES_PER_CHANNEL = 5000;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------- persistence
let db = { users: {}, sessions: {}, servers: {}, channels: {}, messages: {}, friends: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  console.log('Loaded database from', DB_FILE);
} catch {
  console.log('Starting with a fresh database at', DB_FILE);
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    } catch (e) {
      console.error('Failed to save database:', e);
    }
  }, 1000);
}
function saveNow() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch {}
}
process.on('SIGTERM', () => { saveNow(); process.exit(0); });
process.on('SIGINT', () => { saveNow(); process.exit(0); });

db.users[AI_ID] = {
  id: AI_ID,
  username: 'hearthai',
  displayName: 'Hearth AI',
  bot: true,
  avatar: '/ai-avatar.svg',
  banner: '#7c5cff',
  bio: 'Your built-in AI assistant. Mention @hearthai, type /ai <question>, DM me, or turn on AI auto-reply in a channel.',
  status: 'online',
  customStatus: 'Ask me anything ✨',
  createdAt: db.users[AI_ID]?.createdAt || Date.now(),
};

// ---------------------------------------------------------------- helpers
const newId = () => Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
const inviteCode = () => crypto.randomBytes(5).toString('base64url');
const clamp = (v, n) => String(v ?? '').slice(0, n);
const isHexColor = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const isUpload = v => typeof v === 'string' && /^\/uploads\/[a-z0-9]+(\.[a-z0-9]+)?$/i.test(v);
const STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);
const BANNER_COLORS = ['#7c5cff', '#ff6b6b', '#1abc9c', '#f39c12', '#3498db', '#e84393', '#2ecc71', '#e67e22'];

const online = new Map(); // userId -> number of connected sockets
const voice = new Map(); // channelId -> Map(socketId -> participant state)

function presenceOf(u) {
  if (u.bot) return 'online';
  if (!online.get(u.id)) return 'offline';
  return u.status === 'invisible' ? 'offline' : (u.status || 'online');
}
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, banner: u.banner,
    bio: u.bio, customStatus: u.customStatus, bot: !!u.bot, presence: presenceOf(u), createdAt: u.createdAt,
  };
}
function privateUser(u) {
  return { ...publicUser(u), status: u.status || 'online', settings: u.settings || {} };
}
function friendsOf(uid) {
  return (db.friends[uid] ||= { friends: [], incoming: [], outgoing: [], blocked: [] });
}
function friendsPayload(uid) {
  const f = friendsOf(uid);
  const ids = new Set([...f.friends, ...f.incoming, ...f.outgoing, ...f.blocked]);
  return { ...f, users: [...ids].map(id => publicUser(db.users[id])).filter(Boolean) };
}
function serverPayload(s) {
  const { bans, ...rest } = s;
  return {
    ...rest,
    bans: bans.length,
    channels: s.channels.map(cid => db.channels[cid]).filter(Boolean),
    users: [...s.members, AI_ID].map(id => publicUser(db.users[id])).filter(Boolean),
  };
}
function dmPayload(ch) {
  return { ...ch, users: ch.members.map(id => publicUser(db.users[id])).filter(Boolean) };
}
function canAccess(uid, ch) {
  if (!ch) return false;
  if (ch.serverId) return !!db.servers[ch.serverId]?.members.includes(uid);
  return ch.members.includes(uid);
}
function isAdmin(uid, s) {
  return !!s && (s.ownerId === uid || s.admins.includes(uid));
}
function userServers(uid) {
  return Object.values(db.servers).filter(s => s.members.includes(uid));
}
function userDms(uid) {
  return Object.values(db.channels).filter(c => !c.serverId && c.members.includes(uid));
}
function relatedUserIds(uid) {
  const ids = new Set([uid, AI_ID]);
  for (const s of userServers(uid)) s.members.forEach(m => ids.add(m));
  for (const c of userDms(uid)) c.members.forEach(m => ids.add(m));
  const f = friendsOf(uid);
  [...f.friends, ...f.incoming, ...f.outgoing, ...f.blocked].forEach(m => ids.add(m));
  return ids;
}
function voiceList(cid) {
  const room = voice.get(cid);
  return room ? [...room.entries()].map(([sid, st]) => ({ sid, ...st })) : [];
}
function cleanChannelName(name, type) {
  const n = clamp(name, 40).trim();
  if (type === 'voice') return n || 'Voice';
  return n.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_\p{L}\p{N}\p{Extended_Pictographic}]/gu, '') || 'channel';
}
function makeChannel(serverId, name, type, extra = {}) {
  const ch = { id: newId(), serverId, type, name: cleanChannelName(name, type), topic: '', aiEnabled: false, createdAt: Date.now(), ...extra };
  db.channels[ch.id] = ch;
  return ch;
}

// ---------------------------------------------------------------- express
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Only media types render inline; anything else (html, svg, js…) is forced to download
// so an uploaded file can never run script on this origin.
const INLINE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.mov', '.mp3', '.ogg', '.wav', '.m4a']);
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders(res, p) {
    if (!INLINE_EXT.has(path.extname(p).toLowerCase())) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
}));

function userFromToken(t) {
  const uid = t && db.sessions[t];
  return uid ? db.users[uid] : null;
}
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const u = userFromToken(t);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  req.user = u;
  req.token = t;
  next();
}

const loginAttempts = new Map(); // ip -> { count, reset }
function rateLimitAuth(req, res, next) {
  const now = Date.now();
  const a = loginAttempts.get(req.ip) || { count: 0, reset: now + 15 * 60e3 };
  if (now > a.reset) { a.count = 0; a.reset = now + 15 * 60e3; }
  a.count++;
  loginAttempts.set(req.ip, a);
  if (a.count > 30) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  next();
}

const USERNAME_RE = /^[a-z0-9_.]{2,32}$/;
function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = uid;
  save();
  return token;
}

app.post('/api/register', rateLimitAuth, async (req, res) => {
  const username = clamp(req.body?.username, 64).trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 2–32 characters: letters, numbers, _ or .' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (Object.values(db.users).some(u => u.username === username)) return res.status(409).json({ error: 'That username is taken.' });
  const u = {
    id: newId(), username, displayName: clamp(req.body?.displayName, 32).trim() || username,
    passHash: await bcrypt.hash(password, 10), avatar: null,
    banner: BANNER_COLORS[Math.floor(Math.random() * BANNER_COLORS.length)],
    bio: '', status: 'online', customStatus: '', settings: {}, createdAt: Date.now(),
  };
  db.users[u.id] = u;
  res.json({ token: newSession(u.id) });
});

app.post('/api/login', rateLimitAuth, async (req, res) => {
  const username = clamp(req.body?.username, 64).trim().toLowerCase();
  const u = Object.values(db.users).find(x => x.username === username && !x.bot);
  if (!u || !(await bcrypt.compare(String(req.body?.password || ''), u.passHash))) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  res.json({ token: newSession(u.id) });
});

app.post('/api/logout', auth, (req, res) => {
  delete db.sessions[req.token];
  save();
  res.json({ ok: true });
});

function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map(s => s.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return list;
}

app.get('/api/me', auth, (req, res) => {
  const uid = req.user.id;
  const servers = userServers(uid);
  const dms = userDms(uid);
  const voiceState = {};
  for (const ch of [...servers.flatMap(s => s.channels.map(c => db.channels[c])), ...dms]) {
    if (ch && voice.has(ch.id)) voiceState[ch.id] = voiceList(ch.id);
  }
  res.json({
    user: privateUser(req.user),
    servers: servers.map(serverPayload),
    dms: dms.map(dmPayload),
    friends: friendsPayload(uid),
    users: [...relatedUserIds(uid)].map(id => publicUser(db.users[id])).filter(Boolean),
    voice: voiceState,
    ice: iceServers(),
    features: {
      ai: !!process.env.ANTHROPIC_API_KEY,
      gifs: !!(process.env.GIPHY_API_KEY || process.env.TENOR_API_KEY),
    },
  });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    url: '/uploads/' + req.file.filename,
    name: clamp(req.file.originalname, 200),
    type: clamp(req.file.mimetype, 100),
    size: req.file.size,
  });
});

app.get('/api/gifs', auth, async (req, res) => {
  const q = clamp(req.query.q, 100).trim();
  try {
    if (process.env.GIPHY_API_KEY) {
      const base = q
        ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&`
        : 'https://api.giphy.com/v1/gifs/trending?';
      const r = await fetch(`${base}api_key=${process.env.GIPHY_API_KEY}&limit=30&rating=pg-13`);
      const j = await r.json();
      return res.json((j.data || []).map(g => ({
        id: g.id, title: g.title, preview: g.images?.fixed_width?.url, url: g.images?.original?.url,
      })));
    }
    if (process.env.TENOR_API_KEY) {
      const base = q
        ? `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&`
        : 'https://tenor.googleapis.com/v2/featured?';
      const r = await fetch(`${base}key=${process.env.TENOR_API_KEY}&client_key=hearth&limit=30&media_filter=gif,tinygif`);
      const j = await r.json();
      return res.json((j.results || []).map(g => ({
        id: g.id, title: g.content_description, preview: g.media_formats?.tinygif?.url, url: g.media_formats?.gif?.url,
      })));
    }
    res.json([]);
  } catch (e) {
    console.error('GIF search failed:', e);
    res.status(502).json({ error: 'GIF search failed' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 25 MB.' : err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------------------------------------------------------------- socket.io
const httpServer = http.createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 2e6 });

function emitToChannel(ch, ev, data) {
  if (ch.serverId) io.to('server:' + ch.serverId).emit(ev, data);
  else ch.members.forEach(m => io.to('user:' + m).emit(ev, data));
}
function emitServer(s) {
  io.to('server:' + s.id).emit('server:update', serverPayload(s));
}
function broadcastUser(uid) {
  io.emit('user:update', publicUser(db.users[uid]));
}
function emitVoice(cid) {
  const ch = db.channels[cid];
  if (ch) emitToChannel(ch, 'voice:state', { channelId: cid, participants: voiceList(cid) });
}
function pushMessage(ch, msg) {
  const list = (db.messages[ch.id] ||= []);
  list.push(msg);
  if (list.length > MAX_MESSAGES_PER_CHANNEL) list.splice(0, list.length - MAX_MESSAGES_PER_CHANNEL);
  ch.lastMessageAt = msg.createdAt;
  save();
  emitToChannel(ch, 'message:new', msg);
}
function findMsg(channelId, id) {
  return (db.messages[channelId] || []).find(m => m.id === id);
}
function systemMessage(ch, kind, userId) {
  pushMessage(ch, {
    id: newId(), channelId: ch.id, authorId: userId, system: kind, content: '', createdAt: Date.now(),
    attachments: [], reactions: {},
  });
}
function firstTextChannel(s) {
  return s.channels.map(c => db.channels[c]).find(c => c?.type === 'text');
}

io.use((socket, next) => {
  const u = userFromToken(socket.handshake.auth?.token);
  if (!u) return next(new Error('unauthorized'));
  socket.data.uid = u.id;
  next();
});

io.on('connection', socket => {
  const uid = socket.data.uid;
  const me = () => db.users[uid];
  socket.join('user:' + uid);
  for (const s of userServers(uid)) socket.join('server:' + s.id);
  online.set(uid, (online.get(uid) || 0) + 1);
  if (online.get(uid) === 1) broadcastUser(uid);

  // Every handler replies through the ack callback: a return value, or { error }.
  const on = (ev, fn) => socket.on(ev, async (data, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    try {
      const r = await fn(data && typeof data === 'object' ? data : {});
      ack(r === undefined ? { ok: true } : r);
    } catch (e) {
      if (!e.userFacing) console.error(`[${ev}]`, e);
      ack({ error: e.userFacing ? e.message : 'Something went wrong.' });
    }
  });
  const fail = msg => { const e = new Error(msg); e.userFacing = true; throw e; };
  const getChannel = id => {
    const ch = db.channels[id];
    if (!canAccess(uid, ch)) fail('Channel not found.');
    return ch;
  };
  const getServer = (id, needAdmin) => {
    const s = db.servers[id];
    if (!s || !s.members.includes(uid)) fail('Server not found.');
    if (needAdmin && !isAdmin(uid, s)) fail('You need admin permissions for that.');
    return s;
  };

  // ---------------- messages
  const recentSends = [];
  on('messages:fetch', ({ channelId, before }) => {
    getChannel(channelId);
    const list = db.messages[channelId] || [];
    let end = list.length;
    if (before) {
      const i = list.findIndex(m => m.id === before);
      if (i >= 0) end = i;
    }
    const start = Math.max(0, end - 50);
    return { messages: list.slice(start, end), hasMore: start > 0 };
  });

  on('message:send', async d => {
    const ch = getChannel(d.channelId);
    if (ch.type === 'dm') {
      const other = ch.members.find(m => m !== uid);
      if (other && (friendsOf(other).blocked.includes(uid) || friendsOf(uid).blocked.includes(other))) {
        fail("You can't message this user.");
      }
    }
    const now = Date.now();
    while (recentSends.length && now - recentSends[0] > 5000) recentSends.shift();
    if (recentSends.length >= 8) fail('Slow down! You are sending messages too fast.');
    if (ch.slowmode && !isAdmin(uid, db.servers[ch.serverId])) {
      const last = [...(db.messages[ch.id] || [])].reverse().find(m => m.authorId === uid);
      if (last && now - last.createdAt < ch.slowmode * 1000) fail(`Slowmode is on: wait ${ch.slowmode}s between messages.`);
    }
    recentSends.push(now);

    const content = clamp(d.content, 4000);
    const attachments = (Array.isArray(d.attachments) ? d.attachments : []).slice(0, 10)
      .filter(a => a && isUpload(a.url))
      .map(a => ({ url: a.url, name: clamp(a.name || 'file', 200), type: clamp(a.type, 100), size: Number(a.size) || 0 }));
    const sticker = d.sticker && typeof d.sticker.url === 'string' && (d.sticker.url.startsWith('builtin:') || isUpload(d.sticker.url))
      ? { name: clamp(d.sticker.name || 'sticker', 40), url: clamp(d.sticker.url, 200) } : null;
    const gif = d.gif && typeof d.gif.url === 'string' && /^https:\/\//.test(d.gif.url)
      ? { url: clamp(d.gif.url, 1000), title: clamp(d.gif.title, 200) } : null;
    let poll = null;
    if (d.poll && Array.isArray(d.poll.options)) {
      const options = d.poll.options.map(o => clamp(o, 100).trim()).filter(Boolean).slice(0, 10);
      if (options.length >= 2) poll = { question: clamp(d.poll.question, 300).trim() || 'Poll', options: options.map(text => ({ text, votes: [] })) };
    }
    if (!content.trim() && !attachments.length && !sticker && !gif && !poll) fail('Message is empty.');

    let replyTo = null;
    let replyPreview = null;
    if (d.replyTo) {
      const ref = findMsg(ch.id, d.replyTo);
      if (ref) { replyTo = ref.id; replyPreview = { authorId: ref.authorId, content: clamp(ref.content, 120) || (ref.attachments?.length ? '📎 Attachment' : ref.sticker ? '🖼 Sticker' : ref.gif ? 'GIF' : '') }; }
    }
    const msg = {
      id: newId(), channelId: ch.id, authorId: uid, content, createdAt: now, editedAt: null,
      replyTo, replyPreview, attachments, sticker, gif, poll, reactions: {}, pinned: false,
    };
    pushMessage(ch, msg);
    maybeAiReply(ch, msg);
    return { message: msg };
  });

  on('message:edit', ({ channelId, id, content }) => {
    const ch = getChannel(channelId);
    const m = findMsg(ch.id, id);
    if (!m || m.authorId !== uid) fail("You can only edit your own messages.");
    const text = clamp(content, 4000);
    if (!text.trim() && !m.attachments?.length) fail('Message is empty.');
    m.content = text;
    m.editedAt = Date.now();
    save();
    emitToChannel(ch, 'message:update', m);
  });

  on('message:delete', ({ channelId, id }) => {
    const ch = getChannel(channelId);
    const list = db.messages[ch.id] || [];
    const i = list.findIndex(m => m.id === id);
    if (i < 0) fail('Message not found.');
    if (list[i].authorId !== uid && !isAdmin(uid, db.servers[ch.serverId])) fail("You can't delete that message.");
    list.splice(i, 1);
    save();
    emitToChannel(ch, 'message:delete', { channelId: ch.id, id });
  });

  on('message:react', ({ channelId, id, emoji }) => {
    const ch = getChannel(channelId);
    const m = findMsg(ch.id, id);
    if (!m) fail('Message not found.');
    const e = clamp(emoji, 32);
    if (!e) fail('Bad emoji.');
    const r = (m.reactions ||= {});
    const users = (r[e] ||= []);
    const i = users.indexOf(uid);
    if (i >= 0) users.splice(i, 1);
    else {
      if (Object.keys(r).length >= 20 && users.length === 0) fail('Too many different reactions.');
      users.push(uid);
    }
    if (!users.length) delete r[e];
    save();
    emitToChannel(ch, 'message:update', m);
  });

  on('message:pin', ({ channelId, id }) => {
    const ch = getChannel(channelId);
    if (ch.serverId && !isAdmin(uid, db.servers[ch.serverId])) fail('Only admins can pin messages.');
    const m = findMsg(ch.id, id);
    if (!m) fail('Message not found.');
    m.pinned = !m.pinned;
    save();
    emitToChannel(ch, 'message:update', m);
  });

  on('poll:vote', ({ channelId, id, option }) => {
    const ch = getChannel(channelId);
    const m = findMsg(ch.id, id);
    if (!m?.poll?.options[option]) fail('Poll not found.');
    const had = m.poll.options[option].votes.includes(uid);
    m.poll.options.forEach(o => { o.votes = o.votes.filter(v => v !== uid); });
    if (!had) m.poll.options[option].votes.push(uid);
    save();
    emitToChannel(ch, 'message:update', m);
  });

  on('messages:pins', ({ channelId }) => {
    getChannel(channelId);
    return { messages: (db.messages[channelId] || []).filter(m => m.pinned).reverse() };
  });

  on('messages:search', ({ channelId, serverId, q }) => {
    const query = clamp(q, 100).trim().toLowerCase();
    if (!query) return { messages: [] };
    let channels;
    if (serverId) channels = getServer(serverId).channels.map(c => db.channels[c]).filter(Boolean);
    else channels = [getChannel(channelId)];
    const results = [];
    for (const ch of channels) {
      for (const m of db.messages[ch.id] || []) {
        const author = db.users[m.authorId];
        if (m.content?.toLowerCase().includes(query) || (query.startsWith('from:') && author?.username === query.slice(5))) results.push(m);
      }
    }
    return { messages: results.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50) };
  });

  let lastTyping = 0;
  socket.on('typing', ({ channelId } = {}) => {
    const ch = db.channels[channelId];
    if (!canAccess(uid, ch) || Date.now() - lastTyping < 2000) return;
    lastTyping = Date.now();
    emitToChannel(ch, 'typing', { channelId, userId: uid });
  });

  // ---------------- servers & channels
  on('server:create', ({ name, icon }) => {
    const s = {
      id: newId(), name: clamp(name, 50).trim() || `${me().displayName}'s server`,
      icon: isUpload(icon) ? icon : null, ownerId: uid, members: [uid], admins: [], bans: [],
      invite: inviteCode(), channels: [], stickers: [], createdAt: Date.now(),
    };
    s.channels.push(
      makeChannel(s.id, 'general', 'text', { topic: 'Say hi! 👋' }).id,
      makeChannel(s.id, 'media', 'text', { topic: 'Pictures, GIFs, memes' }).id,
      makeChannel(s.id, 'ask-ai', 'text', { topic: 'Every message here gets an answer from Hearth AI', aiEnabled: true }).id,
      makeChannel(s.id, 'Lounge', 'voice').id,
      makeChannel(s.id, 'Gaming', 'voice').id,
    );
    db.servers[s.id] = s;
    io.in('user:' + uid).socketsJoin('server:' + s.id);
    save();
    return { server: serverPayload(s) };
  });

  on('server:join', ({ invite }) => {
    const code = clamp(invite, 300).trim().split(/[/=]/).pop();
    const s = Object.values(db.servers).find(x => x.invite === code);
    if (!s) fail('That invite is invalid or expired.');
    if (s.bans.includes(uid)) fail('You are banned from this server.');
    if (!s.members.includes(uid)) {
      s.members.push(uid);
      io.in('user:' + uid).socketsJoin('server:' + s.id);
      const ch = firstTextChannel(s);
      if (ch) systemMessage(ch, 'join', uid);
      save();
      emitServer(s);
    }
    return { server: serverPayload(s) };
  });

  on('server:leave', ({ serverId }) => {
    const s = getServer(serverId);
    if (s.ownerId === uid) fail("You own this server — delete it instead (or transfer it first).");
    s.members = s.members.filter(m => m !== uid);
    s.admins = s.admins.filter(m => m !== uid);
    io.in('user:' + uid).socketsLeave('server:' + s.id);
    io.to('user:' + uid).emit('server:remove', { id: s.id });
    const ch = firstTextChannel(s);
    if (ch) systemMessage(ch, 'leave', uid);
    save();
    emitServer(s);
  });

  on('server:update', ({ serverId, name, icon, regenInvite, ownerId }) => {
    const s = getServer(serverId, true);
    if (name !== undefined) s.name = clamp(name, 50).trim() || s.name;
    if (icon !== undefined) s.icon = isUpload(icon) ? icon : null;
    if (regenInvite) s.invite = inviteCode();
    if (ownerId && s.ownerId === uid && s.members.includes(ownerId)) s.ownerId = ownerId;
    save();
    emitServer(s);
  });

  on('server:delete', ({ serverId }) => {
    const s = getServer(serverId);
    if (s.ownerId !== uid) fail('Only the owner can delete the server.');
    for (const cid of s.channels) { delete db.channels[cid]; delete db.messages[cid]; }
    delete db.servers[s.id];
    io.to('server:' + s.id).emit('server:remove', { id: s.id });
    io.in('server:' + s.id).socketsLeave('server:' + s.id);
    save();
  });

  const removeMember = (s, target, ban) => {
    if (target === s.ownerId) fail("You can't remove the owner.");
    if (s.admins.includes(target) && s.ownerId !== uid) fail('Only the owner can remove admins.');
    s.members = s.members.filter(m => m !== target);
    s.admins = s.admins.filter(m => m !== target);
    if (ban && !s.bans.includes(target)) s.bans.push(target);
    io.in('user:' + target).socketsLeave('server:' + s.id);
    io.to('user:' + target).emit('server:remove', { id: s.id, reason: ban ? 'banned' : 'kicked' });
    save();
    emitServer(s);
  };
  on('server:kick', ({ serverId, userId }) => removeMember(getServer(serverId, true), userId, false));
  on('server:ban', ({ serverId, userId }) => removeMember(getServer(serverId, true), userId, true));
  on('server:unbanAll', ({ serverId }) => {
    const s = getServer(serverId, true);
    s.bans = [];
    save();
    emitServer(s);
  });
  on('server:admin', ({ serverId, userId }) => {
    const s = getServer(serverId);
    if (s.ownerId !== uid) fail('Only the owner can change admins.');
    if (!s.members.includes(userId) || userId === uid) fail('Invalid member.');
    s.admins = s.admins.includes(userId) ? s.admins.filter(a => a !== userId) : [...s.admins, userId];
    save();
    emitServer(s);
  });

  on('channel:create', ({ serverId, name, type }) => {
    const s = getServer(serverId, true);
    if (s.channels.length >= 100) fail('Too many channels.');
    const ch = makeChannel(s.id, name, type === 'voice' ? 'voice' : 'text');
    s.channels.push(ch.id);
    save();
    emitServer(s);
    return { channel: ch };
  });

  on('channel:update', ({ channelId, name, topic, aiEnabled, slowmode }) => {
    const ch = getChannel(channelId);
    if (ch.serverId) getServer(ch.serverId, true);
    if (name !== undefined) ch.name = ch.serverId ? cleanChannelName(name, ch.type) : clamp(name, 40);
    if (topic !== undefined) ch.topic = clamp(topic, 300);
    if (aiEnabled !== undefined) ch.aiEnabled = !!aiEnabled;
    if (slowmode !== undefined) ch.slowmode = Math.max(0, Math.min(3600, Number(slowmode) || 0));
    save();
    if (ch.serverId) emitServer(db.servers[ch.serverId]);
    else emitToChannel(ch, 'dm:new', dmPayload(ch));
  });

  on('channel:delete', ({ channelId }) => {
    const ch = getChannel(channelId);
    if (!ch.serverId) fail('Not a server channel.');
    const s = getServer(ch.serverId, true);
    s.channels = s.channels.filter(c => c !== ch.id);
    delete db.channels[ch.id];
    delete db.messages[ch.id];
    save();
    emitServer(s);
  });

  on('channel:move', ({ channelId, dir }) => {
    const ch = getChannel(channelId);
    const s = getServer(ch.serverId, true);
    const i = s.channels.indexOf(ch.id);
    const j = i + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= s.channels.length) return;
    [s.channels[i], s.channels[j]] = [s.channels[j], s.channels[i]];
    save();
    emitServer(s);
  });

  on('sticker:add', ({ serverId, name, url }) => {
    const s = getServer(serverId, true);
    if (!isUpload(url)) fail('Upload an image first.');
    if (s.stickers.length >= 60) fail('Sticker limit reached.');
    s.stickers.push({ id: newId(), name: clamp(name, 30).trim() || 'sticker', url });
    save();
    emitServer(s);
  });
  on('sticker:delete', ({ serverId, id }) => {
    const s = getServer(serverId, true);
    s.stickers = s.stickers.filter(x => x.id !== id);
    save();
    emitServer(s);
  });

  // ---------------- profile & settings
  on('profile:update', d => {
    const u = me();
    if (d.displayName !== undefined) u.displayName = clamp(d.displayName, 32).trim() || u.username;
    if (d.avatar !== undefined) u.avatar = isUpload(d.avatar) ? d.avatar : null;
    if (d.banner !== undefined) u.banner = isHexColor(d.banner) || isUpload(d.banner) ? d.banner : u.banner;
    if (d.bio !== undefined) u.bio = clamp(d.bio, 190);
    if (d.customStatus !== undefined) u.customStatus = clamp(d.customStatus, 80);
    if (d.status !== undefined && STATUSES.has(d.status)) u.status = d.status;
    save();
    broadcastUser(uid);
    io.to('user:' + uid).emit('me:update', privateUser(u));
  });

  on('settings:update', ({ settings }) => {
    const json = JSON.stringify(settings || {});
    if (json.length > 8000) fail('Settings too large.');
    me().settings = JSON.parse(json);
    save();
    socket.to('user:' + uid).emit('me:update', privateUser(me()));
  });

  on('account:password', async ({ oldPassword, newPassword }) => {
    const u = me();
    if (!(await bcrypt.compare(String(oldPassword || ''), u.passHash))) fail('Current password is wrong.');
    if (String(newPassword || '').length < 6) fail('New password must be at least 6 characters.');
    u.passHash = await bcrypt.hash(String(newPassword), 10);
    save();
  });

  on('account:username', ({ username }) => {
    const name = clamp(username, 64).trim().toLowerCase();
    if (!USERNAME_RE.test(name)) fail('Username must be 2–32 characters: letters, numbers, _ or .');
    if (Object.values(db.users).some(u => u.username === name && u.id !== uid)) fail('That username is taken.');
    me().username = name;
    save();
    broadcastUser(uid);
    io.to('user:' + uid).emit('me:update', privateUser(me()));
  });

  // ---------------- friends & DMs
  const pushFriends = (...ids) => ids.forEach(id => io.to('user:' + id).emit('friends:update', friendsPayload(id)));
  const unlink = (a, b) => {
    const fa = friendsOf(a), fb = friendsOf(b);
    for (const k of ['friends', 'incoming', 'outgoing']) {
      fa[k] = fa[k].filter(x => x !== b);
      fb[k] = fb[k].filter(x => x !== a);
    }
  };

  on('friend:request', ({ username }) => {
    const name = clamp(username, 64).trim().toLowerCase().replace(/^@/, '');
    const other = Object.values(db.users).find(u => u.username === name);
    if (!other || other.bot) fail("Couldn't find a user with that username.");
    if (other.id === uid) fail("You can't friend yourself.");
    const mine = friendsOf(uid), theirs = friendsOf(other.id);
    if (theirs.blocked.includes(uid)) fail("Couldn't send a request to that user.");
    if (mine.friends.includes(other.id)) fail("You're already friends.");
    mine.blocked = mine.blocked.filter(x => x !== other.id);
    if (mine.incoming.includes(other.id)) {
      unlink(uid, other.id);
      mine.friends.push(other.id);
      theirs.friends.push(uid);
    } else if (!mine.outgoing.includes(other.id)) {
      mine.outgoing.push(other.id);
      theirs.incoming.push(uid);
    }
    save();
    pushFriends(uid, other.id);
  });

  on('friend:accept', ({ userId }) => {
    const mine = friendsOf(uid);
    if (!mine.incoming.includes(userId)) fail('No pending request.');
    unlink(uid, userId);
    mine.friends.push(userId);
    friendsOf(userId).friends.push(uid);
    save();
    pushFriends(uid, userId);
  });

  on('friend:remove', ({ userId }) => {
    unlink(uid, userId);
    save();
    pushFriends(uid, userId);
  });

  on('friend:block', ({ userId }) => {
    if (!db.users[userId] || userId === uid) fail('Invalid user.');
    unlink(uid, userId);
    const mine = friendsOf(uid);
    if (!mine.blocked.includes(userId)) mine.blocked.push(userId);
    save();
    pushFriends(uid, userId);
  });

  on('friend:unblock', ({ userId }) => {
    const mine = friendsOf(uid);
    mine.blocked = mine.blocked.filter(x => x !== userId);
    save();
    pushFriends(uid);
  });

  on('dm:open', ({ userId }) => {
    if (!db.users[userId] || userId === uid) fail('User not found.');
    let ch = Object.values(db.channels).find(c => c.type === 'dm' && c.members.length === 2 && c.members.includes(uid) && c.members.includes(userId));
    if (!ch) {
      ch = { id: newId(), type: 'dm', serverId: null, members: [uid, userId], createdAt: Date.now() };
      db.channels[ch.id] = ch;
      save();
      emitToChannel(ch, 'dm:new', dmPayload(ch));
    }
    return { channel: dmPayload(ch) };
  });

  on('group:create', ({ userIds, name }) => {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).filter(id => db.users[id] && id !== uid))].slice(0, 9);
    if (!ids.length) fail('Pick at least one person.');
    const ch = { id: newId(), type: 'group', serverId: null, name: clamp(name, 40).trim(), ownerId: uid, members: [uid, ...ids], createdAt: Date.now() };
    db.channels[ch.id] = ch;
    save();
    emitToChannel(ch, 'dm:new', dmPayload(ch));
    return { channel: dmPayload(ch) };
  });

  on('group:add', ({ channelId, userId }) => {
    const ch = getChannel(channelId);
    if (ch.type !== 'group' || !db.users[userId]) fail('Invalid.');
    if (ch.members.length >= 10) fail('Group DMs are limited to 10 people.');
    if (!ch.members.includes(userId)) ch.members.push(userId);
    save();
    emitToChannel(ch, 'dm:new', dmPayload(ch));
  });

  on('group:leave', ({ channelId }) => {
    const ch = getChannel(channelId);
    if (ch.type !== 'group') fail('Not a group.');
    ch.members = ch.members.filter(m => m !== uid);
    io.to('user:' + uid).emit('dm:remove', { id: ch.id });
    if (!ch.members.length) { delete db.channels[ch.id]; delete db.messages[ch.id]; }
    else emitToChannel(ch, 'dm:new', dmPayload(ch));
    save();
  });

  // ---------------- calls (DM ringing)
  on('call:ring', ({ channelId }) => {
    const ch = getChannel(channelId);
    if (ch.serverId) fail('Not a DM.');
    ch.members.filter(m => m !== uid).forEach(m => io.to('user:' + m).emit('call:incoming', { channelId: ch.id, from: uid }));
  });
  on('call:decline', ({ channelId }) => {
    const ch = getChannel(channelId);
    ch.members.filter(m => m !== uid).forEach(m => io.to('user:' + m).emit('call:declined', { channelId: ch.id, by: uid }));
  });

  // ---------------- voice / video (WebRTC mesh signaling)
  const leaveVoice = () => {
    const cid = socket.data.voice;
    if (!cid) return;
    const room = voice.get(cid);
    room?.delete(socket.id);
    if (room && !room.size) voice.delete(cid);
    socket.data.voice = null;
    socket.leave('voice:' + cid);
    io.to('voice:' + cid).emit('voice:peer-left', { sid: socket.id });
    emitVoice(cid);
  };

  on('voice:join', ({ channelId, muted, deafened }) => {
    const ch = getChannel(channelId);
    if (ch.serverId && ch.type !== 'voice') fail('Not a voice channel.');
    leaveVoice();
    const peers = voiceList(ch.id);
    if (peers.length >= 16) fail('This call is full (16 people max).');
    if (!voice.has(ch.id)) voice.set(ch.id, new Map());
    voice.get(ch.id).set(socket.id, { userId: uid, muted: !!muted, deafened: !!deafened, video: false, screen: false, joinedAt: Date.now() });
    socket.data.voice = ch.id;
    socket.join('voice:' + ch.id);
    emitVoice(ch.id);
    return { self: socket.id, peers };
  });

  on('voice:leave', () => leaveVoice());

  on('voice:update', d => {
    const cid = socket.data.voice;
    const st = cid && voice.get(cid)?.get(socket.id);
    if (!st) return;
    for (const k of ['muted', 'deafened', 'video', 'screen']) if (d[k] !== undefined) st[k] = !!d[k];
    emitVoice(cid);
  });

  socket.on('rtc:signal', ({ to, data } = {}) => {
    const target = io.sockets.sockets.get(to);
    if (!socket.data.voice || !target || target.data.voice !== socket.data.voice) return;
    target.emit('rtc:signal', { from: socket.id, userId: uid, data });
  });

  socket.on('disconnect', () => {
    leaveVoice();
    const n = (online.get(uid) || 1) - 1;
    if (n <= 0) { online.delete(uid); broadcastUser(uid); }
    else online.set(uid, n);
  });
});

// ---------------------------------------------------------------- AI bot
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const aiBusy = new Set();

function postBot(ch, content, replyTo) {
  const ref = replyTo && findMsg(ch.id, replyTo);
  pushMessage(ch, {
    id: newId(), channelId: ch.id, authorId: AI_ID, content: clamp(content, 4000), createdAt: Date.now(), editedAt: null,
    replyTo: ref ? ref.id : null,
    replyPreview: ref ? { authorId: ref.authorId, content: clamp(ref.content, 120) } : null,
    attachments: [], reactions: {}, pinned: false,
  });
}

function describeForAi(m) {
  const name = db.users[m.authorId]?.displayName || 'Someone';
  if (m.system) return `[${name} ${m.system === 'join' ? 'joined the server' : 'left the server'}]`;
  let text = (m.content || '').replace(/^\/ai\s+/i, '');
  if (m.attachments?.length) text += ` [attached: ${m.attachments.map(a => a.name).join(', ')}]`;
  if (m.sticker) text += ` [sent a sticker: ${m.sticker.name}]`;
  if (m.gif) text += ` [sent a GIF${m.gif.title ? ': ' + m.gif.title : ''}]`;
  if (m.poll) text += ` [started a poll: ${m.poll.question} — ${m.poll.options.map(o => o.text).join(' / ')}]`;
  return m.authorId === AI_ID ? text : `${name}: ${text}`;
}

function imageBlocks(m) {
  const blocks = [];
  for (const a of m.attachments || []) {
    const ext = path.extname(a.url).toLowerCase();
    const mediaType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
    if (!mediaType || a.size > 5 * 1024 * 1024) continue;
    try {
      const data = fs.readFileSync(path.join(UPLOAD_DIR, path.basename(a.url))).toString('base64');
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    } catch {}
  }
  return blocks.slice(0, 4);
}

async function maybeAiReply(ch, msg) {
  if (msg.authorId === AI_ID) return;
  const text = msg.content || '';
  const dmWithAi = !ch.serverId && ch.members.includes(AI_ID);
  if (!(dmWithAi || ch.aiEnabled || /^\/ai\s+/i.test(text) || /@hearthai\b/i.test(text))) return;
  if (!anthropic) {
    postBot(ch, "I'm not switched on yet — whoever runs this Hearth site needs to set the `ANTHROPIC_API_KEY` environment variable.", msg.id);
    return;
  }
  if (aiBusy.has(ch.id)) return;
  aiBusy.add(ch.id);
  const typingTimer = setInterval(() => emitToChannel(ch, 'typing', { channelId: ch.id, userId: AI_ID }), 3000);
  emitToChannel(ch, 'typing', { channelId: ch.id, userId: AI_ID });
  try {
    // Turn recent history into alternating user/assistant turns (consecutive human messages merge).
    const history = (db.messages[ch.id] || []).slice(-30);
    const messages = [];
    for (const m of history) {
      const role = m.authorId === AI_ID ? 'assistant' : 'user';
      const line = describeForAi(m);
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content[0].text += '\n' + line;
      else messages.push({ role, content: [{ type: 'text', text: line }] });
    }
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== 'user') return;
    messages[messages.length - 1].content.unshift(...imageBlocks(msg));

    const s = ch.serverId && db.servers[ch.serverId];
    const where = s
      ? `the #${ch.name} channel of the "${s.name}" server${ch.topic ? ` (topic: ${ch.topic})` : ''}`
      : 'a private conversation';
    const res = await anthropic.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system:
        `You are Hearth AI, a friendly, witty assistant living inside Hearth, a group chat app. You are in ${where}. ` +
        'Each user line is prefixed with the speaker\'s display name. Reply like a helpful person in a chat: ' +
        'usually short (a few sentences), longer only when someone asks for detail or code. ' +
        'Markdown works: **bold**, *italics*, `code`, ``` code blocks ```, > quotes, ||spoilers||. ' +
        'Never prefix your reply with your own name.',
      messages,
    });
    if (res.stop_reason === 'refusal') {
      postBot(ch, "Sorry, I can't help with that one.", msg.id);
    } else {
      const reply = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      postBot(ch, reply || '🤔', msg.id);
    }
  } catch (e) {
    console.error('AI reply failed:', e);
    let note = 'Something went wrong talking to the AI. Try again in a bit.';
    if (e instanceof Anthropic.AuthenticationError) note = 'The AI API key on this server is invalid.';
    else if (e instanceof Anthropic.RateLimitError) note = "I'm getting too many requests right now — try again in a minute.";
    else if (e instanceof Anthropic.BadRequestError) note = `The AI request was rejected: ${e.message}`;
    postBot(ch, note, msg.id);
  } finally {
    clearInterval(typingTimer);
    aiBusy.delete(ch.id);
  }
}

httpServer.listen(PORT, () => {
  console.log(`Hearth is running on http://localhost:${PORT}`);
  if (!anthropic) console.log('AI bot disabled: set ANTHROPIC_API_KEY to enable it.');
});
