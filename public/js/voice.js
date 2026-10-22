'use strict';
// Voice & video: a WebRTC mesh (everyone connects to everyone) signaled over Socket.IO.
// Each connection gets one audio + one video transceiver up front, so turning the camera or
// screen share on/off is just replaceTrack() — no renegotiation needed.

const V = {
  channelId: null, selfSid: null, local: null, peers: new Map(),
  muted: false, deafened: false, camTrack: null, screenTrack: null,
  videoEls: new Map(), analysers: new Map(), audioCtx: null, chain: Promise.resolve(),
};

function stopStream(s) { s?.getTracks().forEach(t => t.stop()); }

async function getMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: prefs.mic ? { ideal: prefs.mic } : undefined,
        echoCancellation: prefs.echo !== false, noiseSuppression: prefs.noise !== false, autoGainControl: true,
      },
    });
  } catch {
    toast("Couldn't access your microphone — you joined muted.", true);
    V.muted = true;
    return new MediaStream();
  }
}

async function joinVoice(cid) {
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    return toast('Voice needs a modern browser on an https:// address.', true);
  }
  if (V.channelId === cid) return;
  if (V.channelId) leaveVoice(true);
  V.local = await getMic();
  const r = await emit('voice:join', { channelId: cid, muted: V.muted, deafened: V.deafened });
  if (r.error) {
    stopStream(V.local);
    V.local = null;
    return toast(r.error, true);
  }
  V.channelId = cid;
  V.selfSid = r.self;
  watchSpeaking(V.selfSid, V.local);
  applyMicState(false);
  for (const p of r.peers) createPeer(p.sid, p.userId, true);
  sound('join');
  schedule('side', 'main');
}

function leaveVoice(silent) {
  if (!V.channelId) return;
  emit('voice:leave');
  cleanupVoice();
  if (!silent) sound('leave');
}

function cleanupVoice() {
  for (const sid of [...V.peers.keys()]) closePeer(sid);
  stopStream(V.local);
  V.camTrack?.stop();
  V.screenTrack?.stop();
  V.camTrack = V.screenTrack = V.local = null;
  V.analysers.clear();
  V.videoEls.clear();
  V.channelId = V.selfSid = null;
  schedule('side', 'main');
}

function closePeer(sid) {
  const p = V.peers.get(sid);
  if (!p) return;
  try { p.pc.close(); } catch {}
  p.audioEl?.remove();
  V.peers.delete(sid);
  V.analysers.delete(sid);
  V.videoEls.delete(sid);
}

