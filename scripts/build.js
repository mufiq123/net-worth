// scripts/build.js
// Generates dist/index.html — the one-page Net Worth dashboard — from
// data/history.json (value over time), data/latest.json (per-institution
// holdings) and data/deposits.json (what went in, for the gain figures).
// DATA_DIR overrides the data folder, which is how a preview is built from
// sample data without touching the real files.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { INSTITUTIONS } from './institutions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(root, 'data');
const readJSON = (f, fallback) => {
  const p = join(dataDir, f);
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
  } catch (err) {
    console.warn(`Could not read data/${f} (${err.message}).`);
    return fallback;
  }
};

const history = readJSON('history.json', []);
const latest = readJSON('latest.json', null);
const depositsFile = readJSON('deposits.json', {});

// Institutions in a fixed order, limited to those with a snapshot.
const insts = INSTITUTIONS.filter((i) => latest?.institutions?.[i.id]).map((i) => ({ ...i, ...latest.institutions[i.id] }));
const total = latest ? latest.total : 0;
const asOf = latest?.date || history[history.length - 1]?.date || null;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short$ = (n) => (n >= 1000 ? '$' + Math.round(n / 1000) + 'k' : '$' + Math.round(n));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const prettyDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
// History starts on the day the first account was linked, so the axis reads
// in days ("Sep 28") until there is most of a year to show, then in months
// ("Sep ’26").
const spanDays = history.length > 1
  ? (Date.parse(history[history.length - 1].date) - Date.parse(history[0].date)) / 86400000
  : 0;
const tickLabel = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return spanDays > 300 ? `${MONTHS[m - 1]} ’${String(y).slice(2)}` : `${MONTHS[m - 1]} ${d}`;
};
const signed = (n) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`; // a real minus sign

// ---- growth chart (SVG, time-scaled x axis, y from 0) ----
// Colors are CSS custom properties, so the chart follows the active theme.
function chartSVG(points) {
  const W = 680, H = 400, PL = 56, PR = 20, PT = 30, PB = 42;
  // The viewBox starts above y=0 purely to give the scrubber's value label
  // somewhere to sit when the point being read is at the top of the plot.
  const VT = -34;
  const t = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const t0 = t(points[0].date);
  const t1 = t(points[points.length - 1].date);
  const maxV = Math.max(...points.map((p) => p.value));
  const yMax = maxV * 1.06 || 1;
  const X = (tt) => PL + ((tt - t0) / Math.max(t1 - t0, 1)) * (W - PL - PR);
  const Y = (v) => PT + (1 - v / yMax) * (H - PT - PB);

  const line = points.map((p) => `${X(t(p.date)).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
  const area = `${PL},${Y(0).toFixed(1)} ${line} ${X(t1).toFixed(1)},${Y(0).toFixed(1)}`;

  const gridVals = [0, yMax / 2, yMax];
  const grid = gridVals.map((v) => `
      <line x1="${PL}" y1="${Y(v).toFixed(1)}" x2="${W - PR}" y2="${Y(v).toFixed(1)}" stroke="var(--rule-strong)" stroke-dasharray="5 5"/>
      <text class="money" x="${PL - 10}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" font-size="13" fill="var(--ink-muted)">${short$(v)}</text>`).join('');

  const n = points.length;
  const tickIdx = [...new Set([0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1])];
  // The first and last points sit on the plot edges, so a centred label there
  // would overflow the viewBox and get clipped. Anchor those two inward.
  const xticks = (n > 1 ? tickIdx : [0]).map((i) => {
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    return `
      <text x="${X(t(points[i].date)).toFixed(1)}" y="${H - 12}" text-anchor="${anchor}" font-size="13" fill="var(--ink-muted)">${tickLabel(points[i].date)}</text>`;
  }).join('');

  const last = points[n - 1];
  const lx = X(t(last.date)), ly = Y(last.value);

  // Only real history points are listed: the scrubber snaps to these rather
  // than interpolating, because a value read off the line between two points
  // is one the portfolio never held.
  const scrubData = points.map((p) => ({
    x: +X(t(p.date)).toFixed(1),
    y: +Y(p.value).toFixed(1),
    v: money(p.value),
    m: tickLabel(p.date),
  }));

  return `
  <svg class="chart" viewBox="0 ${VT} ${W} ${H - VT}" style="width:100%;height:auto;display:block" role="img" aria-label="Net worth growth chart"
       data-points='${JSON.stringify(scrubData)}' data-w="${W}" data-pl="${PL}" data-pr="${PR}" data-top="${VT + 14}">
    <defs>
      <linearGradient id="gg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${grid}
    <polygon points="${area}" fill="url(#gg)"/>
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle id="endDot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="7" fill="var(--surface)" stroke="var(--accent)" stroke-width="3.5"/>
    <text id="endLabel" class="money" x="${(lx < W / 2 ? lx + 12 : lx - 12).toFixed(1)}" y="${(ly - 14).toFixed(1)}" text-anchor="${lx < W / 2 ? 'start' : 'end'}" font-size="16" font-weight="700" fill="var(--ink-soft)">${money(last.value)}</text>
    <g id="xticks">${xticks}
    </g>
    <g id="scrub" opacity="0" pointer-events="none">
      <line id="scrubLine" y1="${PT}" y2="${H - PB}" stroke="var(--ink-muted)" stroke-width="1" stroke-dasharray="4 4"/>
      <circle id="scrubDot" r="7" fill="var(--surface)" stroke="var(--accent)" stroke-width="3.5"/>
      <text id="scrubVal" class="money" text-anchor="middle" font-size="16" font-weight="700" fill="var(--ink)"></text>
      <text id="scrubMonth" text-anchor="middle" font-size="13" font-weight="700" fill="var(--ink)" y="${H - 12}"></text>
    </g>
    <rect id="hit" x="0" y="0" width="${W}" height="${H}" fill="transparent"/>
  </svg>`;
}

