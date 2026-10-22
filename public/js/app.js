'use strict';
// Core client: boot, socket events, navigation, rendering and the message composer.

const currentChannel = () => S.channels[S.view.channelId] || null;
const currentServer = () => S.servers[S.view.serverId] || null;
const isAdminOf = s => !!s && (s.ownerId === S.me.id || s.admins.includes(S.me.id));

// ---------------------------------------------------------------- render scheduling
const dirty = new Set();
let rafId = 0;
function schedule(...parts) {
  parts.forEach(p => dirty.add(p));
  if (!rafId) rafId = requestAnimationFrame(flush);
}
function flush() {
  rafId = 0;
  if (!S.me || !$('.layout')) { dirty.clear(); return; }
  const d = new Set(dirty);
  dirty.clear();
  if (d.has('rail')) renderRail();
  if (d.has('side')) renderSidebar();
  if (d.has('main')) renderMain();
  else {
    if (d.has('header')) renderHeader();
    if (d.has('messages')) renderMessages();
    if (d.has('stage')) renderStage();
    if (d.has('typing')) renderTyping();
    if (d.has('friends') && !currentChannel()) renderMain();
  }
  if (d.has('members') || d.has('main')) renderMembers();
  updateTitle();
}

// ---------------------------------------------------------------- data ingestion
function addUser(u) { if (u) S.users[u.id] = { ...(S.users[u.id] || {}), ...u }; }
function indexChannels() {
  S.channels = {};
  for (const s of Object.values(S.servers)) for (const c of s.channels) S.channels[c.id] = c;
  for (const c of Object.values(S.dms)) S.channels[c.id] = c;
}
function addServer(s) {
  (s.users || []).forEach(addUser);
  S.servers[s.id] = s;
  indexChannels();
}
function addDm(c) {
  (c.users || []).forEach(addUser);
  S.dms[c.id] = c;
  indexChannels();
}
function setFriends(f) {
  (f.users || []).forEach(addUser);
  S.friends = f;
}
function ingest(d) {
  S.me = d.user;
  addUser(d.user);
  d.users.forEach(addUser);
  S.servers = {};
  d.servers.forEach(s => { (s.users || []).forEach(addUser); S.servers[s.id] = s; });
  S.dms = {};
  d.dms.forEach(c => { (c.users || []).forEach(addUser); S.dms[c.id] = c; });
  indexChannels();
  setFriends(d.friends);
  S.voice = d.voice || {};
  S.ice = d.ice;
  S.features = d.features;
  if (d.user.settings && Object.keys(d.user.settings).length) prefs = { ...DEFAULT_PREFS, ...d.user.settings };
  store.set('hearth.prefs', prefs);
  applyPrefs();
}

// ---------------------------------------------------------------- auth screen
function renderAuth(mode = 'login') {
  $('#app').innerHTML = `<div class="auth-wrap"><form class="auth-card" id="auth-form">
    <img class="auth-logo" src="/favicon.svg" alt="">
    <h1>${mode === 'login' ? 'Welcome back!' : 'Create an account'}</h1>
    <p class="sub">${mode === 'login' ? "We're so excited to see you again!" : 'Join your friends on Hearth — it takes 10 seconds.'}</p>
    ${mode === 'register' ? '<label class="field"><span>Display name</span><input name="displayName" maxlength="32" autocomplete="nickname" placeholder="What everyone sees"></label>' : ''}
    <label class="field"><span>Username</span><input name="username" required maxlength="32" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
    <label class="field"><span>Password</span><input name="password" type="password" required minlength="6" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>
    <div class="error-text" id="auth-err"></div>
    <button class="btn block" type="submit">${mode === 'login' ? 'Log In' : 'Continue'}</button>
    <p class="muted" style="margin:12px 0 0;font-size:14px">${mode === 'login' ? 'Need an account?' : 'Already have an account?'}
      <button type="button" class="btn link" id="auth-switch">${mode === 'login' ? 'Register' : 'Log in'}</button></p>
  </form></div>`;
  $('#auth-switch').onclick = () => renderAuth(mode === 'login' ? 'register' : 'login');
  $('#auth-form').onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api(mode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body: JSON.stringify(body) });
      S.token = r.token;
      store.set('hearth.token', r.token);
      boot();
    } catch (err) {
      $('#auth-err').textContent = err.message;
      btn.disabled = false;
    }
  };
  $('#auth-form input').focus();
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  store.del('hearth.token');
  location.href = '/';
}

// ---------------------------------------------------------------- boot & socket
async function boot() {
  applyPrefs();
  if (!S.token) return renderAuth();
  let d;
  try {
    d = await api('/api/me');
  } catch (e) {
    if (e.status === 401) { store.del('hearth.token'); S.token = null; return renderAuth(); }
    $('#app').innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>Can't reach Hearth</h1><p class="sub">${esc(e.message)}</p><button class="btn block" onclick="location.reload()">Retry</button></div></div>`;
    return;
  }
  ingest(d);
  $('#app').innerHTML = `<div class="layout ${prefs.showMembers ? '' : ''}"><nav class="rail"></nav><aside class="sidebar"></aside><main class="main"></main><aside class="members"></aside></div>`;
  connectSocket();
  const saved = store.get('hearth.view', {});
  if (saved.channelId && S.channels[saved.channelId]) go(saved.serverId, saved.channelId);
  else go(null, null);
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) {
    history.replaceState(null, '', '/');
    joinByInvite(invite);
  }
  if (prefs.notif && 'Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => Notification.requestPermission().catch(() => {}), { once: true });
  }
}

