/* PingChat v2 — small shared UI helpers. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

/* seconds -> "mm:ss" */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

/* Set the text/visibility of a message box. type: 'error' | 'success' | '' */
export function showMsg(el, text, type) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'form-msg' + (type ? ' ' + type : '');
  el.hidden = !text;
}
