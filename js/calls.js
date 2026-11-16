/* PingChat v2 — calls: WebRTC audio/video calls.
 * Signaling: Supabase Realtime Broadcast on a per-user channel `calls:<userId>`.
 * Media: peer-to-peer WebRTC, Google free STUN + free OpenRelay TURN
 * (see js/call-config.js). Without TURN, calls between two phones on
 * mobile data usually connect at the signaling level but carry no audio.
 * Call rows live in the `calls` table (status: ringing/accepted/declined/missed/ended).
 */
import { sb, PC, toast, avatarHtml, timeAgo, icon, ringtoneEnabled } from './config.js';
import { ICE_SERVERS, CALL_TIMEOUT_MS } from './call-config.js';
import { esc, formatDuration } from './ui.js';
import { getOrCreateConversation } from './chats.js';
import { setCallHistoryRefresher } from './app.js';
import { loadFriendProfiles, loadFriendships, checkBlockDirection, isBlockedEither } from './friends.js';

let me = null;
let myChannel = null;
let callsInitialized = false;
const peerChannels = new Map();
let current = null; // active or ringing call state
let ringCtx = null;
let ringOsc = null;
let ringGain = null;
let ringPulse = null;

const $ = (id) => document.getElementById(id);

export function initCalls(user) {
  me = user;
  if (callsInitialized) return;
  callsInitialized = true;
  setCallHistoryRefresher(renderCallHistory);
  // If the tab is closed while dialling, tell the other side the call
  // was cancelled instead of leaving them ringing forever.
  window.addEventListener('beforeunload', () => {
    if (current && current.status === 'calling') {
      sendSignal(current.peerId, 'call-cancel', { callId: current.callId });
      updateCall(current.callId, { status: 'missed' });
    }
  });
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

/* ---------- signaling transport ----------
 * supabase-js v2: `await ch.subscribe()` does NOT wait for the SUBSCRIBED
 * state — it resolves immediately, so the first signals sent on a fresh
 * channel were silently lost and calls usually never connected. This waits
 * for SUBSCRIBED (with a timeout + error path) and only caches the channel
 * after a successful subscription; a failed channel is never cached. */
async function peerChannel(peerId) {
  if (peerChannels.has(peerId)) return peerChannels.get(peerId);
  const ch = sb.channel('calls:' + peerId);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Signaling channel timed out')), 10000);
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          clearTimeout(timer);
          reject(new Error('Signaling channel failed: ' + status));
        }
      });
    });
  } catch (e) {
    peerChannels.delete(peerId);
    try { ch.unsubscribe(); } catch (err) {}
    throw e;
  }
  peerChannels.set(peerId, ch);
  return ch;
}
async function sendSignal(peerId, event, payload) {
  // One attempt on the (cached) channel; on failure drop the cached
  // channel and retry once on a fresh one — a mobile connection drop
  // can leave the cached channel dead, and every later candidate then
  // fails with a toast. Only toast if the retry also fails.
  const attempt = async () => {
    const ch = await peerChannel(peerId);
    const res = await ch.send({ type: 'broadcast', event, payload });
    if (res !== 'ok') throw new Error('Signal send returned ' + res);
  };
  try {
    await attempt();
  } catch (e) {
    console.warn('signal send failed, retrying on a fresh channel', event, e);
    const stale = peerChannels.get(peerId);
    peerChannels.delete(peerId);
    if (stale) { try { stale.unsubscribe(); } catch (err) {} }
    try {
      await attempt();
    } catch (e2) {
      console.warn('signal send failed', event, e2);
      toast('Could not reach the other side. Check your connection and try again.', 'error');
    }
  }
}

/* ---------- call row helpers ---------- */
async function updateCall(callId, patch) {
  try { await sb.from('calls').update(patch).eq('id', callId); } catch (e) { console.warn('updateCall failed', e); }
}

