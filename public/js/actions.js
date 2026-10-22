'use strict';
// Click actions, context menus, keyboard shortcuts, modals and the settings screens.

const msgOf = el => {
  const id = el.closest('.msg')?.dataset.id;
  return id && S.messages[S.view.channelId]?.find(m => m.id === id);
};

const ACT = {
  'go-home': () => go(null, null),
  'go-server': el => go(el.dataset.id),
  'go-channel': el => {
    const ch = S.channels[el.dataset.id];
    go(ch.serverId, ch.id);
    if (ch.type === 'voice' && V.channelId !== ch.id) joinVoice(ch.id);
  },
  'go-dm': el => go(null, el.dataset.id),
  'go-voice': () => { const ch = S.channels[V.channelId]; if (ch) go(ch.serverId, ch.id); },
  'open-dm': async el => {
    closePopover();
    closeTopModal();
    const r = await act('dm:open', { userId: el.dataset.uid });
    if (r) { addDm(r.channel); go(null, r.channel.id); }
  },
  'nav-toggle': () => $('.layout').classList.toggle('nav-open'),
  'join-voice': el => joinVoice(el.dataset.id),
  'leave-voice': () => leaveVoice(),
  'toggle-mute': () => toggleMute(),
  'toggle-deafen': () => toggleDeafen(),
  'toggle-camera': () => toggleCamera(),
  'toggle-screen': () => toggleScreen(),
  'fullscreen': el => el.closest('.tile')?.requestFullscreen?.(),
  'call': el => startCall(S.view.channelId, !!el.dataset.video),
  'toggle-members': () => {
    if (innerWidth <= 900) $('.layout').classList.toggle('show-members');
    else setPref('showMembers', !prefs.showMembers);
    schedule('members', 'header');
  },
  'show-topic': () => {
    const ch = currentChannel();
    modal(`<div class="modal-head"><h2>#${esc(ch.name)}</h2></div><div class="modal-body"><div class="msg" style="padding:0;margin:0"><div class="body">${md(ch.topic)}</div></div></div>`);
  },
  'friends-tab': el => { S.friendsTab = el.dataset.tab; if (currentChannel()) go(null, null); else schedule('main'); },
  'friend-add': async el => { if (await act('friend:request', { username: el.dataset.username })) { toast('Friend request sent!'); closePopover(); } },
  'friend-accept': el => act('friend:accept', { userId: el.dataset.uid }),
  'friend-remove': el => act('friend:remove', { userId: el.dataset.uid }),
  'friend-unblock': el => act('friend:unblock', { userId: el.dataset.uid }),
  'friend-menu': (el, e) => {
    e.stopPropagation();
    const uid = el.dataset.uid;
    menu([
      { label: 'Start voice call', icon: '📞', run: async () => { const r = await act('dm:open', { userId: uid }); if (r) { addDm(r.channel); go(null, r.channel.id); startCall(r.channel.id); } } },
      { label: 'Remove friend', icon: '💔', danger: true, run: async () => { if (await confirmBox('Remove friend', `Remove <b>${esc(user(uid).displayName)}</b> from your friends?`, 'Remove')) act('friend:remove', { userId: uid }); } },
      { label: 'Block', icon: '🚫', danger: true, run: () => act('friend:block', { userId: uid }) },
    ], el);
  },
  'profile': (el, e) => {
    const uid = el.dataset.uid || el.closest('[data-uid]')?.dataset.uid;
    if (!uid || !S.users[uid]) return;
    e.stopPropagation();
    popover(profileCardHtml(user(uid)), el, { side: el.closest('.members') ? 'left' : 'right' });
  },
  'status-menu': el => {
    const set = status => act('profile:update', { status });
    menu([
      { label: 'Online', icon: '🟢', run: () => set('online') },
      { label: 'Idle', icon: '🌙', run: () => set('idle') },
      { label: 'Do Not Disturb', icon: '⛔', run: () => set('dnd') },
      { label: 'Invisible', icon: '⚪', run: () => set('invisible') },
      '-',
      { label: 'Set custom status', icon: '😀', run: async () => { const v = await promptBox('Set a custom status', "What's happening?", S.me.customStatus || '', 'Save', { max: 80 }); if (v !== null) act('profile:update', { customStatus: v }); } },
      { label: 'Edit profile', icon: '✏️', run: () => openSettings('profile') },
      { label: 'Copy username', icon: '📋', run: () => { navigator.clipboard?.writeText(S.me.username); toast('Copied!'); } },
    ], el, { side: 'top' });
  },
  'open-settings': el => { closePopover(); openSettings(el.dataset.tab || 'account'); },
  'quick-switch': () => quickSwitcher(),
  'add-server': () => addServerModal(),
  'join-server': () => joinServerModal(),
  'server-menu': el => serverMenu(currentServer(), el),
  'create-channel': (el, e) => { e.stopPropagation(); createChannelModal(currentServer(), el.dataset.type); },
  'channel-settings': (el, e) => { e.stopPropagation(); channelSettings(S.channels[el.dataset.id]); },
  'new-group': () => groupModal(),
  'add-to-group': () => groupModal(currentChannel()),
  'rename-group': async () => {
    const ch = currentChannel();
    const v = await promptBox('Rename group', 'Group name', ch.name || '', 'Save', { max: 40 });
    if (v !== null) act('channel:update', { channelId: ch.id, name: v });
  },
  'pins': () => pinsModal(),
  'search': () => searchModal(),
  'load-more': () => loadMessages(S.view.channelId, true),
  'attach': async () => addFiles(await pickFile('', true)),
  'remove-pending': el => { S.pending.splice(+el.dataset.i, 1); renderPending(); },
  'open-picker': el => openPicker(el, el.dataset.tab),
  'cancel-reply': () => { S.replyTo = null; renderComposerTop(); },
  'spoiler': el => el.classList.add('shown'),
  'lightbox': el => lightbox(el.dataset.src),
  'jump': el => {
    const t = $(`.msg[data-id="${CSS.escape(el.dataset.id)}"]`);
    if (!t) return toast('That message is too far back — scroll up to load it.');
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.classList.remove('highlight');
    void t.offsetWidth;
    t.classList.add('highlight');
  },
  'vote': el => { const m = msgOf(el); if (m) act('poll:vote', { channelId: m.channelId, id: m.id, option: +el.dataset.opt }); },
  'react-toggle': el => { const m = msgOf(el); if (m && !m.ephemeral) act('message:react', { channelId: m.channelId, id: m.id, emoji: el.dataset.emoji }); },
  'msg-react': el => {
    const m = msgOf(el);
    if (!m) return;
    openPicker(el, 'emoji', '', item => { closePopover(); act('message:react', { channelId: m.channelId, id: m.id, emoji: item.emoji }); });
  },
  'msg-reply': el => {
    const m = msgOf(el);
    if (!m) return;
    S.replyTo = m.id;
    renderComposerTop();
    $('#input')?.focus();
  },
  'msg-edit': el => { const m = msgOf(el); if (m) startEdit(m.id); },
  'edit-save': () => saveEdit(),
  'edit-cancel': () => cancelEdit(),
  'msg-delete': async (el, e) => {
    const m = msgOf(el);
    if (!m) return;
    if (e.shiftKey || await confirmBox('Delete message', 'Are you sure you want to delete this message? <br><small class="muted">Tip: hold Shift to skip this.</small>', 'Delete')) {
      act('message:delete', { channelId: m.channelId, id: m.id });
    }
  },
  'msg-more': (el, e) => { const m = msgOf(el); if (m) messageMenu(m, el); },
};

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const fn = ACT[t.dataset.act];
  if (!fn) return;
  if (t.tagName === 'A') e.preventDefault();
  fn(t, e);
});
document.addEventListener('mousedown', e => {
  if (!e.target.closest('.popover') && !e.target.closest('[data-act="open-picker"], [data-act="msg-react"]')) closePopover();
});

