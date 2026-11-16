/* PingChat v2 — chats: conversation list, messages, typing, read ticks,
 * reactions, replies, message delete, view-once voice messages. */
import { sb, PC, toast, avatarHtml, timeAgo, fmtTime, fmtDate, icon, onPresenceChange } from './config.js';
import { esc, debounce, formatDuration } from './ui.js';
import { startCall } from './calls.js';
import { openProfilePreview } from './friends.js';

let me = null;
let chatsInitialized = false;
let conversations = [];       // [{id, other, lastMessage, unread, lastAt}]
let activeId = null;
let activeOther = null;
let otherLastReadAt = null;
let roomChannel = null;
let typingChannel = null;
let feedChannel = null;
let reactionsChannel = null;
let renderedMsgIds = new Set();
let typingTimeout = null;
let typingVisibleFor = null;

let messagesById = new Map(); // rendered message id -> row
let replyTargets = new Map(); // reply_to_id -> row | null (null = deleted / not visible)
let reactionsByMsg = new Map(); // message id -> [{user_id, emoji}]
let replyTo = null;           // message being replied to
let consumedVoiceIds = new Set(); // view-once voice ids already consumed by me
let audioEls = new Map();     // voice message id -> { audio }
let playingAudio = null;      // { msgId, audio }

const REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '😡', '👍'];
const MAX_VOICE_SECONDS = 120;

const $ = (id) => document.getElementById(id);

