// Formatting helpers (Swedish locale).

const formatters = new Map();
function nf(decimals) {
  if (!formatters.has(decimals)) {
    formatters.set(decimals, new Intl.NumberFormat('sv-SE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  }
  return formatters.get(decimals);
}

const compact = new Intl.NumberFormat('sv-SE', { notation: 'compact', maximumFractionDigits: 1 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function fmtNumber(v, decimals = 0) {
  return isNum(v) ? nf(decimals).format(v) : '–';
}

export function fmtValue(v, ds) {
  if (!isNum(v)) return '–';
  return `${nf(ds.decimals).format(v)} ${ds.unit}`;
}

/** Compact form for tiles, split so the unit can be styled smaller: {num: '10,6 mn', unit: 'invånare'} */
export function fmtCompactParts(v, ds) {
  if (!isNum(v)) return { num: '–', unit: '' };
  if (ds.unit === 'mnkr' && Math.abs(v) >= 1000) return { num: nf(0).format(v / 1000), unit: 'mdkr' };
  if (Math.abs(v) >= 100_000) return { num: compact.format(v), unit: ds.unit };
  return { num: nf(ds.decimals).format(v), unit: ds.unit };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/** SCB period code -> readable label: 2024, 2024K1, 2024M08 */
export function periodLabel(code) {
  if (!code) return '';
  const q = /^(\d{4})K(\d)$/.exec(code);
  if (q) return `kv ${q[2]} ${q[1]}`;
  const m = /^(\d{4})M(\d{2})$/.exec(code);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return code;
}

const MINUS = '−';
const sign = (d) => (d > 0 ? '+' : d < 0 ? MINUS : '±');

/**
 * Change from `prev` to `cur`. Percent units are compared in percentage points.
 * @returns {{text: string, dir: 'up'|'down'|'flat'} | null}
 */
export function fmtDelta(cur, prev, ds) {
  if (!isNum(cur) || !isNum(prev)) return null;
  const diff = cur - prev;
  const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  if (ds.unit === '%') {
    return { text: `${sign(diff)}${nf(1).format(Math.abs(diff))} p.e.`, dir };
  }
  const abs = `${sign(diff)}${nf(ds.decimals).format(Math.abs(diff))}`;
  const pct = prev !== 0 ? ` (${sign(diff)}${nf(1).format(Math.abs((diff / Math.abs(prev)) * 100))} %)` : '';
  return { text: `${abs}${pct}`, dir };
}

/** "Stockholms län" -> "Stockholm", "Skåne län" -> "Skåne" */
export function shortName(name) {
  return name.replace(/s? län$/, '');
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function timeLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
}

export function dateLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });
}
