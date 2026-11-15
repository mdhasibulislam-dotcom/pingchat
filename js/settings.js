/* PingChat v2 — settings view: appearance, privacy, sound, security, log out.
 * Log out lives ONLY here — nowhere else in the app. */
import { sb, PC, toast, icon, ringtoneEnabled, setRingtoneEnabled } from './config.js';
import { showMsg } from './ui.js';
import { logout } from './auth.js';
import { toggleTheme } from './app.js';

let me = null;

const $ = (id) => document.getElementById(id);

export function initSettings(user) {
  me = user;
  $('settingsBackBtn').addEventListener('click', () => { location.hash = '#/profile'; });
  $('settingsThemeRow').addEventListener('click', () => { toggleTheme(); syncThemeRow(); });
  $('privacyToggle').addEventListener('click', onPrivacyToggle);
  $('ringtoneToggle').addEventListener('click', onRingtoneToggle);
  $('changePassForm').addEventListener('submit', onChangePassword);
  $('settingsLogoutBtn').addEventListener('click', logout);
}

export function loadSettings() {
  syncThemeRow();
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
