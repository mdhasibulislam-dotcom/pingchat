/* PingChat v2 — authentication (login / register / forgot / reset / logout).
 * Works with the SPA hash router: views are sections in index.html.
 */
import { sb, PC, toast, friendlyError, icon } from './config.js';
import { showMsg } from './ui.js';
import { clearPushUser } from './push.js';

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const usernameRe = /^[a-z0-9_]{3,20}$/;
let authInitialized = false;

function busy(btn, on, label) {
  if (!btn) return;
  // innerHTML (not textContent) so buttons with an icon keep it on restore.
  if (on) { btn.dataset.label = btn.innerHTML; btn.textContent = label || 'Please wait…'; btn.disabled = true; }
  else { btn.innerHTML = btn.dataset.label || btn.innerHTML; btn.disabled = false; }
}

/* Pick a username for a user who signed up without one (e.g. Google).
 * Email users always carry meta.username, so this only runs for OAuth. */
async function usernameForNewUser(user, meta) {
  let uname = String(meta.username || '').toLowerCase();
  if (usernameRe.test(uname)) return uname;
  // Derive from the email prefix: hasibul@gmail.com -> hasibul.
  const base = String(user.email || '').split('@')[0].toLowerCase()
    .replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16);
  if (base.length >= 3) {
    try {
      const chk = await sb.rpc('is_username_available', { p_username: base });
      if (chk.data === true) return base;
    } catch (e) { /* fall through to a suffixed name */ }
    const suffixed = (base + '_' + Math.random().toString(36).slice(2, 6)).slice(0, 20);
    if (usernameRe.test(suffixed)) {
      try {
        const chk2 = await sb.rpc('is_username_available', { p_username: suffixed });
        if (chk2.data === true) return suffixed;
      } catch (e) { /* fall through */ }
    }
  }
  return 'user_' + user.id.replace(/-/g, '').slice(0, 10);
}

/* Make sure the signed-in user has a profile row. The SQL trigger
 * handle_new_user() normally creates it; this is the fallback. */
export async function ensureProfile(user) {
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) console.warn('ensureProfile read failed', error);
  const meta = user.user_metadata || {};
  // Google sends the profile picture as avatar_url (or picture).
  const avatar = meta.avatar_url || meta.picture || '';
  if (data) {
    // The trigger creates the row without a photo, so backfill the Google
    // picture when the row has none (profiles_update_self allows this).
    if (!data.avatar_url && avatar) {
      const { data: upd } = await sb.from('profiles')
        .update({ avatar_url: avatar }).eq('id', user.id).select().single();
      if (upd) return upd;
    }
    return data;
  }
  const fullName = meta.full_name || meta.name || (user.email || '').split('@')[0];
  const uname = await usernameForNewUser(user, meta);
  const { data: ins, error: insErr } = await sb.from('profiles')
    .insert({ id: user.id, username: uname, full_name: fullName, avatar_url: avatar || null })
    .select().single();
  if (insErr) {
    // Username taken (race with the trigger) — fall back to a generated one.
    const { data: retry } = await sb.from('profiles')
      .insert({ id: user.id, username: 'user_' + user.id.replace(/-/g, '').slice(0, 10), full_name: fullName, avatar_url: avatar || null })
      .select().single();
    if (retry) return retry;
    // Both inserts failed: the trigger may have created the row after our
    // first read, so re-select before giving up and returning null.
    const { data: again } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    return again || null;
  }
  return ins;
}

export async function logout() {
  try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
  clearPushUser(); // unlink this device's push subscription from the user
  PC.state.me = null;
  PC.state.profile = null;
  location.hash = '#/login';
}

export function isRecoveryUrl() {
  return location.hash.indexOf('type=recovery') !== -1;
}

