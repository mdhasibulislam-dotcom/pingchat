/* PingChat v2 — calls: WebRTC audio/video calls.
 * Signaling: Supabase Realtime Broadcast on a per-user channel `calls:<userId>`.
 * Media: peer-to-peer WebRTC, Google free STUN (see js/call-config.js).
 * Call rows live in the `calls` table (status: ringing/accepted/declined/missed/ended).
 */
import { sb, PC, toast, avatarHtml, timeAgo, icon } from './config.js';
import { ICE_SERVERS, CALL_TIMEOUT_MS } from './call-config.js';
import { esc, formatDuration } from './ui.js';
import { getOrCreateConversation } from './chats.js';
import { setCallHistoryRefresher } from './app.js';

let me = null;
let myChannel = null;
const peerChannels = new Map();
let current = null; // active or ringing call state
let ringCtx = null;
let ringOsc = null;
let ringGain = null;
let ringPulse = null;

const $ = (id) => document.getElementById(id);

export function initCalls(user) {
  me = user;
  setCallHistoryRefresher(renderCallHistory);
  if (myChannel) return;
  myChannel = sb.channel('calls:' + user.id)
    .on('broadcast', { event: 'call-offer' }, ({ payload }) => onOffer(payload))
    .on('broadcast', { event: 'call-answer' }, ({ payload }) => onAnswer(payload))
    .on('broadcast', { event: 'ice-candidate' }, ({ payload }) => onCandidate(payload))
    .on('broadcast', { event: 'call-decline' }, ({ payload }) => onDecline(payload))
    .on('broadcast', { event: 'call-end' }, ({ payload }) => onRemoteEnd(payload))
    .on('broadcast', { event: 'call-cancel' }, ({ payload }) => onCancel(payload))
    .subscribe();
}

/* ---------- signaling transport ---------- */
async function peerChannel(peerId) {
  if (peerChannels.has(peerId)) return peerChannels.get(peerId);
  const ch = sb.channel('calls:' + peerId);
  peerChannels.set(peerId, ch);
  await ch.subscribe();
  return ch;
}
async function sendSignal(peerId, event, payload) {
  try {
    const ch = await peerChannel(peerId);
    await ch.send({ type: 'broadcast', event, payload });
  } catch (e) {
    console.warn('signal send failed', event, e);
  }
}

/* ---------- call row helpers ---------- */
async function updateCall(callId, patch) {
  try { await sb.from('calls').update(patch).eq('id', callId); } catch (e) { console.warn('updateCall failed', e); }
}

/* ---------- ringtone (WebAudio only, no audio file) ---------- */
function startRingtone() {
  try {
    stopRingtone();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ringCtx = ringCtx || new AC();
    if (ringCtx.state === 'suspended') ringCtx.resume().catch(() => {});
    ringOsc = ringCtx.createOscillator();
    ringGain = ringCtx.createGain();
    ringOsc.type = 'sine';
    ringOsc.frequency.value = 880;
    ringGain.gain.value = 0.0001;
    ringOsc.connect(ringGain);
    ringGain.connect(ringCtx.destination);
    ringOsc.start();
    let on = false;
    ringPulse = setInterval(() => {
      if (!ringGain) return;
      on = !on;
      ringGain.gain.setTargetAtTime(on ? 0.05 : 0.0001, ringCtx.currentTime, 0.05);
    }, 450);
  } catch (e) { /* ringtone is best-effort */ }
}
function stopRingtone() {
  if (ringPulse) { clearInterval(ringPulse); ringPulse = null; }
  if (ringOsc) { try { ringOsc.stop(); } catch (e) {} ringOsc = null; }
  ringGain = null;
}

/* ---------- outgoing call ---------- */
export async function startCall(conversationId, peer, kind) {
  if (!me) return;
  if (current) { toast('You are already in a call.', 'error'); return; }
  if (!peer || !peer.id) { toast('Cannot call this person right now.', 'error'); return; }
  const callId = (crypto.randomUUID ? crypto.randomUUID() : 'call-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const { error } = await sb.from('calls').insert({
    id: callId, conversation_id: conversationId, caller_id: me.id, callee_id: peer.id, kind, status: 'ringing'
  });
  if (error) { toast('Could not start call: ' + error.message, 'error'); return; }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false });
  } catch (e) {
    toast('Microphone/camera unavailable: ' + (e && (e.message || e.name) || 'permission denied'), 'error');
    await updateCall(callId, { status: 'ended', ended_at: new Date().toISOString() });
    return;
  }

  const pc = makePeerConnection(callId, peer.id);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  current = {
    callId, conversationId, peerId: peer.id, peer, kind, pc,
    localStream: stream, direction: 'outgoing', status: 'calling',
    startedAt: null, timerId: null, timeoutId: null, pendingCandidates: []
  };
  showCallOverlay('Calling…');
  $('localVideo').srcObject = stream;
  $('localVideo').hidden = kind !== 'video';

  let offer;
  try {
    offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  } catch (e) {
    toast('Could not start call: ' + (e.message || 'offer failed'), 'error');
    endCallLocal();
    return;
  }
  await sendSignal(peer.id, 'call-offer', {
    callId, conversationId, from: { id: me.id, name: PC.state.profile?.full_name || PC.state.profile?.username || 'Someone' }, kind, sdp: pc.localDescription
  });
  current.timeoutId = setTimeout(() => {
    if (current && current.callId === callId && current.status === 'calling') {
      updateCall(callId, { status: 'missed' });
      endCallLocal();
      toast('No answer — call marked as missed.', 'error');
      renderCallHistory();
    }
  }, CALL_TIMEOUT_MS);
}

