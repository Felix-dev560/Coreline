'use strict';

/**
 * Ringline client.
 *
 * Flow of one call:
 *   caller: press Call -> get microphone -> send "call"
 *   callee: sees "incoming" (ring + dialog) -> Answer -> get microphone -> make peer -> send "accept"
 *   caller: gets "accepted" -> make peer -> create offer -> send offer
 *   callee: gets offer -> create answer -> send answer
 *   both:   exchange ICE candidates until audio connects
 * The server only relays these small messages. Audio goes directly between the two browsers.
 */

const $ = (id) => document.getElementById(id);

const els = {
  authView: $('authView'), homeView: $('homeView'),
  tabLogin: $('tabLogin'), tabRegister: $('tabRegister'),
  authForm: $('authForm'), username: $('username'), password: $('password'),
  usernameHint: $('usernameHint'), passwordHint: $('passwordHint'),
  authError: $('authError'), authSubmit: $('authSubmit'),
  meName: $('meName'), logoutBtn: $('logoutBtn'),
  connStatus: $('connStatus'), connText: $('connText'),
  search: $('search'), listNote: $('listNote'), userList: $('userList'),
  dialog: $('callDialog'), callAvatar: $('callAvatar'), callKind: $('callKind'),
  callName: $('callName'), callStatus: $('callStatus'),
  acceptBtn: $('acceptBtn'), muteBtn: $('muteBtn'), endBtn: $('endBtn'), endLabel: $('endLabel'),
  remoteAudio: $('remoteAudio'), toast: $('toast'),
};

const state = {
  me: null,
  mode: 'login',            // 'login' | 'register'
  users: [],                // usernames returned by the server
  online: new Set(),        // usernames currently connected
  query: '',
  ws: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  call: null,               // { peer, role: 'caller'|'callee', phase: 'preparing'|'calling'|'ringing'|'connecting'|'active' }
  pc: null,
  localStream: null,
  pendingCandidates: [],
  disconnectTimer: null,
  timerId: null,
  startedAt: 0,
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong. Try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  // showPopover puts the toast in the top layer so it appears above the call dialog.
  try { if (!els.toast.matches(':popover-open')) els.toast.showPopover(); } catch { /* old browser: text is still in the live region */ }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    try { els.toast.hidePopover(); } catch { /* already hidden */ }
  }, 5000);
}

function initial(name) { return (name || '?').charAt(0).toUpperCase(); }

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Sounds: made with the Web Audio API, so there are no audio files    */
/* ------------------------------------------------------------------ */

let audioCtx = null;
let toneInterval = null;
let toneKind = null;

/** Browsers only allow sound after a tap or key press. Any early interaction unlocks it. */
function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}
document.addEventListener('pointerdown', unlockAudio, { passive: true });
document.addEventListener('keydown', unlockAudio);

function burst(freqs, seconds, volume) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  // Short fade in and out so the tone does not click.
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.02);
  gain.gain.setValueAtTime(volume, t + seconds - 0.05);
  gain.gain.linearRampToValueAtTime(0, t + seconds);
  gain.connect(audioCtx.destination);
  for (const f of freqs) {
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
  }
}

function startTone(kind) {
  stopTone();
  toneKind = kind;
  const play = kind === 'ring'
    ? () => {
        burst([880, 1175], 0.35, 0.14);
        setTimeout(() => { if (toneKind === 'ring') burst([880, 1175], 0.35, 0.14); }, 450);
      }
    : () => burst([425], 1.0, 0.08); // softer tone for the caller while waiting
  play();
  toneInterval = setInterval(play, kind === 'ring' ? 2200 : 3000);
  if (kind === 'ring' && navigator.vibrate) navigator.vibrate([300, 150, 300]);
}

function stopTone() {
  clearInterval(toneInterval);
  toneInterval = null;
  toneKind = null;
  if (navigator.vibrate) navigator.vibrate(0);
}

/* ------------------------------------------------------------------ */
/* Views: sign in, directory                                           */
/* ------------------------------------------------------------------ */

