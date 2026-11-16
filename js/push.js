/* PingChat v2 — OneSignal free web push (Web SDK v16).
 *
 * Free tier, no Firebase Blaze needed: OneSignal's servers send the push,
 * so PingChat needs no backend of its own for this. Only the public App ID
 * lives here — NEVER put a OneSignal REST API key in client code or the repo.
 *
 * Service worker: PingChat already has its own PWA worker (sw.js) owning
 * the /pingchat/ scope, so OneSignal's worker code is merged INTO sw.js via
 * importScripts (see the top of sw.js) instead of a separate
 * OneSignalSDKWorker.js — two workers on the same scope would replace each
 * other and break either the PWA or push. The init below tells the SDK to
 * use the merged file. Verified against the v16 SDK source (build 160801)
 * and the official docs:
 *   - importScripts URL: https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js
 *   - worker URL is built as location.origin + path + '/' + serviceWorkerPath
 *     -> https://mdhasibulislam-dotcom.github.io/pingchat/sw.js
 *   - serviceWorkerParam.scope must be the worker's own directory: /pingchat/
 *   - the dashboard app is a "Typical site", so serviceWorkerOverrideForTypical
 *     is required for these code options to win over the dashboard defaults.
 *
 * Everything here is guarded: if the OneSignal CDN script fails to load
 * (offline / blocked), init resolves false and the app keeps working
 * normally — push is best-effort, never fatal.
 */
const APP_ID = 'da3c98f6-d518-41d1-807e-0e8b77c702d6';
const SITE_PATH = '/pingchat';
const WORKER_FILE = 'sw.js';
const WORKER_SCOPE = '/pingchat/';

let initStarted = false;
let initResult = null; // Promise<boolean>, settles once
let initError = null; // message from a failed init, shown in Settings

function deferredQueue() {
  try {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    return window.OneSignalDeferred;
  } catch (e) {
    return null;
  }
}

/* Run a function with the loaded OneSignal object and resolve with its
 * return value. Resolves null when the SDK never loads or the function
 * throws. Never throws. */
function runOneSignal(fn) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const q = deferredQueue();
      if (!q) return done(null);
      q.push(async function (OneSignal) {
        try { done(await fn(OneSignal)); }
        catch (e) { console.warn('OneSignal call failed', e); done(null); }
      });
      setTimeout(() => done(null), 15000);
    } catch (e) {
      console.warn('OneSignal call failed', e);
      done(null);
    }
  });
}

/* Queue the OneSignal init exactly once. Call once at boot. Resolves true
 * when init succeeds, false when push is unavailable. Never throws. */
export function initPush() {
  if (initStarted) return initResult;
  initStarted = true;
  initResult = new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const q = deferredQueue();
      if (!q) return done(false);
      q.push(async function (OneSignal) {
        try {
          await OneSignal.init({
            appId: APP_ID,
            serviceWorkerOverrideForTypical: true,
            path: SITE_PATH,
            serviceWorkerPath: WORKER_FILE,
            serviceWorkerParam: { scope: WORKER_SCOPE },
          });
          done(true);
        } catch (e) {
          initError = e && e.message ? String(e.message) : String(e);
          console.warn('OneSignal init failed', e);
          done(false);
        }
      });
      // If the SDK script never loads (offline / blocked), don't hang.
      // Only record the timeout when init has not already settled.
      setTimeout(() => {
        if (!settled && !initError) initError = 'OneSignal SDK did not load within 15 seconds.';
        done(false);
      }, 15000);
    } catch (e) {
      console.warn('OneSignal init failed', e);
      done(false);
    }
  });
  return initResult;
}

/* Link this device's push subscription to the signed-in PingChat user, so
 * the user can be targeted by their Supabase id from the OneSignal
 * dashboard. Safe to call on every login / session restore; logging in
 * with the same id is a no-op server-side. Never throws. */
export function setPushUser(userId, username) {
  try {
    if (!userId) return;
    const q = deferredQueue();
    if (!q) return;
    q.push(async function (OneSignal) {
      try {
        await OneSignal.login(String(userId));
        if (username) await OneSignal.User.addTag('username', String(username));
      } catch (e) {
        console.warn('OneSignal login failed', e);
      }
    });
  } catch (e) {
    console.warn('OneSignal login failed', e);
  }
}

/* Unlink the push subscription from the user on log out. Never throws. */
export function clearPushUser() {
  try {
    const q = deferredQueue();
    if (!q) return;
    q.push(async function (OneSignal) {
      try { await OneSignal.logout(); }
      catch (e) { console.warn('OneSignal logout failed', e); }
    });
  } catch (e) {
    console.warn('OneSignal logout failed', e);
  }
}