function connectSocket() {
  socket = io({ auth: { token: S.token } });
  let first = true;
  socket.on('connect', async () => {
    S.connected = true;
    if (!first) {
      try {
        const d = await api('/api/me');
        ingest(d);
        S.messages = {};
        if (S.view.channelId && S.channels[S.view.channelId]) loadMessages(S.view.channelId);
      } catch {}
      schedule('rail', 'side', 'main');
    }
    first = false;
    renderOfflineBar();
  });
  socket.on('connect_error', err => { if (err.message === 'unauthorized') logout(); });
  socket.on('disconnect', () => {
    S.connected = false;
    if (V.channelId) { cleanupVoice(); toast('Disconnected from voice.', true); }
    renderOfflineBar();
  });

  socket.on('message:new', m => {
    const list = S.messages[m.channelId];
    if (list && !list.some(x => x.id === m.id)) list.push(m);
    if (S.typing[m.channelId]) delete S.typing[m.channelId][m.authorId];
    const ch = S.channels[m.channelId];
    if (ch && !ch.serverId) ch.lastMessageAt = m.createdAt;
    const viewing = S.view.channelId === m.channelId;
    const mine = m.authorId === S.me.id;
    if (viewing) {
      if (mine) S.stickBottom = true;
      schedule('messages', 'typing');
    }
    if (!mine && !m.system) {
      const mentioned = mentionsMe(m);
      if (!viewing || document.hidden) {
        if (!viewing) {
          S.unread[m.channelId] = true;
          if (mentioned || (ch && !ch.serverId)) S.mentions[m.channelId] = (S.mentions[m.channelId] || 0) + 1;
        }
        if (mentioned || (ch && !ch.serverId)) {
          sound('message');
          const a = user(m.authorId);
          notify(ch?.serverId ? `${a.displayName} (#${ch.name})` : a.displayName, m.content || (m.attachments?.length ? 'Sent an attachment' : m.sticker ? 'Sent a sticker' : m.gif ? 'Sent a GIF' : 'New message'), a.avatar, m.channelId);
        }
      }
      schedule('rail', 'side');
    } else if (ch && !ch.serverId) schedule('side');
  });
  socket.on('message:update', m => {
    const list = S.messages[m.channelId];
    const i = list ? list.findIndex(x => x.id === m.id) : -1;
    if (i >= 0) list[i] = m;
    if (S.view.channelId === m.channelId) schedule('messages');
  });
  socket.on('message:delete', ({ channelId, id }) => {
    const list = S.messages[channelId];
    if (list) S.messages[channelId] = list.filter(x => x.id !== id);
    if (S.view.channelId === channelId) schedule('messages');
  });
  socket.on('typing', ({ channelId, userId }) => {
    if (userId === S.me.id) return;
    (S.typing[channelId] ||= {})[userId] = Date.now() + 6000;
    if (S.view.channelId === channelId) schedule('typing');
  });
  socket.on('user:update', u => {
    if (!S.users[u.id] && u.id !== S.me.id) return;
    addUser(u);
    schedule('side', 'members', 'header');
    if (!currentChannel()) schedule('friends');
  });
  socket.on('me:update', u => {
    const settingsChanged = JSON.stringify(u.settings || {}) !== JSON.stringify(S.me.settings || {});
    S.me = u;
    addUser(u);
    if (settingsChanged && Object.keys(u.settings || {}).length) {
      prefs = { ...DEFAULT_PREFS, ...u.settings };
      store.set('hearth.prefs', prefs);
      applyPrefs();
    }
    schedule('side');
  });
  socket.on('server:update', s => { addServer(s); schedule('rail', 'side', 'header', 'members'); });
  socket.on('server:remove', ({ id, reason }) => {
    const s = S.servers[id];
    delete S.servers[id];
    indexChannels();
    if (reason && s) toast(`You were ${reason} from ${s.name}.`, true);
    if (V.channelId && !S.channels[V.channelId]) leaveVoice(true);
    if (S.view.serverId === id) go(null, null);
    else schedule('rail', 'side');
  });
  socket.on('dm:new', c => { addDm(c); schedule('side', 'header', 'members'); });
  socket.on('dm:remove', ({ id }) => {
    delete S.dms[id];
    indexChannels();
    if (S.view.channelId === id) go(null, null);
    else schedule('side');
  });
  socket.on('friends:update', f => {
    const before = S.friends.incoming.length;
    setFriends(f);
    if (f.incoming.length > before) { sound('message'); toast('New friend request!'); }
    schedule('side', 'friends', 'rail');
  });
  socket.on('voice:state', ({ channelId, participants }) => {
    const had = (S.voice[channelId] || []).length;
    S.voice[channelId] = participants;
    if (!participants.length) delete S.voice[channelId];
    if (V.channelId === channelId && !participants.some(p => p.sid === V.selfSid)) cleanupVoice();
    const ch = currentChannel();
    if (ch && ch.id === channelId) {
      if (!ch.serverId && (had === 0) !== (participants.length === 0)) schedule('main');
      else schedule('stage');
    }
    schedule('side');
  });
  socket.on('voice:peer-left', ({ sid }) => { closePeer(sid); sound('leave'); });
  socket.on('rtc:signal', onSignal);
  socket.on('call:incoming', ({ channelId, from }) => showRing(channelId, from));
  socket.on('call:declined', ({ by }) => toast(`${user(by).displayName} declined the call.`));
}

function renderOfflineBar() {
  let bar = $('#offline-bar');
  if (S.connected) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'offline-bar';
    bar.className = 'offline-bar';
    bar.textContent = 'Connection lost — reconnecting…';
    document.body.prepend(bar);
  }
}

function mentionsMe(m) {
  if (m.authorId === S.me.id) return false;
  if (m.replyPreview?.authorId === S.me.id) return true;
  const re = new RegExp(`(^|\\W)@(${S.me.username.replace(/\./g, '\\.')}|everyone|here)(?![\\w.])`, 'i');
  return re.test(m.content || '');
}

function notify(title, body, icon, channelId) {
  if (!prefs.notif || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(title, { body: String(body).slice(0, 140), icon: icon || '/favicon.svg', tag: channelId || title });
    n.onclick = () => {
      window.focus();
      const ch = channelId && S.channels[channelId];
      if (ch) go(ch.serverId, ch.id);
      n.close();
    };
  } catch {}
}

function updateTitle() {
  const n = Object.values(S.mentions).reduce((a, b) => a + b, 0) + S.friends.incoming.length;
  const ch = currentChannel();
  document.title = (n ? `(${n}) ` : '') + (ch ? (ch.serverId ? '#' : '@') + chName(ch) + ' · ' : '') + 'Hearth';
}

// ---------------------------------------------------------------- navigation
function go(serverId, channelId) {
  if (serverId && !S.servers[serverId]) serverId = null;
  if (serverId && !channelId) {
    const s = S.servers[serverId];
    const last = S.lastChannel[serverId];
    channelId = (last && s.channels.some(c => c.id === last)) ? last : (s.channels.find(c => c.type === 'text') || s.channels[0])?.id || null;
  }
  const input = $('#input');
  if (input && S.view.channelId) S.drafts[S.view.channelId] = input.value;
  S.view = { serverId: serverId || null, channelId: channelId || null };
  if (serverId) { S.lastChannel[serverId] = channelId; store.set('hearth.lastChannel', S.lastChannel); }
  S.replyTo = null;
  S.editing = null;
  S.pending = [];
  S.stickBottom = true;
  if (channelId) {
    delete S.unread[channelId];
    delete S.mentions[channelId];
    const ch = S.channels[channelId];
    if (ch && ch.type !== 'voice' && !S.messages[channelId]) loadMessages(channelId);
  }
  $('.layout')?.classList.remove('nav-open');
  store.set('hearth.view', S.view);
  closePopover();
  schedule('rail', 'side', 'main');
}

async function loadMessages(cid, older) {
  if (S.loading[cid]) return;
  S.loading[cid] = true;
  const before = older ? S.messages[cid]?.[0]?.id : undefined;
  const r = await emit('messages:fetch', { channelId: cid, before });
  S.loading[cid] = false;
  if (r.error) {
    if (!older) setTimeout(() => { if (S.view.channelId === cid && !S.messages[cid]) loadMessages(cid); }, 1500);
    return;
  }
  if (older) S.messages[cid] = [...r.messages, ...(S.messages[cid] || [])];
  else {
    const extra = (S.messages[cid] || []).filter(m => !r.messages.some(x => x.id === m.id));
    S.messages[cid] = [...r.messages, ...extra];
  }
  S.hasMore[cid] = r.hasMore;
  if (S.view.channelId === cid) renderMessages(older);
}

async function joinByInvite(code) {
  const r = await act('server:join', { invite: code });
  if (r) { addServer(r.server); go(r.server.id); toast(`Welcome to ${r.server.name}!`); }
}

// ---------------------------------------------------------------- rail
function renderRail() {
  const el = $('.rail');
  if (!el) return;
  const dmMentions = Object.values(S.dms).reduce((a, c) => a + (S.mentions[c.id] || 0), 0) + S.friends.incoming.length;
  const serverItems = Object.values(S.servers).map(s => {
    const unread = s.channels.some(c => S.unread[c.id]);
    const mentions = s.channels.reduce((a, c) => a + (S.mentions[c.id] || 0), 0);
    return `<div class="rail-item ${S.view.serverId === s.id ? 'active' : ''} ${unread ? 'unread' : ''}" data-act="go-server" data-id="${s.id}" data-ctx="server" title="${esc(s.name)}">
      <span class="rail-pill"></span><button class="rail-btn">${s.icon ? `<img src="${esc(s.icon)}" alt="">` : esc(serverAcronym(s.name))}</button>
      ${mentions ? `<span class="badge">${mentions}</span>` : ''}</div>`;
  }).join('');
  el.innerHTML = `
    <div class="rail-item ${!S.view.serverId ? 'active' : ''}" data-act="go-home" title="Direct Messages">
      <span class="rail-pill"></span><button class="rail-btn"><img src="/favicon.svg" alt="Home"></button>
      ${dmMentions ? `<span class="badge">${dmMentions}</span>` : ''}</div>
    <div class="rail-sep"></div>
    ${serverItems}
    <div class="rail-item" data-act="add-server" title="Add a server"><button class="rail-btn add">+</button></div>
    <div class="rail-item" data-act="join-server" title="Join with an invite"><button class="rail-btn add" style="font-size:20px">🧭</button></div>`;
}

