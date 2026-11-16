/* PingChat v2 — people directory + friend requests.
 *
 * Everyone is listed, but nobody can message or call anyone until a friend
 * request is sent and accepted. Non-friends get no Message / Call buttons.
 */
import { sb, PC, avatarHtml, icon, onPresenceChange } from './config.js';
import { esc, debounce } from './ui.js';
import { getOrCreateConversation } from './chats.js';
import { startCall } from './calls.js';
import {
  initFriends, loadFriendships, loadRequests, friendshipStateOf,
  sendFriendRequest, respondFriendRequest, cancelFriendRequest,
  openProfilePreview, canSeeDetails, onFriendshipsChange,
  isBlockedByMe, isBlockedEither, unblockUser
} from './friends.js';

let me = null;
let peopleInitialized = false;
let people = [];
let tab = 'all'; // 'all' | 'requests'
let incoming = [];
let outgoing = [];

const $ = (id) => document.getElementById(id);

export function initPeople(user) {
  me = user;
  // setupUser() can run twice (boot + SIGNED_IN): without this guard every
  // listener below binds twice.
  if (peopleInitialized) return;
  peopleInitialized = true;
  initFriends(user);
  $('peopleSearch').addEventListener('input', debounce(() => renderPeople(), 200));
  $('peopleTabAll').addEventListener('click', () => { tab = 'all'; renderPeople(); });
  $('peopleTabRequests').addEventListener('click', () => { tab = 'requests'; renderPeople(); });
  onPresenceChange(() => renderPeople());
  onFriendshipsChange(() => loadPeople());
}

export async function loadPeople() {
  if (!me) return;
  let r;
  try {
    r = await sb.from('profiles').select('id, username, full_name, bio, avatar_url, is_public, created_at')
      .neq('id', me.id).order('created_at', { ascending: false }).limit(200);
  } catch (e) {
    $('peopleGrid').innerHTML = '<div class="empty">Could not load people. Check your connection.</div>';
    return;
  }
  if (r.error) {
    $('peopleGrid').innerHTML = '<div class="empty">Could not load people.</div>';
    return;
  }
  people = r.data || [];
  await loadFriendships();
  const req = await loadRequests();
  incoming = req.incoming;
  outgoing = req.outgoing;
  renderPeople();
}

function updateBadge() {
  const b = $('requestsBadge');
  if (!b) return;
  b.hidden = incoming.length === 0;
  b.textContent = incoming.length ? String(incoming.length) : '';
}

function renderPeople() {
  $('peopleTabAll').classList.toggle('active', tab === 'all');
  $('peopleTabRequests').classList.toggle('active', tab === 'requests');
  $('peopleAllWrap').hidden = tab !== 'all';
  $('peopleReqWrap').hidden = tab !== 'requests';
  updateBadge();
  if (tab === 'all') renderAll();
  else renderRequests();
}

/* ---------- action buttons for one person, by friendship state ---------- */
function personActions(p) {
  if (isBlockedEither(p.id)) {
    return '<span class="friend-badge" style="color:var(--danger)">Blocked</span>'
      + (isBlockedByMe(p.id) ? '<button class="btn btn-ghost btn-sm" data-unblock="' + p.id + '" type="button">Unblock</button>' : '');
  }
  const st = friendshipStateOf(p.id);
  if (st === 'friends') {
    return '<span class="friend-badge">' + icon('userCheck', 14) + ' Friends</span>'
      + '<button class="btn btn-primary btn-sm" data-msg="' + p.id + '" type="button">Message</button>'
      + '<button class="btn btn-ghost btn-sm" data-call-audio="' + p.id + '" type="button" aria-label="Audio call">' + icon('phone', 16) + '</button>'
      + '<button class="btn btn-ghost btn-sm" data-call-video="' + p.id + '" type="button" aria-label="Video call">' + icon('video', 16) + '</button>';
  }
  if (st === 'pending_out') {
    return '<button class="btn btn-ghost btn-sm" disabled type="button">Request sent</button>'
      + '<button class="btn btn-ghost btn-sm" data-cancel="' + p.id + '" type="button">Cancel</button>';
  }
  if (st === 'pending_in') {
    return '<button class="btn btn-primary btn-sm" data-accept="' + p.id + '" type="button">Accept</button>'
      + '<button class="btn btn-ghost btn-sm" data-decline="' + p.id + '" type="button">Decline</button>';
  }
  return '<button class="btn btn-primary btn-sm" data-add="' + p.id + '" type="button">Add Friend</button>';
}

function findPerson(id) {
  return people.find((p) => p.id === id)
    || incoming.find((p) => p.id === id)
    || outgoing.find((p) => p.id === id);
}

