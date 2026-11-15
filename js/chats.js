/* PingChat v2 — chats: conversation list, messages, typing, read ticks. */
import { sb, PC, toast, avatarHtml, timeAgo, fmtTime, fmtDate, icon, onPresenceChange } from './config.js';
import { esc, debounce } from './ui.js';
import { startCall } from './calls.js';
import { openProfilePreview } from './friends.js';

let me = null;
let conversations = [];       // [{id, other, lastMessage, unread, lastAt}]
let activeId = null;
let activeOther = null;
let otherLastReadAt = null;
let roomChannel = null;
let typingChannel = null;
let feedChannel = null;
let renderedMsgIds = new Set();
let typingTimeout = null;
let typingVisibleFor = null;

const $ = (id) => document.getElementById(id);

export function initChats(user) {
  me = user;
  $('convSearch').addEventListener('input', debounce(() => renderConversationLists(), 200));
  $('composerForm').addEventListener('submit', onSend);
  $('msgInput').addEventListener('input', onTypingInput);
  $('audioCallBtn').addEventListener('click', () => { if (activeId && activeOther) startCall(activeId, activeOther, 'audio'); });
  $('videoCallBtn').addEventListener('click', () => { if (activeId && activeOther) startCall(activeId, activeOther, 'video'); });
  $('chatWho').addEventListener('click', () => { if (activeOther) openProfilePreview(activeOther); });
  onPresenceChange(() => { renderConversationLists(); renderChatHeader(); });

  // Global feed: any new message refreshes the list (and the open chat).
  if (!feedChannel) {
    feedChannel = sb.channel('messages-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new;
        if (m.conversation_id === activeId) appendMessage(m, true);
        refreshConversations();
      })
      .subscribe();
  }
}

/* ---------- conversation list ---------- */
export async function refreshConversations() {
  if (!me) return;
  let parts;
  try {
    const r = await sb.from('conversation_participants')
      .select('conversation_id, last_read_at').eq('user_id', me.id);
    if (r.error) throw r.error;
    parts = r.data || [];
  } catch (e) { console.warn('load conversations failed', e); return; }
  const convIds = parts.map((p) => p.conversation_id);
  const myRead = new Map(parts.map((p) => [p.conversation_id, p.last_read_at]));
  if (!convIds.length) { conversations = []; renderConversationLists(); return; }

  const [allPartsR, msgsR, convsR] = await Promise.all([
    sb.from('conversation_participants').select('conversation_id, user_id, last_read_at').in('conversation_id', convIds),
    sb.from('messages').select('id, conversation_id, sender_id, body, created_at').in('conversation_id', convIds).order('created_at', { ascending: false }).limit(500),
    sb.from('conversations').select('id, created_at, last_message_at').in('id', convIds)
  ]);
  if (allPartsR.error || msgsR.error || convsR.error) { console.warn('load conversations detail failed'); return; }

  const otherIds = [...new Set((allPartsR.data || []).map((p) => p.user_id).filter((id) => id !== me.id))];
  let profilesById = new Map();
  if (otherIds.length) {
    const pr = await sb.from('profiles').select('id, username, full_name, bio, avatar_url, is_public, created_at').in('id', otherIds);
    if (!pr.error) profilesById = new Map((pr.data || []).map((p) => [p.id, p]));
  }
  const msgsByConv = new Map();
  (msgsR.data || []).forEach((m) => {
    if (!msgsByConv.has(m.conversation_id)) msgsByConv.set(m.conversation_id, []);
    msgsByConv.get(m.conversation_id).push(m);
  });
  const convMeta = new Map((convsR.data || []).map((c) => [c.id, c]));

  conversations = convIds.map((cid) => {
    const others = (allPartsR.data || []).filter((p) => p.conversation_id === cid && p.user_id !== me.id);
    const other = others.length ? profilesById.get(others[0].user_id) || { id: others[0].user_id, username: 'user', full_name: 'PingChat user' } : null;
    const msgs = msgsByConv.get(cid) || [];
    const lastMessage = msgs[0] || null;
    const readAt = myRead.get(cid);
    const unread = msgs.filter((m) => m.sender_id !== me.id && (!readAt || new Date(m.created_at) > new Date(readAt))).length;
    const meta = convMeta.get(cid);
    return { id: cid, other, lastMessage, unread, lastAt: lastMessage ? lastMessage.created_at : (meta ? (meta.last_message_at || meta.created_at) : null) };
  }).sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));

  renderConversationLists();
}