// ---------------------------------------------------------------- sidebar
function renderSidebar() {
  const el = $('.sidebar');
  if (!el) return;
  const s = currentServer();
  const scroll = el.querySelector('.side-scroll')?.scrollTop || 0;
  el.innerHTML = (s ? serverSidebarHtml(s) : homeSidebarHtml()) + voicePanelHtml() + userPanelHtml();
  const sc = el.querySelector('.side-scroll');
  if (sc) sc.scrollTop = scroll;
}

function voiceUsersHtml(cid) {
  const parts = S.voice[cid] || [];
  if (!parts.length) return '';
  return `<div class="voice-users">${parts.map(p => {
    const u = user(p.userId);
    return `<div class="voice-user" data-sid="${esc(p.sid)}" data-uid="${esc(u.id)}" data-ctx="voice-user" data-act="profile">
      ${avatarHtml(u, 'av-sm')}<span>${esc(u.displayName)}</span>
      <span class="flags">${p.screen ? '<span class="live-tag">LIVE</span>' : ''}${p.video ? '📹' : ''}${p.muted ? '🔇' : ''}${p.deafened ? '🎧' : ''}</span></div>`;
  }).join('')}</div>`;
}

function serverSidebarHtml(s) {
  const admin = isAdminOf(s);
  const chanHtml = c => {
    const active = S.view.channelId === c.id;
    const voiceCh = c.type === 'voice';
    return `<div class="chan ${active ? 'active' : ''} ${S.unread[c.id] && !active ? 'unread' : ''}" data-act="go-channel" data-id="${c.id}" data-ctx="channel">
      <span class="icon">${voiceCh ? '🔊' : '#'}</span><span class="label">${esc(c.name)}</span>
      ${c.aiEnabled ? '<span class="ai-tag">AI</span>' : ''}
      ${S.mentions[c.id] ? `<span class="badge">${S.mentions[c.id]}</span>` : ''}
      ${admin ? `<span class="tools"><button data-act="channel-settings" data-id="${c.id}" title="Edit channel">⚙</button></span>` : ''}
    </div>${voiceCh ? voiceUsersHtml(c.id) : ''}`;
  };
  const text = s.channels.filter(c => c.type === 'text');
  const voiceChans = s.channels.filter(c => c.type === 'voice');
  return `<div class="side-header" data-act="server-menu"><span class="name">${esc(s.name)}</span><span>⌄</span></div>
    <div class="side-scroll">
      <div class="cat"><span>Text Channels</span>${admin ? '<button data-act="create-channel" data-type="text" title="Create channel">+</button>' : ''}</div>
      ${text.map(chanHtml).join('')}
      <div class="cat"><span>Voice Channels</span>${admin ? '<button data-act="create-channel" data-type="voice" title="Create voice channel">+</button>' : ''}</div>
      ${voiceChans.map(chanHtml).join('')}
    </div>`;
}

function homeSidebarHtml() {
  const dms = Object.values(S.dms).sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
  const pending = S.friends.incoming.length;
  return `<div class="side-header" style="cursor:default"><div class="side-search" style="margin:0;flex:1"><button data-act="quick-switch">Find or start a conversation</button></div></div>
    <div class="side-scroll">
      <div class="chan ${!S.view.channelId ? 'active' : ''}" data-act="go-home"><span class="icon">👥</span><span class="label">Friends</span>${pending ? `<span class="badge">${pending}</span>` : ''}</div>
      <div class="chan" data-act="open-dm" data-uid="${AI_ID}"><span class="icon">✨</span><span class="label">Chat with Hearth AI</span></div>
      <div class="cat"><span>Direct Messages</span><button data-act="new-group" title="Create group DM">+</button></div>
      ${dms.map(c => {
        const other = c.type === 'dm' ? user(c.members.find(m => m !== S.me.id)) : null;
        const inCall = (S.voice[c.id] || []).length;
        return `<div class="dm-item ${S.view.channelId === c.id ? 'active' : ''}" data-act="go-dm" data-id="${c.id}" data-ctx="dm">
          ${other ? avatarHtml(other, 'av-sm', true) : `<div class="av av-sm"><div class="av-fill" style="background:${colorFor(c.id)}">👥</div></div>`}
          <div class="meta"><div style="${S.unread[c.id] ? 'color:var(--text);font-weight:600' : ''}">${esc(chName(c))}${other?.bot ? '<span class="bot-tag">AI</span>' : ''}</div>
          <small>${inCall ? '🔊 In a call' : other ? esc(other.customStatus || '') : c.members.length + ' members'}</small></div>
          ${S.mentions[c.id] ? `<span class="badge">${S.mentions[c.id]}</span>` : ''}
        </div>`;
      }).join('') || '<div class="muted" style="padding:8px;font-size:13px">No conversations yet. Add a friend to get started!</div>'}
    </div>`;
}

function voicePanelHtml() {
  if (!V.channelId) return '';
  const ch = S.channels[V.channelId];
  const where = ch ? (ch.serverId ? `${ch.name} / ${S.servers[ch.serverId]?.name || ''}` : chName(ch)) : '';
  return `<div class="voice-panel">
    <div class="row"><div style="min-width:0"><div class="status">📶 Voice Connected</div>
      <div class="where" data-act="go-voice">${esc(where)}</div></div>
      <button class="icon-btn" data-act="leave-voice" title="Disconnect">📞</button></div>
    <div class="vbtns">
      <button class="${V.camTrack ? 'on' : ''}" data-act="toggle-camera" title="Camera">📹</button>
      <button class="${V.screenTrack ? 'on' : ''}" data-act="toggle-screen" title="Share screen">🖥️</button>
    </div></div>`;
}

function userPanelHtml() {
  const me = user(S.me.id);
  return `<div class="user-panel">
    <div class="who" data-act="status-menu">${avatarHtml(me, 'av-sm', true)}
      <div class="t"><div>${esc(me.displayName)}</div><small>${esc(me.customStatus || '@' + me.username)}</small></div></div>
    <button class="icon-btn ${V.muted ? 'off' : ''}" data-act="toggle-mute" title="${V.muted ? 'Unmute' : 'Mute'}">${V.muted ? '🔇' : '🎙️'}</button>
    <button class="icon-btn ${V.deafened ? 'off' : ''}" data-act="toggle-deafen" title="${V.deafened ? 'Undeafen' : 'Deafen'}">${V.deafened ? '🔕' : '🎧'}</button>
    <button class="icon-btn" data-act="open-settings" title="User settings">⚙️</button>
  </div>`;
}

// ---------------------------------------------------------------- main area
function renderMain() {
  const main = $('.main');
  if (!main) return;
  const ch = currentChannel();
  const bg = '<div class="main-bg"></div>';
  if (!ch) {
    main.innerHTML = bg + friendsPageHtml();
    applyBg();
    bindFriendsPage();
    return;
  }
  if (ch.type === 'voice') {
    main.innerHTML = bg + `<div class="main-header" id="mh"></div><div class="stage" id="stage"></div>`;
    renderHeader();
    renderStage();
    applyBg();
    return;
  }
  const showStage = !ch.serverId && ((S.voice[ch.id] || []).length || V.channelId === ch.id);
  main.innerHTML = bg + `<div class="main-header" id="mh"></div>
    ${showStage ? '<div class="stage in-dm" id="stage"></div>' : ''}
    <div class="messages" id="messages"></div>
    <div class="composer-wrap" id="composer-wrap"></div>`;
  renderHeader();
  if (showStage) renderStage();
  renderMessages();
  renderComposer();
  applyBg();
  const box = $('#messages');
  box.addEventListener('scroll', () => {
    S.stickBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    if (box.scrollTop < 80 && S.hasMore[ch.id] && !S.loading[ch.id]) loadMessages(ch.id, true);
  });
  box.addEventListener('load', () => { if (S.stickBottom) box.scrollTop = box.scrollHeight; }, true);
}

