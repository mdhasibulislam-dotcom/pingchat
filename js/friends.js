/* PingChat v2 — friend system: requests, friendship state, privacy, profile preview.
 *
 * Nobody can message or call anyone until a friend request is sent and
 * accepted. The People directory lists everyone, but Message / Call buttons
 * appear only for friends. A pending request (either direction) lets both
 * sides see the other person's full profile, so a request recipient can
 * inspect the sender before accepting.
 *
 * Blocks: while a block row exists between two users there is no contact
 * either way (enforced in SQL: get_or_create_conversation + the messages
 * INSERT policy). Reports are stored for later review; there is no admin
 * review UI in the app.
 */
import { sb, PC, toast, avatarHtml, icon } from './config.js';
import { esc } from './ui.js';
import { getOrCreateConversation, getConversationIdWith, refreshConversations, openConversation } from './chats.js';
import { startCall } from './calls.js';

let me = null;
let friendsInitialized = false;
let cache = new Map(); // otherUserId -> 'none' | 'pending_out' | 'pending_in' | 'friends' | 'declined'
let listeners = [];
let feedChannel = null;
let blocksByMe = new Set(); // ids I blocked
let blockedBy = new Set();  // ids who blocked me
let previewProfile = null;
let reportTarget = null;

const $ = (id) => document.getElementById(id);

export function initFriends(user) {
  me = user;
  // setupUser() can run twice (boot + SIGNED_IN): without this guard every
  // listener below binds twice.
  if (friendsInitialized) return;
  friendsInitialized = true;
  $('pvClose').innerHTML = icon('x', 18);
  $('pvClose').addEventListener('click', closeProfilePreview);
  $('profileModal').addEventListener('click', (e) => { if (e.target === $('profileModal')) closeProfilePreview(); });
  $('reportCancel').addEventListener('click', closeReportModal);
  $('reportModal').addEventListener('click', (e) => { if (e.target === $('reportModal')) closeReportModal(); });
  $('reportSubmit').addEventListener('click', submitReport);
  loadBlocks();
  // Live updates: when any friendship row involving anyone changes,
  // reload the cache and tell listeners (People re-renders itself).
  if (!feedChannel) {
    feedChannel = sb.channel('friendships-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => {
        loadFriendships().then(() => listeners.forEach((fn) => { try { fn(); } catch (e) {} }));
      })
      .subscribe();
  }
}

export function onFriendshipsChange(fn) { listeners.push(fn); }

function notify() { listeners.forEach((fn) => { try { fn(); } catch (e) {} }); }

/* ---------- state ---------- */
export async function loadFriendships() {
  if (!me) return cache;
  try {
    const r = await sb.from('friendships').select('requester_id, addressee_id, status')
      .or('requester_id.eq.' + me.id + ',addressee_id.eq.' + me.id);
    if (r.error) throw r.error;
    cache = new Map();
    (r.data || []).forEach((row) => {
      const other = row.requester_id === me.id ? row.addressee_id : row.requester_id;
      if (row.status === 'accepted') cache.set(other, 'friends');
      else if (row.status === 'pending') cache.set(other, row.requester_id === me.id ? 'pending_out' : 'pending_in');
      else cache.set(other, 'declined');
    });
  } catch (e) { console.warn('load friendships failed', e); }
  return cache;
}

export function friendshipStateOf(userId) { return cache.get(userId) || 'none'; }

export async function getFriendshipStatus(userId) {
  const cached = cache.get(userId);
  if (cached) return cached;
  try {
    const r = await sb.rpc('friendship_status', { p_user_id: userId });
    if (!r.error && r.data) { cache.set(userId, r.data); return r.data; }
  } catch (e) { /* fall through */ }
  return 'none';
}

/* ---------- blocks ---------- */
export async function loadBlocks() {
  if (!me) return;
  try {
    const r = await sb.from('blocks').select('blocker_id, blocked_id')
      .or('blocker_id.eq.' + me.id + ',blocked_id.eq.' + me.id);
    if (r.error) throw r.error;
    blocksByMe = new Set();
    blockedBy = new Set();
    (r.data || []).forEach((row) => {
      if (row.blocker_id === me.id) blocksByMe.add(row.blocked_id);
      if (row.blocked_id === me.id) blockedBy.add(row.blocker_id);
    });
  } catch (e) { console.warn('load blocks failed', e); }
}