/* ---------- incoming call ---------- */
async function onOffer(payload) {
  if (!payload || !payload.callId) return;
  if (current) {
    // Busy: auto-decline so the caller is not left ringing.
    await sendSignal(payload.from.id, 'call-decline', { callId: payload.callId });
    return;
  }
  current = {
    callId: payload.callId, conversationId: payload.conversationId,
    peerId: payload.from.id, peer: { id: payload.from.id, full_name: payload.from.name, username: '' },
    kind: payload.kind || 'audio', pc: null, localStream: null,
    direction: 'incoming', status: 'ringing', offer: payload.sdp,
    startedAt: null, timerId: null, timeoutId: null, pendingCandidates: []
  };
  // Resolve the caller's profile for a proper avatar/name.
  try {
    const pr = await sb.from('profiles').select('id, username, full_name, avatar_url').eq('id', payload.from.id).maybeSingle();
    if (pr.data) current.peer = pr.data;
  } catch (e) {}
  $('incomingAvatar').innerHTML = avatarHtml(current.peer, 'lg');
  $('incomingName').textContent = current.peer.full_name || current.peer.username || 'Unknown caller';
  $('incomingKind').textContent = 'Incoming ' + (current.kind === 'video' ? 'video' : 'audio') + ' call';
  $('incomingModal').hidden = false;
  startRingtone();
  current.timeoutId = setTimeout(() => {
    if (current && current.callId === payload.callId && current.status === 'ringing') {
      stopRingtone();
      $('incomingModal').hidden = true;
      updateCall(payload.callId, { status: 'missed' });
      current = null;
      renderCallHistory();
    }
  }, CALL_TIMEOUT_MS);
}

export async function acceptCall() {
  const c = current;
  if (!c || c.status !== 'ringing') return;
  clearTimeout(c.timeoutId);
  stopRingtone();
  $('incomingModal').hidden = true;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: c.kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false });
  } catch (e) {
    toast('Microphone/camera unavailable: ' + (e && (e.message || e.name) || 'permission denied'), 'error');
    await sendSignal(c.peerId, 'call-decline', { callId: c.callId });
    await updateCall(c.callId, { status: 'declined' });
    current = null;
    return;
  }

  const pc = makePeerConnection(c.callId, c.peerId);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  c.pc = pc;
  c.localStream = stream;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(c.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
  } catch (e) {
    toast('Could not answer call: ' + (e.message || 'failed'), 'error');
    await sendSignal(c.peerId, 'call-decline', { callId: c.callId });
    await updateCall(c.callId, { status: 'declined' });
    endCallLocal();
    return;
  }
  c.status = 'active';
  c.startedAt = Date.now();
  await sendSignal(c.peerId, 'call-answer', { callId: c.callId, sdp: pc.localDescription });
  await updateCall(c.callId, { status: 'accepted', started_at: new Date().toISOString() });
  flushPendingCandidates(c);
  showCallOverlay('Connected');
  $('localVideo').srcObject = stream;
  $('localVideo').hidden = c.kind !== 'video';
  startTimer();
}

export async function declineCall() {
  const c = current;
  if (!c) return;
  clearTimeout(c.timeoutId);
  stopRingtone();
  $('incomingModal').hidden = true;
  await sendSignal(c.peerId, 'call-decline', { callId: c.callId });
  await updateCall(c.callId, { status: 'declined' });
  current = null;
  renderCallHistory();
}

/* ---------- signaling handlers ---------- */
async function onAnswer(payload) {
  const c = current;
  if (!c || c.callId !== payload.callId || c.status !== 'calling') return;
  clearTimeout(c.timeoutId);
  try {
    await c.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  } catch (e) {
    toast('Call failed: ' + (e.message || 'bad answer'), 'error');
    endCallLocal();
    return;
  }
  c.status = 'active';
  c.startedAt = Date.now();
  flushPendingCandidates(c);
  showCallOverlay('Connected');
  startTimer();
}

