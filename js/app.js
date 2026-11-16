/* PingChat v2 — bootstrap, hash router, auth guard, presence, theme.
 * Single-page app: ONE index.html shell, views switched by hash route.
 * Routes: #/login #/register #/reset (signed out)
 *         #/chats #/chat/<id> #/calls #/people #/profile #/settings (signed in)
 * Root URL (#/ or empty) shows login when signed out, chats when signed in.
 * There is deliberately NO landing page.
 */
import { sb, PC, toast, avatarHtml, icon, onPresenceChange, emitPresenceChange } from './config.js';
import { initAuth, ensureProfile, isRecoveryUrl } from './auth.js';
import { initChats, openConversation, closeChat, refreshConversations } from './chats.js';
import { initCalls, endCallIfActive, renderCallFriends } from './calls.js';
import { initPeople, loadPeople } from './people.js';
import { initProfile, loadProfile } from './profile.js';
import { initSettings, loadSettings } from './settings.js';

const AUTH_VIEWS = ['login', 'register', 'reset'];
const APP_VIEWS = ['chats', 'chat', 'calls', 'people', 'profile', 'settings'];

let session = null;
let presenceChannel = null;
let booted = false;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  // Ignore Supabase auth tokens in the hash (e.g. access_token=…&type=recovery).
  if (parts.length && parts[0].includes('access_token')) return { name: '', param: null };
  return { name: parts[0] || '', param: parts[1] || null };
}

function $(id) { return document.getElementById(id); }

/* ---------- theme ---------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('pingchat-theme', theme); } catch (e) {}
  const btn = $('themeBtnMobile');
  if (btn) btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 20);
  const rowIcon = $('settingsThemeIcon');
  if (rowIcon) rowIcon.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 20);
}
export function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
}
export function initTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem('pingchat-theme') || 'light'; } catch (e) {}
  applyTheme(saved === 'dark' ? 'dark' : 'light');
  $('themeBtnMobile').addEventListener('click', toggleTheme);
}

/* ---------- view switching ---------- */
function showAuthView(name) {
  $('authRoot').hidden = false;
  $('appLayout').hidden = true;
  document.body.classList.remove('in-chat');
  AUTH_VIEWS.forEach((v) => { $('view-' + v).hidden = v !== name; });
  if (name === 'reset' && isRecoveryUrl()) {
    $('forgotWrap').hidden = true;
    $('newPassWrap').hidden = false;
  } else if (name === 'reset') {
    $('forgotWrap').hidden = false;
    $('newPassWrap').hidden = true;
  }
}

function showAppView(name, param) {
  $('authRoot').hidden = true;
  $('appLayout').hidden = false;
  APP_VIEWS.forEach((v) => { $('view-' + v).hidden = v !== name; });
  document.body.classList.toggle('in-chat', name === 'chat');
  // Tabs (sidebar + mobile tab bar).
  document.querySelectorAll('[data-nav]').forEach((el) => {
    const tab = el.dataset.nav;
    el.classList.toggle('active', tab === name || (name === 'chat' && tab === 'chats'));
  });
  if (name === 'calls') { refreshCallHistory(); renderCallFriends(); }
  if (name === 'people') loadPeople();
  if (name === 'profile') loadProfile();
  if (name === 'settings') loadSettings();
  if (name === 'chat' && param) openConversation(param);
  if (name !== 'chat') closeChat();
}

function route() {
  if (isRecoveryUrl()) { showAuthView('reset'); return; }
  const { name, param } = parseHash();
  if (!session) {
    showAuthView(AUTH_VIEWS.includes(name) ? name : 'login');
    if (!AUTH_VIEWS.includes(name) && name !== '') location.hash = '#/login';
    return;
  }
  if (AUTH_VIEWS.includes(name) || name === '') { location.hash = '#/chats'; return; }
  if (!APP_VIEWS.includes(name)) { location.hash = '#/chats'; return; }
  showAppView(name, param);
}

/* ---------- presence (who is online) ---------- */
async function initPresence(user) {
  if (presenceChannel) { try { await presenceChannel.unsubscribe(); } catch (e) {} }
  presenceChannel = sb.channel('online', { config: { presence: { key: user.id } } });
  presenceChannel.on('presence', { event: 'sync' }, () => {
    const state = presenceChannel.presenceState();
    PC.state.online = new Set(Object.keys(state));
    emitPresenceChange();
  });
  presenceChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      try { await presenceChannel.track({ user_id: user.id, name: PC.state.profile?.full_name || '' }); } catch (e) {}
    }
  });
}