// ---------------------------------------------------------------- context menus
function messageMenu(m, anchor) {
  const ch = S.channels[m.channelId];
  const s = ch?.serverId && S.servers[ch.serverId];
  const mine = m.authorId === S.me.id;
  const canPin = !s || isAdminOf(s);
  menu([
    { html: `<div style="display:flex;gap:2px;padding:4px">${QUICK_REACTIONS.map(e => `<button class="icon-btn" data-quick="${e}" style="font-size:18px">${e}</button>`).join('')}</div>` },
    { label: 'Reply', icon: '↩️', run: () => { S.replyTo = m.id; renderComposerTop(); $('#input')?.focus(); } },
    mine && m.content ? { label: 'Edit message', icon: '✏️', run: () => startEdit(m.id) } : null,
    canPin ? { label: m.pinned ? 'Unpin message' : 'Pin message', icon: '📌', run: () => act('message:pin', { channelId: m.channelId, id: m.id }) } : null,
    m.content ? { label: 'Copy text', icon: '📋', run: () => { navigator.clipboard?.writeText(m.content); toast('Copied!'); } } : null,
    { label: 'Ask Hearth AI about this', icon: '✨', run: () => {
      const ta = $('#input');
      if (ta) { ta.value = `/ai about ${user(m.authorId).displayName}'s message "${(m.content || '').slice(0, 300)}": `; ta.focus(); autosize(ta); }
    } },
    mine || isAdminOf(s) ? '-' : null,
    mine || isAdminOf(s) ? { label: 'Delete message', icon: '🗑️', danger: true, run: () => act('message:delete', { channelId: m.channelId, id: m.id }) } : null,
  ], anchor instanceof Element ? anchor : anchor);
  $('#popover-root .menu').addEventListener('click', e => {
    const q = e.target.closest('[data-quick]');
    if (q) { closePopover(); act('message:react', { channelId: m.channelId, id: m.id, emoji: q.dataset.quick }); }
  });
}

function serverMenu(s, anchor) {
  if (!s) return;
  const admin = isAdminOf(s);
  menu([
    { label: 'Invite People', icon: '📨', run: () => inviteModal(s) },
    admin ? { label: 'Server Settings', icon: '⚙️', run: () => openServerSettings(s) } : null,
    admin ? { label: 'Create Text Channel', icon: '#', run: () => createChannelModal(s, 'text') } : null,
    admin ? { label: 'Create Voice Channel', icon: '🔊', run: () => createChannelModal(s, 'voice') } : null,
    { label: 'Mark as read', icon: '✔', run: () => { s.channels.forEach(c => { delete S.unread[c.id]; delete S.mentions[c.id]; }); schedule('rail', 'side'); } },
    '-',
    s.ownerId === S.me.id
      ? { label: 'Delete Server', icon: '🗑️', danger: true, run: () => deleteServer(s) }
      : { label: 'Leave Server', icon: '🚪', danger: true, run: async () => { if (await confirmBox(`Leave '${s.name}'`, `Are you sure you want to leave <b>${esc(s.name)}</b>?`, 'Leave Server')) act('server:leave', { serverId: s.id }); } },
  ], anchor);
}

document.addEventListener('contextmenu', e => {
  const t = e.target.closest('[data-ctx]');
  if (!t || e.target.closest('a, textarea, input')) return;
  e.preventDefault();
  const pos = { x: e.clientX, y: e.clientY };
  const kind = t.dataset.ctx;
  if (kind === 'msg') { const m = msgOf(t); if (m && !m.ephemeral) messageMenu(m, pos); }
  else if (kind === 'server') serverMenu(S.servers[t.dataset.id], pos);
  else if (kind === 'channel') {
    const ch = S.channels[t.dataset.id];
    const s = S.servers[ch.serverId];
    menu([
      { label: 'Mark as read', icon: '✔', run: () => { delete S.unread[ch.id]; delete S.mentions[ch.id]; schedule('rail', 'side'); } },
      ch.type === 'voice' ? { label: V.channelId === ch.id ? 'Disconnect' : 'Join voice', icon: '🔊', run: () => V.channelId === ch.id ? leaveVoice() : joinVoice(ch.id) } : null,
      isAdminOf(s) ? { label: 'Edit channel', icon: '⚙️', run: () => channelSettings(ch) } : null,
      isAdminOf(s) ? { label: 'Move up', icon: '⬆️', run: () => act('channel:move', { channelId: ch.id, dir: -1 }) } : null,
      isAdminOf(s) ? { label: 'Move down', icon: '⬇️', run: () => act('channel:move', { channelId: ch.id, dir: 1 }) } : null,
      { label: 'Copy invite to server', icon: '📨', run: () => copyInvite(s) },
    ], pos);
  } else if (kind === 'dm') {
    const ch = S.channels[t.dataset.id];
    menu([
      { label: 'Mark as read', icon: '✔', run: () => { delete S.unread[ch.id]; delete S.mentions[ch.id]; schedule('rail', 'side'); } },
      ch.type === 'group' ? { label: 'Leave group', icon: '🚪', danger: true, run: () => act('group:leave', { channelId: ch.id }) } : null,
    ], pos);
  } else if (kind === 'member' || kind === 'voice-user') {
    const uid = t.dataset.uid;
    const u = user(uid);
    const s = currentServer();
    const items = [
      { label: 'Profile', icon: '👤', run: () => popover(profileCardHtml(u), pos) },
      uid !== S.me.id ? { label: 'Message', icon: '💬', run: () => ACT['open-dm']({ dataset: { uid } }) } : null,
      uid !== S.me.id && !u.bot && !S.friends.friends.includes(uid) ? { label: 'Add friend', icon: '➕', run: () => act('friend:request', { username: u.username }).then(r => r && toast('Friend request sent!')) } : null,
    ];
    if (kind === 'voice-user' && uid !== S.me.id) {
      items.push('-', { html: `<div style="padding:6px 8px"><div style="font-size:12px;color:var(--text-3)">User volume</div><input type="range" min="0" max="100" value="${prefs.volumes?.[uid] ?? 100}" data-vol="${esc(uid)}"></div>` });
    }
    if (s && isAdminOf(s) && uid !== s.ownerId && uid !== S.me.id && !u.bot) {
      items.push('-',
        s.ownerId === S.me.id ? { label: s.admins.includes(uid) ? 'Remove admin' : 'Make admin', icon: '🛡️', run: () => act('server:admin', { serverId: s.id, userId: uid }) } : null,
        { label: `Kick ${u.displayName}`, icon: '👢', danger: true, run: async () => { if (await confirmBox('Kick member', `Kick <b>${esc(u.displayName)}</b>? They can rejoin with an invite.`, 'Kick')) act('server:kick', { serverId: s.id, userId: uid }); } },
        { label: `Ban ${u.displayName}`, icon: '🔨', danger: true, run: async () => { if (await confirmBox('Ban member', `Ban <b>${esc(u.displayName)}</b>? They won't be able to rejoin.`, 'Ban')) act('server:ban', { serverId: s.id, userId: uid }); } });
    }
    if (uid !== S.me.id && !u.bot) items.push({ label: 'Block', icon: '🚫', danger: true, run: () => act('friend:block', { userId: uid }) });
    const el = menu(items, pos);
    el.querySelector('[data-vol]')?.addEventListener('input', ev => {
      const v = +ev.target.value;
      setPref('volumes', { ...(prefs.volumes || {}), [uid]: v });
      for (const p of V.peers.values()) if (p.userId === uid && p.audioEl) p.audioEl.volume = v / 100;
    });
  }
});

