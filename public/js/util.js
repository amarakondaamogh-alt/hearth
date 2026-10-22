'use strict';
// Shared state, helpers, emoji/sticker data, markdown, sounds and preferences.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const AI_ID = 'ai-bot';
const S = {
  token: store.get('hearth.token'),
  me: null, users: {}, servers: {}, dms: {}, channels: {},
  friends: { friends: [], incoming: [], outgoing: [], blocked: [] },
  view: { serverId: null, channelId: null }, lastChannel: store.get('hearth.lastChannel', {}),
  messages: {}, hasMore: {}, loading: {}, unread: {}, mentions: {}, typing: {}, voice: {},
  drafts: {}, pending: [], replyTo: null, editing: null, editText: '',
  friendsTab: 'online', features: {}, ice: [], connected: false, stickBottom: true,
};
let socket = null;

// ---------------------------------------------------------------- formatting
const PALETTE = ['#7c5cff', '#ff6b6b', '#1abc9c', '#f39c12', '#3498db', '#e84393', '#2ecc71', '#e67e22', '#9b59b6', '#16a085'];
function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => [...w][0]).join('').toUpperCase() || '?';
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today at ' + fmtClock(ts);
  if (d.toDateString() === y.toDateString()) return 'Yesterday at ' + fmtClock(ts);
  return d.toLocaleDateString() + ' ' + fmtClock(ts);
}
function fmtDay(ts) {
  return new Date(ts).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function user(id) {
  return S.users[id] || { id, username: 'unknown', displayName: 'Unknown user', presence: 'offline' };
}
function userByName(name) {
  return Object.values(S.users).find(u => u.username === name);
}
function avatarHtml(u, size = '', dot = false) {
  u = u || { id: '?', displayName: '?' };
  const inner = u.avatar
    ? `<img src="${esc(u.avatar)}" alt="" loading="lazy">`
    : `<div class="av-fill" style="background:${colorFor(u.id)}">${esc(initials(u.displayName || u.username))}</div>`;
  return `<div class="av ${size}" data-uid="${esc(u.id)}">${inner}${dot ? `<span class="dot ${esc(u.presence || 'offline')}"></span>` : ''}</div>`;
}
function serverAcronym(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0, 3).map(w => [...w][0]).join('');
}
function chName(ch) {
  if (!ch) return '';
  if (ch.serverId) return ch.name;
  if (ch.type === 'dm') return user(ch.members.find(m => m !== S.me.id) || S.me.id).displayName;
  return ch.name || ch.members.filter(m => m !== S.me.id).map(m => user(m).displayName).join(', ') || 'Empty group';
}

// ---------------------------------------------------------------- toasts / network
function toast(text, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3500);
}
async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}), ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.status = r.status; throw e; }
  return j;
}
function emit(ev, data = {}) {
  return new Promise(res => {
    if (!socket?.connected) return res({ error: 'Not connected — reconnecting…' });
    socket.timeout(20000).emit(ev, data, (err, r) => res(err ? { error: 'Request timed out' } : (r || {})));
  });
}
async function act(ev, data) {
  const r = await emit(ev, data);
  if (r.error) { toast(r.error, true); return null; }
  return r;
}
async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Upload failed');
  return j;
}
function pickFile(accept, multiple = false) {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept || '';
    i.multiple = multiple;
    i.onchange = () => res([...i.files]);
    i.click();
  });
}