function setAuthMode(mode) {
  state.mode = mode;
  const reg = mode === 'register';
  els.tabLogin.setAttribute('aria-selected', String(!reg));
  els.tabRegister.setAttribute('aria-selected', String(reg));
  els.tabLogin.tabIndex = reg ? -1 : 0;
  els.tabRegister.tabIndex = reg ? 0 : -1;
  els.authForm.setAttribute('aria-labelledby', reg ? 'tabRegister' : 'tabLogin');
  els.authSubmit.textContent = reg ? 'Create account' : 'Log in';
  els.password.autocomplete = reg ? 'new-password' : 'current-password';
  els.usernameHint.hidden = !reg;
  els.passwordHint.hidden = !reg;
  els.authError.textContent = '';
}

els.tabLogin.addEventListener('click', () => setAuthMode('login'));
els.tabRegister.addEventListener('click', () => setAuthMode('register'));
[els.tabLogin, els.tabRegister].forEach((tab) => {
  tab.addEventListener('keydown', (e) => {
    // Arrow keys move between tabs, as people expect from tab lists.
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = state.mode === 'login' ? els.tabRegister : els.tabLogin;
    setAuthMode(next === els.tabRegister ? 'register' : 'login');
    next.focus();
  });
});

els.authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  unlockAudio();
  const username = els.username.value.trim().toLowerCase();
  const password = els.password.value;
  els.authError.textContent = '';

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    els.authError.textContent = 'Username must be 3 to 20 characters: letters, numbers or underscore.';
    els.username.focus();
    return;
  }
  if (state.mode === 'register' && password.length < 8) {
    els.authError.textContent = 'Password must be at least 8 characters.';
    els.password.focus();
    return;
  }
  if (!password) {
    els.authError.textContent = 'Enter your password.';
    els.password.focus();
    return;
  }

  els.authSubmit.disabled = true;
  try {
    const data = await api(state.mode === 'register' ? '/api/register' : '/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    els.password.value = '';
    enterHome(data.username);
  } catch (err) {
    els.authError.textContent = err.message;
  } finally {
    els.authSubmit.disabled = false;
  }
});

function showAuth() {
  state.me = null;
  els.homeView.hidden = true;
  els.authView.hidden = false;
  document.title = 'Ringline';
  setAuthMode('login');
}

function enterHome(username) {
  state.me = username;
  els.meName.textContent = username;
  els.authView.hidden = true;
  els.homeView.hidden = false;
  document.title = 'Ringline';
  setConn('Connecting', false);
  loadUsers();
  connectWs();
}

els.logoutBtn.addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* cookie may already be gone */ }
  closeSocketForGood();
  if (state.call) finishCall();
  state.online.clear();
  state.users = [];
  showAuth();
});

function setConn(text, on) {
  els.connText.textContent = text;
  els.connStatus.classList.toggle('is-on', on);
}

/* ------------------------------------------------------------------ */
/* User list                                                           */
/* ------------------------------------------------------------------ */

let searchTimer = null;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = els.search.value.trim().toLowerCase();
    loadUsers();
  }, 250);
});

async function loadUsers() {
  try {
    const data = await api(`/api/users?q=${encodeURIComponent(state.query)}`);
    state.users = Array.isArray(data.users) ? data.users : [];
    renderUsers();
  } catch (err) {
    if (err.status === 401) return handleSignedOut();
    els.listNote.textContent = 'Could not load the list. Check your connection.';
  }
}

