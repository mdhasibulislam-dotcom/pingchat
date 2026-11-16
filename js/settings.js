/* PingChat v2 — settings view: appearance, privacy, sound, security, log out.
 * Log out lives ONLY here — nowhere else in the app. */
import { sb, PC, toast, icon, ringtoneEnabled, setRingtoneEnabled } from './config.js';
import { showMsg } from './ui.js';
import { logout } from './auth.js';
import { toggleTheme } from './app.js';
import { getInstallPrompt, onInstallPromptChange, promptInstall } from './install.js';
import { getPushState, promptPush, optOut } from './push.js';

let me = null;
let settingsInitialized = false;
let pushBusy = false;

const $ = (id) => document.getElementById(id);

export function initSettings(user) {
  me = user;
  // setupUser() can run twice (boot + SIGNED_IN): without this guard every
  // listener below binds twice.
  if (settingsInitialized) return;
  settingsInitialized = true;
  $('settingsBackBtn').addEventListener('click', () => { location.hash = '#/profile'; });
  $('settingsThemeRow').addEventListener('click', () => { toggleTheme(); syncThemeRow(); });
  $('privacyToggle').addEventListener('click', onPrivacyToggle);
  $('ringtoneToggle').addEventListener('click', onRingtoneToggle);
  $('changePassForm').addEventListener('submit', onChangePassword);
  $('settingsLogoutBtn').addEventListener('click', logout);
  $('installAppBtn').addEventListener('click', onInstallAppTap);
  $('pushToggleBtn').addEventListener('click', onPushToggle);
  onInstallPromptChange(syncInstallRow);
}

export function loadSettings() {
  syncThemeRow();
  syncInstallRow();
  syncPushRow();
  const p = PC.state.profile;
  const isPublic = !p || p.is_public !== false;
  setSwitch($('privacyToggle'), isPublic);
  $('privacyStateLabel').textContent = isPublic ? 'Public profile' : 'Private profile';
  setSwitch($('ringtoneToggle'), ringtoneEnabled());
}

function setSwitch(el, on) {
  if (!el) return;
  el.classList.toggle('on', !!on);
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

function syncThemeRow() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const ic = $('settingsThemeIcon');
  if (ic) ic.innerHTML = icon(dark ? 'sun' : 'moon', 20);
  const lb = $('settingsThemeLabel');
  if (lb) lb.textContent = dark ? 'Switch to light theme' : 'Switch to dark theme';
}

/* ---------- install app (Android PWA) ---------- */
// The Install card shows ONLY when the browser offers installation
// (beforeinstallprompt fired). On desktop/iOS it stays hidden.
function syncInstallRow() {
  const card = $('installCard');
  if (!card) return;
  card.hidden = !getInstallPrompt();
}

async function onInstallAppTap() {
  const btn = $('installAppBtn');
  if (!btn) return;
  btn.disabled = true;
  const ok = await promptInstall();
  btn.disabled = false;
  syncInstallRow(); // prompt is consumed either way; hide the card
  toast(ok ? 'PingChat installed. Look for it on your home screen.' : 'Install dismissed. You can try again later.', ok ? 'success' : undefined);
}

/* ---------- privacy ---------- */
async function onPrivacyToggle() {
  const p = PC.state.profile;
  if (!p || !me) return;
  const next = p.is_public === false; // currently private -> make public
  const btn = $('privacyToggle');
  btn.disabled = true;
  let r;
  try {
    r = await sb.from('profiles').update({ is_public: next }).eq('id', me.id).select().single();
  } catch (e) {
    btn.disabled = false;
    return toast('Could not update privacy: ' + (e.message || 'network error'), 'error');
  }
  btn.disabled = false;
  if (r.error) return toast('Could not update privacy: ' + r.error.message, 'error');
  PC.state.profile = r.data;
  setSwitch(btn, next);
  $('privacyStateLabel').textContent = next ? 'Public profile' : 'Private profile';
  toast(next ? 'Your profile is now public.' : 'Your profile is now private.', 'success');
}

/* ---------- sound ---------- */
function onRingtoneToggle() {
  const next = !ringtoneEnabled();
  setRingtoneEnabled(next);
  setSwitch($('ringtoneToggle'), next);
  toast(next ? 'Ringtone on.' : 'Ringtone off.');
}

/* ---------- notifications ---------- */
// Refreshes every time the Settings view opens (loadSettings).
async function syncPushRow() {
  const label = $('pushStateLabel');
  const hint = $('pushStateHint');
  const btn = $('pushToggleBtn');
  if (!label || !btn) return;
  label.textContent = 'Checking…';
  if (hint) hint.hidden = true;
  btn.hidden = true;
  let st;
  try { st = await getPushState(); } catch (e) { st = { supported: false }; }
  if (!st || !st.supported) {
    label.textContent = 'Not available';
    if (hint) {
      hint.hidden = false;
      hint.textContent = st && st.initError
        ? 'Push is unavailable: ' + st.initError
        : 'Try Chrome — some browsers block push notifications.';
    }
    btn.hidden = true;
    return;
  }
  if (st.permission === 'denied') {
    label.textContent = 'Blocked';
    if (hint) {
      hint.hidden = false;
      hint.textContent = 'Allow notifications for this site in your browser settings.';
    }
    btn.hidden = true;
    return;
  }
  if (st.optedIn) {
    label.textContent = 'On';
    if (hint) hint.hidden = true;
    btn.hidden = false;
    btn.textContent = 'Turn off notifications';
    return;
  }
  label.textContent = 'Off';
  if (hint) hint.hidden = true;
  btn.hidden = false;
  btn.textContent = 'Turn on notifications';
}

async function onPushToggle() {
  if (pushBusy) return;
  let st;
  try { st = await getPushState(); } catch (e) { st = { supported: false }; }
  if (!st || !st.supported) { await syncPushRow(); return; }
  const btn = $('pushToggleBtn');
  pushBusy = true;
  if (btn) btn.disabled = true;
  try {
    if (st.optedIn) {
      await optOut();
      toast('Notifications turned off.');
    } else {
      const shown = await promptPush();
      const after = await getPushState();
      if (after.optedIn) toast('Notifications are on.', 'success');
      else if (after.permission === 'denied') toast('Notifications are blocked for this site. Allow them in your browser settings.', 'error');
      else if (!shown) toast('Could not turn on notifications. Try again from Settings.', 'error');
      else toast('Notifications are still off.');
    }
  } finally {
    pushBusy = false;
    if (btn) btn.disabled = false;
    await syncPushRow();
  }
}

/* ---------- security: change password ---------- */
async function onChangePassword(e) {
  e.preventDefault();
  const out = $('changePassMsg');
  const btn = $('changePassBtn');
  const p1 = $('setPass1').value;
  const p2 = $('setPass2').value;
  if (p1.length < 8) return showMsg(out, 'Password must be at least 8 characters.');
  if (p1 !== p2) return showMsg(out, 'Passwords do not match.');
  showMsg(out, '');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  let r;
  try { r = await sb.auth.updateUser({ password: p1 }); }
  catch (err) {
    btn.disabled = false;
    btn.textContent = 'Change password';
    return showMsg(out, 'Could not change password: ' + (err.message || 'network error'));
  }
  btn.disabled = false;
  btn.textContent = 'Change password';
  if (r.error) return showMsg(out, 'Could not change password: ' + r.error.message);
  $('changePassForm').reset();
  showMsg(out, 'Password changed.', 'success');
  toast('Password changed.', 'success');
}