function renderHeader() {
  const el = $('#mh');
  const ch = currentChannel();
  if (!el || !ch) return;
  const s = currentServer();
  const ham = '<button class="icon-btn hamburger" data-act="nav-toggle" title="Menu">☰</button>';
  if (ch.type === 'voice') {
    el.innerHTML = `${ham}<div class="title"><span class="hash">🔊</span>${esc(ch.name)}</div><div class="spacer"></div>
      <div class="tools">${isAdminOf(s) ? `<button class="icon-btn" data-act="channel-settings" data-id="${ch.id}" title="Edit channel">⚙️</button>` : ''}</div>`;
    return;
  }
  if (ch.serverId) {
    el.innerHTML = `${ham}<div class="title"><span class="hash">#</span>${esc(ch.name)}${ch.aiEnabled ? '<span class="ai-tag" style="font-size:10px;background:#7c5cff;color:#fff;border-radius:3px;padding:1px 4px">AI</span>' : ''}</div>
      ${ch.topic ? `<div class="topic" data-act="show-topic" title="${esc(ch.topic)}">${esc(ch.topic)}</div>` : '<div class="spacer"></div>'}
      <div class="tools">
        <button class="icon-btn" data-act="pins" title="Pinned messages">📌</button>
        <button class="icon-btn" data-act="search" title="Search">🔍</button>
        <button class="icon-btn ${prefs.showMembers ? 'active' : ''}" data-act="toggle-members" title="Member list">👥</button>
        ${isAdminOf(s) ? `<button class="icon-btn" data-act="channel-settings" data-id="${ch.id}" title="Edit channel">⚙️</button>` : ''}
      </div>`;
    return;
  }
  const other = ch.type === 'dm' ? user(ch.members.find(m => m !== S.me.id)) : null;
  el.innerHTML = `${ham}<div class="title">${other ? avatarHtml(other, 'av-xs', false) : '👥'} ${esc(chName(ch))}${other?.bot ? '<span class="bot-tag">AI</span>' : ''}</div>
    <div class="spacer"></div>
    <div class="tools">
      ${other?.bot ? '' : `<button class="icon-btn" data-act="call" title="Start voice call">📞</button><button class="icon-btn" data-act="call" data-video="1" title="Start video call">📹</button>`}
      <button class="icon-btn" data-act="pins" title="Pinned messages">📌</button>
      ${ch.type === 'group' ? `<button class="icon-btn" data-act="add-to-group" title="Add friends">➕</button><button class="icon-btn" data-act="rename-group" title="Rename group">✏️</button>` : ''}
      <button class="icon-btn" data-act="search" title="Search">🔍</button>
      <button class="icon-btn ${prefs.showMembers ? 'active' : ''}" data-act="toggle-members" title="${ch.type === 'group' ? 'Member list' : 'User profile'}">👥</button>
    </div>`;
}

function welcomeHtml(ch) {
  if (ch.serverId) {
    return `<div class="welcome"><div class="big-icon">#</div><h2>Welcome to #${esc(ch.name)}!</h2>
      <p>This is the start of the #${esc(ch.name)} channel.${ch.aiEnabled ? ' <b>Hearth AI answers every message here.</b>' : ''}</p></div>`;
  }
  if (ch.type === 'dm') {
    const o = user(ch.members.find(m => m !== S.me.id));
    return `<div class="welcome">${avatarHtml(o, 'av-lg')}<h2>${esc(o.displayName)}</h2>
      <p>${o.bot ? 'This is your private chat with Hearth AI. Ask it anything — homework help, ideas, jokes, code…' : `This is the beginning of your direct message history with <b>@${esc(o.username)}</b>.`}</p></div>`;
  }
  return `<div class="welcome"><div class="big-icon">👥</div><h2>${esc(chName(ch))}</h2><p>Welcome to the beginning of this group.</p></div>`;
}

function renderMessages(keepOffset) {
  const el = $('#messages');
  const ch = currentChannel();
  if (!el || !ch) return;
  const list = S.messages[ch.id];
  if (!list) { el.innerHTML = '<div class="empty"><div class="art">⏳</div>Loading messages…</div>'; return; }
  const oldHeight = el.scrollHeight, oldTop = el.scrollTop;
  let html = S.hasMore[ch.id] ? '<button class="btn secondary small load-more" data-act="load-more">Load older messages</button>' : welcomeHtml(ch);
  let prev = null;
  for (const m of list) {
    const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
    if (newDay) html += `<div class="day-sep">${esc(fmtDay(m.createdAt))}</div>`;
    const cont = prev && !newDay && !m.system && !prev.system && !m.replyTo && prev.authorId === m.authorId && m.createdAt - prev.createdAt < 7 * 60e3;
    html += msgHtml(m, cont, ch);
    prev = m;
  }
  el.innerHTML = html;
  if (keepOffset === true) el.scrollTop = el.scrollHeight - oldHeight + oldTop;
  else if (S.stickBottom) el.scrollTop = el.scrollHeight;
  const editBox = $('#edit-box');
  if (editBox) {
    editBox.focus();
    editBox.setSelectionRange(editBox.value.length, editBox.value.length);
  }
}