/* Current push state for the Settings screen. Never throws; on any failure
 * returns { supported: false } (with initError when init failed).
 * permission is 'default' | 'granted' | 'denied'. In this SDK build
 * (v16, build 160801) OneSignal.Notifications.permission is a boolean and
 * permissionNative is the string, so both are read and the browser's
 * Notification.permission is the fallback — all three agree in practice. */
export async function getPushState() {
  const failed = { supported: false, permission: 'default', optedIn: false, subscribedId: null, initError };
  try {
    const ok = await initPush();
    if (!ok) return failed;
    const state = await runOneSignal((OneSignal) => {
      let permission = 'default';
      try {
        const nativePerm = (typeof Notification !== 'undefined' && typeof Notification.permission === 'string')
          ? Notification.permission : 'default';
        const n = OneSignal.Notifications;
        if (n) {
          if (typeof n.permission === 'string') permission = n.permission;
          else if (typeof n.permissionNative === 'string') permission = n.permissionNative;
          else if (typeof n.permission === 'boolean') permission = n.permission ? 'granted' : nativePerm;
          else permission = nativePerm;
        } else {
          permission = nativePerm;
        }
      } catch (e) { /* fall through with 'default' */ }
      if (permission !== 'default' && permission !== 'granted' && permission !== 'denied') permission = 'default';
      let optedIn = false;
      let subscribedId = null;
      try {
        const sub = OneSignal.User && OneSignal.User.PushSubscription;
        if (sub) {
          optedIn = !!sub.optedIn;
          if (typeof sub.id === 'string' && sub.id) subscribedId = sub.id;
        }
      } catch (e) { /* leave defaults */ }
      return { supported: true, permission, optedIn, subscribedId, initError };
    });
    if (!state) return failed;
    return state;
  } catch (e) {
    console.warn('getPushState failed', e);
    return failed;
  }
}

/* Trigger the notification permission prompt on demand (Settings button,
 * and the once-after-login ask). Tries the OneSignal slide prompt first;
 * if that API is absent, falls back to the native prompt via optIn().
 * Resolves true when the prompt was shown or the user is already
 * subscribed, false otherwise. Never throws. */
export async function promptPush() {
  try {
    const ok = await initPush();
    if (!ok) return false;
    const before = await getPushState();
    if (before.optedIn) return true;
    if (before.permission === 'denied') return false;
    const t0 = Date.now();
    const shown = await runOneSignal(async (OneSignal) => {
      try {
        if (OneSignal.Slidedown && typeof OneSignal.Slidedown.promptPush === 'function') {
          await OneSignal.Slidedown.promptPush();
          return 'slidedown';
        }
      } catch (e) {
        console.warn('Slidedown promptPush failed, trying optIn', e);
      }
      if (OneSignal.User && OneSignal.User.PushSubscription
          && typeof OneSignal.User.PushSubscription.optIn === 'function') {
        await OneSignal.User.PushSubscription.optIn();
        return 'optin';
      }
      return null;
    });
    if (!shown) return false;
    // The slide prompt resolves almost instantly when it is suppressed
    // (never actually shown) — then fall back to the native prompt, which
    // always shows unless the user already denied. A real prompt takes the
    // user at least a moment to answer, so a sub-second resolve with no
    // state change means it never appeared.
    if (shown === 'slidedown' && Date.now() - t0 < 1000) {
      const after = await getPushState();
      if (!after.optedIn && after.permission === 'default') {
        const viaOptIn = await runOneSignal(async (OneSignal) => {
          if (OneSignal.User && OneSignal.User.PushSubscription
              && typeof OneSignal.User.PushSubscription.optIn === 'function') {
            await OneSignal.User.PushSubscription.optIn();
            return true;
          }
          return false;
        });
        return !!viaOptIn;
      }
    }
    return true;
  } catch (e) {
    console.warn('promptPush failed', e);
    return false;
  }
}

/* Turn push notifications off for this device. Never throws. */
export async function optOut() {
  try {
    const ok = await initPush();
    if (!ok) return;
    await runOneSignal(async (OneSignal) => {
      if (OneSignal.User && OneSignal.User.PushSubscription
          && typeof OneSignal.User.PushSubscription.optOut === 'function') {
        await OneSignal.User.PushSubscription.optOut();
      }
    });
  } catch (e) {
    console.warn('optOut failed', e);
  }
}