// ---------------------------------------------------------------- keyboard shortcuts
document.addEventListener('keydown', e => {
  if (!S.me) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); quickSwitcher(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); toggleMute(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); toggleDeafen(); return; }
  if (e.key === 'Escape') {
    if ($('#popover-root').firstChild) { closePopover(); return; }
    if (closeTopModal()) return;
    if (S.editing) cancelEdit();
  }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const s = currentServer();
    const list = s ? s.channels.filter(c => c.type === 'text') : Object.values(S.dms);
    const i = list.findIndex(c => c.id === S.view.channelId);
    const next = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
    if (next) { e.preventDefault(); go(next.serverId, next.id); }
  }
  // Typing anywhere jumps into the composer.
  if (!mod && !e.altKey && e.key.length === 1 && !e.target.closest('input, textarea, select, [contenteditable]') && !$('#modal-root').firstChild) {
    $('#input')?.focus();
  }
});

// ---------------------------------------------------------------- servers
function addServerModal() {
  const m = modal(`<div class="modal-head" style="text-align:center"><h2>Create a server</h2><p>Your server is where you and your friends hang out. Make yours and start talking.</p></div>
    <div class="modal-body">
      <button class="choice" data-c="create"><span class="ci">🏡</span><div><b>Create My Own</b><div class="muted" style="font-size:13px">For me and my friends</div></div></button>
      <button class="choice" data-c="join"><span class="ci">🧭</span><div><b>Join a Server</b><div class="muted" style="font-size:13px">I have an invite link</div></div></button>
    </div>`);
  m.el.addEventListener('click', e => {
    const c = e.target.closest('[data-c]');
    if (!c) return;
    m.close();
    c.dataset.c === 'create' ? createServerModal() : joinServerModal();
  });
}
function createServerModal() {
  let icon = null;
  const m = modal(`<form><div class="modal-head" style="text-align:center"><h2>Customize your server</h2><p>Give your new server a personality with a name and an icon.</p></div>
    <div class="modal-body" style="text-align:center">
      <button type="button" class="rail-btn" id="srv-icon" style="width:80px;height:80px;margin:0 auto 16px;border:2px dashed var(--text-3);background:none;font-size:13px">📷<br>Upload</button>
      <label class="field" style="text-align:left"><span>Server name</span><input name="name" maxlength="50" value="${esc(S.me.displayName)}'s server" required></label>
    </div>
    <div class="modal-foot"><button type="button" class="btn secondary" data-x>Back</button><button class="btn">Create</button></div></form>`);
  m.el.querySelector('[data-x]').onclick = () => { m.close(); addServerModal(); };
  m.el.querySelector('#srv-icon').onclick = async () => {
    const [f] = await pickFile('image/png,image/jpeg,image/gif,image/webp');
    if (!f) return;
    try {
      icon = (await uploadFile(f)).url;
      m.el.querySelector('#srv-icon').innerHTML = `<img src="${esc(icon)}" alt="">`;
    } catch (e) { toast(e.message, true); }
  };
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const r = await act('server:create', { name: e.target.name.value, icon });
    if (!r) return;
    m.close();
    addServer(r.server);
    go(r.server.id);
    inviteModal(r.server);
  };
}
function joinServerModal() {
  const m = modal(`<form><div class="modal-head" style="text-align:center"><h2>Join a Server</h2><p>Enter an invite below to join an existing server.</p></div>
    <div class="modal-body"><label class="field"><span>Invite link or code</span><input name="invite" required placeholder="${esc(location.origin)}/?invite=hTKzmak" autocomplete="off"></label>
    <p class="muted" style="font-size:13px">Invites look like <code>hTKzmak</code> or <code>${esc(location.origin)}/?invite=hTKzmak</code></p></div>
    <div class="modal-foot"><button type="button" class="btn secondary" data-x>Cancel</button><button class="btn">Join Server</button></div></form>`);
  m.el.querySelector('[data-x]').onclick = () => m.close();
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const r = await act('server:join', { invite: e.target.invite.value });
    if (r) { m.close(); addServer(r.server); go(r.server.id); toast(`Welcome to ${r.server.name}!`); }
  };
}
const inviteLink = s => `${location.origin}/?invite=${s.invite}`;
function copyInvite(s) {
  navigator.clipboard?.writeText(inviteLink(s)).then(() => toast('Invite link copied!'), () => inviteModal(s));
}
function inviteModal(s) {
  const m = modal(`<div class="modal-head"><h2>Invite friends to ${esc(s.name)}</h2><p>Send this link to anyone — they can sign up and join in seconds.</p></div>
    <div class="modal-body"><div class="add-friend"><input readonly value="${esc(inviteLink(s))}" id="inv"><button class="btn small" data-x>Copy</button></div>
    <p class="muted" style="font-size:13px">Invite code: <code>${esc(s.invite)}</code></p></div>`);
  m.el.querySelector('[data-x]').onclick = () => {
    const inp = m.el.querySelector('#inv');
    inp.select();
    navigator.clipboard?.writeText(inp.value).then(() => toast('Copied!'), () => document.execCommand('copy'));
  };
}
async function deleteServer(s) {
  const v = await promptBox(`Delete '${s.name}'`, 'Type the server name to confirm', '', 'Delete Server', { sub: 'This can\'t be undone. All channels and messages will be gone forever.' });
  if (v === null) return;
  if (v.trim() !== s.name) return toast('Server name did not match.', true);
  if (await act('server:delete', { serverId: s.id })) toast('Server deleted.');
}
function createChannelModal(s, type = 'text') {
  if (!s) return;
  const m = modal(`<form><div class="modal-head"><h2>Create Channel</h2></div><div class="modal-body">
    <label class="radio-row"><input type="radio" name="type" value="text" ${type === 'text' ? 'checked' : ''}> <b>#</b> Text — send messages, images, GIFs, stickers, polls</label>
    <label class="radio-row"><input type="radio" name="type" value="voice" ${type === 'voice' ? 'checked' : ''}> 🔊 Voice — hang out with voice, video and screen share</label>
    <label class="field" style="margin-top:12px"><span>Channel name</span><input name="name" maxlength="40" required placeholder="new-channel"></label>
    </div><div class="modal-foot"><button type="button" class="btn secondary" data-x>Cancel</button><button class="btn">Create Channel</button></div></form>`);
  m.el.querySelector('[data-x]').onclick = () => m.close();
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const r = await act('channel:create', { serverId: s.id, name: e.target.name.value, type: e.target.type.value });
    if (r) { m.close(); go(s.id, r.channel.id); }
  };
}
function channelSettings(ch) {
  if (!ch) return;
  const voiceCh = ch.type === 'voice';
  const m = modal(`<form><div class="modal-head"><h2>${voiceCh ? '🔊' : '#'} ${esc(ch.name)}</h2><p>Channel settings</p></div><div class="modal-body">
    <label class="field"><span>Channel name</span><input name="name" maxlength="40" value="${esc(ch.name)}"></label>
    ${voiceCh ? '' : `<label class="field"><span>Channel topic</span><textarea name="topic" maxlength="300">${esc(ch.topic || '')}</textarea></label>
    <div class="section row-between"><div><b>✨ AI auto-reply</b><div class="muted" style="font-size:13px">Hearth AI answers every message in this channel${S.features.ai ? '' : ' (needs an API key on the server)'}. Anyone can still use <code>/ai</code> or <code>@hearthai</code> anywhere.</div></div>
      <label class="toggle"><input type="checkbox" name="ai" ${ch.aiEnabled ? 'checked' : ''}><span></span></label></div>
    <label class="field"><span>Slowmode</span><select name="slowmode">${[0, 5, 10, 30, 60, 300, 900, 3600].map(v => `<option value="${v}" ${(ch.slowmode || 0) === v ? 'selected' : ''}>${v === 0 ? 'Off' : v < 60 ? v + ' seconds' : v / 60 + ' minute' + (v > 60 ? 's' : '')}</option>`).join('')}</select></label>`}
    </div><div class="modal-foot" style="justify-content:space-between"><button type="button" class="btn danger" data-del>Delete Channel</button>
    <div style="display:flex;gap:8px"><button type="button" class="btn secondary" data-x>Cancel</button><button class="btn">Save</button></div></div></form>`);
  m.el.querySelector('[data-x]').onclick = () => m.close();
  m.el.querySelector('[data-del]').onclick = async () => {
    m.close();
    if (await confirmBox('Delete Channel', `Delete <b>${esc(ch.name)}</b> and all its messages? This can't be undone.`, 'Delete Channel')) {
      if (await act('channel:delete', { channelId: ch.id }) && S.view.channelId === ch.id) go(ch.serverId);
    }
  };
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const data = { channelId: ch.id, name: f.name.value };
    if (!voiceCh) Object.assign(data, { topic: f.topic.value, aiEnabled: f.ai.checked, slowmode: +f.slowmode.value });
    if (await act('channel:update', data)) m.close();
  };
}