/* ---------- sidebar "me" card ---------- */
function renderMeCard() {
  const p = PC.state.profile;
  const u = PC.state.me;
  if (!p || !u) return;
  $('meAvatar').innerHTML = avatarHtml(p, 'sm');
  $('meName').textContent = p.full_name || p.username || 'Me';
  $('meSub').textContent = '@' + p.username;
  $('topAvatar').innerHTML = avatarHtml(p, 'sm');
}

/* ---------- service worker (PWA: offline shell + installable app) ---------- */
function registerServiceWorker() {
  // A failure here must never break the app — log and carry on.
  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => {
        console.warn('Service worker registration failed', e);
      });
    }
  } catch (e) {
    console.warn('Service worker not available', e);
  }
}

/* ---------- boot ---------- */
async function setupUser(user) {
  PC.state.me = user;
  PC.state.profile = await ensureProfile(user);
  renderMeCard();
  initPresence(user);
  initCalls(user);
  initChats(user);
  initPeople(user); // also inits the friend system (js/friends.js)
  initProfile(user);
  initSettings(user);
  refreshConversations();
}

async function boot() {
  if (booted) return;
  booted = true;
  initTheme();
  registerServiceWorker();

  // Static icons in the shell.
  $('searchIcon').innerHTML = icon('search', 18);
  $('peopleSearchIcon').innerHTML = icon('search', 18);
  $('backBtn').innerHTML = icon('back', 22);
  $('audioCallBtn').innerHTML = icon('phone', 20);
  $('videoCallBtn').innerHTML = icon('video', 20);
  $('sendBtn').innerHTML = icon('send', 20);
  $('micBtn').innerHTML = icon('mic', 20);
  document.querySelectorAll('[data-tab-icon]').forEach((el) => {
    const map = { chats: 'chat', calls: 'phone', people: 'users', profile: 'user' };
    el.innerHTML = icon(map[el.dataset.tabIcon] || 'chat', 22);
  });

  // Navigation (sidebar tabs, mobile tab bar, me card).
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => { location.hash = '#/' + el.dataset.nav; });
  });
  $('meCard').addEventListener('click', () => { location.hash = '#/profile'; });
  $('topAvatar').addEventListener('click', () => { location.hash = '#/profile'; });
  $('backBtn').addEventListener('click', () => { location.hash = '#/chats'; });

  initAuth();

  // Re-render conversation list + people when presence changes.
  onPresenceChange(() => { refreshConversations(); });

  let s = null;
  try {
    const res = await sb.auth.getSession();
    s = res.data && res.data.session ? res.data.session : null;
  } catch (e) {
    console.warn('getSession failed', e);
    toast('Could not reach the server. Check your connection.', 'error');
  }
  if (s) {
    session = s;
    try { await setupUser(s.user); } catch (e) { console.warn('setupUser failed', e); }
  }

  sb.auth.onAuthStateChange(async (event, sess) => {
    if (event === 'SIGNED_IN' && sess) {
      session = sess;
      try { await setupUser(sess.user); } catch (e) { console.warn('setupUser failed', e); }
      if (parseHash().name === '' || AUTH_VIEWS.includes(parseHash().name)) location.hash = '#/chats';
      route();
    }
    if (event === 'SIGNED_OUT') {
      session = null;
      PC.state.me = null;
      PC.state.profile = null;
      endCallIfActive();
      location.hash = '#/login';
      route();
    }
  });

  window.addEventListener('hashchange', route);
  route();
}

// Calls history is rendered by calls.js; app.js calls it lazily to avoid a
// circular import (calls.js imports nothing from app.js).
let refreshCallHistory = () => {};
export function setCallHistoryRefresher(fn) { refreshCallHistory = fn; }

boot().catch((e) => {
  console.error(e);
  // Never leave a blank page: fall back to the login view with an error.
  try {
    document.getElementById('authRoot').hidden = false;
    document.getElementById('view-login').hidden = false;
    toast('Something went wrong while starting PingChat. Please reload.', 'error');
  } catch (e2) { /* ignore */ }
});