function createPeer(sid, userId, initiator) {
  const pc = new RTCPeerConnection({ iceServers: S.ice });
  const peer = { pc, userId, audioSender: null, videoSender: null, videoStream: null, audioEl: null, pending: [] };
  V.peers.set(sid, peer);
  pc.onicecandidate = e => { if (e.candidate) socket.emit('rtc:signal', { to: sid, data: { candidate: e.candidate } }); };
  pc.ontrack = e => {
    if (e.track.kind === 'audio') {
      const a = document.createElement('audio');
      a.autoplay = true;
      a.srcObject = new MediaStream([e.track]);
      a.muted = V.deafened;
      a.volume = Math.min(1, (prefs.volumes?.[userId] ?? 100) / 100);
      if (prefs.speaker && a.setSinkId) a.setSinkId(prefs.speaker).catch(() => {});
      peer.audioEl?.remove();
      peer.audioEl = a;
      $('#audio-sink').append(a);
      a.play?.().catch(() => {});
      watchSpeaking(sid, a.srcObject);
    } else {
      peer.videoStream = new MediaStream([e.track]);
      V.videoEls.delete(sid);
      schedule('stage');
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') toast(`Couldn't connect to ${user(userId).displayName}'s audio (network blocked).`, true);
  };
  if (initiator) {
    peer.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    peer.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
    attachLocal(peer);
    (async () => {
      await pc.setLocalDescription(await pc.createOffer());
      socket.emit('rtc:signal', { to: sid, data: { sdp: pc.localDescription } });
    })().catch(console.error);
  }
  return peer;
}

function attachLocal(peer) {
  peer.audioSender?.replaceTrack(V.local?.getAudioTracks()[0] || null).catch(() => {});
  peer.videoSender?.replaceTrack(V.screenTrack || V.camTrack || null).catch(() => {});
}

async function handleSignal({ from, userId, data }) {
  if (!V.channelId || !data) return;
  let peer = V.peers.get(from);
  if (data.sdp) {
    if (data.sdp.type === 'offer') {
      if (peer) closePeer(from);
      peer = createPeer(from, userId, false);
      await peer.pc.setRemoteDescription(data.sdp);
      for (const t of peer.pc.getTransceivers()) {
        t.direction = 'sendrecv';
        if (t.receiver.track.kind === 'audio') peer.audioSender = t.sender;
        else peer.videoSender = t.sender;
      }
      attachLocal(peer);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      socket.emit('rtc:signal', { to: from, data: { sdp: peer.pc.localDescription } });
    } else if (peer) {
      await peer.pc.setRemoteDescription(data.sdp);
    }
    if (peer) for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  } else if (data.candidate && peer) {
    if (!peer.pc.remoteDescription) peer.pending.push(data.candidate);
    else await peer.pc.addIceCandidate(data.candidate).catch(() => {});
  }
}
function onSignal(msg) {
  V.chain = V.chain.then(() => handleSignal(msg)).catch(console.error);
}

function applyMicState(notify = true) {
  V.local?.getAudioTracks().forEach(t => { t.enabled = !V.muted && !V.deafened; });
  for (const p of V.peers.values()) if (p.audioEl) p.audioEl.muted = V.deafened;
  if (V.channelId && notify) emit('voice:update', { muted: V.muted, deafened: V.deafened });
  schedule('side', 'stage');
}
function toggleMute() {
  if (V.deafened) { V.deafened = false; V.muted = false; }
  else V.muted = !V.muted;
  sound(V.muted ? 'mute' : 'unmute');
  applyMicState();
}
function toggleDeafen() {
  V.deafened = !V.deafened;
  sound(V.deafened ? 'mute' : 'unmute');
  applyMicState();
}

async function toggleCamera() {
  if (!V.channelId) return;
  if (V.camTrack) {
    V.camTrack.stop();
    V.camTrack = null;
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: prefs.cam ? { ideal: prefs.cam } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      V.camTrack = s.getVideoTracks()[0];
    } catch {
      return toast("Couldn't access your camera.", true);
    }
  }
  pushVideo();
}
async function toggleScreen() {
  if (!V.channelId) return;
  if (V.screenTrack) {
    V.screenTrack.stop();
    V.screenTrack = null;
  } else {
    if (!navigator.mediaDevices.getDisplayMedia) return toast("Screen sharing isn't supported on this device.", true);
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      V.screenTrack = s.getVideoTracks()[0];
      V.screenTrack.onended = () => { V.screenTrack = null; pushVideo(); };
    } catch {
      return;
    }
  }
  pushVideo();
}
function pushVideo() {
  const track = V.screenTrack || V.camTrack || null;
  for (const p of V.peers.values()) p.videoSender?.replaceTrack(track).catch(() => {});
  V.videoEls.delete(V.selfSid);
  emit('voice:update', { video: !!V.camTrack, screen: !!V.screenTrack });
  schedule('stage', 'side');
}

// Returns a <video> element for a participant, reusing it between renders.
function videoFor(sid) {
  const self = sid === V.selfSid;
  const stream = self ? null : V.peers.get(sid)?.videoStream;
  const track = self ? (V.screenTrack || V.camTrack) : stream?.getVideoTracks()[0];
  if (!track) return null;
  let v = V.videoEls.get(sid);
  if (!v || v._track !== track) {
    v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.muted = true;
    v.srcObject = self ? new MediaStream([track]) : stream;
    v._track = track;
    if (self && !V.screenTrack) v.className = 'mirror';
    V.videoEls.set(sid, v);
  }
  return v;
}

// ---------------------------------------------------------------- speaking indicator
function watchSpeaking(key, stream) {
  if (!stream?.getAudioTracks().length) return;
  try {
    V.audioCtx ||= new AudioContext();
    if (V.audioCtx.state === 'suspended') V.audioCtx.resume();
    const an = V.audioCtx.createAnalyser();
    an.fftSize = 512;
    V.audioCtx.createMediaStreamSource(stream).connect(an);
    V.analysers.set(key, an);
  } catch {}
}
const speakBuf = new Uint8Array(512);
setInterval(() => {
  if (!V.channelId) return;
  for (const [sid, an] of V.analysers) {
    an.getByteTimeDomainData(speakBuf);
    let sum = 0;
    for (const v of speakBuf) { const x = (v - 128) / 128; sum += x * x; }
    const loud = Math.sqrt(sum / speakBuf.length) > 0.035 && !(sid === V.selfSid && (V.muted || V.deafened));
    $$(`[data-sid="${sid}"]`).forEach(el => el.classList.toggle('speaking', loud));
  }
}, 150);