function renderUsers() {
  // Online people first, then alphabetical.
  const sorted = [...state.users].sort((a, b) => {
    const diff = Number(state.online.has(b)) - Number(state.online.has(a));
    return diff || a.localeCompare(b);
  });

  els.userList.replaceChildren();
  const inCall = Boolean(state.call);

  for (const name of sorted) {
    const online = state.online.has(name);
    const li = document.createElement('li');
    li.className = 'user-row' + (online ? ' is-online' : '');

    const av = document.createElement('span');
    av.className = 'avatar-sm';
    av.setAttribute('aria-hidden', 'true');
    av.textContent = initial(name);

    const main = document.createElement('div');
    main.className = 'user-main';
    const nameEl = document.createElement('p');
    nameEl.className = 'user-name';
    nameEl.textContent = name; // textContent, never innerHTML, so names cannot inject markup
    const stateEl = document.createElement('p');
    stateEl.className = 'user-state';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    stateEl.append(dot, online ? 'Online' : 'Offline');
    main.append(nameEl, stateEl);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-call';
    btn.textContent = 'Call';
    btn.setAttribute('aria-label', `Call ${name}`);
    btn.disabled = !online || inCall || !wsOpen();
    btn.addEventListener('click', () => startCall(name));

    li.append(av, main, btn);
    els.userList.append(li);
  }

  if (!state.users.length) {
    els.listNote.textContent = state.query
      ? 'No one matches that name.'
      : 'No one else has an account yet. Share this site and ask a friend to create one.';
  } else if (![...state.users].some((n) => state.online.has(n))) {
    els.listNote.textContent = 'No one is online right now. Online people appear at the top of the list.';
  } else {
    els.listNote.textContent = '';
  }
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

function wsOpen() { return state.ws && state.ws.readyState === WebSocket.OPEN; }

function sendWs(obj) {
  if (!wsOpen()) return false;
  state.ws.send(JSON.stringify(obj));
  return true;
}

function closeSocketForGood() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  const ws = state.ws;
  state.ws = null;
  if (ws) ws.close(1000, 'Signed out');
}

function connectWs() {
  if (!state.me || state.ws) return;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.reconnectDelay = 1000;
    setConn('Online', true);
    renderUsers();
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg && typeof msg.type === 'string') onMessage(msg);
  };

  ws.onclose = async (event) => {
    if (state.ws !== ws) return; // we closed it on purpose
    state.ws = null;
    state.online.clear();
    if (state.call) finishCall('The connection dropped, so the call ended.');
    renderUsers();

    if (event.code === 4000) {
      setConn('Signed in somewhere else', false);
      toast('You signed in on another tab or device, so this one went offline.');
      return;
    }
    setConn('Reconnecting', false);

    // Check the session first. If it expired, go to the sign-in screen instead of retrying forever.
    try {
      await api('/api/me');
    } catch (err) {
      if (err.status === 401) return handleSignedOut();
    }
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connectWs, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000); // back off up to 15 seconds
  };

  ws.onerror = () => { /* onclose follows and handles it */ };
}

function handleSignedOut() {
  closeSocketForGood();
  if (state.call) finishCall();
  showAuth();
  els.authError.textContent = 'Your session ended. Log in again.';
}

// If the phone woke up and the socket died quietly, reconnect right away.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me && !state.ws) {
    clearTimeout(state.reconnectTimer);
    connectWs();
  }
});

function onMessage(msg) {
  switch (msg.type) {
    case 'ready':
      state.online = new Set(Array.isArray(msg.online) ? msg.online : []);
      renderUsers();
      break;

    case 'presence':
      if (typeof msg.username !== 'string') break;
      if (msg.online) state.online.add(msg.username); else state.online.delete(msg.username);
      // A name we have never seen means a new account. Refresh the list.
      if (msg.online && !state.users.includes(msg.username) && !state.query) loadUsers();
      else renderUsers();
      break;

    case 'incoming':
      onIncoming(String(msg.from || ''));
      break;

    case 'accepted':
      onAccepted();
      break;

    case 'declined':
      finishCall(`${state.call?.peer || 'They'} declined the call.`);
      break;

    case 'cancelled':
      finishCall(`${state.call?.peer || 'They'} stopped calling.`);
      break;

    case 'missed':
      finishCall(`Missed call from ${msg.from || 'someone'}.`);
      break;

    case 'ended':
      finishCall('The call ended.');
      break;

    case 'call-failed':
      onCallFailed(msg);
      break;

    case 'signal':
      onSignal(msg);
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Call screen                                                         */
/* ------------------------------------------------------------------ */

/** mode picks the buttons (incoming | outgoing | active); phase drives the ring animation. */
function showCall(mode, phase, name, kind, status) {
  els.dialog.dataset.mode = mode;
  els.dialog.dataset.phase = phase;
  els.callAvatar.textContent = initial(name);
  els.callName.textContent = name;
  els.callKind.textContent = kind;
  els.callStatus.textContent = status;
  els.endLabel.textContent = mode === 'incoming' ? 'Decline' : mode === 'outgoing' ? 'Cancel' : 'Hang up';
  if (!els.dialog.open) els.dialog.showModal();
  (mode === 'incoming' ? els.acceptBtn : els.endBtn).focus();
}

// Escape must not close the call screen without telling the other person.
els.dialog.addEventListener('cancel', (e) => e.preventDefault());

function micMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Plug one in or check your device settings.';
    case 'NotReadableError':
      return 'Another app is using your microphone. Close it and try again.';
    case 'NotSupportedError':
      return 'This browser cannot make calls here. Use a recent Chrome, Edge, Firefox or Safari over https.';
    default:
      return 'Could not start the microphone.';
  }
}