export function initChats(user) {
  me = user;
  // setupUser() can run twice (boot + SIGNED_IN): without this guard every
  // listener below binds twice, so messages send twice and calls start twice.
  if (chatsInitialized) return;
  chatsInitialized = true;
  $('convSearch').addEventListener('input', debounce(() => renderConversationLists(), 200));
  $('composerForm').addEventListener('submit', onSend);
  $('msgInput').addEventListener('input', onTypingInput);
  $('audioCallBtn').addEventListener('click', () => { if (activeId && activeOther) startCall(activeId, activeOther, 'audio'); });
  $('videoCallBtn').addEventListener('click', () => { if (activeId && activeOther) startCall(activeId, activeOther, 'video'); });
  $('chatWho').addEventListener('click', () => { if (activeOther) openProfilePreview(activeOther); });
  $('replyBarCancel').innerHTML = icon('x', 16);
  $('replyBarCancel').addEventListener('click', clearReply);
  $('micBtn').addEventListener('click', onMicClick);
  $('voiceRecStop').addEventListener('click', stopVoiceRecording);
  $('voicePrevPlay').addEventListener('click', togglePreviewPlayback);
  $('voicePrevSend').addEventListener('click', sendVoicePreview);
  $('voicePrevCancel').addEventListener('click', cancelVoicePreview);
  onPresenceChange(() => { renderConversationLists(); renderChatHeader(); renderMessagesTicks(); });

  // Mark read when the chat comes back on screen (seen = actually looking).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activeId) markRead();
  });

  // Close the floating message menu on outside click / Escape.
  document.addEventListener('click', (e) => {
    const menu = $('msgMenu');
    if (!menu || menu.hidden) return;
    if (menu.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.msg-menu-btn')) return;
    closeMsgMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMsgMenu(); });

  // Global feed: new messages, deletions and delete-for-me updates.
  if (!feedChannel) {
    feedChannel = sb.channel('messages-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new;
        if (m.conversation_id === activeId) appendMessage(m, true);
        refreshConversations();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (payload) => {
        const m = payload.new;
        if (m && m.conversation_id === activeId && m.deleted_by && m.deleted_by.includes(me.id)) {
          removeMessageElement(m.id);
        }
        refreshConversations();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (payload) => {
        const id = payload.old && payload.old.id;
        if (id) {
          markQuotesDeleted(id);
          removeMessageElement(id);
        }
        refreshConversations();
      })
      .subscribe();
  }
  // Live reactions.
  if (!reactionsChannel) {
    reactionsChannel = sb.channel('reactions-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions' }, (payload) => {
        applyReactionInsert(payload.new);
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions' }, (payload) => {
        applyReactionDelete(payload.old);
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

  const [allPartsR, convsR] = await Promise.all([
    sb.from('conversation_participants').select('conversation_id, user_id, last_read_at').in('conversation_id', convIds),
    sb.from('conversations').select('id, created_at, last_message_at').in('id', convIds)
  ]);
  if (allPartsR.error || convsR.error) { console.warn('load conversations detail failed'); return; }

  // One query per conversation for its latest message + unread count.
  // The old code fetched 500 messages across ALL conversations, so quiet
  // conversations lost their last message (and unread counts) once the
  // 500 cap was hit by busier chats.
  const perConv = await Promise.all(convIds.map(async (cid) => {
    const readAt = myRead.get(cid);
    let unreadQ = sb.from('messages').select('id', { count: 'exact', head: true })
      .eq('conversation_id', cid).neq('sender_id', me.id);
    if (readAt) unreadQ = unreadQ.gt('created_at', readAt);
    const [lastR, unreadR] = await Promise.all([
      sb.from('messages').select('id, conversation_id, sender_id, body, created_at, kind')
        .eq('conversation_id', cid).order('created_at', { ascending: false }).limit(1),
      unreadQ
    ]);
    return {
      cid,
      lastMessage: (!lastR.error && lastR.data && lastR.data[0]) ? lastR.data[0] : null,
      unread: (!unreadR.error && typeof unreadR.count === 'number') ? unreadR.count : 0
    };
  }));
  const lastByConv = new Map(perConv.map((p) => [p.cid, p]));

  const otherIds = [...new Set((allPartsR.data || []).map((p) => p.user_id).filter((id) => id !== me.id))];
  let profilesById = new Map();
  if (otherIds.length) {
    const pr = await sb.from('profiles').select('id, username, full_name, bio, avatar_url, is_public, created_at').in('id', otherIds);
    if (!pr.error) profilesById = new Map((pr.data || []).map((p) => [p.id, p]));
  }
  const convMeta = new Map((convsR.data || []).map((c) => [c.id, c]));

  conversations = convIds.map((cid) => {
    const others = (allPartsR.data || []).filter((p) => p.conversation_id === cid && p.user_id !== me.id);
    const other = others.length ? profilesById.get(others[0].user_id) || { id: others[0].user_id, username: 'user', full_name: 'PingChat user' } : null;
    const entry = lastByConv.get(cid) || { lastMessage: null, unread: 0 };
    const lastMessage = entry.lastMessage;
    const meta = convMeta.get(cid);
    return { id: cid, other, lastMessage, unread: entry.unread, lastAt: lastMessage ? lastMessage.created_at : (meta ? (meta.last_message_at || meta.created_at) : null) };
  }).sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));

  renderConversationLists();
}

function convRowHtml(c) {
  const name = esc(c.other ? (c.other.full_name || c.other.username) : 'PingChat user');
  const last = c.lastMessage
    ? esc((c.lastMessage.sender_id === me.id ? 'You: ' : '') + (c.lastMessage.kind === 'voice' ? 'Voice message' : c.lastMessage.body))
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

/* ---------- find a conversation with a peer (for Clear chat etc.) ---------- */
export async function getConversationIdWith(peerId) {
  const c = conversations.find((x) => x.other && x.other.id === peerId);
  if (c) return c.id;
  try {
    const mine = await sb.from('conversation_participants').select('conversation_id').eq('user_id', me.id);
    const ids = (mine.data || []).map((p) => p.conversation_id);
    if (!ids.length) return null;
    const others = await sb.from('conversation_participants').select('conversation_id')
      .in('conversation_id', ids).eq('user_id', peerId);
    return (others.data && others.data[0]) ? others.data[0].conversation_id : null;
  } catch (e) { return null; }
}

/* ---------- open chat ---------- */
export async function openConversation(id) {
  if (!me) return;
  activeId = id;
  PC.state.activeConversationId = id;
  renderedMsgIds = new Set();
  messagesById = new Map();
  replyTargets = new Map();
  reactionsByMsg = new Map();
  consumedVoiceIds = new Set();
  stopPlayingAudio();
  audioEls.forEach((e) => { try { e.audio.pause(); } catch (err) {} });
  audioEls.clear();
  stopVoiceRecording();
  cancelVoicePreview();
  clearReply();
  closeMsgMenu();
  const conv = conversations.find((c) => c.id === id);
  activeOther = conv ? conv.other : null;

  // Load the other participant + their read position.
  // If the query succeeds but has no row for me, I am not part of this
  // conversation — show an error and go back instead of a blank window.
  let partsOk = false;
  let isParticipant = false;
  try {
    const parts = await sb.from('conversation_participants').select('user_id, last_read_at').eq('conversation_id', id);
    if (!parts.error) {
      partsOk = true;
      isParticipant = (parts.data || []).some((p) => p.user_id === me.id);
      const otherPart = (parts.data || []).find((p) => p.user_id !== me.id);
      otherLastReadAt = otherPart ? otherPart.last_read_at : null;
      if (otherPart && !activeOther) {
        const pr = await sb.from('profiles').select('id, username, full_name, bio, avatar_url, is_public, created_at').eq('id', otherPart.user_id).maybeSingle();
        if (pr.data) activeOther = pr.data;
      }
    }
  } catch (e) { console.warn('load participants failed', e); }
  if (partsOk && !isParticipant) {
    toast('You are not part of this conversation.', 'error');
    closeChat();
    location.hash = '#/chats';
    return;
  }

  renderChatHeader();
  $('msgList').innerHTML = '<div class="empty">Loading messages…</div>';
  let msgs = [];
  try {
    const r = await sb.from('messages').select('id, conversation_id, sender_id, body, created_at, reply_to_id, kind, media_url, media_path, view_once')
      .eq('conversation_id', id).order('created_at', { ascending: true }).limit(200);
    if (r.error) throw r.error;
    msgs = r.data || [];
  } catch (e) {
    $('msgList').innerHTML = '<div class="empty">Could not load messages. Check your connection and try again.</div>';
    return;
  }
  // Resolve reply targets (for quotes) before rendering.
  const replyIds = [...new Set(msgs.map((m) => m.reply_to_id).filter(Boolean))];
  const missing = replyIds.filter((x) => !replyTargets.has(x));
  if (missing.length) {
    try {
      const tr = await sb.from('messages').select('id, sender_id, body, kind').in('id', missing);
      if (!tr.error) {
        (tr.data || []).forEach((t) => replyTargets.set(t.id, t));
        missing.forEach((x) => { if (!replyTargets.has(x)) replyTargets.set(x, null); });
      }
    } catch (e) { /* quotes fill in later via ensureReplyTarget */ }
  }
  $('msgList').innerHTML = '';
  msgs.forEach((m) => appendMessage(m, false));
  // Reactions for the loaded messages.
  const ids = msgs.map((m) => m.id);
  if (ids.length) {
    try {
      const rr = await sb.from('message_reactions').select('message_id, user_id, emoji').in('message_id', ids);
      if (!rr.error) {
        (rr.data || []).forEach((row) => {
          const list = reactionsByMsg.get(row.message_id) || [];
          list.push(row);
          reactionsByMsg.set(row.message_id, list);
        });
        ids.forEach((x) => renderReactions(x));
      }
    } catch (e) { /* reactions are best-effort */ }
  }
  scrollToBottom();
  subscribeRoom(id);
  markRead();
  renderConversationLists();

  // Opened from a notification's Reply button (?reply=1): focus the composer
  // so the user can type straight away, then drop the param.
  try {
    if (new URLSearchParams(window.location.search).get('reply') === '1') {
      const inp = $('msgInput');
      if (inp) inp.focus();
      history.replaceState(null, '', window.location.pathname + window.location.hash);
    }
  } catch (e) { /* focus is best-effort */ }
}

export function closeChat() {
  activeId = null;
  activeOther = null;
  PC.state.activeConversationId = null;
  unsubscribeRoom();
  stopVoiceRecording();
  cancelVoicePreview();
  stopPlayingAudio();
  clearReply();
  closeMsgMenu();
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

function senderNameOf(userId) {
  if (userId === me.id) return 'You';
  return activeOther ? (activeOther.full_name || activeOther.username) : 'Them';
}

function quoteHtml(m) {
  if (!m.reply_to_id) return '';
  const t = messagesById.get(m.reply_to_id);
  if (t) return quoteElHtml(m.reply_to_id, t.sender_id, t.kind === 'voice' ? 'Voice message' : (t.body || ''));
  const known = replyTargets.get(m.reply_to_id);
  if (known === null) return '<div class="quote" data-target="' + m.reply_to_id + '"><b></b><span class="quote-text">Message deleted</span></div>';
  if (known) return quoteElHtml(m.reply_to_id, known.sender_id, known.kind === 'voice' ? 'Voice message' : (known.body || ''));
  ensureReplyTarget(m.reply_to_id);
  return '<div class="quote" data-target="' + m.reply_to_id + '"><b>…</b><span class="quote-text">Loading…</span></div>';
}

function quoteElHtml(targetId, senderId, text) {
  return '<div class="quote" data-target="' + targetId + '"><b>' + esc(senderNameOf(senderId)) + '</b><span class="quote-text">' + esc(text) + '</span></div>';
}

async function ensureReplyTarget(id) {
  if (replyTargets.has(id)) return;
  try {
    const r = await sb.from('messages').select('id, sender_id, body, kind').eq('id', id).maybeSingle();
    replyTargets.set(id, r.data || null);
  } catch (e) { return; }
  const t = replyTargets.get(id);
  document.querySelectorAll('#msgList .quote[data-target="' + id + '"]').forEach((el) => {
    if (t === null) {
      const s = el.querySelector('.quote-text');
      if (s) s.textContent = 'Message deleted';
      const b = el.querySelector('b');
      if (b) b.textContent = '';
    } else {
      el.outerHTML = quoteElHtml(id, t.sender_id, t.kind === 'voice' ? 'Voice message' : (t.body || ''));
    }
  });
  // Re-bind quote clicks after an outerHTML swap.
  document.querySelectorAll('#msgList .quote[data-target="' + id + '"]').forEach((el) => {
    el.addEventListener('click', () => jumpToMessage(id));
  });
}

function jumpToMessage(id) {
  const el = document.querySelector('#msgList .msg[data-id="' + id + '"]');
  if (!el) { toast('Original message is no longer visible.', 'error'); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1300);
}

function markQuotesDeleted(id) {
  replyTargets.set(id, null);
  document.querySelectorAll('#msgList .quote[data-target="' + id + '"]').forEach((q) => {
    const t = q.querySelector('.quote-text');
    if (t) t.textContent = 'Message deleted';
  });
}

function voiceBubbleHtml(m) {
  return '<span class="bubble voice-bubble"><span class="voice-player">'
    + '<button class="voice-play" type="button" aria-label="Play voice message">' + icon('play', 16) + '</button>'
    + '<span class="voice-prog"><span class="voice-prog-fill"></span></span>'
    + '<span class="voice-dur">0:00</span></span>'
    + (m.view_once ? '<span class="voice-once">View once</span>' : '')
    + '</span>';
}

function appendMessage(m, scroll) {
  if (renderedMsgIds.has(m.id)) return;
  renderedMsgIds.add(m.id);
  messagesById.set(m.id, m);
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
  const ticks = mine ? ticksHtml(m) : '';
  div.innerHTML = '<div class="msg-row"><div class="bubble-wrap">'
    + quoteHtml(m)
    + (m.kind === 'voice' ? voiceBubbleHtml(m) : '<span class="bubble">' + esc(m.body || '') + '</span>')
    + '<div class="reactions"></div>'
    + '</div><button class="msg-menu-btn" type="button" aria-label="Message options">' + icon('more', 16) + '</button></div>'
    + '<span class="meta">' + fmtTime(m.created_at) + ticks + '</span>';
  list.append(div);
  wireMessage(div, m);
  renderReactions(m.id);
  if (scroll) scrollToBottom();
  // Seen only when the chat is actually on screen: an open-but-backgrounded
  // chat must not mark messages read.
  if (!mine && m.conversation_id === activeId && document.visibilityState === 'visible') markRead();
}

function wireMessage(div, m) {
  const menuBtn = div.querySelector('.msg-menu-btn');
  if (menuBtn) menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openMsgMenu(m.id, menuBtn); });
  const quote = div.querySelector('.quote');
  if (quote) quote.addEventListener('click', () => jumpToMessage(m.reply_to_id));
  const playBtn = div.querySelector('.voice-play');
  if (playBtn) playBtn.addEventListener('click', () => toggleVoicePlayback(m));
  const prog = div.querySelector('.voice-prog');
  if (prog) prog.addEventListener('click', (e) => {
    const entry = audioEls.get(m.id);
    if (!entry || !entry.audio.duration) return;
    const r = prog.getBoundingClientRect();
    entry.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * entry.audio.duration;
  });
}

function removeMessageElement(msgId) {
  renderedMsgIds.delete(msgId);
  messagesById.delete(msgId);
  const el = document.querySelector('#msgList .msg[data-id="' + msgId + '"]');
  if (el) el.remove();
  if (replyTo && replyTo.id === msgId) clearReply();
}

function isRead(m) {
  return !!otherLastReadAt && new Date(otherLastReadAt) >= new Date(m.created_at);
}
// Three tick states: sent (one tick), delivered (two ticks), seen (round badge).
// Delivered = the message reached the peer's phone, which we know when the
// peer is online (app connected); offline = sent only.
// Delivered is sticky within the session: once a message was delivered, it
// stays double-ticked even if the peer goes offline again.
const deliveredIds = new Set();
function tickState(m) {
  if (isRead(m)) return 'seen';
  if (deliveredIds.has(m.id)) return 'delivered';
  if (activeOther && PC.state.online.has(activeOther.id)) { deliveredIds.add(m.id); return 'delivered'; }
  return 'sent';
}
function ticksHtml(m) {
  const s = tickState(m);
  if (s === 'seen') return '<span class="ticks read"><span class="seen-badge">✓</span></span>';
  if (s === 'delivered') return '<span class="ticks">✓✓</span>';
  return '<span class="ticks">✓</span>';
}
function renderMessagesTicks() {
  document.querySelectorAll('#msgList .msg.me').forEach((el) => {
    const t = el.querySelector('.ticks');
    if (!t) return;
    t.outerHTML = ticksHtml({ id: el.dataset.id, created_at: el.dataset.createdAt });
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
  const payload = { conversation_id: activeId, sender_id: me.id, body };
  if (replyTo) payload.reply_to_id = replyTo.id;
  let r;
  try {
    r = await sb.from('messages').insert(payload).select().single();
  } catch (err) { toast('Could not send message. Check your connection.', 'error'); return; }
  if (r.error) { toast('Could not send message: ' + r.error.message, 'error'); return; }
  clearReply();
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

/* ---------- message menu: react / reply / delete ---------- */
function openMsgMenu(msgId, anchor) {
  const m = messagesById.get(msgId);
  if (!m) return;
  const menu = $('msgMenu');
  const mine = m.sender_id === me.id;
  menu.innerHTML = '';
  const mkItem = (label, fn, danger) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'msg-menu-item' + (danger ? ' danger' : '');
    b.textContent = label;
    // Stop propagation: without this, the document outside-click handler
    // runs after the item handler (bubbling) and closes the menu. For
    // "React" the click replaces menu.innerHTML (showEmojiPicker), which
    // detaches the clicked button, so menu.contains(e.target) is false
    // and the emoji picker closes in the same tap.
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    menu.append(b);
  };
  mkItem('React', () => showEmojiPicker(msgId));
  mkItem('Reply', () => { closeMsgMenu(); startReply(msgId); });
  if (mine) {
    mkItem('Delete for me', () => { closeMsgMenu(); deleteForMe(msgId); });
    mkItem('Delete for everyone', () => { closeMsgMenu(); deleteForEveryone(msgId); }, true);
  }
  positionMenu(menu, anchor);
}

function showEmojiPicker(msgId) {
  const menu = $('msgMenu');
  menu.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'emoji-row';
  REACTION_EMOJIS.forEach((em) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    b.setAttribute('aria-label', 'React ' + em);
    b.addEventListener('click', () => { closeMsgMenu(); toggleReaction(msgId, em); });
    row.append(b);
  });
  menu.append(row);
}

function positionMenu(menu, anchor) {
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function closeMsgMenu() {
  const menu = $('msgMenu');
  if (menu) menu.hidden = true;
}

/* ---------- reactions ---------- */
function renderReactions(msgId) {
  const el = document.querySelector('#msgList .msg[data-id="' + msgId + '"] .reactions');
  if (!el) return;
  const list = reactionsByMsg.get(msgId) || [];
  const groups = new Map();
  list.forEach((r) => {
    const g = groups.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false };
    g.count += 1;
    if (r.user_id === me.id) g.mine = true;
    groups.set(r.emoji, g);
  });
  el.innerHTML = '';
  [...groups.values()].forEach((g) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'react-chip' + (g.mine ? ' mine' : '');
    chip.textContent = g.emoji + (g.count > 1 ? ' ' + g.count : '');
    chip.addEventListener('click', () => toggleReaction(msgId, g.emoji));
    el.append(chip);
  });
}

function applyReactionInsert(row) {
  if (!row || !row.message_id) return;
  const list = reactionsByMsg.get(row.message_id) || [];
  const i = list.findIndex((r) => r.user_id === row.user_id);
  if (i >= 0) list[i] = row; else list.push(row);
  reactionsByMsg.set(row.message_id, list);
  renderReactions(row.message_id);
}

function applyReactionDelete(oldRow) {
  if (!oldRow || !oldRow.message_id) return;
  const list = reactionsByMsg.get(oldRow.message_id) || [];
  reactionsByMsg.set(oldRow.message_id, list.filter((r) => r.user_id !== oldRow.user_id));
  renderReactions(oldRow.message_id);
}

async function toggleReaction(msgId, emoji) {
  const list = reactionsByMsg.get(msgId) || [];
  const mine = list.find((r) => r.user_id === me.id);
  try {
    if (mine && mine.emoji === emoji) {
      const r = await sb.from('message_reactions').delete()
        .eq('message_id', msgId).eq('user_id', me.id).eq('emoji', emoji);
      if (r.error) throw r.error;
      applyReactionDelete({ message_id: msgId, user_id: me.id });
    } else {
      const r = await sb.from('message_reactions')
        .upsert({ message_id: msgId, user_id: me.id, emoji }, { onConflict: 'message_id,user_id' })
        .select().single();
      if (r.error) throw r.error;
      applyReactionInsert(r.data);
    }
  } catch (e) {
    toast('Could not react: ' + (e.message || 'error'), 'error');
  }
}

/* ---------- reply ---------- */
function startReply(msgId) {
  const m = messagesById.get(msgId);
  if (!m) return;
  replyTo = m;
  $('replyBarName').textContent = 'Replying to ' + senderNameOf(m.sender_id);
  $('replyBarText').textContent = m.kind === 'voice' ? 'Voice message' : (m.body || '');
  $('replyBar').hidden = false;
  $('msgInput').focus();
}

function clearReply() {
  replyTo = null;
  const bar = $('replyBar');
  if (bar) bar.hidden = true;
}

/* ---------- delete ---------- */
async function deleteForMe(msgId) {
  let r;
  try { r = await sb.rpc('delete_message_for_me', { p_message_id: msgId }); }
  catch (e) { toast('Could not delete message. Check your connection.', 'error'); return; }
  if (r.error) { toast('Could not delete message: ' + r.error.message, 'error'); return; }
  removeMessageElement(msgId);
  refreshConversations();
}

async function deleteForEveryone(msgId) {
  let r;
  try { r = await sb.rpc('delete_message_for_everyone', { p_message_id: msgId }); }
  catch (e) { toast('Could not delete message. Check your connection.', 'error'); return; }
  if (r.error) { toast('Could not delete message: ' + r.error.message, 'error'); return; }
  const mediaPath = r.data;
  removeMessageElement(msgId);
  if (mediaPath) {
    try { await sb.storage.from('voice-messages').remove([mediaPath]); } catch (e) { /* best-effort */ }
  }
  refreshConversations();
}

/* ---------- voice messages (view-once) ---------- */
let recState = null;    // { stream, recorder, chunks, mime, startAt, timerId, stopId }
let previewState = null; // { blob, url, mime, duration, audio, playing }

function onMicClick() {
  if (previewState) { toast('Finish or cancel the current voice clip first.'); return; }
  if (recState) { toast('Recording already in progress — tap Stop to finish.'); return; }
  startVoiceRecording();
}

async function startVoiceRecording() {
  if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Voice recording is not supported in this browser.', 'error');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const errName = e && e.name;
    if (errName === 'NotAllowedError' || errName === 'SecurityError' || errName === 'PermissionDeniedError') {
      toast('Microphone is blocked. Tap the lock icon in the address bar → Site settings → Microphone → Allow, then tap the mic again.', 'error');
    } else {
      toast('Microphone unavailable: ' + (e && (e.message || errName) || 'permission denied'), 'error');
    }
    return;
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => {
    try { return MediaRecorder.isTypeSupported(t); } catch (err) { return false; }
  }) || '';
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    toast('Voice recording is not supported in this browser.', 'error');
    return;
  }
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  // Capture this recording's state in a local const: the old code read the
  // module-level recState inside onstop, so starting a second recording
  // before the first one's onstop fired wiped the first clip's state.
  const state = { stream, recorder, chunks, mime, startAt: Date.now(), timerId: null, stopId: null, convId: activeId };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: baseMime(mime) });
    const duration = (Date.now() - state.startAt) / 1000;
    stream.getTracks().forEach((t) => t.stop());
    if (recState === state) recState = null;
    $('voiceRecBar').hidden = true;
    // If the user left the chat while recording, discard the clip
    // instead of showing a preview that could be sent to the wrong chat.
    if (state.convId !== activeId) return;
    showVoicePreview(blob, mime, duration);
  };
  recState = state;
  recorder.start(250);
  $('voiceRecBar').hidden = false;
  $('voiceRecTimer').textContent = '00:00';
  state.timerId = setInterval(() => {
    if (recState !== state) return;
    $('voiceRecTimer').textContent = formatDuration((Date.now() - state.startAt) / 1000);
  }, 500);
  state.stopId = setTimeout(() => { if (recState === state) stopVoiceRecording(); }, MAX_VOICE_SECONDS * 1000);
}