function msgHtml(m, cont, ch) {
  const u = user(m.authorId);
  if (m.system) {
    const join = m.system === 'join';
    return `<div class="msg cont" data-id="${m.id}"><div class="system"><span class="arrow ${join ? '' : 'leave'}">${join ? '→' : '←'}</span>
      <b class="author" data-act="profile" data-uid="${esc(u.id)}">${esc(u.displayName)}</b> ${join ? 'just showed up. Say hi! 👋' : 'left the server.'}
      <span class="time">${esc(fmtTime(m.createdAt))}</span></div></div>`;
  }
  const mine = m.authorId === S.me.id;
  const s = ch.serverId && S.servers[ch.serverId];
  const canDelete = mine || isAdminOf(s);
  const nameColor = s && (s.ownerId === u.id || s.admins.includes(u.id)) ? `style="color:${s.ownerId === u.id ? 'var(--yellow)' : '#00a8fc'}"` : '';
  const reply = m.replyPreview ? `<div class="reply" data-act="jump" data-id="${m.replyTo}">${avatarHtml(user(m.replyPreview.authorId), 'av-xs')}
      <b>${esc(user(m.replyPreview.authorId).displayName)}</b><span class="txt">${esc(m.replyPreview.content || 'Click to see attachment')}</span></div>` : '';
  let body = '';
  if (S.editing === m.id) {
    body = `<div class="composer-bar" style="margin:4px 0"><div class="composer"><textarea id="edit-box" rows="1">${esc(S.editText)}</textarea></div></div>
      <div style="font-size:12px;color:var(--text-3)">escape to <button class="btn link" data-act="edit-cancel">cancel</button> • enter to <button class="btn link" data-act="edit-save">save</button></div>`;
  } else if (m.content) {
    const onlyImage = /^https?:\/\/\S+\.(gif|png|jpe?g|webp)(\?\S*)?$/i.test(m.content.trim()) || /^https:\/\/media\d*\.(giphy|tenor)\.com\/\S+$/.test(m.content.trim());
    const big = isOnlyEmoji(m.content) ? ' big-emoji' : '';
    if (!onlyImage) body = `<div class="body${big}">${md(m.content)}${m.editedAt ? '<span class="edited">(edited)</span>' : ''}</div>`;
    body += embedsFor(m.content);
  }
  const atts = (m.attachments || []).length ? `<div class="attachments">${m.attachments.map(a => {
    if (/^image\//.test(a.type)) return `<img src="${esc(a.url)}" alt="${esc(a.name)}" data-act="lightbox" data-src="${esc(a.url)}" loading="lazy">`;
    if (/^video\//.test(a.type)) return `<video src="${esc(a.url)}" controls preload="metadata"></video>`;
    if (/^audio\//.test(a.type)) return `<div class="file-card" style="flex-direction:column;align-items:stretch"><div>🎵 ${esc(a.name)}</div><audio src="${esc(a.url)}" controls preload="none"></audio></div>`;
    return `<div class="file-card"><span class="ficon">📄</span><div><a href="${esc(a.url)}" download="${esc(a.name)}">${esc(a.name)}</a><small>${fmtSize(a.size)}</small></div></div>`;
  }).join('')}</div>` : '';
  const sticker = m.sticker ? `<img class="sticker-img" src="${esc(stickerSrc(m.sticker.url))}" alt="${esc(m.sticker.name)}" title="${esc(m.sticker.name)}">` : '';
  const gif = m.gif ? `<img class="embed-gif" src="${esc(m.gif.url)}" alt="${esc(m.gif.title || 'GIF')}" data-act="lightbox" data-src="${esc(m.gif.url)}">` : '';
  let poll = '';
  if (m.poll) {
    const total = m.poll.options.reduce((a, o) => a + o.votes.length, 0);
    poll = `<div class="poll"><h4>📊 ${esc(m.poll.question)}</h4>${m.poll.options.map((o, i) => {
      const pct = total ? Math.round(o.votes.length / total * 100) : 0;
      return `<button class="poll-opt ${o.votes.includes(S.me.id) ? 'voted' : ''}" data-act="vote" data-opt="${i}">
        <div class="fill" style="width:${pct}%"></div><span>${esc(o.text)}</span><span>${o.votes.length} · ${pct}%</span></button>`;
    }).join('')}<small>${total} vote${total === 1 ? '' : 's'} · click to vote</small></div>`;
  }
  const reacts = Object.entries(m.reactions || {}).filter(([, us]) => us.length);
  const reactions = reacts.length ? `<div class="reactions">${reacts.map(([e, us]) =>
    `<button class="reaction ${us.includes(S.me.id) ? 'mine' : ''}" data-act="react-toggle" data-emoji="${esc(e)}" title="${esc(us.map(id => user(id).displayName).join(', '))}">${esc(e)} <b>${us.length}</b></button>`).join('')}
    <button class="reaction" data-act="msg-react" title="Add reaction">➕</button></div>` : '';
  const classes = ['msg', cont ? 'cont' : '', mentionsMe(m) ? 'mentioned' : '', reply ? 'has-reply' : ''].join(' ');
  return `<div class="${classes}" data-id="${m.id}" data-ctx="msg">
    ${cont ? `<span class="side-time">${esc(fmtClock(m.createdAt))}</span>` : avatarHtml(u, '').replace('class="av ', 'data-act="profile" class="av ')}
    ${reply}
    ${cont ? '' : `<div class="head"><span class="author" data-act="profile" data-uid="${esc(u.id)}" ${nameColor}>${esc(u.displayName)}</span>${u.bot ? '<span class="bot-tag">AI</span>' : ''}<span class="time">${esc(fmtTime(m.createdAt))}</span>${m.pinned ? '<span class="pin-tag">📌 pinned</span>' : ''}</div>`}
    ${body}${atts}${sticker}${gif}${poll}${reactions}
    ${m.ephemeral ? '<div class="muted" style="font-size:12px">👁 Only you can see this</div>' : `<div class="msg-actions">
      ${QUICK_REACTIONS.slice(0, 3).map(e => `<button data-act="react-toggle" data-emoji="${e}" title="React ${e}">${e}</button>`).join('')}
      <button data-act="msg-react" title="Add reaction">😀</button>
      <button data-act="msg-reply" title="Reply">↩️</button>
      ${mine && m.content ? '<button data-act="msg-edit" title="Edit">✏️</button>' : ''}
      ${canDelete ? '<button class="danger" data-act="msg-delete" title="Delete">🗑️</button>' : ''}
      <button data-act="msg-more" title="More">⋯</button></div>`}
  </div>`;
}

function renderTyping() {
  const el = $('#typing');
  const ch = currentChannel();
  if (!el || !ch) return;
  const now = Date.now();
  const t = S.typing[ch.id] || {};
  const who = Object.entries(t).filter(([, until]) => until > now).map(([id]) => user(id).displayName);
  if (!who.length) { el.innerHTML = ''; return; }
  const names = who.length > 3 ? 'Several people are' : who.map(n => `<b>${esc(n)}</b>`).join(', ') + (who.length === 1 ? ' is' : ' are');
  el.innerHTML = `<span class="dots"><span></span><span></span><span></span></span> ${names} typing…`;
}
setInterval(() => { if (S.me && currentChannel()) renderTyping(); }, 1500);

// ---------------------------------------------------------------- members panel
function renderMembers() {
  const el = $('.members');
  if (!el) return;
  const ch = currentChannel();
  const s = currentServer();
  const desktop = innerWidth > 900;
  if (!ch || ch.type === 'voice' || (desktop && !prefs.showMembers)) { el.hidden = true; return; }
  el.hidden = false;
  if (ch.type === 'dm') {
    const o = user(ch.members.find(m => m !== S.me.id));
    el.innerHTML = `<div style="padding:4px">${profileCardHtml(o, true)}</div>`;
    return;
  }
  const ids = s ? [...s.users.map(u => u.id)] : ch.members;
  const members = [...new Set(ids)].map(user);
  const on = members.filter(u => u.presence && u.presence !== 'offline');
  const off = members.filter(u => !u.presence || u.presence === 'offline');
  const row = u => `<div class="member ${u.presence === 'offline' || !u.presence ? 'offline' : ''}" data-act="profile" data-uid="${esc(u.id)}" data-ctx="member">
      ${avatarHtml(u, 'av-sm', true)}<div class="meta"><div>${esc(u.displayName)}${u.bot ? '<span class="bot-tag">AI</span>' : ''}${s?.ownerId === u.id ? '<span class="crown" title="Owner">👑</span>' : s?.admins.includes(u.id) ? '<span class="crown" title="Admin">🛡️</span>' : ''}</div>
      ${u.customStatus ? `<small>${esc(u.customStatus)}</small>` : ''}</div></div>`;
  el.innerHTML = `<div class="cat">Online — ${on.length}</div>${on.map(row).join('')}
    ${off.length ? `<div class="cat">Offline — ${off.length}</div>${off.map(row).join('')}` : ''}`;
}

function profileCardHtml(u, inline = false) {
  const banner = u.banner && u.banner.startsWith('/uploads/') ? `background-image:url('${esc(u.banner)}')` : `background:${esc(u.banner || colorFor(u.id))}`;
  const me = u.id === S.me.id;
  const f = S.friends;
  let actions = '';
  if (me) actions = '<button class="btn small" data-act="open-settings" data-tab="profile">✏️ Edit Profile</button>';
  else {
    actions = `<button class="btn small" data-act="open-dm" data-uid="${esc(u.id)}">💬 Message</button>`;
    if (!u.bot) {
      if (f.friends.includes(u.id)) actions += '<button class="btn small secondary" disabled>✓ Friends</button>';
      else if (f.incoming.includes(u.id)) actions += `<button class="btn small green" data-act="friend-accept" data-uid="${esc(u.id)}">Accept Request</button>`;
      else if (f.outgoing.includes(u.id)) actions += '<button class="btn small secondary" disabled>Request Sent</button>';
      else actions += `<button class="btn small secondary" data-act="friend-add" data-username="${esc(u.username)}">➕ Add Friend</button>`;
    }
  }
  return `<div class="profile-card" style="${inline ? 'width:100%;box-shadow:none' : ''}">
    <div class="banner" style="${banner}"></div>${avatarHtml(u, 'av-lg', true)}
    <div class="inner"><h3>${esc(u.displayName)}${u.bot ? '<span class="bot-tag">AI</span>' : ''}</h3><div class="uname">@${esc(u.username)}</div>
      ${u.customStatus ? `<p style="margin-top:8px">${esc(u.customStatus)}</p>` : ''}<hr>
      ${u.bio ? `<h6>About me</h6><p>${esc(u.bio)}</p>` : ''}
      <h6>Member since</h6><p>${u.createdAt ? new Date(u.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}</p>
      <div class="actions">${actions}</div></div></div>`;
}