async function getMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof RTCPeerConnection === 'undefined') {
    throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
  }
  state.localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

/* ---- Caller side ---- */

async function startCall(peer) {
  if (state.call) return;
  if (!wsOpen()) return toast('You are offline. Wait for the connection, then try again.');
  unlockAudio();

  const call = { peer, role: 'caller', phase: 'preparing' };
  state.call = call;
  renderUsers();
  showCall('outgoing', 'calling', peer, 'Calling', 'Getting your microphone ready');

  try {
    await getMic();
  } catch (err) {
    if (state.call === call) finishCall(micMessage(err));
    return;
  }
  if (state.call !== call) { releaseMedia(); return; } // cancelled while the permission prompt was open

  if (!sendWs({ type: 'call', to: peer })) return finishCall('You are offline. Try again.');
  call.phase = 'calling';
  els.callStatus.textContent = 'Ringing';
  startTone('ringback');
}

async function onAccepted() {
  const call = state.call;
  if (!call || call.role !== 'caller' || call.phase !== 'calling') return;
  stopTone();
  call.phase = 'connecting';
  els.callStatus.textContent = 'Connecting';
  try {
    await createPeer();
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    sendWs({ type: 'signal', kind: 'offer', payload: { type: offer.type, sdp: offer.sdp } });
  } catch (err) {
    console.error(err);
    failCall('Could not set up the call.');
  }
}

function onCallFailed(msg) {
  const to = msg.to || state.call?.peer || 'That person';
  const reasons = {
    offline: `${to} just went offline.`,
    busy: `${to} is on another call.`,
    'no-answer': `${to} did not answer.`,
    'busy-self': 'You are already in a call.',
  };
  finishCall(reasons[msg.reason] || 'The call could not be placed.');
}

/* ---- Callee side ---- */

function onIncoming(from) {
  if (!from) return;
  // The server only rings idle users, so this is a real new call.
  state.call = { peer: from, role: 'callee', phase: 'ringing' };
  renderUsers();
  showCall('incoming', 'ringing', from, 'Incoming call', 'Answer to start talking');
  document.title = `Incoming call from ${from}`;
  startTone('ring');
}

els.acceptBtn.addEventListener('click', async () => {
  const call = state.call;
  if (!call || call.role !== 'callee' || call.phase !== 'ringing') return;
  unlockAudio();
  stopTone();
  call.phase = 'connecting';
  showCall('active', 'connecting', call.peer, 'Connecting', 'Getting your microphone ready');
  els.muteBtn.disabled = true;

  try {
    await getMic();
    if (state.call !== call) { releaseMedia(); return; } // caller hung up while we waited
    await createPeer();
  } catch (err) {
    if (state.call !== call) { releaseMedia(); return; }
    sendWs({ type: 'end' }); // decline, since we cannot take the call
    finishCall(err && err.name ? micMessage(err) : 'Could not set up the call.');
    return;
  }
  if (state.call !== call) return;
  // The peer exists now, so the offer cannot arrive before we can handle it.
  if (!sendWs({ type: 'accept' })) finishCall('You are offline. Try again.');
});

/* ---- Both sides ---- */

els.endBtn.addEventListener('click', () => {
  sendWs({ type: 'end' }); // cancel, decline or hang up: the server works out which
  finishCall();
});

els.muteBtn.addEventListener('click', () => {
  if (!state.localStream) return;
  const muted = els.muteBtn.getAttribute('aria-pressed') !== 'true';
  state.localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  els.muteBtn.setAttribute('aria-pressed', String(muted));
  els.muteBtn.textContent = muted ? 'Unmute' : 'Mute';
});