/* ---------- ringtone (WebAudio only, no audio file) ---------- */
function startRingtone() {
  if (!ringtoneEnabled()) return; // Settings > Sound > Ringtone off
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
  const blockDir = await checkBlockDirection(peer.id);
  if (blockDir === 'i_blocked') { toast('You blocked this user.', 'error'); return; }
  if (blockDir === 'blocked_me') { toast('You cannot call this user.', 'error'); return; }
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
  // Blocked callers never get through: auto-decline silently.
  const blockDir = await checkBlockDirection(payload.from.id);
  if (blockDir !== 'none') {
    await sendSignal(payload.from.id, 'call-decline', { callId: payload.callId });
    await updateCall(payload.callId, { status: 'declined' });
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
    if (!current || current.callId !== callId) return;
    if (pc.connectionState === 'disconnected' && !current.disconnectedToastShown) {
      // ICE can recover from a short disconnect on its own — warn once
      // and stay on the call instead of hanging up.
      current.disconnectedToastShown = true;
      toast('Connection lost — trying to reconnect…');
    } else if (pc.connectionState === 'failed') {
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

/* ---------- "Call friends" section ----------
 * The union of accepted friends and people with an existing conversation
 * with me. Everyone here is a friend by construction, so call buttons
 * are always shown. */
export async function renderCallFriends() {
  const list = $('callFriendsList');
  if (!list || !me) return;
  let friendProfiles = [];
  // Refresh the friendship cache first: loadFriendProfiles() reads the
  // cache, which may be stale/empty, so accepted friends with no
  // conversation yet would otherwise never appear here.
  try { await loadFriendships(); } catch (e) { /* ignore */ }
  try { friendProfiles = await loadFriendProfiles(); } catch (e) { /* ignore */ }
  let partnerIds = [];
  try {
    const myParts = await sb.from('conversation_participants').select('conversation_id').eq('user_id', me.id);
    const convIds = (myParts.data || []).map((p) => p.conversation_id);
    if (convIds.length) {
      const others = await sb.from('conversation_participants').select('user_id').in('conversation_id', convIds).neq('user_id', me.id);
      partnerIds = [...new Set((others.data || []).map((p) => p.user_id))];
    }
  } catch (e) { /* ignore */ }
  const byId = new Map(friendProfiles.map((p) => [p.id, p]));
  const missing = partnerIds.filter((id) => !byId.has(id));
  if (missing.length) {
    try {
      const pr = await sb.from('profiles').select('id, username, full_name, bio, avatar_url, is_public, created_at').in('id', missing);
      (pr.data || []).forEach((p) => byId.set(p.id, p));
    } catch (e) { /* ignore */ }
  }
  const rows = [...byId.values()]
    .filter((p) => !isBlockedEither(p.id))
    .sort((a, b) => (a.full_name || a.username || '').localeCompare(b.full_name || b.username || ''));
  if (!rows.length) {
    list.innerHTML = '<div class="empty">' + icon('users', 48) + '<h3>No friends yet</h3><p>Add friends from People to call them here.</p></div>';
    return;
  }
  list.innerHTML = rows.map((p) => {
    const online = PC.state.online.has(p.id);
    return '<div class="call-row">'
      + avatarHtml(p, 'sm')
      + '<span class="c-body"><b>' + esc(p.full_name || p.username) + '</b><span>@' + esc(p.username) + (online ? ' · Online' : '') + '</span></span>'
      + '<button class="btn btn-ghost btn-sm" data-call-audio="' + p.id + '" type="button" aria-label="Audio call">' + icon('phone', 16) + '</button>'
      + '<button class="btn btn-ghost btn-sm" data-call-video="' + p.id + '" type="button" aria-label="Video call">' + icon('video', 16) + '</button>'
      + '</div>';
  }).join('');
  list.querySelectorAll('[data-call-audio], [data-call-video]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const peerId = btn.dataset.callAudio || btn.dataset.callVideo;
      const kind = btn.dataset.callVideo ? 'video' : 'audio';
      const peer = byId.get(peerId);
      if (!peer) return;
      const convId = await getOrCreateConversation(peerId);
      if (!convId) return;
      startCall(convId, peer, kind);
    });
  });
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
  // A 'ringing' row older than ~60s is stale (caller closed the tab, the
  // network dropped, or the timeout never fired) — show it as missed
  // instead of leaving it ringing forever in history.
  const STALE_RINGING_MS = 60000;
  list.innerHTML = rows.map((r) => {
    const otherId = r.caller_id === me.id ? r.callee_id : r.caller_id;
    const other = profilesById.get(otherId) || { id: otherId, username: 'user', full_name: 'PingChat user' };
    const outgoing = r.caller_id === me.id;
    const isStaleRinging = r.status === 'ringing' && (Date.now() - new Date(r.created_at).getTime() > STALE_RINGING_MS);
    const displayStatus = isStaleRinging ? 'missed' : r.status;
    const missed = displayStatus === 'missed';
    const dur = r.duration_seconds ? ' · ' + formatDuration(r.duration_seconds) : '';
    const label = (outgoing ? 'Outgoing ' : 'Incoming ') + (r.kind === 'video' ? 'video' : 'audio') + ' call — ' + (statusLabel[displayStatus] || displayStatus) + dur;
    return '<div class="call-row">'
      + '<span class="c-ic' + (missed ? ' missed' : '') + '">' + icon(missed ? 'phoneMissed' : (r.kind === 'video' ? 'video' : 'phone'), 20) + '</span>'
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
