/* PingChat v2 — "Install app" prompt handling (Android PWA).
 *
 * Captures the browser's beforeinstallprompt event so the Settings view can
 * offer a real install button. On browsers that never fire the event
 * (desktop, iOS), nothing is shown — the feature simply stays hidden.
 * Loaded as a side-effect import; safe to import from anywhere.
 */
let deferredPrompt = null;
let onChange = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // hold the prompt until the user taps Install
  deferredPrompt = e;
  if (onChange) onChange();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  if (onChange) onChange();
});

export function getInstallPrompt() { return deferredPrompt; }

export function onInstallPromptChange(fn) { onChange = fn; }

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const p = deferredPrompt;
  deferredPrompt = null; // a prompt can only be shown once
  try {
    await p.prompt();
    const choice = await p.userChoice;
    return !!choice && choice.outcome === 'accepted';
  } catch (e) {
    return false;
  }
}