function convRowHtml(c) {
  const name = esc(c.other ? (c.other.full_name || c.other.username) : 'PingChat user');
  const last = c.lastMessage
    ? esc((c.lastMessage.sender_id === me.id ? 'You: ' : '') + c.lastMessage.body)
    : '<span style="color:var(--muted)">No messages yet — say hello.</span>';
  const badge = c.unread ? '<span class="badge">' + c.unread + '</span>' : '';
  return '<button class="conv-row' + (c.id === activeId ? ' active' : '') + '" data-conv="' + c.id + '" type="button">'
    + avatarHtml(c.other)
    + '<span class="c-body"><span class="c-top"><b>' + name + '</b><span class="c-time">' + (c.lastAt ? timeAgo(c.lastAt) : '') + '</span></span>'
    + '<span class="c-last">' + last + '</span></span>' + badge + '</button>';
}

function emptyChatsHtml() {
  return '<div class="empty">' + icon('chat', 48) + '<h3>No conversations yet</h3>'
    + '<p>Find someone in <b>People</b> and send your first message.</p></div>';
}

export function renderConversationLists() {
  const q = ($('convSearch').value || '').trim().toLowerCase();
  const list = conversations.filter((c) => {
    if (!q) return true;
    const o = c.other || {};
    return (o.full_name || '').toLowerCase().includes(q) || (o.username || '').toLowerCase().includes(q);
  });
  const html = list.length ? list.map(convRowHtml).join('') : emptyChatsHtml();
  $('convList').innerHTML = html;
  const mobile = $('convListMobile');
  if (mobile) {
    mobile.innerHTML = list.length
      ? '<div class="view-head"><h2>Chats</h2><p>Your conversations.</p></div>' + html
      : '<div class="view-head"><h2>Chats</h2><p>Your conversations.</p></div>' + emptyChatsHtml();
  }
  document.querySelectorAll('[data-conv]').forEach((el) => {
    el.onclick = () => { location.hash = '#/chat/' + el.dataset.conv; };
  });
}

/* ---------- open chat ---------- */
export async function openConversation(id) {
  if (!me) return;
  activeId = id;
  PC.state.activeConversationId = id;
  renderedMsgIds = new Set();
  const conv = conversations.find((c) => c.id === id);
  activeOther = conv ? conv.other : null;

  // Load the other participant + their read position.
  try {
    const parts = await sb.from('conversation_participants').select('user_id, last_read_at').eq('conversation_id', id);
    if (!parts.error) {
      const otherPart = (parts.data || []).find((p) => p.user_id !== me.id);
      otherLastReadAt = otherPart ? otherPart.last_read_at : null;
      if (otherPart && !activeOther) {
        const pr = await sb.from('profiles').select('id, username, full_name, bio, avatar_url, is_public, created_at').eq('id', otherPart.user_id).maybeSingle();
        if (pr.data) activeOther = pr.data;
      }
    }
  } catch (e) { console.warn('load participants failed', e); }

  renderChatHeader();
  $('msgList').innerHTML = '<div class="empty">Loading messages…</div>';
  let msgs = [];
  try {
    const r = await sb.from('messages').select('id, conversation_id, sender_id, body, created_at')
      .eq('conversation_id', id).order('created_at', { ascending: true }).limit(200);
    if (r.error) throw r.error;
    msgs = r.data || [];
  } catch (e) {
    $('msgList').innerHTML = '<div class="empty">Could not load messages. Check your connection and try again.</div>';
    return;
  }
  $('msgList').innerHTML = '';
  msgs.forEach((m) => appendMessage(m, false));
  scrollToBottom();
  subscribeRoom(id);
  markRead();
  renderConversationLists();
}

export function closeChat() {
  activeId = null;
  activeOther = null;
  PC.state.activeConversationId = null;
  unsubscribeRoom();
  renderConversationLists();
}

function renderChatHeader() {
  if (!activeOther) return;
  $('chatAvatar').innerHTML = avatarHtml(activeOther, 'sm');
  $('chatName').textContent = activeOther.full_name || activeOther.username;
  const st = $('chatStatus');
  const online = PC.state.online.has(activeOther.id);
  st.textContent = online ? 'Online' : 'Offline';
  st.className = online ? 'online' : '';
}

function subscribeRoom(id) {
  unsubscribeRoom();
  roomChannel = sb.channel('room:' + id)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_participants', filter: 'conversation_id=eq.' + id },
      (payload) => {
        if (payload.new.user_id !== me.id) {
          otherLastReadAt = payload.new.last_read_at;
          renderMessagesTicks();
        }
      })
    .subscribe();
  typingChannel = sb.channel('typing:' + id)
    .on('broadcast', { event: 'typing' }, (payload) => {
      if (payload.payload.user_id === me.id) return;
      showTyping(payload.payload.name);
    })
    .on('broadcast', { event: 'typing-stop' }, (payload) => {
      if (payload.payload.user_id === me.id) return;
      hideTyping();
    })
    .subscribe();
}

