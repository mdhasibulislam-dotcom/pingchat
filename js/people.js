/* PingChat v2 — people directory: all registered profiles except self. */
import { sb, PC, toast, avatarHtml, icon, onPresenceChange } from './config.js';
import { esc, debounce } from './ui.js';
import { getOrCreateConversation } from './chats.js';
import { startCall } from './calls.js';

let me = null;
let people = [];

const $ = (id) => document.getElementById(id);

export function initPeople(user) {
  me = user;
  $('peopleSearch').addEventListener('input', debounce(() => renderPeople(), 200));
  onPresenceChange(() => renderPeople());
}

export async function loadPeople() {
  if (!me) return;
  let r;
  try {
    r = await sb.from('profiles').select('id, username, full_name, bio, avatar_url, created_at')
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
  renderPeople();
}

function renderPeople() {
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
    return '<div class="person-card">'
      + avatarHtml(p, 'lg')
      + '<b>' + esc(p.full_name || p.username) + '</b>'
      + '<span class="uname">@' + esc(p.username) + (online ? ' · <span style="color:var(--primary)">Online</span>' : '') + '</span>'
      + '<span class="bio">' + esc(p.bio || '') + '</span>'
      + '<div class="actions">'
      + '<button class="btn btn-primary btn-sm" data-msg="' + p.id + '" type="button">Message</button>'
      + '<button class="btn btn-ghost btn-sm" data-call-audio="' + p.id + '" type="button" aria-label="Audio call">' + icon('phone', 16) + '</button>'
      + '<button class="btn btn-ghost btn-sm" data-call-video="' + p.id + '" type="button" aria-label="Video call">' + icon('video', 16) + '</button>'
      + '</div></div>';
  }).join('');

  grid.querySelectorAll('[data-msg]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const convId = await getOrCreateConversation(btn.dataset.msg);
      if (convId) location.hash = '#/chat/' + convId;
    });
  });
  grid.querySelectorAll('[data-call-audio], [data-call-video]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const peerId = btn.dataset.callAudio || btn.dataset.callVideo;
      const kind = btn.dataset.callVideo ? 'video' : 'audio';
      const peer = people.find((p) => p.id === peerId);
      if (!peer) return;
      const convId = await getOrCreateConversation(peerId);
      if (!convId) return;
      startCall(convId, peer, kind);
    });
  });
}