async function onCandidate(payload) {
  const c = current;
  if (!c || c.callId !== payload.callId || !payload.candidate) return;
  try {
    if (c.pc && c.pc.remoteDescription) {
      await c.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    } else {
      c.pendingCandidates.push(payload.candidate);
    }
  } catch (e) { console.warn('addIceCandidate failed', e); }
}

function flushPendingCandidates(c) {
  if (!c.pc || !c.pendingCandidates.length) return;
  const queued = c.pendingCandidates.splice(0);
  queued.forEach((cand) => {
    c.pc.addIceCandidate(new RTCIceCandidate(cand)).catch((e) => console.warn('queued ICE failed', e));
  });
}

function onDecline(payload) {
  const c = current;
  if (!c || c.callId !== payload.callId) return;
  clearTimeout(c.timeoutId);
  // Record the decline so the call does not stay "ringing" in history
  // (the callee already updates the row on a manual decline; this covers
  // the busy auto-decline path too).
  updateCall(payload.callId, { status: 'declined' });
  endCallLocal();
  toast('Call declined.', 'error');
  renderCallHistory();
}

function onRemoteEnd(payload) {
  const c = current;
  if (!c || c.callId !== payload.callId) return;
  endCallLocal();
  toast('Call ended.');
  renderCallHistory();
}

function onCancel(payload) {
  const c = current;
  if (!c || c.callId !== payload.callId) return;
  clearTimeout(c.timeoutId);
  stopRingtone();
  $('incomingModal').hidden = true;
  current = null;
  toast('Call cancelled.');
}

/* ---------- peer connection ---------- */
function makePeerConnection(callId, peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, 'ice-candidate', { callId, candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    const c = current;
    if (!c || c.callId !== callId) return; // call already ended
    const remote = $('remoteVideo');
    if (e.streams && e.streams[0]) {
      remote.srcObject = e.streams[0];
      const isVideo = c.kind === 'video';
      remote.hidden = !isVideo;
      $('remoteFallback').style.display = isVideo ? 'none' : 'flex';
      $('callStatusBar').hidden = !isVideo;
      if (isVideo) {
        $('callPeerName2').textContent = c.peer.full_name || c.peer.username || '';
        $('callAvatar').innerHTML = avatarHtml(c.peer, 'lg');
      }
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && current && current.callId === callId) {
      toast('Connection failed. The other side may be unreachable (a TURN server may be needed).', 'error');
      hangUp();
    }
  };
  return pc;
}

/* ---------- in-call UI ---------- */
function showCallOverlay(statusText) {
  const c = current;
  if (!c) return;
  $('callAvatar').innerHTML = avatarHtml(c.peer, 'lg');
  $('callPeerName').textContent = c.peer.full_name || c.peer.username || 'Unknown';
  $('callStatus').textContent = statusText || 'Calling…';
  $('remoteVideo').hidden = true;
  $('remoteFallback').style.display = 'flex';
  $('callStatusBar').hidden = true;
  $('muteBtn').innerHTML = icon('mic', 24);
  $('muteBtn').classList.remove('off');
  $('cameraBtn').innerHTML = icon('video', 24);
  $('cameraBtn').classList.remove('off');
  $('cameraBtn').style.display = c.kind === 'video' ? '' : 'none';
  $('endCallBtn').innerHTML = icon('phoneOff', 26);
  $('callOverlay').hidden = false;
}

function startTimer() {
  const c = current;
  if (!c) return;
  const tick = () => {
    if (!current || current.callId !== c.callId || !c.startedAt) return;
    const s = formatDuration((Date.now() - c.startedAt) / 1000);
    $('callStatus').textContent = s;
    $('callTimer').textContent = s;
  };
  tick();
  c.timerId = setInterval(tick, 1000);
}

/* Mute / camera toggles (bound once in app boot via event delegation below). */
function toggleMute() {
  const c = current;
  if (!c || !c.localStream) return;
  const track = c.localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('muteBtn').innerHTML = icon(track.enabled ? 'mic' : 'micOff', 24);
  $('muteBtn').classList.toggle('off', !track.enabled);
}
function toggleCamera() {
  const c = current;
  if (!c || !c.localStream || c.kind !== 'video') return;
  const track = c.localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('cameraBtn').innerHTML = icon(track.enabled ? 'video' : 'videoOff', 24);
  $('cameraBtn').classList.toggle('off', !track.enabled);
}