export function initAuth() {
  // Bind once: a second bind would double-submit every auth form.
  if (authInitialized) return;
  authInitialized = true;
  // Show/hide password toggles (all auth forms).
  document.querySelectorAll('[data-toggle-pass]').forEach((btn) => {
    btn.innerHTML = icon('eye', 18);
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = icon(show ? 'eyeOff' : 'eye', 18);
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });

  /* ------------------------- login ------------------------- */
  const loginForm = document.getElementById('loginForm');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('loginMsg');
    const btn = document.getElementById('loginBtn');
    const email = document.getElementById('loginEmail').value.trim();
    const pass = document.getElementById('loginPassword').value;
    if (!emailRe.test(email)) return showMsg(out, 'Enter a valid email address.');
    if (!pass) return showMsg(out, 'Enter your password.');
    showMsg(out, '');
    busy(btn, true, 'Logging in…');
    let r;
    try { r = await sb.auth.signInWithPassword({ email, password: pass }); }
    catch (err) { busy(btn, false); return showMsg(out, friendlyError(err)); }
    busy(btn, false);
    if (r.error) return showMsg(out, friendlyError(r.error));
    location.hash = '#/chats';
  });

  /* ------------------------- Continue with Google ------------------------- */
  async function signInWithGoogle(out, btn) {
    showMsg(out, '');
    busy(btn, true, 'Redirecting to Google…');
    let r;
    try {
      r = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: 'https://mdhasibulislam-dotcom.github.io/pingchat/' }
      });
    } catch (err) { busy(btn, false); return showMsg(out, friendlyError(err)); }
    busy(btn, false);
    if (r.error) return showMsg(out, friendlyError(r.error));
    // Success: Supabase redirects the browser to Google. The return lands
    // on the app root and the client (detectSessionInUrl) picks up the
    // session, then the app routes to #/chats.
  }
  const googleLoginBtn = document.getElementById('googleLoginBtn');
  if (googleLoginBtn) googleLoginBtn.addEventListener('click', () => signInWithGoogle(document.getElementById('loginMsg'), googleLoginBtn));
  const googleRegisterBtn = document.getElementById('googleRegisterBtn');
  if (googleRegisterBtn) googleRegisterBtn.addEventListener('click', () => signInWithGoogle(document.getElementById('regMsg'), googleRegisterBtn));

  /* ------------------------- register ------------------------- */
  const unameInput = document.getElementById('regUsername');
  const unameHint = document.getElementById('unameHint');
  let unameOk = false;
  let unameTimer;
  unameInput.addEventListener('input', () => {
    clearTimeout(unameTimer);
    unameOk = false;
    const v = unameInput.value.trim().toLowerCase();
    if (!v) { unameHint.textContent = '3–20 characters: letters, numbers, underscore.'; unameHint.className = 'hint'; return; }
    if (!usernameRe.test(v)) { unameHint.textContent = 'Use 3–20 letters, numbers or underscores.'; unameHint.className = 'hint bad'; return; }
    unameHint.textContent = 'Checking…';
    unameHint.className = 'hint';
    unameTimer = setTimeout(async () => {
      let r;
      try { r = await sb.rpc('is_username_available', { p_username: v }); }
      catch (err) { unameHint.textContent = 'Could not check username right now.'; unameHint.className = 'hint bad'; return; }
      if (unameInput.value.trim().toLowerCase() !== v) return;
      if (r.error) { unameHint.textContent = 'Could not check username right now.'; unameHint.className = 'hint bad'; return; }
      unameOk = r.data === true;
      unameHint.textContent = unameOk ? '@' + v + ' is available' : '@' + v + ' is already taken';
      unameHint.className = 'hint ' + (unameOk ? 'good' : 'bad');
    }, 350);
  });

  const registerForm = document.getElementById('registerForm');
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('regMsg');
    const btn = document.getElementById('regBtn');
    const name = document.getElementById('regName').value.trim();
    const uname = unameInput.value.trim().toLowerCase();
    const email = document.getElementById('regEmail').value.trim();
    const p1 = document.getElementById('regPassword').value;
    const p2 = document.getElementById('regPassword2').value;
    if (name.length < 2) return showMsg(out, 'Enter your full name.');
    if (!usernameRe.test(uname)) return showMsg(out, 'Username must be 3–20 letters, numbers or underscores.');
    if (!emailRe.test(email)) return showMsg(out, 'Enter a valid email address.');
    if (p1.length < 8) return showMsg(out, 'Password must be at least 8 characters.');
    if (p1 !== p2) return showMsg(out, 'Passwords do not match.');
    showMsg(out, '');
    busy(btn, true, 'Creating account…');
    let chk;
    try { chk = await sb.rpc('is_username_available', { p_username: uname }); }
    catch (err) { busy(btn, false); return showMsg(out, friendlyError(err)); }
    if (chk.error || chk.data !== true) {
      busy(btn, false);
      return showMsg(out, chk.error ? friendlyError(chk.error) : 'That username is already taken.');
    }
    const base = location.origin + location.pathname.replace(/[^/]*$/, '');
    let r;
    try {
      r = await sb.auth.signUp({
        email, password: p1,
        options: { data: { full_name: name, username: uname }, emailRedirectTo: base + '#/login' }
      });
    } catch (err) { busy(btn, false); return showMsg(out, friendlyError(err)); }
    busy(btn, false);
    if (r.error) return showMsg(out, friendlyError(r.error));
    // Supabase returns an empty identities array for an already-registered email.
    if (r.data.user && r.data.user.identities && r.data.user.identities.length === 0) {
      return showMsg(out, 'This email is already registered. Try logging in.');
    }
    if (r.data.session) { location.hash = '#/chats'; return; }
    registerForm.reset();
    showMsg(out, 'Account created! Check your email and click the confirmation link, then log in.', 'success');
  });

  /* ------------------------- forgot password ------------------------- */
  const forgotForm = document.getElementById('forgotForm');
  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('forgotMsg');
    const btn = document.getElementById('forgotBtn');
    const email = document.getElementById('forgotEmail').value.trim();
    if (!emailRe.test(email)) return showMsg(out, 'Enter a valid email address.');
    showMsg(out, '');
    busy(btn, true, 'Sending…');
    const base = location.origin + location.pathname.replace(/[^/]*$/, '');
    let r;
    try { r = await sb.auth.resetPasswordForEmail(email, { redirectTo: base + '#/login' }); }
    catch (err) { busy(btn, false); return showMsg(out, friendlyError(err)); }
    busy(btn, false);
    if (r.error) return showMsg(out, friendlyError(r.error));
    showMsg(out, 'If an account exists for that email, a reset link is on its way.', 'success');
  });

  /* ------------------------- reset password (recovery link) ------------------------- */
  const resetForm = document.getElementById('resetForm');
  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('resetMsg');
    const btn = document.getElementById('resetBtn');
    const p1 = document.getElementById('newPassword').value;
    const p2 = document.getElementById('newPassword2').value;
    if (p1.length < 8) return showMsg(out, 'Password must be at least 8 characters.');
    if (p1 !== p2) return showMsg(out, 'Passwords do not match.');
    showMsg(out, '');
    busy(btn, true, 'Saving…');
    let r;
    try { r = await sb.auth.updateUser({ password: p1 }); }
    catch (err) { busy(btn, false); return showMsg(out, friendlyError(err)); }
    busy(btn, false);
    if (r.error) return showMsg(out, friendlyError(r.error));
    showMsg(out, 'Password updated. Taking you to PingChat…', 'success');
    setTimeout(() => { location.hash = '#/chats'; }, 900);
  });

  // Recovery links land with #access_token=…&type=recovery — show the
  // new-password panel instead of the forgot panel.
  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY' || isRecoveryUrl()) {
      document.getElementById('forgotWrap').hidden = true;
      document.getElementById('newPassWrap').hidden = false;
    }
  });
}