// ---------------------------------------------------------------- stage (voice channel / call view)
function renderStage() {
  const el = $('#stage');
  const ch = currentChannel();
  if (!el || !ch) return;
  const parts = S.voice[ch.id] || [];
  if (V.channelId !== ch.id) {
    const isCall = !ch.serverId;
    el.innerHTML = `<div class="tiles" style="place-items:center"><div class="stage-empty">
        <div style="display:flex;gap:6px;justify-content:center">${parts.length ? parts.map(p => avatarHtml(user(p.userId), 'av-lg')).join('') : '<div style="font-size:56px">🔊</div>'}</div>
        <h2>${esc(isCall ? chName(ch) : ch.name)}</h2>
        <p>${parts.length ? esc(parts.map(p => user(p.userId).displayName).join(', ')) + (parts.length === 1 ? ' is' : ' are') + ' in here.' : 'No one is here yet. Jump in!'}</p>
      </div></div>
      <div class="stage-controls"><button class="join" data-act="join-voice" data-id="${ch.id}">${isCall ? '📞 Join Call' : 'Join Voice'}</button></div>`;
    return;
  }
  el.innerHTML = `<div class="tiles">${parts.map(p => {
    const u = user(p.userId);
    const vid = p.video || p.screen;
    return `<div class="tile" data-sid="${esc(p.sid)}">${vid ? '' : avatarHtml(u, 'av-lg')}
      <div class="name">${p.muted ? '🔇' : ''}${p.deafened ? '🎧' : ''} ${esc(u.displayName)}${p.sid === V.selfSid ? ' (you)' : ''} ${p.screen ? '<span class="live-tag">LIVE</span>' : ''}</div>
      ${vid ? '<button class="fs" data-act="fullscreen" title="Fullscreen">⛶</button>' : ''}</div>`;
  }).join('')}</div>
    <div class="stage-controls">
      <button class="${V.muted ? 'off' : ''}" data-act="toggle-mute" title="${V.muted ? 'Unmute' : 'Mute'}">${V.muted ? '🔇' : '🎙️'}</button>
      <button class="${V.deafened ? 'off' : ''}" data-act="toggle-deafen" title="${V.deafened ? 'Undeafen' : 'Deafen'}">${V.deafened ? '🔕' : '🎧'}</button>
      <button class="${V.camTrack ? 'on' : ''}" data-act="toggle-camera" title="Camera">📹</button>
      <button class="${V.screenTrack ? 'on' : ''}" data-act="toggle-screen" title="Share your screen">🖥️</button>
      <button class="hang" data-act="leave-voice" title="Disconnect">📞</button>
    </div>`;
  for (const p of parts) {
    if (!(p.video || p.screen)) continue;
    const v = videoFor(p.sid);
    const tile = el.querySelector(`.tile[data-sid="${CSS.escape(p.sid)}"]`);
    if (v && tile) { tile.prepend(v); v.play?.().catch(() => {}); }
  }
}

// ---------------------------------------------------------------- incoming calls
let ringStop = null;
function showRing(cid, from) {
  if (V.channelId === cid || ringStop) return;
  const u = user(from);
  const ch = S.channels[cid];
  sound('ring');
  const t = setInterval(() => sound('ring'), 2200);
  const timeout = setTimeout(() => m.close(), 30000);
  ringStop = () => { clearInterval(t); clearTimeout(timeout); ringStop = null; };
  const m = modal(`<div class="ring">${avatarHtml(u, 'av-lg')}<h2 style="margin:0">${esc(u.displayName)}</h2>
      <p class="muted">is calling you${ch?.type === 'group' ? ' in ' + esc(chName(ch)) : ''}…</p>
      <div style="display:flex;gap:12px;justify-content:center;margin-top:16px">
        <button class="btn danger" data-r="no">Decline</button><button class="btn green" data-r="yes">Accept</button>
      </div></div>`, { onClose: () => ringStop?.() });
  m.el.addEventListener('click', e => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    m.close();
    if (b.dataset.r === 'yes') { go(null, cid); joinVoice(cid); }
    else emit('call:decline', { channelId: cid });
  });
  if (document.hidden) notify(`${u.displayName} is calling you`, 'Open Hearth to answer', u.avatar);
}

async function startCall(cid, video) {
  const others = (S.voice[cid] || []).length;
  await joinVoice(cid);
  if (V.channelId !== cid) return;
  if (video && !V.camTrack) await toggleCamera();
  if (!others) emit('call:ring', { channelId: cid });
}