// ---------------------------------------------------------------- DMs, search, pins, quick switcher
function groupModal(existing) {
  const friends = S.friends.friends.filter(id => !existing?.members.includes(id));
  if (!friends.length) return toast(existing ? 'All your friends are already here.' : 'Add some friends first!', true);
  const m = modal(`<form><div class="modal-head"><h2>${existing ? 'Add friends to group' : 'Create a group DM'}</h2><p>Pick up to 9 friends.</p></div>
    <div class="modal-body">${existing ? '' : '<label class="field"><span>Group name (optional)</span><input name="gname" maxlength="40"></label>'}
    ${friends.map(id => `<label class="radio-row"><input type="checkbox" value="${esc(id)}"> ${avatarHtml(user(id), 'av-xs')} ${esc(user(id).displayName)} <span class="muted">@${esc(user(id).username)}</span></label>`).join('')}</div>
    <div class="modal-foot"><button type="button" class="btn secondary" data-x>Cancel</button><button class="btn">${existing ? 'Add' : 'Create Group'}</button></div></form>`);
  m.el.querySelector('[data-x]').onclick = () => m.close();
  m.el.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const ids = $$('input[type=checkbox]:checked', m.el).map(i => i.value);
    if (!ids.length) return toast('Pick at least one friend.', true);
    if (existing) {
      for (const id of ids) await act('group:add', { channelId: existing.id, userId: id });
      m.close();
      return;
    }
    const r = await act('group:create', { userIds: ids, name: e.target.gname.value });
    if (r) { m.close(); addDm(r.channel); go(null, r.channel.id); }
  };
}