// ---------------------------------------------------------------- friends page
function friendsPageHtml() {
  const t = S.friendsTab;
  const tabs = [['online', 'Online'], ['all', 'All'], ['pending', `Pending${S.friends.incoming.length ? ` (${S.friends.incoming.length})` : ''}`], ['blocked', 'Blocked']];
  const head = `<div class="main-header friends-head"><button class="icon-btn hamburger" data-act="nav-toggle">☰</button>
    <div class="title">👥 Friends</div>
    <div class="tools" style="gap:6px;margin-left:12px;overflow-x:auto">
      ${tabs.map(([k, l]) => `<button class="tab ${t === k ? 'active' : ''}" data-act="friends-tab" data-tab="${k}">${l}</button>`).join('')}
      <button class="tab add ${t === 'add' ? 'active' : ''}" data-act="friends-tab" data-tab="add">Add Friend</button>
    </div></div>`;
  const row = (id, buttons, sub) => {
    const u = user(id);
    return `<div class="friend-row" data-act="open-dm" data-uid="${esc(id)}">${avatarHtml(u, 'av-sm', true)}
      <div class="meta"><b>${esc(u.displayName)}</b> <span class="muted">@${esc(u.username)}</span><small>${esc(sub ?? (u.customStatus || u.presence || 'offline'))}</small></div>${buttons}</div>`;
  };
  const msgBtn = id => `<button class="round-btn" data-act="open-dm" data-uid="${esc(id)}" title="Message">💬</button><button class="round-btn" data-act="friend-menu" data-uid="${esc(id)}" title="More">⋯</button>`;
  let body = '';
  if (t === 'add') {
    body = `<h3 style="margin:0 0 4px">Add Friend</h3><p class="muted" style="margin:0">You can add friends with their Hearth username.</p>
      <form class="add-friend" id="add-friend"><input name="username" placeholder="Type a username, like coolperson123" autocomplete="off" autocapitalize="none" maxlength="32">
      <button class="btn small">Send Friend Request</button></form>
      <div class="section" style="margin-top:24px;display:flex;gap:12px;align-items:center">${avatarHtml(user(AI_ID), '')}
        <div style="flex:1"><b>Bored? Talk to Hearth AI</b><div class="muted" style="font-size:14px">The built-in AI is always online.</div></div>
        <button class="btn small" data-act="open-dm" data-uid="${AI_ID}">Chat</button></div>`;
  } else if (t === 'pending') {
    const inc = S.friends.incoming, out = S.friends.outgoing;
    body = (inc.length ? `<h4>Incoming — ${inc.length}</h4>` + inc.map(id => row(id, `<button class="round-btn ok" data-act="friend-accept" data-uid="${esc(id)}" title="Accept">✔</button><button class="round-btn no" data-act="friend-remove" data-uid="${esc(id)}" title="Ignore">✕</button>`, 'Incoming friend request')).join('') : '')
      + (out.length ? `<h4>Outgoing — ${out.length}</h4>` + out.map(id => row(id, `<button class="round-btn no" data-act="friend-remove" data-uid="${esc(id)}" title="Cancel">✕</button>`, 'Outgoing friend request')).join('') : '');
    if (!body) body = '<div class="empty"><div class="art">📭</div>No pending friend requests.</div>';
  } else if (t === 'blocked') {
    body = S.friends.blocked.map(id => row(id, `<button class="btn small secondary" data-act="friend-unblock" data-uid="${esc(id)}">Unblock</button>`, 'Blocked')).join('')
      || '<div class="empty"><div class="art">🕊️</div>You haven\'t blocked anyone.</div>';
  } else {
    const list = S.friends.friends.filter(id => t === 'all' || (user(id).presence && user(id).presence !== 'offline'));
    body = list.length ? `<h4>${t === 'all' ? 'All friends' : 'Online'} — ${list.length}</h4>` + list.map(id => row(id, msgBtn(id))).join('')
      : `<div class="empty"><div class="art">🔥</div>${t === 'all' ? 'No friends yet — click <b>Add Friend</b> to get started!' : 'No one is online right now.'}<br><br><button class="btn" data-act="friends-tab" data-tab="add">Add Friend</button></div>`;
  }
  return head + `<div class="friends-body">${body}</div>`;
}
function bindFriendsPage() {
  const f = $('#add-friend');
  if (!f) return;
  f.querySelector('input').focus();
  f.onsubmit = async e => {
    e.preventDefault();
    const username = f.username.value.trim();
    if (!username) return;
    const r = await act('friend:request', { username });
    if (r) { toast(`Friend request sent to ${username}!`); f.reset(); }
  };
}

// ---------------------------------------------------------------- composer
const COMMANDS = [
  ['ai', 'Ask Hearth AI a question', '<question>'],
  ['gif', 'Search for a GIF', '<search>'],
  ['poll', 'Create a poll', 'Question | Option 1 | Option 2'],
  ['shrug', 'Append ¯\\_(ツ)_/¯', '[message]'],
  ['tableflip', 'Append (╯°□°)╯︵ ┻━┻', '[message]'],
  ['unflip', 'Append ┬─┬ノ( º _ ºノ)', '[message]'],
  ['lenny', 'Append ( ͡° ͜ʖ ͡°)', '[message]'],
  ['me', 'Send an action message in italics', '<action>'],
  ['spoiler', 'Hide your message behind a spoiler', '<message>'],
  ['roll', 'Roll a die', '[sides]'],
  ['coin', 'Flip a coin', ''],
  ['8ball', 'Ask the magic 8-ball', '<question>'],
  ['nick', 'Change your display name', '<name>'],
  ['status', 'Set online / idle / dnd / invisible', '<status>'],
  ['help', 'List all commands', ''],
];