export function isBlockedByMe(userId) { return blocksByMe.has(userId); }
export function isBlockedBy(userId) { return blockedBy.has(userId); }
export function isBlockedEither(userId) { return blocksByMe.has(userId) || blockedBy.has(userId); }

/* 'i_blocked' | 'blocked_me' | 'none' — direct query, no cache needed,
 * so it is safe to call from calls.js before the cache is warm. */
export async function checkBlockDirection(peerId) {
  if (!me) return 'none';
  try {
    const r = await sb.from('blocks').select('blocker_id, blocked_id')
      .or('and(blocker_id.eq.' + me.id + ',blocked_id.eq.' + peerId + '),and(blocker_id.eq.' + peerId + ',blocked_id.eq.' + me.id + ')');
    if (r.error) throw r.error;
    const rows = r.data || [];
    if (rows.some((x) => x.blocker_id === me.id)) return 'i_blocked';
    if (rows.length) return 'blocked_me';
    return 'none';
  } catch (e) { return 'none'; }
}

export async function blockUser(userId) {
  try {
    const r = await sb.from('blocks').insert({ blocker_id: me.id, blocked_id: userId });
    if (r.error) throw r.error;
  } catch (e) {
    toast('Could not block user: ' + (e.message || 'error'), 'error');
    return false;
  }
  blocksByMe.add(userId);
  toast('User blocked.');
  notify();
  return true;
}

export async function unblockUser(userId) {
  try {
    const r = await sb.from('blocks').delete().eq('blocker_id', me.id).eq('blocked_id', userId);
    if (r.error) throw r.error;
  } catch (e) {
    toast('Could not unblock user: ' + (e.message || 'error'), 'error');
    return false;
  }
  blocksByMe.delete(userId);
  toast('User unblocked.');
  notify();
  return true;
}

/* ---------- reports ---------- */
function openReportModal(profile) {
  reportTarget = profile;
  $('reportName').textContent = profile.full_name || profile.username;
  document.querySelectorAll('input[name="reportReason"]').forEach((x) => { x.checked = false; });
  $('reportDetails').value = '';
  $('reportModal').hidden = false;
}

function closeReportModal() {
  $('reportModal').hidden = true;
  reportTarget = null;
}

async function submitReport() {
  if (!reportTarget) return;
  const checked = document.querySelector('input[name="reportReason"]:checked');
  const reason = checked ? checked.value : '';
  if (!reason) { toast('Choose a reason for the report.', 'error'); return; }
  const details = $('reportDetails').value.trim() || null;
  try {
    const r = await sb.from('reports').insert({
      reporter_id: me.id, reported_id: reportTarget.id, reason, details
    });
    if (r.error) throw r.error;
  } catch (e) {
    toast('Could not send report: ' + (e.message || 'error'), 'error');
    return;
  }
  closeReportModal();
  toast('Thanks, your report was sent.', 'success');
}

/* ---------- actions ---------- */
export async function sendFriendRequest(userId) {
  let r;
  try { r = await sb.rpc('send_friend_request', { p_user_id: userId }); }
  catch (e) { toast('Could not send request. Check your connection.', 'error'); return false; }
  if (r.error) { toast('Could not send request: ' + r.error.message, 'error'); return false; }
  cache.set(userId, 'pending_out');
  toast('Friend request sent.', 'success');
  notify();
  return true;
}

export async function respondFriendRequest(requesterId, accept) {
  let r;
  try { r = await sb.rpc('respond_friend_request', { p_requester_id: requesterId, p_accept: accept }); }
  catch (e) { toast('Could not respond. Check your connection.', 'error'); return false; }
  if (r.error) { toast('Could not respond: ' + r.error.message, 'error'); return false; }
  cache.set(requesterId, accept ? 'friends' : 'declined');
  toast(accept ? 'Friend request accepted.' : 'Friend request declined.', 'success');
  notify();
  return true;
}