function messageResultsHtml(list) {
  return list.length ? list.map(m => {
    const u = user(m.authorId);
    const ch = S.channels[m.channelId];
    return `<div class="list-row" data-go="${m.channelId}" data-mid="${m.id}" style="cursor:pointer;align-items:flex-start">${avatarHtml(u, 'av-sm')}
      <div class="grow"><b>${esc(u.displayName)}</b> <span class="muted" style="font-size:12px">${ch?.serverId ? '#' + esc(ch.name) + ' · ' : ''}${esc(fmtTime(m.createdAt))}</span>
      <div style="word-break:break-word">${m.content ? md(m.content) : '<i class="muted">attachment</i>'}</div></div></div>`;
  }).join('') : '<div class="empty">Nothing found.</div>';
}
function bindResultClicks(m) {
  m.el.addEventListener('click', e => {
    const r = e.target.closest('[data-go]');
    if (!r) return;
    const ch = S.channels[r.dataset.go];
    m.close();
    if (!ch) return;
    if (S.view.channelId !== ch.id) go(ch.serverId, ch.id);
    setTimeout(() => ACT.jump({ dataset: { id: r.dataset.mid } }), 400);
  });
}
async function pinsModal() {
  const ch = currentChannel();
  const r = await act('messages:pins', { channelId: ch.id });
  if (!r) return;
  const m = modal(`<div class="modal-head"><h2>📌 Pinned Messages</h2></div><div class="modal-body">${r.messages.length ? messageResultsHtml(r.messages) : '<div class="empty"><div class="art">📌</div>This channel has no pinned messages yet.<br>Right-click a message to pin it.</div>'}</div>`, { cls: 'wide' });
  bindResultClicks(m);
}
function searchModal() {
  const ch = currentChannel();
  const s = currentServer();
  const m = modal(`<div class="modal-head"><h2>🔍 Search</h2><p>Search ${s ? `all of <b>${esc(s.name)}</b>` : 'this conversation'}. Tip: <code>from:username</code></p></div>
    <div class="modal-body"><input class="input" placeholder="Search messages"><div id="sres" style="margin-top:12px"></div></div>`, { cls: 'wide' });
  const inp = m.el.querySelector('input');
  inp.addEventListener('input', debounce(async () => {
    const r = await emit('messages:search', s ? { serverId: s.id, q: inp.value } : { channelId: ch.id, q: inp.value });
    m.el.querySelector('#sres').innerHTML = inp.value.trim() ? messageResultsHtml(r.messages || []) : '';
  }, 300));
  bindResultClicks(m);
}
function quickSwitcher() {
  const m = modal(`<div class="modal-body" style="padding:16px"><input class="input" placeholder="Where would you like to go?" style="font-size:18px;padding:14px"><div id="qs" style="margin-top:8px;max-height:50vh;overflow-y:auto"></div>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Ctrl+K anytime · ↑↓ to choose · Enter to go</p></div>`);
  const inp = m.el.querySelector('input');
  let results = [];
  const draw = () => {
    const q = inp.value.toLowerCase().replace(/^[#@]/, '');
    const all = [
      ...Object.values(S.dms).map(c => ({ label: (c.type === 'dm' ? '@' : '👥 ') + chName(c), sub: 'Direct message', go: () => go(null, c.id) })),
      ...Object.values(S.servers).flatMap(s => s.channels.map(c => ({ label: (c.type === 'voice' ? '🔊 ' : '#') + c.name, sub: s.name, go: () => ACT['go-channel']({ dataset: { id: c.id } }) }))),
      ...Object.values(S.servers).map(s => ({ label: '🏠 ' + s.name, sub: 'Server', go: () => go(s.id) })),
      ...S.friends.friends.map(id => ({ label: '@' + user(id).displayName, sub: 'Friend', go: () => ACT['open-dm']({ dataset: { uid: id } }) })),
    ];
    results = all.filter(r => r.label.toLowerCase().includes(q)).slice(0, 12);
    m.el.querySelector('#qs').innerHTML = results.map((r, i) => `<div class="list-row ${i === 0 ? 'sel' : ''}" data-i="${i}" style="cursor:pointer;${i === 0 ? 'background:var(--active)' : ''}"><div class="grow">${esc(r.label)}</div><span class="muted" style="font-size:12px">${esc(r.sub)}</span></div>`).join('');
  };
  inp.addEventListener('input', draw);
  inp.addEventListener('keydown', e => {
    const rows = $$('#qs .list-row', m.el);
    let i = rows.findIndex(r => r.classList.contains('sel'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows[i]) { rows[i].classList.remove('sel'); rows[i].style.background = ''; }
      i = (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      if (rows[i]) { rows[i].classList.add('sel'); rows[i].style.background = 'var(--active)'; }
    } else if (e.key === 'Enter' && results[i]) { m.close(); results[i].go(); }
  });
  m.el.querySelector('#qs').addEventListener('click', e => {
    const r = e.target.closest('[data-i]');
    if (r) { m.close(); results[r.dataset.i].go(); }
  });
  draw();
}

// ---------------------------------------------------------------- full-screen settings shell
function settingsShell(navHtml, onTab, firstTab, onClose) {
  const el = document.createElement('div');
  el.className = 'settings-full';
  el.innerHTML = `<div class="settings"><nav class="settings-nav"><div>${navHtml}</div></nav><div class="settings-content"><div id="set-body"></div></div></div>
    <button class="settings-close" title="Close (Esc)">✕</button>`;
  $('#modal-root').append(el);
  const close = () => { el.remove(); onClose?.(); };
  el._close = close;
  el.querySelector('.settings-close').onclick = close;
  const show = tab => {
    $$('.settings-nav [data-tab]', el).forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    el.querySelector('.settings').classList.add('show-content');
    onTab(tab, el.querySelector('#set-body'), close);
  };
  el.querySelector('.settings-nav').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) show(b.dataset.tab);
  });
  show(firstTab);
  if (innerWidth <= 760) el.querySelector('.settings').classList.remove('show-content');
  return el;
}

// ---------------------------------------------------------------- user settings
let micTestStop = null;
function openSettings(tab = 'account') {
  settingsShell(`<h5>User Settings</h5>
      <button data-tab="account">My Account</button><button data-tab="profile">Profile</button>
      <h5>App Settings</h5>
      <button data-tab="appearance">Appearance</button><button data-tab="voice">Voice & Video</button>
      <button data-tab="notifications">Notifications</button><button data-tab="keys">Keybinds</button>
      <h5></h5><button data-tab="logout" class="danger">Log Out</button>`,
  (t, body, close) => {
    micTestStop?.();
    const back = '<button class="btn secondary small" data-back style="margin-bottom:16px">‹ Back</button>';
    const render = USER_TABS[t];
    if (!render) return;
    render(body, close);
    if (innerWidth <= 760) {
      body.insertAdjacentHTML('afterbegin', back);
      body.querySelector('[data-back]').onclick = () => body.closest('.settings').classList.remove('show-content');
    }
  }, tab, () => micTestStop?.());
}