function renderComposer() {
  const el = $('#composer-wrap');
  const ch = currentChannel();
  if (!el || !ch) return;
  const other = ch.type === 'dm' ? ch.members.find(m => m !== S.me.id) : null;
  if (other && S.friends.blocked.includes(other)) {
    el.innerHTML = '<div class="composer-bar composer-disabled">You have blocked this user. Unblock them to send messages.</div>';
    return;
  }
  const placeholder = ch.serverId ? `Message #${ch.name}` : `Message ${ch.type === 'dm' ? '@' : ''}${chName(ch)}`;
  el.innerHTML = `<div class="suggest" id="suggest" hidden></div>
    <div class="composer-bar">
      <div id="composer-top"></div>
      <div class="composer-files" id="pending" hidden></div>
      <div class="composer">
        <button class="icon-btn" data-act="attach" title="Upload a file">➕</button>
        <textarea id="input" rows="1" maxlength="4000" placeholder="${esc(placeholder)}"></textarea>
        <button class="icon-btn" data-act="open-picker" data-tab="gif" title="GIFs"><span class="gif-btn">GIF</span></button>
        <button class="icon-btn" data-act="open-picker" data-tab="sticker" title="Stickers">🏷️</button>
        <button class="icon-btn" data-act="open-picker" data-tab="emoji" title="Emoji">😊</button>
      </div>
    </div>
    <div class="typing" id="typing"></div>`;
  const ta = $('#input');
  ta.value = S.drafts[ch.id] || '';
  autosize(ta);
  renderComposerTop();
  renderPending();
  renderTyping();
  ta.addEventListener('input', () => {
    autosize(ta);
    S.drafts[ch.id] = ta.value;
    if (ta.value.trim() && !ta.value.startsWith('/')) socket.emit('typing', { channelId: ch.id });
    updateSuggest();
  });
  ta.addEventListener('keydown', onComposerKey);
  ta.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  if (matchMedia('(pointer:fine)').matches) ta.focus();
}
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px';
}
function renderComposerTop() {
  const el = $('#composer-top');
  if (!el) return;
  const m = S.replyTo && S.messages[S.view.channelId]?.find(x => x.id === S.replyTo);
  el.innerHTML = m ? `<div class="composer-top"><span>Replying to <b>${esc(user(m.authorId).displayName)}</b></span><button data-act="cancel-reply" title="Cancel">✕</button></div>` : '';
}
function renderPending() {
  const el = $('#pending');
  if (!el) return;
  el.hidden = !S.pending.length;
  el.innerHTML = S.pending.map((p, i) => `<div class="pending-file ${p.uploading ? 'uploading' : ''}">
    ${p.preview ? `<img src="${p.preview}" alt="">` : '<div style="font-size:40px;text-align:center;height:80px;line-height:80px">📄</div>'}
    <div class="fname">${p.uploading ? '⏳ ' : ''}${esc(p.name)}</div><button class="x" data-act="remove-pending" data-i="${i}">✕</button></div>`).join('');
}
function addFiles(files) {
  for (const f of [...files].slice(0, 10)) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is larger than 25 MB.`, true); continue; }
    const p = { name: f.name || 'pasted-image.png', type: f.type, size: f.size, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null, uploading: true };
    S.pending.push(p);
    uploadFile(f).then(r => { Object.assign(p, r, { uploading: false }); renderPending(); })
      .catch(e => { S.pending = S.pending.filter(x => x !== p); toast(e.message, true); renderPending(); });
  }
  renderPending();
}

function localMessage(content) {
  const ch = currentChannel();
  if (!ch) return;
  (S.messages[ch.id] ||= []).push({ id: 'local' + Date.now(), channelId: ch.id, authorId: AI_ID, content, createdAt: Date.now(), attachments: [], reactions: {}, ephemeral: true });
  S.stickBottom = true;
  renderMessages();
}

// Returns a message payload, or null when the command was fully handled locally.
async function runSlash(text) {
  const m = text.match(/^\/(\w+)\s*([\s\S]*)$/);
  if (!m) return { content: text };
  const [, cmd, arg] = m;
  const suffix = s => ({ content: (arg ? arg + ' ' : '') + s });
  switch (cmd.toLowerCase()) {
    case 'ai': return { content: text };
    case 'shrug': return suffix('¯\\_(ツ)_/¯');
    case 'tableflip': return suffix('(╯°□°)╯︵ ┻━┻');
    case 'unflip': return suffix('┬─┬ノ( º _ ºノ)');
    case 'lenny': return suffix('( ͡° ͜ʖ ͡°)');
    case 'me': return arg ? { content: `*${arg}*` } : null;
    case 'spoiler': return arg ? { content: `||${arg}||` } : null;
    case 'roll': {
      const n = Math.max(2, Math.min(1e6, parseInt(arg, 10) || 6));
      return { content: `🎲 rolled a **${1 + Math.floor(Math.random() * n)}** (1–${n})` };
    }
    case 'coin': return { content: `🪙 flipped a coin: **${Math.random() < 0.5 ? 'Heads' : 'Tails'}**` };
    case '8ball': {
      const a = ['It is certain.', 'Without a doubt.', 'Yes, definitely.', 'Most likely.', 'Ask again later.', 'Cannot predict now.', "Don't count on it.", 'My sources say no.', 'Very doubtful.', 'Signs point to yes.'];
      return { content: `🎱 ${arg ? `*${arg}*\n` : ''}**${a[Math.floor(Math.random() * a.length)]}**` };
    }
    case 'poll': {
      const parts = arg.split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length < 3) { localMessage('Usage: `/poll Question | Option 1 | Option 2` (up to 10 options)'); return null; }
      return { content: '', poll: { question: parts[0], options: parts.slice(1) } };
    }
    case 'gif': openPicker($('[data-act="open-picker"][data-tab="gif"]'), 'gif', arg); return null;
    case 'nick': if (arg && await act('profile:update', { displayName: arg })) toast('Display name updated!'); return null;
    case 'status':
      if (['online', 'idle', 'dnd', 'invisible'].includes(arg.trim())) await act('profile:update', { status: arg.trim() });
      else localMessage('Usage: `/status online|idle|dnd|invisible`');
      return null;
    case 'help':
      localMessage('**Commands**\n' + COMMANDS.map(([n, d, a]) => `\`/${n}${a ? ' ' + a : ''}\` — ${d}`).join('\n') + '\n\n**Formatting**: `**bold**` `*italics*` `__underline__` `~~strike~~` `||spoiler||` `` `code` `` `> quote` `# heading` and ``` code blocks ```');
      return null;
    default: return { content: text };
  }
}

async function sendMessage() {
  const ta = $('#input');
  const ch = currentChannel();
  if (!ta || !ch) return;
  const text = ta.value;
  if (S.pending.some(p => p.uploading)) return toast('Wait for your uploads to finish.');
  if (!text.trim() && !S.pending.length) return;
  const payload = text.trim().startsWith('/') ? await runSlash(text.trim()) : { content: text };
  const reset = () => {
    ta.value = '';
    S.drafts[ch.id] = '';
    autosize(ta);
    hideSuggest();
  };
  if (!payload) { reset(); return; }
  const data = { channelId: ch.id, ...payload, replyTo: S.replyTo, attachments: S.pending.map(({ url, name, type, size }) => ({ url, name, type, size })) };
  reset();
  S.pending = [];
  S.replyTo = null;
  renderPending();
  renderComposerTop();
  const r = await emit('message:send', data);
  if (r.error) {
    toast(r.error, true);
    if (!ta.value) { ta.value = text; autosize(ta); }
  } else if (r.message) {
    const list = S.messages[ch.id];
    if (list && !list.some(x => x.id === r.message.id)) { list.push(r.message); S.stickBottom = true; renderMessages(); }
  }
}
async function sendExtra(extra) {
  const ch = currentChannel();
  if (!ch) return;
  S.stickBottom = true;
  const r = await act('message:send', { channelId: ch.id, content: '', replyTo: S.replyTo, ...extra });
  if (r) { S.replyTo = null; renderComposerTop(); }
}