/* ---------- "All users" tab ---------- */
function renderAll() {
  const grid = $('peopleGrid');
  if (!grid) return;
  const q = ($('peopleSearch').value || '').trim().toLowerCase();
  const list = people.filter((p) => {
    if (!q) return true;
    return (p.full_name || '').toLowerCase().includes(q) || (p.username || '').toLowerCase().includes(q);
  });
  if (!list.length) {
    grid.innerHTML = '<div class="empty">' + icon('users', 48) + '<h3>No people found</h3><p>Try a different search.</p></div>';
    return;
  }
  grid.innerHTML = list.map((p) => {
    const online = PC.state.online.has(p.id);
    const st = friendshipStateOf(p.id);
    // The directory always shows avatar + name + username. Bio is profile
    // detail, so it only shows when the privacy rule allows it.
    const showBio = canSeeDetails(p, st) && p.bio;
    return '<div class="person-card">'
      + '<span class="person-avatar" data-preview="' + p.id + '">' + avatarHtml(p, 'lg') + '</span>'
      + '<b class="person-name" data-preview="' + p.id + '">' + esc(p.full_name || p.username) + '</b>'
      + '<span class="uname">@' + esc(p.username) + (online ? ' · <span style="color:var(--primary)">Online</span>' : '') + '</span>'
      + (showBio ? '<span class="bio">' + esc(p.bio) + '</span>' : '<span class="bio"></span>')
      + '<div class="actions">' + personActions(p) + '</div></div>';
  }).join('');
  bindPersonButtons(grid);
}

/* ---------- "Requests" tab ---------- */
function renderRequests() {
  const inc = $('incomingList');
  const out = $('outgoingList');
  inc.innerHTML = incoming.length ? incoming.map((p) => reqRowHtml(p, 'in')).join('')
    : '<div class="empty"><h3>No incoming requests</h3><p>When someone sends you a friend request, it will show up here.</p></div>';
  out.innerHTML = outgoing.length ? outgoing.map((p) => reqRowHtml(p, 'out')).join('')
    : '<div class="empty"><h3>No outgoing requests</h3><p>Requests you send will show up here until they are accepted.</p></div>';
  bindPersonButtons(inc);
  bindPersonButtons(out);
}

function reqRowHtml(p, dir) {
  const online = PC.state.online.has(p.id);
  const actions = dir === 'in'
    ? '<button class="btn btn-primary btn-sm" data-accept="' + p.id + '" type="button">Accept</button>'
      + '<button class="btn btn-ghost btn-sm" data-decline="' + p.id + '" type="button">Decline</button>'
    : '<button class="btn btn-ghost btn-sm" disabled type="button">Request sent</button>'
      + '<button class="btn btn-ghost btn-sm" data-cancel="' + p.id + '" type="button">Cancel</button>';
  return '<div class="req-row">'
    + '<span class="person-avatar" data-preview="' + p.id + '">' + avatarHtml(p, 'sm') + '</span>'
    + '<span class="c-body"><b data-preview="' + p.id + '">' + esc(p.full_name || p.username) + '</b>'
    + '<span>@' + esc(p.username) + (online ? ' · Online' : '') + '</span></span>'
    + '<span class="req-actions">' + actions + '</span></div>';
}

/* ---------- shared button wiring ---------- */
function bindPersonButtons(scope) {
  scope.querySelectorAll('[data-preview]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = findPerson(el.dataset.preview);
      if (p) openProfilePreview(p);
    });
  });
  scope.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async () => { await sendFriendRequest(btn.dataset.add); });
  });
  scope.querySelectorAll('[data-unblock]').forEach((btn) => {
    btn.addEventListener('click', async () => { await unblockUser(btn.dataset.unblock); });
  });
  scope.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', async () => { await cancelFriendRequest(btn.dataset.cancel); });
  });
  scope.querySelectorAll('[data-accept]').forEach((btn) => {
    btn.addEventListener('click', async () => { await respondFriendRequest(btn.dataset.accept, true); });
  });
  scope.querySelectorAll('[data-decline]').forEach((btn) => {
    btn.addEventListener('click', async () => { await respondFriendRequest(btn.dataset.decline, false); });
  });
  scope.querySelectorAll('[data-msg]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const convId = await getOrCreateConversation(btn.dataset.msg);
      if (convId) location.hash = '#/chat/' + convId;
    });
  });
  scope.querySelectorAll('[data-call-audio], [data-call-video]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const peerId = btn.dataset.callAudio || btn.dataset.callVideo;
      const kind = btn.dataset.callVideo ? 'video' : 'audio';
      const peer = findPerson(peerId);
      if (!peer) return;
      const convId = await getOrCreateConversation(peerId);
      if (!convId) return;
      startCall(convId, peer, kind);
    });
  });
}