const USER_TABS = {
  account(body) {
    const me = user(S.me.id);
    body.innerHTML = `<h2>My Account</h2>
      <div class="section" style="padding:0;overflow:hidden">${profileCardHtml(me, true)}</div>
      <div class="section">
        <div class="row-between"><div><b>Display name</b><div class="muted">${esc(me.displayName)}</div></div><button class="btn secondary small" data-e="displayName">Edit</button></div><br>
        <div class="row-between"><div><b>Username</b><div class="muted">@${esc(me.username)}</div></div><button class="btn secondary small" data-e="username">Edit</button></div>
      </div>
      <h3>Password</h3>
      <form class="section" id="pw"><label class="field"><span>Current password</span><input type="password" name="o" required autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input type="password" name="n" required minlength="6" autocomplete="new-password"></label>
        <button class="btn">Change Password</button></form>`;
    body.querySelector('[data-e=displayName]').onclick = async () => {
      const v = await promptBox('Change display name', 'Display name', me.displayName, 'Done', { max: 32 });
      if (v !== null && await act('profile:update', { displayName: v })) USER_TABS.account(body);
    };
    body.querySelector('[data-e=username]').onclick = async () => {
      const v = await promptBox('Change username', 'Username', me.username, 'Done', { max: 32, sub: 'Letters, numbers, _ and . only.' });
      if (v !== null && await act('account:username', { username: v })) setTimeout(() => USER_TABS.account(body), 200);
    };
    body.querySelector('#pw').onsubmit = async e => {
      e.preventDefault();
      if (await act('account:password', { oldPassword: e.target.o.value, newPassword: e.target.n.value })) { toast('Password changed!'); e.target.reset(); }
    };
  },

  profile(body) {
    const me = user(S.me.id);
    const draft = { displayName: me.displayName, avatar: me.avatar, banner: me.banner || colorFor(me.id), bio: me.bio || '', customStatus: me.customStatus || '' };
    const preview = () => { body.querySelector('#pp').innerHTML = profileCardHtml({ ...me, ...draft }); };
    body.innerHTML = `<h2>Profile</h2><div style="display:flex;gap:24px;flex-wrap:wrap">
      <form id="pf" style="flex:1;min-width:260px">
        <label class="field"><span>Display name</span><input name="displayName" maxlength="32" value="${esc(draft.displayName)}"></label>
        <div class="field"><span>Avatar</span><button type="button" class="btn small" data-up="avatar">Change Avatar</button> <button type="button" class="btn small secondary" data-rm="avatar">Remove</button>
          <div class="muted" style="font-size:12px;margin-top:4px">PNG, JPG, GIF (animated avatars work!) or WEBP.</div></div>
        <div class="field"><span>Banner</span><div class="color-dots">${PALETTE.map(c => `<button type="button" class="color-dot" data-bc="${c}" style="background:${c}"></button>`).join('')}
          <input type="color" data-bcustom value="${/^#/.test(draft.banner) ? draft.banner : '#7c5cff'}" style="width:36px;height:32px;border:0;background:none;padding:0">
          <button type="button" class="btn small secondary" data-up="banner">Upload image</button></div></div>
        <label class="field"><span>Custom status</span><input name="customStatus" maxlength="80" value="${esc(draft.customStatus)}" placeholder="🎮 playing something"></label>
        <label class="field"><span>About me</span><textarea name="bio" maxlength="190" placeholder="Tell everyone about yourself">${esc(draft.bio)}</textarea></label>
        <button class="btn">Save Changes</button>
      </form>
      <div><div class="field"><span>Preview</span></div><div id="pp"></div></div></div>`;
    preview();
    const f = body.querySelector('#pf');
    f.addEventListener('input', e => {
      if (e.target.name) draft[e.target.name] = e.target.value;
      if (e.target.dataset.bcustom !== undefined) draft.banner = e.target.value;
      preview();
    });
    f.addEventListener('click', async e => {
      const up = e.target.closest('[data-up]'), rm = e.target.closest('[data-rm]'), bc = e.target.closest('[data-bc]');
      if (bc) { draft.banner = bc.dataset.bc; preview(); }
      if (rm) { draft[rm.dataset.rm] = null; preview(); }
      if (up) {
        const [file] = await pickFile('image/png,image/jpeg,image/gif,image/webp');
        if (!file) return;
        try { draft[up.dataset.up] = (await uploadFile(file)).url; preview(); } catch (err) { toast(err.message, true); }
      }
    });
    f.onsubmit = async e => {
      e.preventDefault();
      if (await act('profile:update', draft)) toast('Profile saved!');
    };
  },

  appearance(body) {
    const draw = () => {
      body.innerHTML = `<h2>Appearance</h2>
        <h3>Theme</h3><div class="swatches" style="margin-bottom:28px">${THEMES.map(([k, l, c]) => `<button class="swatch ${prefs.theme === k ? 'sel' : ''}" data-theme="${k}" style="background:${c};box-shadow:inset 0 0 0 1px rgba(128,128,128,.4)"><small>${l}</small></button>`).join('')}</div>
        <h3>Accent color</h3><div class="color-dots" style="margin-bottom:20px">${ACCENTS.map(c => `<button class="color-dot ${prefs.accent === c ? 'sel' : ''}" data-accent="${c}" style="background:${c}"></button>`).join('')}
          <label title="Custom color" style="display:flex;align-items:center;gap:6px">🎨 <input type="color" value="${prefs.accent}" data-accent-custom style="width:40px;height:32px;border:0;background:none;padding:0"></label></div>
        <h3>Chat background</h3><div class="bg-grid">${Object.keys(BACKGROUNDS).map(k => `<button class="bg-opt ${prefs.bg === k ? 'sel' : ''}" data-bg="${k}" style="background:${BACKGROUNDS[k] || 'var(--input)'}">${k}</button>`).join('')}
          <button class="bg-opt ${prefs.bg.startsWith('/uploads/') ? 'sel' : ''}" data-bg-upload style="${prefs.bg.startsWith('/uploads/') ? `background:url('${esc(prefs.bg)}') center/cover` : 'background:var(--input);color:var(--text)'}">📷 Your image</button></div>
        <label class="field" style="margin-top:12px"><span>Background strength — ${Math.round(prefs.bgOpacity * 100)}%</span><input type="range" min="0.05" max="1" step="0.05" value="${prefs.bgOpacity}" data-range="bgOpacity"></label>
        <h3>Text & layout</h3>
        <label class="field"><span>Chat font size — ${prefs.fontSize}px</span><input type="range" min="12" max="20" step="1" value="${prefs.fontSize}" data-range="fontSize"></label>
        <div class="section row-between"><div><b>Compact mode</b><div class="muted" style="font-size:13px">Fit more messages on screen.</div></div><label class="toggle"><input type="checkbox" data-bool="compact" ${prefs.compact ? 'checked' : ''}><span></span></label></div>
        <div class="section row-between"><div><b>Reduce motion</b><div class="muted" style="font-size:13px">Turn off animations.</div></div><label class="toggle"><input type="checkbox" data-bool="reduceMotion" ${prefs.reduceMotion ? 'checked' : ''}><span></span></label></div>
        <p class="muted" style="font-size:13px">Your appearance settings are saved to your account and follow you to every device.</p>`;
    };
    draw();
    body.onclick = async e => {
      const t = e.target.closest('[data-theme],[data-accent],[data-bg],[data-bg-upload]');
      if (!t) return;
      if (t.dataset.theme) setPref('theme', t.dataset.theme);
      else if (t.dataset.accent) setPref('accent', t.dataset.accent);
      else if (t.dataset.bg) setPref('bg', t.dataset.bg);
      else {
        const [f] = await pickFile('image/png,image/jpeg,image/gif,image/webp');
        if (!f) return;
        try { setPref('bg', (await uploadFile(f)).url); } catch (err) { return toast(err.message, true); }
      }
      draw();
    };
    body.oninput = e => {
      const t = e.target;
      if (t.dataset.range) { setPref(t.dataset.range, +t.value); t.previousElementSibling.textContent = t.dataset.range === 'fontSize' ? `Chat font size — ${t.value}px` : `Background strength — ${Math.round(t.value * 100)}%`; }
      if (t.dataset.accentCustom !== undefined) setPref('accent', t.value);
    };
    body.onchange = e => { if (e.target.dataset.bool) setPref(e.target.dataset.bool, e.target.checked); };
  },

  async voice(body) {
    body.innerHTML = '<h2>Voice & Video</h2><p class="muted">Loading devices…</p>';
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
      if (devices.some(d => d.kind === 'audioinput' && !d.label)) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        stopStream(s);
        devices = await navigator.mediaDevices.enumerateDevices();
      }
    } catch {}
    const opts = (kind, cur) => `<option value="">Default</option>` + devices.filter(d => d.kind === kind).map(d => `<option value="${esc(d.deviceId)}" ${cur === d.deviceId ? 'selected' : ''}>${esc(d.label || kind)}</option>`).join('');
    body.innerHTML = `<h2>Voice & Video</h2>
      <label class="field"><span>Input device (microphone)</span><select data-dev="mic">${opts('audioinput', prefs.mic)}</select></label>
      <label class="field"><span>Output device (speakers)</span><select data-dev="speaker">${opts('audiooutput', prefs.speaker)}</select></label>
      <label class="field"><span>Camera</span><select data-dev="cam">${opts('videoinput', prefs.cam)}</select></label>
      <div class="section"><b>Mic test</b><div class="muted" style="font-size:13px;margin-bottom:8px">Say something — the bar should move.</div>
        <div style="height:10px;background:var(--rail);border-radius:5px;overflow:hidden"><div id="meter" style="height:100%;width:0;background:var(--green);transition:width .08s"></div></div>
        <button class="btn small" style="margin-top:10px" id="mictest">Let's Check</button></div>
      <div class="section row-between"><div><b>Noise suppression</b></div><label class="toggle"><input type="checkbox" data-bool="noise" ${prefs.noise ? 'checked' : ''}><span></span></label></div>
      <div class="section row-between"><div><b>Echo cancellation</b></div><label class="toggle"><input type="checkbox" data-bool="echo" ${prefs.echo ? 'checked' : ''}><span></span></label></div>
      <p class="muted" style="font-size:13px">Device changes apply the next time you join a call. Shortcuts: Ctrl+Shift+M mute, Ctrl+Shift+D deafen.</p>`;
    body.onchange = e => {
      if (e.target.dataset.dev) setPref(e.target.dataset.dev, e.target.value);
      if (e.target.dataset.bool) setPref(e.target.dataset.bool, e.target.checked);
    };
    body.querySelector('#mictest').onclick = async () => {
      if (micTestStop) { micTestStop(); return; }
      let s;
      try { s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: prefs.mic ? { ideal: prefs.mic } : undefined } }); }
      catch { return toast("Couldn't access your microphone.", true); }
      const ctx = new AudioContext(), an = ctx.createAnalyser();
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const iv = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        const m = $('#meter');
        if (m) m.style.width = Math.min(100, peak / 64 * 100) + '%';
      }, 60);
      $('#mictest').textContent = 'Stop Testing';
      micTestStop = () => {
        clearInterval(iv);
        stopStream(s);
        ctx.close();
        micTestStop = null;
        const b = $('#mictest');
        if (b) b.textContent = "Let's Check";
        const m = $('#meter');
        if (m) m.style.width = '0';
      };
    };
  },

  notifications(body) {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    body.innerHTML = `<h2>Notifications</h2>
      <div class="section row-between"><div><b>Desktop notifications</b><div class="muted" style="font-size:13px">For DMs and @mentions while Hearth is in the background. Browser permission: <b>${perm}</b></div></div>
        <label class="toggle"><input type="checkbox" data-bool="notif" ${prefs.notif ? 'checked' : ''}><span></span></label></div>
      <div class="section row-between"><div><b>Sounds</b><div class="muted" style="font-size:13px">Message pings, join/leave and ringtone sounds.</div></div>
        <label class="toggle"><input type="checkbox" data-bool="sounds" ${prefs.sounds ? 'checked' : ''}><span></span></label></div>
      <button class="btn secondary" id="testn">Send a test notification</button>`;
    body.onchange = async e => {
      if (!e.target.dataset.bool) return;
      setPref(e.target.dataset.bool, e.target.checked);
      if (e.target.dataset.bool === 'notif' && e.target.checked && 'Notification' in window) await Notification.requestPermission();
    };
    body.querySelector('#testn').onclick = async () => {
      sound('message');
      if (!('Notification' in window)) return toast('This browser does not support notifications.', true);
      if (await Notification.requestPermission() === 'granted') new Notification('Hearth', { body: 'Notifications are working! 🎉', icon: '/favicon.svg' });
      else toast('Notifications are blocked in your browser settings.', true);
    };
  },

  keys(body) {
    const rows = [['Ctrl + K', 'Quick switcher'], ['Ctrl + Shift + M', 'Toggle mute'], ['Ctrl + Shift + D', 'Toggle deafen'], ['Alt + ↑ / ↓', 'Previous / next channel'],
      ['↑ (empty message box)', 'Edit your last message'], ['Enter', 'Send message'], ['Shift + Enter', 'New line'], ['Esc', 'Close popups / cancel reply or edit'],
      ['Right-click', 'Context menu on messages, members, channels and servers'], ['Shift + click 🗑️', 'Delete without confirming'], ['/', 'Slash commands (try /help)'], ['@ or :', 'Mention or emoji autocomplete']];
    body.innerHTML = `<h2>Keybinds</h2><div class="section">${rows.map(([k, d]) => `<div class="row-between" style="padding:6px 0;border-bottom:1px solid var(--border)"><span>${d}</span><code>${k}</code></div>`).join('')}</div>`;
  },

  async logout(body, close) {
    body.innerHTML = '';
    close();
    if (await confirmBox('Log Out', 'Are you sure you want to log out?', 'Log Out')) logout();
  },
};