function stopVoiceRecording() {
  if (!recState) return;
  clearInterval(recState.timerId);
  clearTimeout(recState.stopId);
  try { recState.recorder.stop(); } catch (e) {
    recState.stream.getTracks().forEach((t) => t.stop());
    recState = null;
    $('voiceRecBar').hidden = true;
  }
}

function showVoicePreview(blob, mime, duration) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  previewState = { blob, url, mime, duration, audio, playing: false };
  $('voicePrevPlay').innerHTML = icon('play', 16);
  $('voicePrevDur').textContent = formatDuration(duration);
  $('voicePrevProg').style.width = '0%';
  $('voicePreviewBar').hidden = false;
  audio.addEventListener('timeupdate', () => {
    if (previewState && audio.duration) {
      $('voicePrevProg').style.width = Math.min(100, (audio.currentTime / audio.duration) * 100) + '%';
    }
  });
  audio.addEventListener('ended', () => {
    if (!previewState) return;
    previewState.playing = false;
    $('voicePrevPlay').innerHTML = icon('play', 16);
  });
}

function togglePreviewPlayback() {
  if (!previewState) return;
  if (previewState.playing) {
    previewState.audio.pause();
    previewState.playing = false;
    $('voicePrevPlay').innerHTML = icon('play', 16);
    return;
  }
  previewState.audio.play().catch(() => toast('Could not play preview.', 'error'));
  previewState.playing = true;
  $('voicePrevPlay').innerHTML = icon('pause', 16);
}