async function createPeer() {
  const { iceServers } = await api('/api/ice');
  const pc = new RTCPeerConnection({ iceServers });
  state.pc = pc;
  state.pendingCandidates = [];

  state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));

  pc.ontrack = (event) => {
    els.remoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
    els.remoteAudio.play().catch(() => { /* a tap on the page will start it */ });
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWs({ type: 'signal', kind: 'candidate', payload: event.candidate.toJSON() });
    }
  };

  pc.onconnectionstatechange = () => {
    if (state.pc !== pc) return;
    switch (pc.connectionState) {
      case 'connected':
        clearTimeout(state.disconnectTimer);
        onConnected();
        break;
      case 'disconnected':
        // Often a brief network blip. Give it a few seconds to recover.
        els.callStatus.textContent = 'Connection is unstable';
        clearTimeout(state.disconnectTimer);
        state.disconnectTimer = setTimeout(() => {
          if (state.pc === pc && pc.connectionState !== 'connected') failCall('The connection was lost.');
        }, 8000);
        break;
      case 'failed':
        failCall('Could not connect the audio. Some networks block direct calls and need a relay server.');
        break;
      default:
        break;
    }
  };
}

function onConnected() {
  const call = state.call;
  if (!call || call.phase === 'active') {
    if (call && state.startedAt) els.callStatus.textContent = formatTime(Math.floor((Date.now() - state.startedAt) / 1000));
    return;
  }
  call.phase = 'active';
  els.muteBtn.disabled = false;
  showCall('active', 'active', call.peer, 'In call', '00:00');
  document.title = `In call with ${call.peer}`;
  state.startedAt = Date.now();
  clearInterval(state.timerId);
  state.timerId = setInterval(() => {
    els.callStatus.textContent = formatTime(Math.floor((Date.now() - state.startedAt) / 1000));
  }, 1000);
}

async function onSignal(msg) {
  const pc = state.pc;
  if (!state.call || !pc || !msg.payload) return;
  try {
    if (msg.kind === 'offer') {
      await pc.setRemoteDescription(msg.payload);
      await flushCandidates(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWs({ type: 'signal', kind: 'answer', payload: { type: answer.type, sdp: answer.sdp } });
    } else if (msg.kind === 'answer') {
      await pc.setRemoteDescription(msg.payload);
      await flushCandidates(pc);
    } else if (msg.kind === 'candidate') {
      // Candidates can arrive before the remote description. Hold them until it is set.
      if (pc.remoteDescription) await pc.addIceCandidate(msg.payload).catch(() => {});
      else state.pendingCandidates.push(msg.payload);
    }
  } catch (err) {
    console.error(err);
    failCall('Could not set up the call.');
  }
}

async function flushCandidates(pc) {
  const queued = state.pendingCandidates;
  state.pendingCandidates = [];
  for (const c of queued) await pc.addIceCandidate(c).catch(() => {});
}

/** Ends our side because of a local problem and tells the other person. */
function failCall(message) {
  sendWs({ type: 'end' });
  finishCall(message);
}

function releaseMedia() {
  clearTimeout(state.disconnectTimer);
  clearInterval(state.timerId);
  state.timerId = null;
  state.startedAt = 0;
  if (state.pc) {
    state.pc.onconnectionstatechange = null;
    state.pc.onicecandidate = null;
    state.pc.ontrack = null;
    state.pc.close();
    state.pc = null;
  }
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  state.pendingCandidates = [];
  els.remoteAudio.srcObject = null;
}

function finishCall(message) {
  stopTone();
  releaseMedia();
  state.call = null;
  els.muteBtn.disabled = false;
  els.muteBtn.setAttribute('aria-pressed', 'false');
  els.muteBtn.textContent = 'Mute';
  if (els.dialog.open) els.dialog.close();
  document.title = 'Ringline';
  renderUsers();
  if (message) toast(message);
}

// Closing the tab mid-call: tell the server so the other person is not left hanging.
window.addEventListener('pagehide', () => { if (state.call) sendWs({ type: 'end' }); });

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

(async function init() {
  try {
    const me = await api('/api/me');
    enterHome(me.username);
  } catch {
    showAuth();
  }
})();