export async function cancelFriendRequest(addresseeId) {
  try {
    const r = await sb.from('friendships').delete()
      .eq('requester_id', me.id).eq('addressee_id', addresseeId).eq('status', 'pending');
    if (r.error) throw r.error;
  } catch (e) {
    toast('Could not cancel request: ' + (e.message || 'error'), 'error');
    return false;
  }
  cache.set(addresseeId, 'none');
  toast('Friend request cancelled.');
  notify();
  return true;
}

/* ---------- lists ---------- */
export async function loadRequests() {
  if (!me) return { incoming: [], outgoing: [] };
  let rows = [];
  try {
    const r = await sb.from('friendships').select('requester_id, addressee_id, status, created_at')
      .or('requester_id.eq.' + me.id + ',addressee_id.eq.' + me.id)
      .eq('status', 'pending');
    if (r.error) throw r.error;
    rows = r.data || [];
  } catch (e) {
    console.warn('load requests failed', e);
    return { incoming: [], outgoing: [] };
  }
  const incomingIds = rows.filter((x) => x.addressee_id === me.id).map((x) => x.requester_id);
  const outgoingIds = rows.filter((x) => x.requester_id === me.id).map((x) => x.addressee_id);
  const allIds = [...new Set([...incomingIds, ...outgoingIds])];
  let profilesById = new Map();
  if (allIds.length) {
    try {
      const pr = await sb.from('profiles').select('id, username, full_name, bio, avatar_url, is_public, created_at').in('id', allIds);
      if (!pr.error) profilesById = new Map((pr.data || []).map((p) => [p.id, p]));
    } catch (e) { /* profiles are best-effort */ }
  }
  const fallback = (id) => ({ id, username: 'user', full_name: 'PingChat user' });
  return {
    incoming: incomingIds.map((id) => profilesById.get(id) || fallback(id)),
    outgoing: outgoingIds.map((id) => profilesById.get(id) || fallback(id))
  };
}

export async function loadFriendProfiles() {
  if (!me) return [];
  const ids = [...cache.entries()].filter(([, s]) => s === 'friends').map(([id]) => id);
  if (!ids.length) return [];
  try {
    const pr = await sb.from('profiles').select('id, username, full_name, bio, avatar_url, is_public, created_at').in('id', ids);
    if (pr.error) return [];
    return pr.data || [];
  } catch (e) { return []; }
}

/* ---------- privacy ---------- */
/* Full profile details are visible when the profile is public, when you
 * are friends, or when a friend request is pending either way (so a
 * request recipient can inspect the sender before deciding). Otherwise
 * only avatar, name and username are shown. */
export function canSeeDetails(profile, status) {
  if (!profile) return false;
  if (profile.is_public !== false) return true;
  return status === 'friends' || status === 'pending_in' || status === 'pending_out';
}

/* ---------- profile preview modal ----------
 * Order, top to bottom: avatar, name, @username, Online/Offline status,
 * Message / Audio call / Video call buttons (friends only), friendship
 * actions (Add Friend / Accept / Decline / Request sent), profile info
 * (bio, Member since, friend status), then Clear chat / Block / Report. */