// ---------------------------------------------------------------- emoji
const EMOJI_CATS = [
  ['Smileys', '😀 grinning,😃 smiley,😄 smile,😁 grin,😆 laughing,😅 sweat_smile,🤣 rofl,😂 joy,🙂 slight_smile,🙃 upside_down,😉 wink,😊 blush,😇 innocent,🥰 smiling_hearts,😍 heart_eyes,🤩 star_struck,😘 kissing_heart,😋 yum,😛 tongue,😜 winking_tongue,🤪 zany,😝 squinting_tongue,🤑 money_mouth,🤗 hug,🤭 hand_over_mouth,🤫 shush,🤔 thinking,🤐 zipper,🤨 raised_eyebrow,😐 neutral,😑 expressionless,😶 no_mouth,😏 smirk,😒 unamused,🙄 eye_roll,😬 grimace,😌 relieved,😔 pensive,😪 sleepy,🤤 drool,😴 sleeping,😷 mask,🤒 sick,🤕 hurt,🤢 nauseated,🤮 vomit,🥵 hot,🥶 cold,🥴 woozy,😵 dizzy,🤯 mind_blown,🤠 cowboy,🥳 partying,😎 sunglasses,🤓 nerd,🧐 monocle,😕 confused,😟 worried,🙁 frown,😮 open_mouth,😯 hushed,😲 astonished,😳 flushed,🥺 pleading,😨 fearful,😰 anxious,😥 sad_relieved,😢 cry,😭 sob,😱 scream,😖 confounded,😣 persevere,😞 disappointed,😓 sweat,😩 weary,😫 tired,🥱 yawn,😤 triumph,😡 rage,😠 angry,🤬 cursing,😈 smiling_imp,👿 imp,💀 skull,💩 poop,🤡 clown,👻 ghost,👽 alien,🤖 robot,😺 smiley_cat,😹 joy_cat,😻 heart_eyes_cat,🙀 scream_cat,😿 crying_cat'],
  ['People', '👋 wave,🤚 raised_back,✋ hand,🖖 vulcan,👌 ok_hand,🤌 pinched,✌️ v,🤞 crossed_fingers,🤟 love_you,🤘 metal,🤙 call_me,👈 point_left,👉 point_right,👆 point_up,👇 point_down,👍 thumbsup,👎 thumbsdown,✊ fist,👊 punch,👏 clap,🙌 raised_hands,👐 open_hands,🤲 palms_up,🤝 handshake,🙏 pray,💪 muscle,🧠 brain,👀 eyes,👅 tongue_out,👄 lips,🫡 salute,🫶 heart_hands'],
  ['Hearts', '❤️ heart,🧡 orange_heart,💛 yellow_heart,💚 green_heart,💙 blue_heart,💜 purple_heart,🖤 black_heart,🤍 white_heart,🤎 brown_heart,💔 broken_heart,❣️ heart_exclamation,💕 two_hearts,💞 revolving_hearts,💓 heartbeat,💗 heartpulse,💖 sparkling_heart,💘 cupid,💝 gift_heart,💯 100,💢 anger,💥 boom,💫 dizzy_star,💦 sweat_drops,💨 dash,💬 speech,💭 thought,💤 zzz'],
  ['Nature & Food', '🐶 dog,🐱 cat,🐭 mouse,🐹 hamster,🐰 rabbit,🦊 fox,🐻 bear,🐼 panda,🐨 koala,🐯 tiger,🦁 lion,🐮 cow,🐷 pig,🐸 frog,🐵 monkey,🐔 chicken,🐧 penguin,🐦 bird,🦄 unicorn,🐝 bee,🦋 butterfly,🐢 turtle,🐍 snake,🐙 octopus,🦈 shark,🐳 whale,🌵 cactus,🌲 tree,🌸 blossom,🌹 rose,🌻 sunflower,🍀 clover,🍁 maple,🌈 rainbow,☀️ sun,🌙 moon,⭐ star,🌟 glowing_star,⚡ zap,🔥 fire,❄️ snowflake,🌊 ocean,🍎 apple,🍌 banana,🍉 watermelon,🍓 strawberry,🍕 pizza,🍔 burger,🍟 fries,🌮 taco,🍣 sushi,🍜 ramen,🍩 donut,🍪 cookie,🎂 cake,🍿 popcorn,☕ coffee,🧋 boba,🥤 soda'],
  ['Activities', '⚽ soccer,🏀 basketball,🏈 football,⚾ baseball,🎾 tennis,🎮 video_game,🕹️ joystick,🎲 dice,♟️ chess,🎯 dart,🎳 bowling,🎸 guitar,🎹 piano,🎧 headphones,🎤 microphone,🎬 clapper,🎨 art,🏆 trophy,🥇 first_place,🎉 tada,🎊 confetti,🎈 balloon,🎁 gift,📱 phone,💻 laptop,⌨️ keyboard,📷 camera,💡 bulb,📚 books,✏️ pencil,📌 pushpin,🔒 lock,🔑 key,💰 moneybag,💎 gem,🚀 rocket,✈️ airplane,🚗 car,🏠 house,⏰ alarm,⌛ hourglass'],
  ['Symbols', '✅ check,❌ x,❓ question,❗ exclamation,⚠️ warning,🚫 no_entry,✨ sparkles,🎵 music,🔔 bell,🆗 ok,🆒 cool,🆕 new,🔴 red_circle,🟢 green_circle,🔵 blue_circle,⬆️ up,⬇️ down,➡️ right,⬅️ left,🔁 repeat,➕ plus,➖ minus,💲 dollar'],
].map(([name, list]) => [name, list.split(',').map(s => { const i = s.indexOf(' '); return { e: s.slice(0, i), n: s.slice(i + 1) }; })]);
const EMOJI_BY_NAME = {};
EMOJI_CATS.forEach(([, list]) => list.forEach(x => { EMOJI_BY_NAME[x.n] = x.e; }));
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '💀'];