// ---- what went in, per institution ----
// history.json records value, not cash flow, so "invested" comes from
// deposits.json: base + ledger for the ledger method, or the holdings' cost
// basis for the equity plan. null means not known yet, and the page then
// shows no gain for that institution rather than a wrong one.
function invested(inst) {
  const dep = depositsFile[inst.id];
  if (!dep) return null;
  if (dep.method === 'cost_basis') return Number.isFinite(inst.cost_basis) ? inst.cost_basis : null;
  if (!Number.isFinite(dep.base)) return null;
  const ledger = Array.isArray(dep.ledger) ? dep.ledger : [];
  return round2(dep.base + ledger.reduce((s, e) => s + (Number(e.amount) || 0), 0));
}
insts.forEach((i) => { i.invested = invested(i); });

// The combined stats row needs every institution's figure: a total that
// silently left one out would overstate the gain.
let statsHTML = '';
const allKnown = insts.length && insts.every((i) => i.invested != null && i.invested > 0);
if (allKnown) {
  const inv = round2(insts.reduce((s, i) => s + i.invested, 0));
  const gains = round2(total - inv);
  const cls = gains >= 0 ? 'up' : 'down';
  statsHTML = `
    <div class="stats">
      <div><div class="label">Net invested</div><div class="v money">${money(inv)}</div></div>
      <div><div class="label">Total gains</div><div class="v ${cls} money">${signed(gains)}</div></div>
      <div><div class="label">Return</div><div class="v ${cls} money">${gains >= 0 ? '+' : '−'}${Math.abs((gains / inv) * 100).toFixed(1)}%</div></div>
    </div>`;
} else if (insts.length) {
  const missing = insts.filter((i) => i.invested == null).map((i) => i.name);
  statsHTML = `<div class="fine" style="text-align:left;margin-top:14px">Gains appear once net deposits are set for ${missing.join(', ')}.</div>`;
}