export async function openProfilePreview(profile) {
  if (!profile || !me) return;
  if (profile.id === me.id) { location.hash = '#/profile'; return; }
  previewProfile = profile;
  const status = await getFriendshipStatus(profile.id);
  const blocked = isBlockedEither(profile.id);
  const canSee = canSeeDetails(profile, status);
  $('pvAvatar').innerHTML = avatarHtml(profile, 'lg');
  $('pvName').textContent = profile.full_name || profile.username;
  $('pvUsername').textContent = '@' + profile.username;
  const online = PC.state.online.has(profile.id);
  const stEl = $('pvStatus');
  stEl.textContent = online ? 'Online' : 'Offline';
  stEl.className = 'pv-status' + (online ? ' online' : '');
  renderPreviewActions(profile, status, blocked);
  const details = $('pvDetails');
  const note = $('pvNote');
  if (canSee) {
    note.hidden = true;
    const since = profile.created_at
      ? new Date(profile.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    details.innerHTML = (profile.bio ? '<p class="pv-bio">' + esc(profile.bio) + '</p>' : '')
      + (since ? '<p class="hint">Member since ' + esc(since) + '</p>' : '')
      + (status === 'friends' ? '<p class="hint" style="color:var(--primary)">You are friends</p>'
        : status === 'pending_out' ? '<p class="hint">Friend request sent — waiting for a reply</p>'
        : status === 'pending_in' ? '<p class="hint">This person wants to be your friend</p>' : '');
  } else {
    details.innerHTML = '';
    note.hidden = false;
    note.textContent = 'This profile is private — only friends can see the details.';
  }
  await renderPreviewExtra(profile);
  $('profileModal').hidden = false;
}

export function closeProfilePreview() {
  const m = $('profileModal');
  if (m) m.hidden = true;
  previewProfile = null;
}

function renderPreviewActions(profile, status, blocked) {
  const box = $('pvActions');
  box.innerHTML = '';
  const mk = (label, cls, fn, disabled) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + cls;
    b.textContent = label;
    if (disabled) b.disabled = true;
    b.addEventListener('click', fn);
    box.append(b);
    return b;
  };
  const openChat = async () => {
    const convId = await getOrCreateConversation(profile.id);
    if (convId) { closeProfilePreview(); location.hash = '#/chat/' + convId; }
  };
  const call = async (kind) => {
    const convId = await getOrCreateConversation(profile.id);
    if (!convId) return;
    closeProfilePreview();
    startCall(convId, profile, kind);
  };
  if (blocked) {
    const s = document.createElement('span');
    s.className = 'friend-badge';
    s.style.cssText = 'display:inline-flex;align-items:center;color:var(--danger);font-weight:600;padding:10px 4px';
    s.textContent = 'Blocked';
    box.append(s);
    if (isBlockedByMe(profile.id)) {
      mk('Unblock', 'btn-ghost', async () => { if (await unblockUser(profile.id)) openProfilePreview(profile); });
    }
    return;
  }
  if (status === 'friends') {
    mk('Message', 'btn-primary', openChat);
    mk('Audio call', 'btn-ghost', () => call('audio'));
    mk('Video call', 'btn-ghost', () => call('video'));
  } else if (status === 'pending_out') {
    mk('Request sent', 'btn-ghost', () => {}, true);
    mk('Cancel', 'btn-ghost', async () => { if (await cancelFriendRequest(profile.id)) { closeProfilePreview(); } });
  } else if (status === 'pending_in') {
    mk('Accept', 'btn-primary', async () => { if (await respondFriendRequest(profile.id, true)) openProfilePreview(profile); });
    mk('Decline', 'btn-ghost', async () => { if (await respondFriendRequest(profile.id, false)) closeProfilePreview(); });
  } else {
    mk('Add Friend', 'btn-primary', async () => { if (await sendFriendRequest(profile.id)) openProfilePreview(profile); });
  }
}

async function renderPreviewExtra(profile) {
  const box = $('pvExtra');
  box.innerHTML = '';
  const mkRow = (label, danger, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pv-row' + (danger ? ' danger' : '');
    b.textContent = label;
    b.addEventListener('click', fn);
    box.append(b);
  };
  const convId = await getConversationIdWith(profile.id);
  if (convId) {
    mkRow('Clear chat', false, async () => {
      if (!confirm('Clear all messages in this chat for you?')) return;
      let r;
      try { r = await sb.rpc('clear_chat_for_me', { p_conversation_id: convId }); }
      catch (e) { toast('Could not clear chat. Check your connection.', 'error'); return; }
      if (r.error) { toast('Could not clear chat: ' + r.error.message, 'error'); return; }
      toast('Chat cleared.', 'success');
      // Refresh the conversation list, close the modal, and if this chat
      // is open right now, reload it so its messages disappear at once
      // (the old code left the cleared messages on screen until reload).
      refreshConversations();
      closeProfilePreview();
      if (PC.state.activeConversationId === convId) openConversation(convId);
    });
  }
  mkRow(isBlockedByMe(profile.id) ? 'Unblock' : 'Block', true, async () => {
    if (isBlockedByMe(profile.id)) {
      if (await unblockUser(profile.id)) openProfilePreview(profile);
    } else {
      if (await blockUser(profile.id)) openProfilePreview(profile);
    }
  });
  mkRow('Report', true, () => openReportModal(profile));
}
