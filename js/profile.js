/* PingChat v2 — own profile: view, edit, theme, logout. */
import { sb, PC, toast, avatarHtml, icon } from './config.js';
import { showMsg } from './ui.js';
import { logout } from './auth.js';

const usernameRe = /^[a-z0-9_]{3,20}$/;
let me = null;

const $ = (id) => document.getElementById(id);

export function initProfile(user) {
  me = user;
  $('profileForm').addEventListener('submit', onSave);
  $('pfUsername').addEventListener('input', checkUsernameLive);
}

export async function loadProfile() {
  const p = PC.state.profile;
  if (!p) return;
  $('profileAvatar').innerHTML = avatarHtml(p, 'lg');
  $('profileHeadName').textContent = p.full_name || p.username;
  $('profileHeadUser').textContent = '@' + p.username;
  $('profileEmail').textContent = PC.state.me ? 'Signed in as ' + PC.state.me.email : '';
  $('pfName').value = p.full_name || '';
  $('pfUsername').value = p.username || '';
  $('pfBio').value = p.bio || '';
  $('pfAvatar').value = p.avatar_url || '';
}

let unameTimer;
function checkUsernameLive() {
  clearTimeout(unameTimer);
  const hint = $('pfUnameHint');
  const v = $('pfUsername').value.trim().toLowerCase();
  const current = PC.state.profile ? PC.state.profile.username : '';
  if (!v || v === current) { hint.textContent = '3–20 characters: letters, numbers, underscore.'; hint.className = 'hint'; return; }
  if (!usernameRe.test(v)) { hint.textContent = 'Use 3–20 letters, numbers or underscores.'; hint.className = 'hint bad'; return; }
  hint.textContent = 'Checking…';
  hint.className = 'hint';
  unameTimer = setTimeout(async () => {
    let r;
    try { r = await sb.rpc('is_username_available', { p_username: v }); }
    catch (e) { hint.textContent = 'Could not check username right now.'; hint.className = 'hint bad'; return; }
    if ($('pfUsername').value.trim().toLowerCase() !== v) return;
    if (r.error) { hint.textContent = 'Could not check username right now.'; hint.className = 'hint bad'; return; }
    const ok = r.data === true;
    hint.textContent = ok ? '@' + v + ' is available' : '@' + v + ' is already taken';
    hint.className = 'hint ' + (ok ? 'good' : 'bad');
  }, 350);
}

async function onSave(e) {
  e.preventDefault();
  const out = $('profileMsg');
  const btn = $('pfSaveBtn');
  const name = $('pfName').value.trim();
  const uname = $('pfUsername').value.trim().toLowerCase();
  const bio = $('pfBio').value.trim();
  const avatarUrl = $('pfAvatar').value.trim();
  if (name.length < 2) return showMsg(out, 'Enter your full name.');
  if (!usernameRe.test(uname)) return showMsg(out, 'Username must be 3–20 letters, numbers or underscores.');
  if (avatarUrl && !/^https:\/\//i.test(avatarUrl)) return showMsg(out, 'Photo URL must start with https://');
  showMsg(out, '');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  let r;
  try {
    r = await sb.from('profiles').update({ full_name: name, username: uname, bio: bio || null, avatar_url: avatarUrl || null })
      .eq('id', me.id).select().single();
  } catch (err) {
    btn.disabled = false; btn.textContent = 'Save changes';
    return showMsg(out, 'Could not save: ' + (err.message || 'network error'));
  }
  btn.disabled = false;
  btn.textContent = 'Save changes';
  if (r.error) return showMsg(out, 'Could not save: ' + r.error.message);
  PC.state.profile = r.data;
  loadProfile();
  // Refresh the sidebar "me" card.
  const meAvatar = document.getElementById('meAvatar');
  if (meAvatar) meAvatar.innerHTML = avatarHtml(r.data, 'sm');
  const meName = document.getElementById('meName');
  if (meName) meName.textContent = r.data.full_name || r.data.username;
  const meSub = document.getElementById('meSub');
  if (meSub) meSub.textContent = '@' + r.data.username;
  showMsg(out, 'Profile saved.', 'success');
  toast('Profile saved.', 'success');
}