// ---------------------------------------------------------------- server settings
function openServerSettings(s) {
  const owner = s.ownerId === S.me.id;
  settingsShell(`<h5>${esc(s.name)}</h5>
      <button data-tab="overview">Overview</button><button data-tab="channels">Channels</button><button data-tab="members">Members</button>
      <button data-tab="stickers">Stickers</button><button data-tab="invites">Invites</button><button data-tab="bans">Bans</button>
      ${owner ? '<h5></h5><button data-tab="delete" class="danger">Delete Server</button>' : ''}`,
  (t, body, close) => {
    const srv = S.servers[s.id];
    if (!srv) return close();
    SERVER_TABS[t]?.(srv, body, close);
    if (innerWidth <= 760) {
      body.insertAdjacentHTML('afterbegin', '<button class="btn secondary small" data-back style="margin-bottom:16px">‹ Back</button>');
      body.querySelector('[data-back]').onclick = () => body.closest('.settings').classList.remove('show-content');
    }
  }, 'overview');
}

const SERVER_TABS = {
  overview(s, body) {
    let icon = s.icon;
    body.innerHTML = `<h2>Server Overview</h2><form id="so" style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
      <div style="text-align:center"><div class="rail-btn" id="si" style="width:100px;height:100px;font-size:28px;margin-bottom:8px">${icon ? `<img src="${esc(icon)}" alt="">` : esc(serverAcronym(s.name))}</div>
        <button type="button" class="btn small" data-up>Upload Image</button><br><button type="button" class="btn link" data-rm style="font-size:13px;margin-top:6px">Remove</button></div>
      <div style="flex:1;min-width:220px"><label class="field"><span>Server name</span><input name="name" maxlength="50" value="${esc(s.name)}"></label><button class="btn">Save Changes</button></div></form>`;
    const si = body.querySelector('#si');
    body.querySelector('[data-up]').onclick = async () => {
      const [f] = await pickFile('image/png,image/jpeg,image/gif,image/webp');
      if (!f) return;
      try { icon = (await uploadFile(f)).url; si.innerHTML = `<img src="${esc(icon)}" alt="">`; } catch (e) { toast(e.message, true); }
    };
    body.querySelector('[data-rm]').onclick = () => { icon = null; si.textContent = serverAcronym(s.name); };
    body.querySelector('#so').onsubmit = async e => {
      e.preventDefault();
      if (await act('server:update', { serverId: s.id, name: e.target.name.value, icon })) toast('Saved!');
    };
  },
  channels(s, body) {
    const draw = srv => {
      body.innerHTML = `<h2>Channels</h2><p class="muted">Reorder, edit or delete channels.</p>
        <button class="btn small" data-new="text"># New text channel</button> <button class="btn small" data-new="voice">🔊 New voice channel</button>
        <div class="section" style="margin-top:12px">${srv.channels.map(c => `<div class="list-row"><span>${c.type === 'voice' ? '🔊' : '#'}</span><div class="grow">${esc(c.name)} ${c.aiEnabled ? '<span class="bot-tag">AI</span>' : ''}</div>
          <button class="icon-btn" data-mv="-1" data-id="${c.id}" title="Move up">⬆️</button><button class="icon-btn" data-mv="1" data-id="${c.id}" title="Move down">⬇️</button>
          <button class="icon-btn" data-ed="${c.id}" title="Edit">⚙️</button></div>`).join('')}</div>`;
    };
    draw(s);
    body.onclick = async e => {
      const t = e.target.closest('[data-mv],[data-ed],[data-new]');
      if (!t) return;
      if (t.dataset.new) return createChannelModal(s, t.dataset.new);
      if (t.dataset.ed) return channelSettings(S.channels[t.dataset.ed]);
      await act('channel:move', { channelId: t.dataset.id, dir: +t.dataset.mv });
      setTimeout(() => S.servers[s.id] && draw(S.servers[s.id]), 150);
    };
  },
  members(s, body) {
    const owner = s.ownerId === S.me.id;
    const draw = srv => {
      body.innerHTML = `<h2>Members — ${srv.members.length}</h2><div class="section">${srv.members.map(id => {
        const u = user(id);
        const role = srv.ownerId === id ? '👑 Owner' : srv.admins.includes(id) ? '🛡️ Admin' : 'Member';
        const can = id !== srv.ownerId && id !== S.me.id && (owner || !srv.admins.includes(id));
        return `<div class="list-row">${avatarHtml(u, 'av-sm', true)}<div class="grow"><b>${esc(u.displayName)}</b> <span class="muted">@${esc(u.username)}</span><div class="muted" style="font-size:12px">${role}</div></div>
          ${owner && id !== srv.ownerId ? `<button class="btn small secondary" data-admin="${esc(id)}">${srv.admins.includes(id) ? 'Remove admin' : 'Make admin'}</button>` : ''}
          ${owner && id !== srv.ownerId ? `<button class="btn small secondary" data-owner="${esc(id)}">Transfer ownership</button>` : ''}
          ${can ? `<button class="btn small secondary" data-kick="${esc(id)}">Kick</button><button class="btn small danger" data-ban="${esc(id)}">Ban</button>` : ''}</div>`;
      }).join('')}</div>`;
    };
    draw(s);
    body.onclick = async e => {
      const t = e.target.closest('[data-admin],[data-kick],[data-ban],[data-owner]');
      if (!t) return;
      const uid = t.dataset.admin || t.dataset.kick || t.dataset.ban || t.dataset.owner;
      const name = esc(user(uid).displayName);
      if (t.dataset.admin) await act('server:admin', { serverId: s.id, userId: uid });
      else if (t.dataset.owner) { if (await confirmBox('Transfer ownership', `Make <b>${name}</b> the owner of this server? You'll lose owner powers.`, 'Transfer')) await act('server:update', { serverId: s.id, ownerId: uid }); }
      else if (t.dataset.kick) { if (await confirmBox('Kick member', `Kick <b>${name}</b>?`, 'Kick')) await act('server:kick', { serverId: s.id, userId: uid }); }
      else if (await confirmBox('Ban member', `Ban <b>${name}</b>?`, 'Ban')) await act('server:ban', { serverId: s.id, userId: uid });
      setTimeout(() => S.servers[s.id] && draw(S.servers[s.id]), 150);
    };
  },
  stickers(s, body) {
    const draw = srv => {
      body.innerHTML = `<h2>Stickers</h2><p class="muted">Upload custom stickers anyone in this server can send (PNG, GIF or WEBP, square works best).</p>
        <button class="btn" data-up>Upload Sticker</button>
        <div class="sticker-grid-admin" style="margin-top:16px">${srv.stickers.map(st => `<div><img src="${esc(st.url)}" alt=""><div>${esc(st.name)}</div><button class="btn link" data-del="${st.id}" style="font-size:12px;color:var(--danger)">Delete</button></div>`).join('') || '<p class="muted">No custom stickers yet.</p>'}</div>`;
    };
    draw(s);
    body.onclick = async e => {
      if (e.target.closest('[data-up]')) {
        const [f] = await pickFile('image/png,image/gif,image/webp,image/jpeg');
        if (!f) return;
        const name = await promptBox('Name your sticker', 'Sticker name', f.name.replace(/\.\w+$/, '').slice(0, 30), 'Upload', { max: 30 });
        if (name === null) return;
        try {
          const up = await uploadFile(f);
          await act('sticker:add', { serverId: s.id, name, url: up.url });
        } catch (err) { toast(err.message, true); }
      }
      const d = e.target.closest('[data-del]');
      if (d) await act('sticker:delete', { serverId: s.id, id: d.dataset.del });
      setTimeout(() => S.servers[s.id] && draw(S.servers[s.id]), 200);
    };
  },
  invites(s, body) {
    body.innerHTML = `<h2>Invites</h2><div class="section"><div class="add-friend"><input readonly value="${esc(inviteLink(s))}"><button class="btn small" data-copy>Copy</button></div>
      <button class="btn secondary small" data-regen>Generate new link</button> <span class="muted" style="font-size:13px">(the old link stops working)</span></div>`;
    body.querySelector('[data-copy]').onclick = () => copyInvite(S.servers[s.id]);
    body.querySelector('[data-regen]').onclick = async () => {
      if (await act('server:update', { serverId: s.id, regenInvite: true })) setTimeout(() => SERVER_TABS.invites(S.servers[s.id], body), 200);
    };
  },
  bans(s, body) {
    body.innerHTML = `<h2>Bans</h2><div class="section"><p>${s.bans} banned user${s.bans === 1 ? '' : 's'}.</p>${s.bans ? '<button class="btn secondary" data-unban>Unban everyone</button>' : ''}</div>`;
    body.querySelector('[data-unban]')?.addEventListener('click', async () => {
      if (await act('server:unbanAll', { serverId: s.id })) { toast('Everyone has been unbanned.'); s.bans = 0; SERVER_TABS.bans(s, body); }
    });
  },
  async delete(s, body, close) {
    body.innerHTML = '';
    close();
    deleteServer(s);
  },
};