function onComposerKey(e) {
  const sug = $('#suggest');
  if (sug && !sug.hidden) {
    const items = $$('.item', sug);
    let i = items.findIndex(x => x.classList.contains('sel'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[i]?.classList.remove('sel');
      i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[i]?.classList.add('sel');
      items[i]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if ((e.key === 'Tab' || e.key === 'Enter') && items[i]) {
      e.preventDefault();
      items[i].click();
      return;
    }
    if (e.key === 'Escape') { hideSuggest(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  } else if (e.key === 'ArrowUp' && !e.target.value) {
    const mine = [...(S.messages[S.view.channelId] || [])].reverse().find(m => m.authorId === S.me.id && m.content && !m.ephemeral);
    if (mine) { e.preventDefault(); startEdit(mine.id); }
  } else if (e.key === 'Escape' && S.replyTo) {
    S.replyTo = null;
    renderComposerTop();
  }
}

function hideSuggest() { const s = $('#suggest'); if (s) s.hidden = true; }
function updateSuggest() {
  const ta = $('#input'), sug = $('#suggest');
  if (!ta || !sug) return;
  const before = ta.value.slice(0, ta.selectionStart);
  let items = [], title = '';
  let cmd, at, emo;
  if ((cmd = ta.value.match(/^\/(\w*)$/))) {
    title = 'Commands';
    items = COMMANDS.filter(([n]) => n.startsWith(cmd[1].toLowerCase())).map(([n, d, a]) => ({
      html: `<b>/${n}</b> <span class="muted">${esc(a)}</span><small>${esc(d)}</small>`,
      pick: () => { ta.value = `/${n} `; },
    }));
  } else if ((at = before.match(/(^|\s)@([\w.]*)$/))) {
    const q = at[2].toLowerCase();
    const ch = currentChannel();
    const s = currentServer();
    const ids = s ? s.users.map(u => u.id) : ch ? [...ch.members, AI_ID] : [];
    title = 'Members';
    items = [...new Set(ids)].map(user).filter(u => u.username.startsWith(q) || u.displayName.toLowerCase().startsWith(q)).slice(0, 8).map(u => ({
      html: `${avatarHtml(u, 'av-xs')}<b>${esc(u.displayName)}</b><small>@${esc(u.username)}</small>`,
      pick: () => {
        const start = before.length - at[2].length - 1;
        ta.value = ta.value.slice(0, start) + '@' + u.username + ' ' + ta.value.slice(ta.selectionStart);
      },
    }));
  } else if ((emo = before.match(/:([a-z0-9_]{2,})$/))) {
    title = 'Emoji';
    items = Object.entries(EMOJI_BY_NAME).filter(([n]) => n.includes(emo[1])).slice(0, 8).map(([n, e]) => ({
      html: `<span style="font-size:20px">${e}</span><b>:${esc(n)}:</b>`,
      pick: () => {
        const start = before.length - emo[1].length - 1;
        ta.value = ta.value.slice(0, start) + e + ' ' + ta.value.slice(ta.selectionStart);
      },
    }));
  }
  if (!items.length) { sug.hidden = true; return; }
  sug.hidden = false;
  sug.innerHTML = `<div class="hd">${title}</div>` + items.map((it, i) => `<div class="item ${i === 0 ? 'sel' : ''}" data-i="${i}">${it.html}</div>`).join('');
  sug.onclick = e => {
    const it = e.target.closest('.item');
    if (!it) return;
    items[it.dataset.i].pick();
    hideSuggest();
    autosize(ta);
    ta.focus();
  };
}

// ---------------------------------------------------------------- message editing
function startEdit(id) {
  const m = S.messages[S.view.channelId]?.find(x => x.id === id);
  if (!m) return;
  S.editing = id;
  S.editText = m.content;
  S.stickBottom = false;
  renderMessages();
  const box = $('#edit-box');
  if (!box) return;
  autosize(box);
  box.addEventListener('input', () => { S.editText = box.value; autosize(box); });
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') { e.stopPropagation(); cancelEdit(); }
  });
}
async function saveEdit() {
  const id = S.editing;
  const text = S.editText;
  S.editing = null;
  renderMessages();
  if (!text.trim()) {
    if (await confirmBox('Delete message', 'Are you sure you want to delete this message?', 'Delete')) act('message:delete', { channelId: S.view.channelId, id });
    return;
  }
  act('message:edit', { channelId: S.view.channelId, id, content: text });
  $('#input')?.focus();
}
function cancelEdit() {
  S.editing = null;
  renderMessages();
  $('#input')?.focus();
}

// ---------------------------------------------------------------- pickers (emoji / GIF / sticker)
function openPicker(anchor, tab, query = '', onPick) {
  const reactionMode = !!onPick;
  const el = popover(`<div class="picker">
    ${reactionMode ? '' : `<div class="picker-tabs">${[['gif', 'GIFs'], ['sticker', 'Stickers'], ['emoji', 'Emoji']].map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div>`}
    <div class="picker-search"><input class="input" placeholder="Search" value="${esc(query)}"></div>
    <div class="picker-body"></div></div>`, anchor || { x: innerWidth - 20, y: innerHeight - 90 }, { side: 'top' });
  const body = el.querySelector('.picker-body');
  const input = el.querySelector('input');
  let cur = tab;
  const pick = onPick || (async item => {
    if (item.emoji) {
      const ta = $('#input');
      if (ta) {
        const p = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, p) + item.emoji + ta.value.slice(p);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = p + item.emoji.length;
        S.drafts[S.view.channelId] = ta.value;
      }
      return;
    }
    closePopover();
    if (item.gif) sendExtra({ gif: item.gif });
    if (item.sticker) sendExtra({ sticker: item.sticker });
  });
  const draw = async () => {
    const q = input.value.trim().toLowerCase();
    if (cur === 'emoji') {
      body.innerHTML = (q ? [['Results', EMOJI_CATS.flatMap(([, l]) => l).filter(x => x.n.includes(q))]] : [['Frequently used', QUICK_REACTIONS.map(e => ({ e, n: '' }))], ...EMOJI_CATS])
        .map(([cat, list]) => `<div class="emoji-cat">${esc(cat)}</div><div class="emoji-grid">${list.map(x => `<button data-e="${x.e}" title="${x.n ? ':' + x.n + ':' : ''}">${x.e}</button>`).join('')}</div>`).join('');
    } else if (cur === 'sticker') {
      const s = currentServer();
      const servers = s ? [s] : Object.values(S.servers);
      const sets = [['Hearth Blobs', BUILTIN_STICKERS.map(b => ({ name: b.name, url: b.url, src: b.src }))],
        ...servers.filter(x => x.stickers?.length).map(x => [x.name, x.stickers.map(st => ({ name: st.name, url: st.url, src: st.url }))])];
      body.innerHTML = sets.map(([name, list]) => {
        const f = list.filter(x => !q || x.name.toLowerCase().includes(q));
        return f.length ? `<div class="emoji-cat">${esc(name)}</div><div class="sticker-grid">${f.map(x => `<button data-st="${esc(x.url)}" data-name="${esc(x.name)}" title="${esc(x.name)}"><img src="${esc(x.src)}" alt=""></button>`).join('')}</div>` : '';
      }).join('') || '<div class="empty">No stickers found.</div>';
    } else {
      if (!S.features.gifs) {
        body.innerHTML = '<div class="empty"><div class="art">🎞️</div>GIF search isn\'t set up on this server yet (the owner needs a free GIPHY API key).<br><br>You can still paste any GIF link into chat and it will show up!</div>';
        return;
      }
      body.innerHTML = '<div class="empty">Loading…</div>';
      try {
        const gifs = await api('/api/gifs?q=' + encodeURIComponent(q));
        if (cur !== 'gif') return;
        body.innerHTML = gifs.length ? `<div class="gif-grid">${gifs.map(g => `<img src="${esc(g.preview || g.url)}" data-url="${esc(g.url)}" data-title="${esc(g.title || '')}" alt="${esc(g.title || '')}" loading="lazy">`).join('')}</div>` : '<div class="empty">No GIFs found.</div>';
      } catch {
        body.innerHTML = '<div class="empty">GIF search failed.</div>';
      }
    }
  };
  input.addEventListener('input', debounce(draw, cur === 'gif' ? 400 : 100));
  el.querySelectorAll('.picker-tabs button').forEach(b => b.onclick = () => {
    cur = b.dataset.tab;
    el.querySelectorAll('.picker-tabs button').forEach(x => x.classList.toggle('active', x === b));
    draw();
  });
  body.addEventListener('click', e => {
    const em = e.target.closest('[data-e]');
    if (em) return pick({ emoji: em.dataset.e });
    const st = e.target.closest('[data-st]');
    if (st) return pick({ sticker: { url: st.dataset.st, name: st.dataset.name } });
    const g = e.target.closest('[data-url]');
    if (g) return pick({ gif: { url: g.dataset.url, title: g.dataset.title } });
  });
  draw();
  input.focus();
}

// ---------------------------------------------------------------- drag & drop uploads
let dragDepth = 0;
document.addEventListener('dragenter', e => {
  if (!currentChannel() || currentChannel().type === 'voice' || !e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  if (!$('.drop-overlay')) document.body.insertAdjacentHTML('beforeend', '<div class="drop-overlay">📎 Drop to upload</div>');
});
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('.drop-overlay')?.remove(); } });
document.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => {
  dragDepth = 0;
  $('.drop-overlay')?.remove();
  if (!e.dataTransfer?.files.length || !$('#input')) return;
  e.preventDefault();
  addFiles(e.dataTransfer.files);
});

window.addEventListener('resize', debounce(() => schedule('members'), 200));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.view.channelId) { delete S.unread[S.view.channelId]; delete S.mentions[S.view.channelId]; schedule('rail', 'side'); }
});

boot();
