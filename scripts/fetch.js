// scripts/fetch.js
// Pulls current holdings for every connected institution from Plaid (read-only),
// values the hand-kept Merrill share counts at the day's market price, and
// writes data/latest.json, the deposits ledgers and today's history point.
// Credentials come from environment variables (GitHub Actions secrets in
// production). Never commit real credentials.
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { INSTITUTIONS } from './institutions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = (f) => join(root, 'data', f);
const readJSON = (f, fallback) => (existsSync(dataPath(f)) ? JSON.parse(readFileSync(dataPath(f), 'utf8')) : fallback);

const { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV = 'production' } = process.env;

// A manual institution counts once its file lists at least one share.
const manualConfig = (inst) => {
  const cfg = readJSON(inst.config, null);
  return cfg && (cfg.accounts || []).some((a) => Number(a.shares) > 0) ? cfg : null;
};

// Checked before credentials, so the scheduled runs are a quiet no-op until
// the first account is linked.
const connected = INSTITUTIONS.map((inst) =>
  inst.source === 'manual' ? { ...inst, cfg: manualConfig(inst) } : { ...inst, token: process.env[inst.secret] }
).filter((i) => i.token || i.cfg);
const viaPlaid = connected.filter((i) => i.token);
if (!connected.length) {
  console.log('No institutions linked yet. Nothing to fetch.');
  process.exit(0);
}
console.log(`Linked: ${connected.map((i) => i.name).join(', ')}.`);

if (viaPlaid.length && (!PLAID_CLIENT_ID || !PLAID_SECRET)) {
  console.error('Missing PLAID_CLIENT_ID or PLAID_SECRET.');
  process.exit(1);
}

const envMap = {
  sandbox: PlaidEnvironments.sandbox,
  development: PlaidEnvironments.development,
  production: PlaidEnvironments.production,
};
const basePath = envMap[PLAID_ENV];
if (!basePath) {
  console.error(`Unknown PLAID_ENV "${PLAID_ENV}". Use sandbox, development, or production.`);
  process.exit(1);
}

const plaid = new PlaidApi(
  new Configuration({
    basePath,
    baseOptions: {
      headers: { 'PLAID-CLIENT-ID': PLAID_CLIENT_ID, 'PLAID-SECRET': PLAID_SECRET },
    },
  })
);

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const errCode = (err) => err?.response?.data?.error_code || err?.message || String(err);

// Snapshot date in America/Chicago, so the daily point lands on the right day.
function chicagoDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const today = chicagoDate();


// Ask Plaid to pull straight from each institution before reading holdings,
// otherwise /investments/holdings/get serves Plaid's own once-a-day cache.
// Refresh is asynchronous, so all three are requested together and share one
// grace period. PLAID_REFRESH=false turns it off (it is metered on paid plans).
const REFRESH = (process.env.PLAID_REFRESH ?? 'true') !== 'false';
const REFRESH_WAIT_MS = Number(process.env.PLAID_REFRESH_WAIT_MS ?? 30000);

if (REFRESH && viaPlaid.length) {
  await Promise.all(
    viaPlaid.map((inst) =>
      plaid.investmentsRefresh({ access_token: inst.token }).catch((err) => {
        // Not fatal: the holdings read below falls back to Plaid's cache.
        console.warn(`${inst.name}: refresh request failed (${errCode(err)}) — using Plaid's cached holdings.`);
      })
    )
  );
  console.log(`Requested fresh pulls; waiting ${REFRESH_WAIT_MS / 1000}s for them to land.`);
  await new Promise((resolve) => setTimeout(resolve, REFRESH_WAIT_MS));
}

// ---- holdings ----
// Money market funds and uninvested cash are folded into one "Cash" position
// per institution; build.js then merges it across institutions like any other
// holding.
const isCash = (sec) => sec.type === 'cash' || sec.is_cash_equivalent === true;
const SUBTYPE_LABELS = {
  brokerage: 'Brokerage', roth: 'Roth IRA', ira: 'IRA', '401k': '401(k)', '403b': '403(b)',
  'stock plan': 'Stock plan', 'non-taxable brokerage account': 'Brokerage', hsa: 'HSA',
};

async function fetchHoldings(inst) {
  return inst.source === 'manual' ? manualHoldings(inst) : plaidHoldings(inst);
}