// ---- institutions ----
// Each institution has one colour, used for its slice of the allocation bar,
// its legend dot and the letter in its badge. Everything else stays neutral.
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)'];
const CHEVRON = `<svg class="chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Plaid names accounts "Brokerage Account", "Roth IRA"; the suffix is noise.
const acctName = (a) => (a.name || a.type).replace(/\s+account$/i, '');
let allocBar = '';
let instRows = '';
if (insts.length && total > 0) {
  allocBar = `<div class="alloc">` +
    insts.map((i, n) => `<div style="width:${(i.total / total * 100).toFixed(2)}%;background:${COLORS[n % COLORS.length]}"></div>`).join('') +
    `</div><div class="legend">` +
    insts.map((i, n) => `<span><i style="background:${COLORS[n % COLORS.length]}"></i>${esc(i.name)} <b class="money">${(i.total / total * 100).toFixed(0)}%</b></span>`).join('') +
    `</div>`;
  instRows = insts.map((i, n) => {
    // Plaid lists empty sub-accounts too (Public's Treasury, Bond, …).
    const accts = (i.accounts || []).filter((a) => a.value > 0).sort((a, b) => b.value - a.value);
    const types = [...new Set(accts.map((a) => a.type))].join(' · ');
    const gain = i.invested != null ? round2(i.total - i.invested) : null;
    const gainLine = gain == null
      ? `<span style="color:var(--ink-muted)">—</span>`
      : `<span class="${gain >= 0 ? 'up' : 'down'} money">${signed(gain)}</span>`;
    const multi = accts.length > 1;
    const row = `
      <div class="badge" style="color:${COLORS[n % COLORS.length]}">${esc(i.name[0])}</div>
      <div style="flex:1;min-width:0">
        <div class="r-name">${esc(i.name)}${multi ? CHEVRON : ''}</div>
        <div class="r-sub">${esc(types)}</div>
      </div>
      <div class="r-right">
        <div class="money r-val">${money(i.total)}</div>
        <div style="font-size:12.5px">${gainLine}</div>
      </div>`;
    if (!multi) return `
    <div class="row">${row}
    </div>`;
    // <details> opens and closes without any script, and the balances inside
    // carry .money so the privacy toggle still covers them.
    const subs = accts.map((a) => `
        <div class="acct-line"><span>${esc(acctName(a))}</span><span class="money">${money(a.value)}</span></div>`).join('');
    return `
    <details class="acct">
      <summary class="row">${row}
      </summary>
      <div class="subs">${subs}
      </div>
    </details>`;
  }).join('');
}

// ---- holdings, merged across institutions ----
// The same security held in two places is one row. Tickers are the key;
// 401(k) funds often have none, so their name stands in. Cash from every
// institution lands in the single "Cash" row.
const merged = new Map();
for (const i of insts) {
  for (const p of i.positions) {
    const key = p.cash ? 'CASH' : p.ticker || `name:${p.name}`;
    const m = merged.get(key) || { ...p, value: 0, quantity: p.quantity == null ? null : 0, from: [] };
    m.value = round2(m.value + p.value);
    if (m.quantity != null && p.quantity != null) m.quantity += p.quantity;
    // Public reports a price of 0 alongside correct values and share counts.
    if (!m.price) m.price = p.price || (p.quantity ? p.value / p.quantity : null);
    if (!m.from.includes(i.name)) m.from.push(i.name);
    merged.set(key, m);
  }
}
const positions = [...merged.values()].sort((a, b) => b.value - a.value);

// 401(k) collective trusts have no real ticker; Plaid invents one from the
// abbreviated fund name. Known ones get a readable name and chip here.
const DISPLAY = {
  'TRP.LRG.CAP.GR.TR.D': { name: 'T. Rowe Price Large Cap Growth Trust', chip: 'TRP' },
  'SP.500.INDEX.PL.CL.D': { name: 'S&P 500 Index Pool', chip: 'S&P' },
};
const realTicker = (t) => (t && /^[A-Z]{1,5}(\.[A-Z])?$/.test(t) ? t : null);
function displayName(p) {
  if (DISPLAY[p.ticker]) return DISPLAY[p.ticker];
  // Plaid reports full legal names, "Issuer - Fund". Usually the fund is the
  // part after the first " - " ("Vanguard World Fund - Vanguard Information
  // Technology ETF"). When that part is a share-class or source label instead
  // ("… - Common shares of beneficial interest", "… - contribution"), the
  // part before it is the name.
  const cut = p.name.indexOf(' - ');
  let name = p.name;
  if (cut !== -1) {
    const before = p.name.slice(0, cut).trim();
    const after = p.name.slice(cut + 3).trim();
    name = !after || /^[a-z]/.test(after) || /\bshares\b/i.test(after) ? before : after;
  }
  const initials = name.replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(Boolean).slice(0, 3).map((w) => w[0]).join('');
  return { name, chip: (realTicker(p.ticker) || initials).slice(0, 5).toUpperCase() };
}

let rows = '';
if (positions.length) {
  rows = positions.map((p) => {
    const pct = total > 0 ? (p.value / total) * 100 : 0;
    // Plaid reports full legal names ("Vanguard World Fund - Vanguard
    // Information Technology ETF"). Show whatever follows the first " - ",
    // falling back to the whole name when there is no prefix to strip.
    const d = displayName(p);
    const name = d.name;
    const chip = p.cash ? '$' : d.chip;
    const detail = p.cash
      ? ''
      : [p.quantity != null ? `${Number(p.quantity).toFixed(p.quantity % 1 ? 3 : 0)} sh` : '', p.price != null ? `@ ${money(p.price)}` : '']
          .filter(Boolean).join(' ');
    const tags = p.from.map((f) => `<span class="tag">${esc(f)}</span>`).join('');
    return `
    <div class="row">
      <div class="chip"${chip.length > 3 ? ' style="font-size:10px"' : ''}>${esc(chip)}</div>
      <div style="flex:1;min-width:0">
        <div class="r-name">${esc(name)}</div>
        ${detail ? `<div class="r-sub money">${detail}</div>` : ''}
        <div class="tags">${tags}</div>
      </div>
      <div class="r-right">
        <div class="money r-val">${money(p.value)}</div>
        <div class="money" style="color:var(--ink-muted);font-size:12.5px">${pct.toFixed(1)}%</div>
      </div>
    </div>`;
  }).join('');
} else {
  rows = `<div style="padding:18px 0;color:var(--ink-muted)">Holdings appear after the first data refresh.</div>`;
}

const chartBlock = history.length
  ? chartSVG(history)
  : `<div style="padding:40px 0;text-align:center;color:var(--ink-muted)">The chart starts with the first data refresh.</div>`;

// Per-institution snapshot dates, for the browser-side staleness check.
const asOfData = JSON.stringify(Object.fromEntries(insts.map((i) => [i.name, i.date])));

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1013" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex, nofollow">
<link rel="apple-touch-icon" href="apple-touch-icon.png"><link rel="icon" type="image/png" href="icon-192.png"><link rel="manifest" href="site.webmanifest">
<title>Net Worth</title>
<style>
  /* Light theme (default). Every color is a token, so the dark override below
     also reaches colors used inside inline style attributes and the SVG —
     inline styles outrank a media query, but var() lookups still resolve. */
  :root {
    --bg: #f6f7f9;
    --surface: #ffffff;
    --ink: #111418;
    --ink-soft: #3b424c;
    --ink-muted: #8a919c;
    --rule: #eceef1;
    --rule-strong: #e1e4e8;
    --accent: #3f7fbf;
    --gain: #1f8a4c;
    --loss: #c0392b;
    --chip-bg: #f1f3f5;
    --chip-ink: #3b424c;
    --warn-bg: #fdf4e3;
    --warn-ink: #7a5312;
    --warn-border: #f0dcb4;
    --shadow: 0 1px 2px rgba(17,20,24,.04);
    --c1: #2f6db0; --c2: #368727; --c3: #c9a24d;
  }
  /* Dark theme, following the OS / app appearance setting. */
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1013;
      --surface: #16191e;
      --ink: #f2f4f7;
      --ink-soft: #c7ccd4;
      --ink-muted: #858c97;
      --rule: #23272e;
      --rule-strong: #2b3038;
      --accent: #6ea8e0;
      --gain: #4cc37e;
      --loss: #ef7a6a;
      --chip-bg: #1f2329;
      --chip-ink: #c7ccd4;
      --warn-bg: #2e2413;
      --warn-ink: #edcd8d;
      --warn-border: #4d3c1d;
      --shadow: none;
      --c1: #5c97d6; --c2: #5aa84a; --c3: #d9b26a;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 520px; margin: 0 auto; padding: 20px 16px 40px; }
  .topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .topbar img { width: 44px; height: 44px; border-radius: 12px; object-fit: cover; border: 1px solid var(--rule); }
  .topbar .name { font-weight: 800; font-size: 18px; }
  .topbar .sub { color: var(--ink-muted); font-size: 12.5px; margin-top: 1px; }
  .eye { margin-left: auto; width: 40px; height: 40px; border-radius: 99px; border: 1px solid var(--rule-strong); background: var(--surface); color: inherit; cursor: pointer; font-size: 18px; }
  .card { background: var(--surface); border: 1px solid var(--rule); border-radius: 18px; padding: 20px; margin-bottom: 12px; box-shadow: var(--shadow); }
  .label { color: var(--ink-muted); font-size: 13px; font-weight: 600; }
  .hero { font-size: 42px; font-weight: 800; letter-spacing: -1px; margin-top: 4px; }
  .hero-sub { color: var(--ink-muted); font-size: 13px; margin-top: 6px; }
  .alloc { display: flex; gap: 3px; height: 6px; margin-top: 18px; }
  .alloc > div { border-radius: 99px; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; font-size: 12.5px; color: var(--ink-muted); }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 99px; margin-right: 6px; }
  .legend b { color: var(--ink-soft); font-weight: 700; margin-left: 2px; }
  /* Equal columns, and each cell is a flex column whose label absorbs the
     spare height. A label that wraps to two lines therefore pushes nothing
     around: all three values still sit on one baseline. */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 16px; border-top: 1px solid var(--rule); padding-top: 14px; }
  .stats > div { display: flex; flex-direction: column; min-width: 0; padding-right: 10px; }
  .stats > div + div { border-left: 1px solid var(--rule); padding-left: 12px; }
  .stats .label { flex: 1; font-size: 12.5px; line-height: 1.35; }
  .stats .v { font-weight: 800; font-size: 16px; margin-top: 5px; white-space: nowrap; }
  .up { color: var(--gain); }
  .down { color: var(--loss); }
  .sect { display: flex; align-items: baseline; justify-content: space-between; margin: 24px 4px 10px; }
  .sect h2 { font-size: 17px; font-weight: 750; }
  .sect span { color: var(--ink-muted); font-size: 12.5px; }
  /* Rows are separated by their container, so a row wrapped in <details>
     gets the same divider as a plain one. */
  .list { padding-top: 4px; padding-bottom: 4px; }
  .list > * + * { border-top: 1px solid var(--rule); }
  .row { display: flex; align-items: center; gap: 12px; padding: 14px 0; }
  .chip, .badge { width: 42px; height: 42px; border-radius: 12px; background: var(--chip-bg); font-weight: 800; display: flex; align-items: center; justify-content: center; flex: none; }
  .chip { color: var(--chip-ink); font-size: 11.5px; }
  .badge { font-size: 17px; }
  .r-name { font-weight: 650; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .r-sub { color: var(--ink-muted); font-size: 12.5px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .r-right { display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; align-self: stretch; flex: none; gap: 2px; }
  .r-val { font-weight: 750; font-size: 15px; }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .tag { font-size: 10.5px; font-weight: 600; color: var(--ink-muted); background: var(--chip-bg); border-radius: 99px; padding: 2px 7px; }
  .acct summary { list-style: none; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .acct summary::-webkit-details-marker { display: none; }
  .chev { color: var(--ink-muted); margin-left: 6px; transition: transform .15s; }
  .acct[open] .chev { transform: rotate(180deg); }
  .subs { margin: -4px 0 12px 54px; border-left: 2px solid var(--rule); }
  .acct-line { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0 7px 12px; font-size: 13.5px; color: var(--ink-soft); }
  .acct-line .money { font-weight: 650; color: var(--ink); }
  .fine { color: var(--ink-muted); font-size: 11.5px; text-align: center; margin-top: 18px; line-height: 1.6; }
  .chart { touch-action: pan-y; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent; cursor: crosshair; }
  /* blur scales with font size so a 12px share count is hidden as well as the 44px total */
  .hide-values .money { filter: blur(0.4em); }
  /* WebKit does not reliably apply CSS filters to individual SVG elements,
     so on iOS the chart's labels stayed sharp while everything else blurred.
     Hide them outright instead — opacity works on SVG text everywhere. */
  .hide-values text.money { opacity: 0; }
  .stale { display: flex; gap: 9px; align-items: flex-start; background: var(--warn-bg); color: var(--warn-ink); border: 1px solid var(--warn-border); border-radius: 14px; padding: 12px 14px; margin-bottom: 14px; font-size: 12.5px; line-height: 1.5; }
  .stale[hidden] { display: none; }
  .stale b { font-weight: 800; }
</style>
</head>
<body data-asof='${esc(asOfData)}'>
<div class="wrap">
  <div class="topbar">
    <img src="assets/logo.png" alt="Net Worth logo">
    <div><div class="name">Net Worth</div><div class="sub">${esc(insts.map((i) => i.name).join(' · ') || 'No accounts linked yet')}</div></div>
    <button class="eye" id="eye" aria-label="Hide or show dollar amounts">\u{1F441}</button>
  </div>

  <div class="stale" id="stale" hidden><span aria-hidden="true">⚠️</span><span><b>Some figures may be out of date.</b> <span id="stale-msg"></span></span></div>

  <div class="card">
    <div class="label">Total net worth</div>
    <div class="hero money">${money(total)}</div>
    <div class="hero-sub">${asOf ? `Snapshot · ${prettyDate(asOf)}` : 'Waiting for the first refresh'}</div>
    ${allocBar}
  </div>

  <div class="sect"><h2>Growth</h2></div>
  <div class="card">
    ${chartBlock}${statsHTML}
  </div>

  ${instRows ? `<div class="sect"><h2>Accounts</h2><span>${insts.length} institutions</span></div>
  <div class="card list">${instRows}</div>` : ''}

  <div class="sect"><h2>Holdings</h2><span>${positions.length} positions</span></div>
  <div class="card list">${rows}</div>

  <div class="fine">${asOf ? `Updated ${prettyDate(asOf)}` : ''}</div>
</div>
<script>
  document.getElementById('eye').addEventListener('click', () => document.body.classList.toggle('hide-values'));

  // Staleness is worked out in the browser, not at build time, so the warning
  // still appears if the daily workflow stops running and this page is never
  // rebuilt. Each institution is checked on its own: one that keeps failing
  // holds its last snapshot, and this is where that becomes visible.
  (function () {
    var dates;
    try { dates = JSON.parse(document.body.getAttribute('data-asof') || '{}'); } catch (e) { return; }
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var old = [];
    Object.keys(dates).forEach(function (name) {
      var p = String(dates[name]).split('-').map(Number);
      if (p.length !== 3 || p.some(isNaN)) return;
      var days = Math.round((today - new Date(p[0], p[1] - 1, p[2])) / 86400000);
      if (days >= 2) old.push(name + ' was last updated ' + days + ' days ago');
    });
    if (!old.length) return;
    document.getElementById('stale-msg').textContent = old.join('; ') + '. The daily refresh may have stopped, or that account may need reconnecting.';
    document.getElementById('stale').hidden = false;
  })();

  // Chart scrubber: press and drag across the graph to read the value at a
  // point in time. Readings snap to real history points. While scrubbing, the
  // fixed x-axis labels give way to a single label for the point being read.
  (function () {
    var svg = document.querySelector('svg.chart');
    if (!svg) return;
    var pts;
    try { pts = JSON.parse(svg.getAttribute('data-points') || '[]'); } catch (e) { return; }
    if (!pts.length) return;

    var W = +svg.getAttribute('data-w');
    var PL = +svg.getAttribute('data-pl');
    var PR = +svg.getAttribute('data-pr');
    var TOP = +svg.getAttribute('data-top'); // highest the label may sit
    var el = function (id) { return svg.querySelector('#' + id); };
    var scrub = el('scrub'), sLine = el('scrubLine'), sDot = el('scrubDot');
    var sVal = el('scrubVal'), sMon = el('scrubMonth');
    var ticks = el('xticks'), endLabel = el('endLabel'), endDot = el('endDot');
    var active = false;

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function nearest(clientX) {
      var r = svg.getBoundingClientRect();
      if (!r.width) return pts[pts.length - 1];
      var sx = (clientX - r.left) * (W / r.width);
      var best = pts[0], bd = Infinity;
      for (var i = 0; i < pts.length; i++) {
        var d = Math.abs(pts[i].x - sx);
        if (d < bd) { bd = d; best = pts[i]; }
      }
      return best;
    }

    function show(clientX) {
      var p = nearest(clientX);
      sLine.setAttribute('x1', p.x); sLine.setAttribute('x2', p.x);
      sDot.setAttribute('cx', p.x); sDot.setAttribute('cy', p.y);
      // keep both labels inside the viewBox no matter which point is picked
      var tx = clamp(p.x, PL + 48, W - PR - 48);
      sVal.setAttribute('x', tx);
      sVal.setAttribute('y', Math.max(p.y - 56, TOP));
      sVal.textContent = p.v;
      sMon.setAttribute('x', tx);
      sMon.textContent = p.m;
      scrub.setAttribute('opacity', '1');
      ticks.setAttribute('opacity', '0');
      endLabel.setAttribute('opacity', '0');
      endDot.setAttribute('opacity', '0');
    }

    function hide() {
      if (!active) return;
      active = false;
      scrub.setAttribute('opacity', '0');
      ticks.setAttribute('opacity', '1');
      endLabel.setAttribute('opacity', '1');
      endDot.setAttribute('opacity', '1');
    }

    svg.addEventListener('pointerdown', function (e) {
      active = true;
      if (svg.setPointerCapture) { try { svg.setPointerCapture(e.pointerId); } catch (err) {} }
      show(e.clientX);
    });
    svg.addEventListener('pointermove', function (e) { if (active) show(e.clientX); });
    // pointercancel fires when the browser takes the gesture over for a
    // vertical scroll, which is exactly when the scrubber should get out of
    // the way rather than fight the page.
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      svg.addEventListener(ev, hide);
    });
  })();
</script>
</body>
</html>`;

const out = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(root, 'dist');
mkdirSync(join(out, 'assets'), { recursive: true });
writeFileSync(join(out, 'index.html'), html);
copyFileSync(join(root, 'assets', 'logo.png'), join(out, 'assets', 'logo.png'));
for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'site.webmanifest']) {
  copyFileSync(join(root, f), join(out, f));
}
console.log(
  `Wrote ${out}/index.html (${(html.length / 1024).toFixed(1)} KB), ${history.length} history points, ` +
  `${insts.length} institutions, ${positions.length} merged positions` +
  (allKnown ? '.' : ' (gains hidden until every institution has net deposits).')
);