function unsubscribeRoom() {
  if (roomChannel) { try { roomChannel.unsubscribe(); } catch (e) {} roomChannel = null; }
  if (typingChannel) { try { typingChannel.unsubscribe(); } catch (e) {} typingChannel = null; }
  hideTyping();
}

/* ---------- messages ---------- */
function dayKey(iso) { return new Date(iso).toDateString(); }

function appendMessage(m, scroll) {
  if (renderedMsgIds.has(m.id)) return;
  renderedMsgIds.add(m.id);
  const list = $('msgList');
  const mine = m.sender_id === me.id;
  const prev = list.querySelector('.msg:last-of-type');
  const prevDay = prev ? prev.dataset.day : null;
  const day = dayKey(m.created_at);
  if (prevDay !== day) {
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    const today = new Date().toDateString() === day;
    const y = new Date(); y.setDate(y.getDate() - 1);
    sep.textContent = today ? 'Today' : (y.toDateString() === day ? 'Yesterday' : fmtDate(m.created_at));
    list.append(sep);
  }
  const div = document.createElement('div');
  div.className = 'msg' + (mine ? ' me' : '');
  div.dataset.day = day;
  div.dataset.id = m.id;
  div.dataset.sender = m.sender_id;
  div.dataset.createdAt = m.created_at;
  const ticks = mine
    ? '<span class="ticks' + (isRead(m) ? ' read' : '') + '">' + (isRead(m) ? '✓✓' : '✓') + '</span>'
    : '';
  div.innerHTML = '<span class="bubble">' + esc(m.body) + '</span>'
    + '<span class="meta">' + fmtTime(m.created_at) + ticks + '</span>';
  list.append(div);
  if (scroll) scrollToBottom();
  if (!mine && m.conversation_id === activeId) markRead();
}

function isRead(m) {
  return !!otherLastReadAt && new Date(otherLastReadAt) >= new Date(m.created_at);
}
function renderMessagesTicks() {
  document.querySelectorAll('#msgList .msg.me').forEach((el) => {
    const t = el.querySelector('.ticks');
    if (!t) return;
    const read = !!otherLastReadAt && new Date(otherLastReadAt) >= new Date(el.dataset.createdAt);
    t.classList.toggle('read', read);
    t.textContent = read ? '✓✓' : '✓';
  });
}
function scrollToBottom() {
  const list = $('msgList');
  list.scrollTop = list.scrollHeight;
}

async function onSend(e) {
  e.preventDefault();
  const input = $('msgInput');
  const body = input.value.trim();
  if (!body || !activeId) return;
  input.value = '';
  stopTypingBroadcast();
  let r;
  try {
    r = await sb.from('messages').insert({ conversation_id: activeId, sender_id: me.id, body }).select().single();
  } catch (err) { toast('Could not send message. Check your connection.', 'error'); return; }
  if (r.error) { toast('Could not send message: ' + r.error.message, 'error'); return; }
  appendMessage(r.data, true);
  markRead();
  refreshConversations();
}

async function markRead() {
  if (!activeId || !me) return;
  try {
    await sb.from('conversation_participants')
      .update({ last_read_at: new Date().toISOString() })
      .eq('conversation_id', activeId).eq('user_id', me.id);
  } catch (e) { /* non-fatal */ }
  const c = conversations.find((x) => x.id === activeId);
  if (c) { c.unread = 0; renderConversationLists(); }
}

/* ---------- typing indicator ---------- */
function onTypingInput() {
  if (!typingChannel || !activeOther) return;
  typingChannel.send({ type: 'broadcast', event: 'typing', payload: { user_id: me.id, name: PC.state.profile?.full_name || 'Someone' } }).catch(() => {});
}
function stopTypingBroadcast() {
  if (!typingChannel) return;
  typingChannel.send({ type: 'broadcast', event: 'typing-stop', payload: { user_id: me.id } }).catch(() => {});
}
function showTyping(name) {
  typingVisibleFor = name;
  $('typingInd').textContent = name + ' is typing…';
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(hideTyping, 3000);
}
function hideTyping() {
  typingVisibleFor = null;
  const el = $('typingInd');
  if (el) el.textContent = '';
  clearTimeout(typingTimeout);
}

/* ---------- start / find a conversation ---------- */
export async function getOrCreateConversation(peerId) {
  let r;
  try { r = await sb.rpc('get_or_create_conversation', { p_user_id: peerId }); }
  catch (e) { toast('Could not open chat. Check your connection.', 'error'); return null; }
  if (r.error) { toast('Could not open chat: ' + r.error.message, 'error'); return null; }
  await refreshConversations();
  return r.data;
}