// ---- market prices (manual institutions) ----
// Yahoo Finance's chart endpoint needs no key. (Stooq's CSV quotes, the usual
// alternative, now sit behind a browser check and return a page instead.)
// Two hosts serve it, so the second is tried when the first fails.
async function quote(ticker) {
  let lastErr;
  for (const host of ['query1', 'query2']) {
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (net-worth dashboard)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meta = (await res.json())?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      if (!(price > 0)) throw new Error('no price in response');
      return { price, asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`no quote for ${ticker} (${lastErr?.message})`);
}

// Merrill: one holding (Visa) split across the ESPP and equity-plan accounts.
// If no quote can be had, the previous snapshot's price is reused with the
// current share counts, so a share-count edit still shows up.
async function manualHoldings(inst) {
  const { cfg } = inst;
  const prev = latest.institutions[inst.id];
  let price;
  try {
    const q = await quote(cfg.ticker);
    price = q.price;
    console.log(`${inst.name}: ${cfg.ticker} $${price} (as of ${q.asOf || 'unreported'}).`);
  } catch (err) {
    price = prev?.positions?.find((p) => p.ticker === cfg.ticker)?.price;
    if (!price) throw err;
    console.warn(`${inst.name}: ${err.message} — reusing the last price, $${price}.`);
  }

  const accts = (cfg.accounts || []).filter((a) => Number(a.shares) > 0);
  // Excluded accounts (the equity grant) have no basis by design.
  const counted = accts.filter((a) => !a.exclude_from_gains);
  const basisKnown = counted.every((a) => Number.isFinite(a.cost_basis));
  const positions = accts.map((a) => ({
    ticker: cfg.ticker,
    name: cfg.name || cfg.ticker,
    value: round2(a.shares * price),
    quantity: Number(a.shares),
    price,
    cost_basis: Number.isFinite(a.cost_basis) ? round2(a.cost_basis) : null,
    accounts: [a.name],
    ...(a.exclude_from_gains ? { exclude_from_gains: true } : {}),
  }));
  const total = round2(positions.reduce((s, p) => s + p.value, 0));
  console.log(`${inst.name}: ${positions.length} positions, $${total.toLocaleString('en-US')}.`);
  if (!basisKnown) console.warn(`${inst.name}: cost_basis missing in data/${inst.config}.`);
  return {
    name: inst.name,
    date: today,
    total,
    cost_basis: basisKnown ? round2(counted.reduce((s, a) => s + a.cost_basis, 0)) : null,
    // Value build.js leaves out of gains, so total − excluded is what the
    // cost basis is measured against.
    excluded: positions.filter((p) => p.exclude_from_gains).map((p) => ({ name: p.accounts[0], value: p.value })),
    accounts: positions.map((p) => ({ name: p.accounts[0], type: p.accounts[0], value: p.value })),
    positions,
  };
}

async function plaidHoldings(inst) {
  const resp = await plaid.investmentsHoldingsGet({ access_token: inst.token });
  const { holdings = [], securities = [], accounts = [] } = resp.data;
  const secById = Object.fromEntries(securities.map((s) => [s.security_id, s]));

  let cash = 0;
  let cashBasis = 0;
  let basisKnown = true;
  const positions = [];
  // Which account each holding sits in, so the page can tag it (Roth IRA,
  // Brokerage). Cash is pooled, so it lists every account it came from.
  const acctNames = Object.fromEntries(accounts.map((a) => [a.account_id, a.name]));
  const cashAccts = new Set();
  for (const h of holdings) {
    const sec = secById[h.security_id] || {};
    const value = round2(h.institution_value ?? (h.quantity ?? 0) * (h.institution_price ?? 0));
    if (!(value > 0)) continue;
    if (isCash(sec)) {
      cash += value;
      cashBasis += value; // cash has no gain of its own
      if (acctNames[h.account_id]) cashAccts.add(acctNames[h.account_id]);
      continue;
    }
    if (!Number.isFinite(h.cost_basis)) basisKnown = false;
    positions.push({
      ticker: sec.ticker_symbol || null,
      name: sec.name || 'Unknown holding',
      value,
      quantity: h.quantity ?? null,
      // Public reports 0 here alongside a correct value and quantity.
      price: h.institution_price || (h.quantity ? round2(value / h.quantity) : null),
      cost_basis: Number.isFinite(h.cost_basis) ? round2(h.cost_basis) : null,
      accounts: acctNames[h.account_id] ? [acctNames[h.account_id]] : [],
    });
  }
  // Some institutions (Public) report part of an account's uninvested cash only
  // in its balance, not as a holding. Per account, anything the balance holds
  // beyond its holdings is counted as cash. Only a positive gap is added: a
  // balance below its holdings is more likely a stale balance than debt.
  const heldByAccount = {};
  for (const h of holdings) {
    const v = h.institution_value ?? (h.quantity ?? 0) * (h.institution_price ?? 0);
    heldByAccount[h.account_id] = (heldByAccount[h.account_id] || 0) + (v > 0 ? v : 0);
  }
  for (const a of accounts) {
    const gap = round2((a.balances?.current ?? 0) - (heldByAccount[a.account_id] || 0));
    if (gap > 0.5) {
      cash += gap;
      cashBasis += gap;
      cashAccts.add(a.name);
      console.log(`${inst.name}: $${gap.toLocaleString('en-US')} of "${a.name}" balance not in holdings — counted as cash.`);
    }
  }
  if (cash > 0) {
    positions.push({ ticker: 'CASH', name: 'Cash', value: round2(cash), quantity: null, price: null, cost_basis: round2(cashBasis), cash: true, accounts: [...cashAccts] });
  }
  positions.sort((a, b) => b.value - a.value);

  if (!positions.length) throw new Error('Plaid returned no holdings');

  const total = round2(positions.reduce((s, p) => s + p.value, 0));
  const costBasis = basisKnown ? round2(positions.reduce((s, p) => s + (p.cost_basis || 0), 0)) : null;

  // Diagnostics: how old the prices are, and whether the account balances
  // Plaid reports agree with the holdings (a gap usually means cash that was
  // not reported as a holding).
  const priceDates = [...new Set(holdings.map((h) => h.institution_price_as_of).filter(Boolean))].sort();
  console.log(`${inst.name}: ${positions.length} positions, $${total.toLocaleString('en-US')}; prices as of ${priceDates.join(', ') || 'unreported'}.`);
  const acctTotal = round2(accounts.reduce((s, a) => s + (a.balances?.current || 0), 0));
  if (Math.abs(acctTotal - total) > 1) {
    console.warn(`${inst.name}: account balances total $${acctTotal.toLocaleString('en-US')} vs holdings $${total.toLocaleString('en-US')}.`);
  }
  if (costBasis == null) console.warn(`${inst.name}: cost basis missing on at least one holding.`);

  return {
    name: inst.name,
    date: today,
    total,
    cost_basis: costBasis,
    accounts: accounts.map((a) => ({
      name: a.name,
      type: SUBTYPE_LABELS[(a.subtype || '').toLowerCase()] || a.subtype || a.type || 'Account',
      value: round2(a.balances?.current || 0),
    })),
    positions,
  };
}

// Each institution is fetched independently. One that fails keeps its last
// good snapshot (with its older date), rather than dropping out of the total —
// otherwise a single Fidelity outage would draw a fake crash on the chart.
const latest = readJSON('latest.json', { institutions: {} });
latest.institutions = latest.institutions || {};
const fresh = [];

const results = await Promise.allSettled(connected.map(fetchHoldings));
results.forEach((r, i) => {
  const inst = connected[i];
  if (r.status === 'fulfilled') {
    latest.institutions[inst.id] = r.value;
    fresh.push(inst);
  } else {
    const prev = latest.institutions[inst.id];
    console.warn(
      `${inst.name}: holdings failed (${errCode(r.reason)}) — ` +
        (prev ? `keeping the snapshot from ${prev.date}.` : 'no earlier snapshot, so it is left out.')
    );
  }
});

if (!fresh.length) {
  console.error('Every institution failed — leaving all data unchanged.');
  process.exit(1);
}

// Only institutions that are still linked count toward the total.
for (const id of Object.keys(latest.institutions)) {
  if (!connected.some((i) => i.id === id)) delete latest.institutions[id];
}
latest.date = today;
latest.total = round2(Object.values(latest.institutions).reduce((s, x) => s + x.total, 0));
writeFileSync(dataPath('latest.json'), JSON.stringify(latest, null, 2));

// ---- net deposits ledgers ----
// Each institution has its own entry in deposits.json. method "ledger": a
// fixed `base` (everything deposited up to `base_through`, for history Plaid
// cannot see; 0 when Plaid has the account's whole history) plus every money
// movement Plaid reports after that, keyed by transaction id so the ledger
// never double-counts or loses an entry as Plaid's window slides.
// method "cost_basis" (the equity plan) uses the holdings' cost basis instead
// and needs no ledger.
const deposits = readJSON('deposits.json', {});
const day = 86400000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// What counts as money in or out, checked against every transaction Plaid
// returned for Public and Fidelity (2026-10-11):
// - cash deposit/contribution/withdrawal rows and transfer rows count. Plaid
//   signs money leaving the account positive, so -amount is the inflow. A
//   transfer between two accounts of the same institution (Public's
//   "Disbursement - XFER" from one account and "Deposit" into another on the
//   same day) is counted on both legs and nets to zero; a disbursement to a
//   bank counts as a withdrawal.
// - Excluded, though Plaid files them as deposit/withdrawal:
//   "Cash adjusted"   Public's internal cash, interest and dividend shuffles;
//   "realizedGainLoss" Fidelity's gain or loss on a fund exchange;
//   "sweep" / money market legs, moves into a settlement fund;
//   zero-amount rows, which are position changes such as stock splits
//   ("Position adjusted" on the NFLX and VGT splits).
const MONEY_KINDS = new Set(['cash/deposit', 'cash/contribution', 'cash/withdrawal']);
const NOT_MONEY = /cash adjusted|position adjusted|realizedgainloss|sweep/i;
function classify(tx, secById) {
  const kind = `${tx.type || ''}/${(tx.subtype || '').toLowerCase()}`;
  if (!MONEY_KINDS.has(kind) && tx.type !== 'transfer') return null; // buys, sells, dividends, fees
  const sec = secById[tx.security_id];
  if (NOT_MONEY.test(tx.name || '')) return { counted: false, why: 'internal' };
  if (sec && sec.is_cash_equivalent && sec.type !== 'cash') return { counted: false, why: 'internal' };
  if (!round2(tx.amount || 0)) return { counted: false, why: 'position' };
  return { counted: true, amount: round2(-tx.amount) };
}

for (const inst of fresh.filter((i) => i.token)) {
  const dep = (deposits[inst.id] = deposits[inst.id] || { method: 'ledger', base: null, base_through: null, ledger: [] });
  if (dep.method === 'cost_basis') continue;

  // The first successful run after linking fixes the seam. The base you enter
  // afterwards is "everything deposited up to and including this date".
  if (!dep.base_through) {
    dep.base_through = today;
    console.log(`${inst.name}: base_through set to ${today}. Enter total net deposits up to this date as "base".`);
  }

  try {
    let txns = [];
    const secById = {};
    for (let offset = 0; ; ) {
      const r = await plaid.investmentsTransactionsGet({
        access_token: inst.token,
        // 730 days is Plaid's maximum.
        start_date: isoDay(Date.now() - 730 * day),
        end_date: isoDay(Date.now() + day),
        options: { count: 500, offset },
      });
      for (const s of r.data.securities || []) secById[s.security_id] = s;
      const batch = r.data.investment_transactions || [];
      txns = txns.concat(batch);
      if (!batch.length || txns.length >= (r.data.total_investment_transactions ?? txns.length)) break;
      offset = txns.length;
    }

    // Every transaction Plaid still shows is re-judged on every run, so an
    // entry recorded under an older rule corrects itself; only entries that
    // have aged out of Plaid's window are kept as recorded.
    dep.ledger = Array.isArray(dep.ledger) ? dep.ledger : [];
    const tally = { counted: 0, internal: 0, position: 0, added: 0, removed: 0, changed: 0 };
    for (const tx of txns) {
      if (tx.date <= dep.base_through) continue; // already inside base
      const c = classify(tx, secById);
      if (!c) continue;
      const id = tx.investment_transaction_id;
      const at = dep.ledger.findIndex((e) => e.id === id);
      if (!c.counted) {
        tally[c.why] += 1;
        if (at !== -1) { dep.ledger.splice(at, 1); tally.removed += 1; }
        continue;
      }
      tally.counted += 1;
      if (at === -1) { dep.ledger.push({ id, date: tx.date, amount: c.amount }); tally.added += 1; }
      else if (dep.ledger[at].amount !== c.amount) { dep.ledger[at].amount = c.amount; tally.changed += 1; }
    }
    dep.ledger.sort((a, b) => (a.date < b.date ? -1 : 1));

    // Aggregates only: this repository's Actions logs are public.
    const sum = round2(dep.ledger.reduce((s, e) => s + (Number(e.amount) || 0), 0));
    const dates = txns.map((tx) => tx.date).sort();
    console.log(
      `${inst.name}: net deposits = base ` +
        (Number.isFinite(dep.base) ? `$${dep.base.toLocaleString('en-US')}` : '(not set yet)') +
        ` + ledger $${sum.toLocaleString('en-US')}. Since ${dep.base_through}: ${tally.counted} money movements counted,` +
        ` ${tally.internal} internal moves and ${tally.position} position changes left out;` +
        ` ${tally.added} added, ${tally.removed} removed, ${tally.changed} changed.` +
        ` Plaid history ${dates[0] || '-'} to ${dates[dates.length - 1] || '-'}.`
    );
  } catch (err) {
    console.warn(`${inst.name}: could not update the deposits ledger (${errCode(err)}) — leaving it unchanged.`);
  }
}
writeFileSync(dataPath('deposits.json'), JSON.stringify(deposits, null, 2));

// ---- history ----
// One point per month. The current month's point is overwritten on every run,
// so it tracks the headline total until the month ends, and the last run of
// the month is what stays as that month's value.
const history = readJSON('history.json', []);
const by = Object.fromEntries(Object.entries(latest.institutions).map(([id, x]) => [id, x.total]));
const point = { date: today, value: latest.total, by };
const existing = history.findIndex((p) => p.date.slice(0, 7) === today.slice(0, 7));
if (existing === -1) history.push(point);
else history[existing] = point;
history.sort((a, b) => (a.date < b.date ? -1 : 1));
writeFileSync(dataPath('history.json'), JSON.stringify(history));
console.log(`History point ${today}: $${latest.total.toLocaleString('en-US')}.`);