function cancelVoicePreview() {
  if (!previewState) return;
  try { previewState.audio.pause(); } catch (e) {}
  URL.revokeObjectURL(previewState.url);
  previewState = null;
  $('voicePreviewBar').hidden = true;
}

function extForMime(mime) {
  if (/mp4/i.test(mime || '')) return '.m4a';
  if (/ogg/i.test(mime || '')) return '.ogg';
  return '.webm';
}

// Strip the codec parameter: the storage bucket's MIME allowlist accepts
// 'audio/webm' but rejects 'audio/webm;codecs=opus'.
function baseMime(mime) {
  return String(mime || 'audio/webm').split(';')[0].trim() || 'audio/webm';
}

async function sendVoicePreview() {
  if (!previewState || !activeId) return;
  const btn = $('voicePrevSend');
  btn.disabled = true;
  const path = me.id + '/' + (crypto.randomUUID ? crypto.randomUUID() : 'v-' + Date.now()) + extForMime(previewState.mime);
  try {
    const up = await sb.storage.from('voice-messages').upload(path, previewState.blob, {
      contentType: baseMime(previewState.mime), upsert: false
    });
    if (up.error) throw up.error;
    const { data } = sb.storage.from('voice-messages').getPublicUrl(path);
    const r = await sb.from('messages').insert({
      conversation_id: activeId, sender_id: me.id, body: '',
      kind: 'voice', media_url: data.publicUrl, media_path: path, view_once: true
    }).select().single();
    if (r.error) throw r.error;
    cancelVoicePreview();
    appendMessage(r.data, true);
    markRead();
    refreshConversations();
  } catch (e) {
    toast('Could not send voice message: ' + (e.message || 'error'), 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- voice playback (view-once consume) ---------- */
function voiceEls(msgId) {
  const el = document.querySelector('#msgList .msg[data-id="' + msgId + '"]');
  if (!el) return null;
  return {
    root: el,
    playBtn: el.querySelector('.voice-play'),
    fill: el.querySelector('.voice-prog-fill'),
    dur: el.querySelector('.voice-dur')
  };
}

function setVoiceIcon(msgId, playing) {
  const els = voiceEls(msgId);
  if (els && els.playBtn) els.playBtn.innerHTML = icon(playing ? 'pause' : 'play', 16);
}

function stopPlayingAudio() {
  if (playingAudio) {
    try { playingAudio.audio.pause(); } catch (e) {}
    playingAudio = null;
  }
}

function toggleVoicePlayback(m) {
  if (!m.media_url) return;
  if (playingAudio && playingAudio.msgId === m.id) {
    playingAudio.audio.pause();
    return;
  }
  stopPlayingAudio();
  let entry = audioEls.get(m.id);
  if (!entry) {
    const audio = new Audio(m.media_url);
    audio.preload = 'metadata';
    entry = { audio };
    audioEls.set(m.id, entry);
    audio.addEventListener('loadedmetadata', () => {
      const els = voiceEls(m.id);
      if (els && els.dur && isFinite(audio.duration)) els.dur.textContent = formatDuration(audio.duration);
    });
    audio.addEventListener('timeupdate', () => {
      const els = voiceEls(m.id);
      if (els && els.fill && audio.duration) {
        els.fill.style.width = Math.min(100, (audio.currentTime / audio.duration) * 100) + '%';
      }
    });
    audio.addEventListener('pause', () => {
      setVoiceIcon(m.id, false);
      if (playingAudio && playingAudio.msgId === m.id) playingAudio = null;
    });
    audio.addEventListener('ended', () => { onVoiceEnded(m); });
  }
  entry.audio.play().catch(() => toast('Could not play voice message.', 'error'));
  playingAudio = { msgId: m.id, audio: entry.audio };
  setVoiceIcon(m.id, true);
}

async function onVoiceEnded(m) {
  setVoiceIcon(m.id, false);
  const els = voiceEls(m.id);
  if (els && els.fill) els.fill.style.width = '0%';
  if (playingAudio && playingAudio.msgId === m.id) playingAudio = null;
  // View-once: only the RECIPIENT's full playback deletes the message.
  // Pausing or stopping early never fires 'ended', so it never counts.
  // The sender playing their own voice does NOT delete it.
  if (!m.view_once || m.sender_id === me.id || consumedVoiceIds.has(m.id)) return;
  try {
    const r = await sb.rpc('consume_voice_message', { p_message_id: m.id });
    if (!r.error && r.data === true) {
      // Only mark consumed AFTER the server confirms the delete, so a
      // failed consume can be retried by listening again.
      consumedVoiceIds.add(m.id);
      if (m.media_path) {
        try { await sb.storage.from('voice-messages').remove([m.media_path]); } catch (e) { /* best-effort */ }
      }
      removeMessageElement(m.id);
      refreshConversations();
    }
  } catch (e) { /* best-effort */ }
}

/* ---------- typing indicator ---------- */
// Debounced + throttled: the old code broadcast on every keystroke. Now we
// wait 300ms after the last keystroke and send at most once per 2.5s while
// typing continues (the peer hides the indicator after 3s of silence).
let typingDebounceTimer = null;
let typingLastSentAt = 0;
function onTypingInput() {
  if (!typingChannel || !activeOther) return;
  clearTimeout(typingDebounceTimer);
  typingDebounceTimer = setTimeout(() => {
    if (!typingChannel || !activeOther) return;
    const now = Date.now();
    if (now - typingLastSentAt < 2500) return; // already announced recently
    typingLastSentAt = now;
    typingChannel.send({ type: 'broadcast', event: 'typing', payload: { user_id: me.id, name: PC.state.profile?.full_name || 'Someone' } }).catch(() => {});
  }, 300);
}
function stopTypingBroadcast() {
  typingLastSentAt = 0;
  clearTimeout(typingDebounceTimer);
  if (!typingChannel) return;
  typingChannel.send({ type: 'broadcast', event: 'typing-stop', payload: { user_id: me.id } }).catch(() => {});
}
function showTyping(name) {
  typingVisibleFor = name;
  const el = $('typingInd');
  if (!el) return;
  // No name text: the peer's small avatar + three waving dots, like Messenger.
  const avatar = activeOther ? avatarHtml(activeOther, 'xs') : '';
  el.innerHTML = avatar + '<span class="typing-dots" aria-label="typing"><span></span><span></span><span></span></span>';
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(hideTyping, 3000);
}
function hideTyping() {
  typingVisibleFor = null;
  const el = $('typingInd');
  if (el) el.innerHTML = '';
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
