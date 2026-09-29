// scripts/fetch.js
// Pulls current holdings for every connected institution from Plaid (read-only)
// and writes data/latest.json, the deposits ledgers and today's history point.
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

// Checked before credentials, so the scheduled runs are a quiet no-op until
// the first account is linked.
const connected = INSTITUTIONS.map((inst) => ({ ...inst, token: process.env[inst.secret] })).filter((i) => i.token);
if (!connected.length) {
  console.log(`No institutions linked yet (none of ${INSTITUTIONS.map((i) => i.secret).join(', ')} is set). Nothing to fetch.`);
  process.exit(0);
}
console.log(`Linked: ${connected.map((i) => i.name).join(', ')}.`);

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
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

if (REFRESH) {
  await Promise.all(
    connected.map((inst) =>
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
  const resp = await plaid.investmentsHoldingsGet({ access_token: inst.token });
  const { holdings = [], securities = [], accounts = [] } = resp.data;
  const secById = Object.fromEntries(securities.map((s) => [s.security_id, s]));

  let cash = 0;
  let cashBasis = 0;
  let basisKnown = true;
  const positions = [];
  for (const h of holdings) {
    const sec = secById[h.security_id] || {};
    const value = round2(h.institution_value ?? (h.quantity ?? 0) * (h.institution_price ?? 0));
    if (!(value > 0)) continue;
    if (isCash(sec)) {
      cash += value;
      cashBasis += value; // cash has no gain of its own
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
      console.log(`${inst.name}: $${gap.toLocaleString('en-US')} of "${a.name}" balance not in holdings — counted as cash.`);
    }
  }
  if (cash > 0) {
    positions.push({ ticker: 'CASH', name: 'Cash', value: round2(cash), quantity: null, price: null, cost_basis: round2(cashBasis), cash: true });
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
// one-time `base` (everything deposited up to `base_through`) plus every
// deposit/withdrawal Plaid reports after that, keyed by transaction id so the
// ledger never double-counts or loses an entry as Plaid's window slides.
// method "cost_basis" (the equity plan) uses the holdings' cost basis instead
// and needs no ledger — RSU vests never arrive as cash deposits.
const deposits = readJSON('deposits.json', {});
const day = 86400000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const DEFAULT_COUNT = ['cash/deposit', 'cash/contribution', 'cash/withdrawal'];

for (const inst of fresh) {
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
    for (let offset = 0; ; ) {
      const r = await plaid.investmentsTransactionsGet({
        access_token: inst.token,
        start_date: isoDay(Date.now() - 120 * day),
        end_date: isoDay(Date.now() + day),
        options: { count: 500, offset },
      });
      const batch = r.data.investment_transactions || [];
      txns = txns.concat(batch);
      if (!batch.length || txns.length >= (r.data.total_investment_transactions ?? txns.length)) break;
      offset = txns.length;
    }

    const count = new Set(dep.count || DEFAULT_COUNT);
    dep.ledger = Array.isArray(dep.ledger) ? dep.ledger : [];
    const seen = new Set(dep.ledger.map((e) => e.id));
    let added = 0;
    const kinds = {};

    for (const tx of txns) {
      const kind = `${tx.type || ''}/${(tx.subtype || '').toLowerCase()}`;
      kinds[kind] = (kinds[kind] || 0) + 1;
      if (!count.has(kind)) continue;
      if (tx.date <= dep.base_through) continue; // already inside base
      if (seen.has(tx.investment_transaction_id)) continue;
      // Sign by meaning rather than Plaid's convention, which differs between
      // cash rows and buy rows. A zero-amount share transfer is valued at
      // quantity × price.
      let amt = Math.abs(tx.amount || 0) || Math.abs((tx.quantity || 0) * (tx.price || 0));
      if (kind.endsWith('/withdrawal')) amt = -amt;
      dep.ledger.push({ id: tx.investment_transaction_id, date: tx.date, amount: round2(amt) });
      seen.add(tx.investment_transaction_id);
      added += 1;
    }
    dep.ledger.sort((a, b) => (a.date < b.date ? -1 : 1));

    const sum = round2(dep.ledger.reduce((s, e) => s + (Number(e.amount) || 0), 0));
    console.log(
      `${inst.name}: ledger $${sum.toLocaleString('en-US')} (${added} new); base ` +
        (Number.isFinite(dep.base) ? `$${dep.base.toLocaleString('en-US')}` : 'not set yet') +
        `. Transaction kinds seen: ${Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(', ') || 'none'}.`
    );
  } catch (err) {
    console.warn(`${inst.name}: could not update the deposits ledger (${errCode(err)}) — leaving it unchanged.`);
  }
}
writeFileSync(dataPath('deposits.json'), JSON.stringify(deposits, null, 2));

// ---- history ----
// Today's point is overwritten on each run rather than kept from the first,
// so the chart's end label stays in step with the headline total.
const history = readJSON('history.json', []);
const by = Object.fromEntries(Object.entries(latest.institutions).map(([id, x]) => [id, x.total]));
const point = { date: today, value: latest.total, by };
const existing = history.findIndex((p) => p.date === today);
if (existing === -1) history.push(point);
else history[existing] = point;
history.sort((a, b) => (a.date < b.date ? -1 : 1));
writeFileSync(dataPath('history.json'), JSON.stringify(history));
console.log(`History point ${today}: $${latest.total.toLocaleString('en-US')}.`);
