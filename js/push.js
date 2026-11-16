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

function deferredQueue() {
  try {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    return window.OneSignalDeferred;
  } catch (e) {
    return null;
  }
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
          console.warn('OneSignal init failed', e);
          done(false);
        }
      });
      // If the SDK script never loads (offline / blocked), don't hang.
      setTimeout(() => done(false), 15000);
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
