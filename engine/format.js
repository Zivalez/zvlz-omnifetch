/* Human-friendly number formatting. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function fmtBytes(n, approx = false) {
  if (n == null || !Number.isFinite(n) || n < 0) return approx ? '~—' : '—';
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0);
  return `${approx ? '~' : ''}${s} ${UNITS[i]}`;
}

export function fmtBytesRange(min, max) {
  if (min == null) return '—';
  if (max == null || Math.abs(max - min) / Math.max(min, 1) < 0.06) return fmtBytes(min, true);
  return `${fmtBytes(min, true)} – ${fmtBytes(max, true)}`;
}

/** Clock style: 1:12, 42:10, 1:05:30 */
export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const d = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${d}` : `${m}:${d}`;
}

export function fmtCount(n) {
  return new Intl.NumberFormat('en-US').format(n ?? 0);
}

export function fmtDate(ts) {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
  } catch { return '—'; }
}