/* ---------- hang up ---------- */
export async function hangUp() {
  const c = current;
  if (!c) return;
  clearTimeout(c.timeoutId);
  const wasAnswered = c.status === 'active';
  const callId = c.callId;
  const startedAt = c.startedAt;
  const peerId = c.peerId;
  // Tell the other side first, then tear down locally.
  if (wasAnswered) await sendSignal(peerId, 'call-end', { callId });
  else await sendSignal(peerId, 'call-cancel', { callId });
  const patch = { status: 'ended', ended_at: new Date().toISOString() };
  if (startedAt) patch.duration_seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  await updateCall(callId, patch);
  endCallLocal();
  renderCallHistory();
}

/* Local teardown only (remote side ended/declined, or an error). */
export function endCallLocal() {
  const c = current;
  if (c) {
    clearTimeout(c.timeoutId);
    if (c.timerId) clearInterval(c.timerId);
    if (c.pc) { try { c.pc.close(); } catch (e) {} }
    if (c.localStream) c.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
  }
  stopRingtone();
  current = null;
  $('callOverlay').hidden = true;
  $('incomingModal').hidden = true;
  const rv = $('remoteVideo');
  if (rv) rv.srcObject = null;
  const lv = $('localVideo');
  if (lv) lv.srcObject = null;
}

export function endCallIfActive() {
  if (current) endCallLocal();
}

/* ---------- call history ---------- */
export async function renderCallHistory() {
  const list = $('callsList');
  if (!list || !me) return;
  let rows = [];
  try {
    const r = await sb.from('calls').select('id, conversation_id, caller_id, callee_id, kind, status, created_at, started_at, ended_at, duration_seconds')
      .or('caller_id.eq.' + me.id + ',callee_id.eq.' + me.id)
      .order('created_at', { ascending: false }).limit(50);
    if (r.error) throw r.error;
    rows = r.data || [];
  } catch (e) {
    list.innerHTML = '<div class="empty">Could not load call history.</div>';
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<div class="empty">' + icon('phone', 48) + '<h3>No calls yet</h3><p>Call someone from a chat or from People.</p></div>';
    return;
  }
  const otherIds = [...new Set(rows.map((r) => (r.caller_id === me.id ? r.callee_id : r.caller_id)))];
  let profilesById = new Map();
  try {
    const pr = await sb.from('profiles').select('id, username, full_name, avatar_url').in('id', otherIds);
    if (!pr.error) profilesById = new Map((pr.data || []).map((p) => [p.id, p]));
  } catch (e) {}
  const statusLabel = { ringing: 'Ringing', accepted: 'Accepted', declined: 'Declined', missed: 'Missed', ended: 'Ended' };
  list.innerHTML = rows.map((r) => {
    const otherId = r.caller_id === me.id ? r.callee_id : r.caller_id;
    const other = profilesById.get(otherId) || { id: otherId, username: 'user', full_name: 'PingChat user' };
    const outgoing = r.caller_id === me.id;
    const missed = r.status === 'missed' || (r.status === 'ringing' && outgoing === false);
    const dur = r.duration_seconds ? ' · ' + formatDuration(r.duration_seconds) : '';
    const label = (outgoing ? 'Outgoing ' : 'Incoming ') + (r.kind === 'video' ? 'video' : 'audio') + ' call — ' + (statusLabel[r.status] || r.status) + dur;
    return '<div class="call-row">'
      + '<span class="c-ic' + (r.status === 'missed' ? ' missed' : '') + '">' + icon(r.status === 'missed' ? 'phoneMissed' : (r.kind === 'video' ? 'video' : 'phone'), 20) + '</span>'
      + avatarHtml(other, 'sm')
      + '<span class="c-body"><b>' + esc(other.full_name || other.username) + '</b><span>' + esc(label) + ' · ' + timeAgo(r.created_at) + '</span></span>'
      + '<button class="btn btn-ghost btn-sm" data-callback="' + otherId + '" data-callkind="' + r.kind + '" type="button">Call back</button>'
      + '</div>';
  }).join('');
  list.querySelectorAll('[data-callback]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const peerId = btn.dataset.callback;
      const kind = btn.dataset.callkind === 'video' ? 'video' : 'audio';
      const convId = await getOrCreateConversation(peerId);
      if (!convId) return;
      let peer = null;
      try {
        const pr = await sb.from('profiles').select('id, username, full_name, avatar_url').eq('id', peerId).maybeSingle();
        peer = pr.data || { id: peerId, username: 'user', full_name: 'PingChat user' };
      } catch (e) { peer = { id: peerId, username: 'user', full_name: 'PingChat user' }; }
      startCall(convId, peer, kind);
    });
  });
}

/* ---------- wire static call buttons (once) ---------- */
document.getElementById('muteBtn').addEventListener('click', toggleMute);
document.getElementById('cameraBtn').addEventListener('click', toggleCamera);
document.getElementById('endCallBtn').addEventListener('click', hangUp);
document.getElementById('acceptBtn').addEventListener('click', acceptCall);
document.getElementById('declineBtn').addEventListener('click', declineCall);