// ---------------------------------------------------------------- built-in stickers (original blob characters)
function blobSvg(color, face) {
  const ink = '#2a1b12';
  const eyes = {
    dots: `<circle cx="46" cy="60" r="6" fill="${ink}"/><circle cx="74" cy="60" r="6" fill="${ink}"/><circle cx="48" cy="58" r="2" fill="#fff"/><circle cx="76" cy="58" r="2" fill="#fff"/>`,
    happy: `<path d="M38 62q8-11 16 0M66 62q8-11 16 0" stroke="${ink}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    closed: `<path d="M38 60q8 7 16 0M66 60q8 7 16 0" stroke="${ink}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    big: `<circle cx="45" cy="58" r="11" fill="#fff"/><circle cx="75" cy="58" r="11" fill="#fff"/><circle cx="46" cy="60" r="6" fill="${ink}"/><circle cx="76" cy="60" r="6" fill="${ink}"/>`,
    squint: `<path d="M38 54l14 7-14 7M82 54l-14 7 14 7" stroke="${ink}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    hearts: `<path d="M46 70l-10-10a6 6 0 0 1 10-7a6 6 0 0 1 10 7z" fill="#e8174a"/><path d="M74 70l-10-10a6 6 0 0 1 10-7a6 6 0 0 1 10 7z" fill="#e8174a"/>`,
    shades: `<rect x="30" y="50" width="26" height="16" rx="6" fill="${ink}"/><rect x="64" y="50" width="26" height="16" rx="6" fill="${ink}"/><rect x="54" y="54" width="12" height="4" fill="${ink}"/><rect x="35" y="53" width="8" height="3" rx="1.5" fill="#fff" opacity=".6"/>`,
    angry: `<path d="M36 50l16 6M84 50l-16 6" stroke="${ink}" stroke-width="5" stroke-linecap="round"/><circle cx="46" cy="63" r="5" fill="${ink}"/><circle cx="74" cy="63" r="5" fill="${ink}"/>`,
  };
  const mouths = {
    smile: `<path d="M46 78q14 14 28 0" stroke="${ink}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    grin: `<path d="M42 76h36q-3 20-18 20t-18-20z" fill="#7a1f2b"/><path d="M50 88q10 6 20 0q-3 8-10 8t-10-8z" fill="#ff7b8a"/>`,
    frown: `<path d="M46 88q14-12 28 0" stroke="${ink}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    o: `<ellipse cx="60" cy="84" rx="8" ry="10" fill="#7a1f2b"/>`,
    small: `<ellipse cx="60" cy="82" rx="4" ry="3" fill="${ink}"/>`,
    smirk: `<path d="M50 82q14 6 24-6" stroke="${ink}" stroke-width="5" fill="none" stroke-linecap="round"/>`,
  };
  const extra = {
    tears: '<path d="M40 70q-4 10 0 14q4-4 0-14zM80 70q-4 10 0 14q4-4 0-14z" fill="#5ab4ff"/>',
    zzz: `<text x="84" y="34" font-family="Arial Black,Arial" font-weight="900" font-size="20" fill="${ink}">Z</text><text x="100" y="20" font-family="Arial Black,Arial" font-weight="900" font-size="13" fill="${ink}">z</text>`,
    hat: '<path d="M60 0l16 30H44z" fill="#ff4d8d"/><circle cx="60" cy="2" r="5" fill="#ffe14d"/><path d="M50 22h20M54 12h12" stroke="#ffe14d" stroke-width="3"/><circle cx="18" cy="30" r="3" fill="#4dd2ff"/><rect x="96" y="40" width="6" height="6" fill="#7cff6b" transform="rotate(30 99 43)"/><circle cx="104" cy="20" r="3" fill="#ffe14d"/>',
    sweat: '<path d="M92 40q-6 10 0 14q6-4 0-14z" fill="#5ab4ff"/>',
    blush: '<ellipse cx="36" cy="74" rx="7" ry="4" fill="#ff7b8a" opacity=".6"/><ellipse cx="84" cy="74" rx="7" ry="4" fill="#ff7b8a" opacity=".6"/>',
    steam: '<path d="M20 40q-6-6 0-12M100 40q6-6 0-12" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" opacity=".8"/>',
  };
  const [e, m, ...x] = face;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">` +
    `<path d="M60 18c28 0 48 20 48 50s-20 46-48 46-48-16-48-46 20-50 48-50z" fill="${color}"/>` +
    `<ellipse cx="42" cy="36" rx="12" ry="7" fill="#fff" opacity=".35" transform="rotate(-25 42 36)"/>` +
    eyes[e] + mouths[m] + x.map(k => extra[k]).join('') + '</svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
const BUILTIN_STICKERS = [
  ['happy', 'Happy', '#ffc93c', ['happy', 'grin', 'blush']],
  ['love', 'In Love', '#ff8fb1', ['hearts', 'smile', 'blush']],
  ['lol', 'LOL', '#ffd25e', ['squint', 'grin', 'tears']],
  ['sad', 'Sad', '#7fb8ff', ['dots', 'frown', 'tears']],
  ['angry', 'Angry', '#ff6247', ['angry', 'frown', 'steam']],
  ['cool', 'Cool', '#3ddcc4', ['shades', 'smirk']],
  ['sleepy', 'Sleepy', '#b5a4ff', ['closed', 'small', 'zzz']],
  ['party', 'Party', '#ffa94d', ['happy', 'grin', 'hat']],
  ['wow', 'Wow', '#ffe08a', ['big', 'o']],
  ['nervous', 'Nervous', '#9be38a', ['dots', 'smirk', 'sweat']],
  ['shy', 'Shy', '#ffc2d6', ['closed', 'smile', 'blush']],
  ['huh', 'Huh?', '#c9b8ff', ['big', 'small', 'sweat']],
].map(([id, name, color, face]) => ({ id, name, url: 'builtin:' + id, src: blobSvg(color, face) }));
function stickerSrc(url) {
  if (url.startsWith('builtin:')) return BUILTIN_STICKERS.find(s => s.url === url)?.src || '';
  return url;
}

// ---------------------------------------------------------------- markdown
function md(src) {
  const holds = [];
  const hold = h => `\u0001${holds.push(h) - 1}\u0002`;
  let s = esc(src);
  s = s.replace(/```(?:[\w+#-]*\n)?([\s\S]*?)```/g, (_, code) => hold(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`));
  s = s.replace(/https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g, url => hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  s = s.split('\n').map(line => {
    if (/^&gt; /.test(line)) return `<blockquote>${line.slice(5)}</blockquote>`;
    if (/^### /.test(line)) return `<h4>${line.slice(4)}</h4>`;
    if (/^## /.test(line)) return `<h4>${line.slice(3)}</h4>`;
    if (/^# /.test(line)) return `<h3>${line.slice(2)}</h3>`;
    if (/^[-*] /.test(line)) return '• ' + line.slice(2) + '<br>';
    return line + '<br>';
  }).join('').replace(/<br>$/, '');
  s = s.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" data-act="spoiler">$1</span>');
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__(.+?)__/g, '<u>$1</u>');
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[\s>(])_(?!\s)([^_]+?)_(?=$|[\s<.,!?)])/g, '$1<i>$2</i>');
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  s = s.replace(/:([a-z0-9_+-]+):/g, (m, n) => EMOJI_BY_NAME[n] || m);
  s = s.replace(/(^|[\s>(])@([a-z0-9_.]{2,32})/gi, (m, pre, name) => {
    const n = name.toLowerCase().replace(/\.+$/, '');
    if (n === 'everyone' || n === 'here') return `${pre}<span class="mention">@${n}</span>`;
    const u = userByName(n);
    return u ? `${pre}<span class="mention" data-act="profile" data-uid="${esc(u.id)}">@${esc(u.displayName)}</span>` : m;
  });
  for (let i = 0; i < 2; i++) s = s.replace(/\u0001(\d+)\u0002/g, (_, n) => holds[n]);
  return s;
}
function isOnlyEmoji(text) {
  const t = (text || '').trim();
  return t.length > 0 && t.length <= 30 && /^(\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u.test(t);
}
function embedsFor(text) {
  const out = [];
  const urls = (text || '').match(/https?:\/\/[^\s<]+/g) || [];
  for (const url of urls.slice(0, 3)) {
    const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
    if (yt) out.push(`<iframe class="yt" src="https://www.youtube-nocookie.com/embed/${yt[1]}" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`);
    else if (/\.(gif|png|jpe?g|webp)(\?\S*)?$/i.test(url) || /^https:\/\/media\d*\.giphy\.com\//.test(url) || /^https:\/\/media\.tenor\.com\//.test(url)) {
      out.push(`<img class="embed-img" src="${esc(url)}" data-act="lightbox" data-src="${esc(url)}" alt="" loading="lazy">`);
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------- sounds
let actx = null;
function tone(freqs, dur = 0.12, type = 'sine', vol = 0.08) {
  if (!prefs.sounds) return;
  try {
    actx ||= new AudioContext();
    let t = actx.currentTime;
    for (const f of freqs) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + dur);
      t += dur * 0.8;
    }
  } catch {}
}
const SOUNDS = {
  message: () => tone([880, 1320], 0.09),
  join: () => tone([523, 784], 0.12),
  leave: () => tone([784, 523], 0.12),
  mute: () => tone([420], 0.07),
  unmute: () => tone([640], 0.07),
  ring: () => tone([660, 880, 660, 880], 0.18, 'triangle', 0.1),
};
const sound = n => SOUNDS[n]?.();

// ---------------------------------------------------------------- preferences (synced to the account)
const DEFAULT_PREFS = {
  theme: 'dark', accent: '#ff7a45', bg: 'none', bgOpacity: 0.35, fontSize: 15, compact: false, reduceMotion: false,
  notif: true, sounds: true, mic: '', speaker: '', cam: '', noise: true, echo: true, volumes: {}, showMembers: true,
};
let prefs = { ...DEFAULT_PREFS, ...store.get('hearth.prefs', {}) };
const BACKGROUNDS = {
  none: '',
  aurora: 'linear-gradient(135deg,#1f005c,#5b0060,#870160,#ac255e,#ca485c,#e16b5c,#f39060,#ffb56b)',
  ocean: 'linear-gradient(160deg,#0f2027,#203a43,#2c5364)',
  sunset: 'linear-gradient(135deg,#ff9a8b,#ff6a88,#ff99ac)',
  mint: 'linear-gradient(135deg,#a8ff78,#78ffd6)',
  galaxy: 'radial-gradient(circle at 20% 30%,#5b2a86 0,transparent 40%),radial-gradient(circle at 80% 70%,#1e3a8a 0,transparent 45%),#0b0b1a',
  peach: 'linear-gradient(135deg,#f6d5f7,#fbe9d7)',
  forest: 'linear-gradient(160deg,#134e5e,#71b280)',
  fire: 'linear-gradient(0deg,#f12711,#f5af19)',
  dots: 'radial-gradient(rgba(255,255,255,.18) 1px,transparent 1px) 0 0/18px 18px',
  grid: 'linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px) 0 0/24px 24px,linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px) 0 0/24px 24px',
};
const THEMES = [
  ['dark', 'Dark', '#313338'], ['light', 'Light', '#ffffff'], ['midnight', 'Midnight', '#000000'],
  ['ocean', 'Ocean', '#142c45'], ['forest', 'Forest', '#1a2d20'], ['sunset', 'Sunset', '#3c1f2f'], ['candy', 'Candy', '#fff6fb'],
];
const ACCENTS = ['#ff7a45', '#5865f2', '#23a55a', '#f23f43', '#eb459e', '#f0b232', '#00a8fc', '#9b59b6', '#1abc9c', '#ffffff'];

function bgCss() {
  if (prefs.bg && prefs.bg.startsWith('/uploads/')) return `url("${prefs.bg}") center/cover no-repeat`;
  return BACKGROUNDS[prefs.bg] || '';
}
function applyBg() {
  const el = $('.main-bg');
  if (!el) return;
  el.style.background = bgCss();
  el.style.opacity = prefs.bgOpacity;
}
function applyPrefs() {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.style.setProperty('--accent', prefs.accent);
  const hex = prefs.accent.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  root.style.setProperty('--accent-text', (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#111' : '#fff');
  root.style.setProperty('--font-size', prefs.fontSize + 'px');
  document.body.classList.toggle('compact', !!prefs.compact);
  document.body.classList.toggle('reduce-motion', !!prefs.reduceMotion);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--rail').trim() || '#1e1f22';
  applyBg();
}
let prefsTimer = null;
function setPref(k, v) {
  prefs[k] = v;
  applyPrefs();
  store.set('hearth.prefs', prefs);
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => emit('settings:update', { settings: prefs }), 800);
}

// ---------------------------------------------------------------- overlays
function closePopover() {
  const root = $('#popover-root');
  if (!root.firstChild) return;
  root.innerHTML = '';
  const fn = S.popoverClose;
  S.popoverClose = null;
  fn?.();
}
function popover(html, anchor, opts = {}) {
  closePopover();
  const el = document.createElement('div');
  el.className = 'popover ' + (opts.cls || '');
  el.innerHTML = html;
  $('#popover-root').append(el);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const w = el.offsetWidth, h = el.offsetHeight, vw = innerWidth, vh = innerHeight;
  let left, top;
  if (opts.side === 'right') { left = r.right + 8; top = r.top; }
  else if (opts.side === 'top') { left = r.right - w; top = r.top - h - 8; }
  else { left = r.left; top = r.bottom + 6; }
  if (left + w > vw - 8) left = vw - w - 8;
  if (left < 8) left = 8;
  if (top + h > vh - 8) top = opts.side === 'right' ? vh - h - 8 : r.top - h - 6;
  if (top < 8) top = 8;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  S.popoverClose = opts.onClose || null;
  return el;
}
function menu(items, anchor, opts) {
  const html = `<div class="menu">${items.filter(Boolean).map((it, i) => it === '-' ? '<hr>'
    : it.html ? it.html
    : `<button data-mi="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? `<span>${it.icon}</span>` : ''}${esc(it.label)}</button>`).join('')}</div>`;
  const list = items.filter(Boolean);
  const el = popover(html, anchor, opts);
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-mi]');
    if (!b) return;
    const it = list[b.dataset.mi];
    closePopover();
    it.run?.();
  });
  return el;
}
function modal(html, opts = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${opts.cls || ''}">${html}</div>`;
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  $('#modal-root').append(back);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    back.remove();
    opts.onClose?.();
  }
  back._close = close;
  const first = back.querySelector('input:not([type=checkbox]):not([type=file]), textarea');
  if (first && opts.focus !== false) setTimeout(() => first.focus(), 30);
  return { el: back, close };
}
function closeTopModal() {
  const m = $('#modal-root').lastElementChild;
  if (m) { m._close(); return true; }
  return false;
}
function confirmBox(title, text, okLabel = 'Confirm', danger = true) {
  return new Promise(res => {
    let answered = false;
    const m = modal(`<div class="modal-head"><h2>${esc(title)}</h2><p>${text}</p></div>
      <div class="modal-foot"><button class="btn secondary" data-x="no">Cancel</button><button class="btn ${danger ? 'danger' : ''}" data-x="yes">${esc(okLabel)}</button></div>`,
      { onClose: () => { if (!answered) res(false); } });
    m.el.addEventListener('click', e => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      answered = true;
      m.close();
      res(b.dataset.x === 'yes');
    });
  });
}
function promptBox(title, label, value = '', okLabel = 'Save', opts = {}) {
  return new Promise(res => {
    let answered = false;
    const m = modal(`<form><div class="modal-head"><h2>${esc(title)}</h2>${opts.sub ? `<p>${opts.sub}</p>` : ''}</div>
      <div class="modal-body"><label class="field"><span>${esc(label)}</span><input name="v" value="${esc(value)}" maxlength="${opts.max || 100}" ${opts.type ? `type="${opts.type}"` : ''}></label></div>
      <div class="modal-foot"><button type="button" class="btn secondary" data-x="no">Cancel</button><button class="btn">${esc(okLabel)}</button></div></form>`,
      { onClose: () => { if (!answered) res(null); } });
    m.el.querySelector('[data-x=no]').onclick = () => m.close();
    m.el.querySelector('form').onsubmit = e => {
      e.preventDefault();
      answered = true;
      const v = m.el.querySelector('input').value;
      m.close();
      res(v);
    };
  });
}
function lightbox(src) {
  const el = document.createElement('div');
  el.className = 'lightbox';
  el.innerHTML = `<img src="${esc(src)}" alt=""><a href="${esc(src)}" target="_blank" rel="noopener">Open original</a>`;
  el.onclick = e => { if (e.target.tagName !== 'A') el.remove(); };
  el._close = () => el.remove();
  $('#modal-root').append(el);
}
