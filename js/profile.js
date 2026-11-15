/* PingChat v2 — own profile: hero card, real photo upload, edit, stats.
 * Photo upload goes to Supabase Storage bucket 'avatars' (free) — no
 * photo-URL field anymore. Log out lives only in Settings. */
import { sb, PC, toast, avatarHtml, icon } from './config.js';
import { showMsg } from './ui.js';

const usernameRe = /^[a-z0-9_]{3,20}$/;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // bucket limit is 2 MB
let me = null;

const $ = (id) => document.getElementById(id);

export function initProfile(user) {
  me = user;
  $('avatarUploadBtn').innerHTML = icon('camera', 18);
  $('avatarUploadBtn').addEventListener('click', () => $('avatarFileInput').click());
  $('avatarFileInput').addEventListener('change', onPhotoChosen);
  $('profileEditBtn').addEventListener('click', () => {
    $('profileEditForm').hidden = false;
    $('profileEditBtn').hidden = true;
  });
  $('pfCancelBtn').addEventListener('click', () => {
    $('profileEditForm').hidden = true;
    $('profileEditBtn').hidden = false;
  });
  $('profileForm').addEventListener('submit', onSave);
  $('pfUsername').addEventListener('input', checkUsernameLive);
  $('goSettingsBtn').addEventListener('click', () => { location.hash = '#/settings'; });
}

export async function loadProfile() {
  const p = PC.state.profile;
  if (!p) return;
  $('profileAvatar').innerHTML = avatarHtml(p, 'lg');
  $('profileHeadName').textContent = p.full_name || p.username;
  $('profileHeadUser').textContent = '@' + p.username;
  $('profileHeadBio').textContent = p.bio || 'No bio yet.';
  $('profileMemberSince').textContent = p.created_at
    ? 'Member since ' + new Date(p.created_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  $('profileEmail').textContent = PC.state.me ? 'Signed in as ' + PC.state.me.email : '';
  $('pfName').value = p.full_name || '';
  $('pfUsername').value = p.username || '';
  $('pfBio').value = p.bio || '';
  // Stats: friends + chats (best-effort — a failure just leaves 0).
  let friends = 0;
  let chats = 0;
  try {
    const [fr, ch] = await Promise.all([
      sb.from('friendships').select('id', { count: 'exact', head: true })
        .or('requester_id.eq.' + me.id + ',addressee_id.eq.' + me.id).eq('status', 'accepted'),
      sb.from('conversation_participants').select('conversation_id', { count: 'exact', head: true }).eq('user_id', me.id)
    ]);
    friends = fr.count || 0;
    chats = ch.count || 0;
  } catch (e) { /* ignore */ }
  $('statFriends').textContent = String(friends);
  $('statChats').textContent = String(chats);
}

function refreshMeCard() {
  const p = PC.state.profile;
  if (!p) return;
  const a = document.getElementById('meAvatar');
  if (a) a.innerHTML = avatarHtml(p, 'sm');
  const n = document.getElementById('meName');
  if (n) n.textContent = p.full_name || p.username;
  const s = document.getElementById('meSub');
  if (s) s.textContent = '@' + p.username;
  const t = document.getElementById('topAvatar');
  if (t) t.innerHTML = avatarHtml(p, 'sm');
}

/* ---------- photo upload ---------- */
function extFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

async function onPhotoChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow picking the same file again
  if (!file || !me) return;
  if (!file.type || !file.type.startsWith('image/')) {
    toast('Please choose an image file.', 'error');
    return;
  }
  if (file.size > MAX_PHOTO_BYTES) {
    toast('Photo must be smaller than 2 MB.', 'error');
    return;
  }
  const btn = $('avatarUploadBtn');
  btn.disabled = true;
  const path = me.id + '/' + Date.now() + '.' + extFromMime(file.type);
  let up;
  try {
    up = await sb.storage.from('avatars').upload(path, file, { cacheControl: '3600', upsert: false });
  } catch (err) {
    btn.disabled = false;
    toast('Upload failed: ' + (err.message || 'network error'), 'error');
    return;
  }
  if (up.error) {
    btn.disabled = false;
    toast('Upload failed: ' + up.error.message, 'error');
    return;
  }
  const { data } = sb.storage.from('avatars').getPublicUrl(path);
  const url = data && data.publicUrl;
  if (!url) {
    btn.disabled = false;
    toast('Upload failed: could not get the photo URL.', 'error');
    return;
  }
  let r;
  try {
    r = await sb.from('profiles').update({ avatar_url: url }).eq('id', me.id).select().single();
  } catch (err) {
    btn.disabled = false;
    toast('Photo uploaded but could not save it: ' + (err.message || 'network error'), 'error');
    return;
  }
  btn.disabled = false;
  if (r.error) {
    toast('Photo uploaded but could not save it: ' + r.error.message, 'error');
    return;
  }
  PC.state.profile = r.data;
  loadProfile();
  refreshMeCard();
  toast('Profile photo updated.', 'success');
}

/* ---------- edit form ---------- */
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
  if (name.length < 2) return showMsg(out, 'Enter your full name.');
  if (!usernameRe.test(uname)) return showMsg(out, 'Username must be 3–20 letters, numbers or underscores.');
  showMsg(out, '');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  let r;
  try {
    r = await sb.from('profiles').update({ full_name: name, username: uname, bio: bio || null })
      .eq('id', me.id).select().single();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Save changes';
    return showMsg(out, 'Could not save: ' + (err.message || 'network error'));
  }
  btn.disabled = false;
  btn.textContent = 'Save changes';
  if (r.error) return showMsg(out, 'Could not save: ' + r.error.message);
  PC.state.profile = r.data;
  loadProfile();
  refreshMeCard();
  $('profileEditForm').hidden = true;
  $('profileEditBtn').hidden = false;
  showMsg(out, 'Profile saved.', 'success');
  toast('Profile saved.', 'success');
}
