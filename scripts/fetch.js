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
  console.log('No institutions linked yet. Nothing to fetch.');
  process.exit(0);
}
console.log(`Linked: ${connected.map((i) => i.name).join(', ')}.`);

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.error('Missing PLAID_CLIENT_ID or PLAID_SECRET.');
  process.exit(1);
}

const envMap = {
  sandbox: PlaidEnvironments.sandbox,
  production: PlaidEnvironments.production,
};
const basePath = envMap[PLAID_ENV];
if (!basePath) {
  console.error(`Unknown PLAID_ENV "${PLAID_ENV}". Use sandbox or production.`);
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
// Refresh is asynchronous, so the investment Items are requested together and
// share one grace period. PLAID_REFRESH=false turns it off (it is metered on
// paid plans). Bank accounts are not refreshed on demand: see bankHoldings.
const REFRESH = (process.env.PLAID_REFRESH ?? 'true') !== 'false';
const REFRESH_WAIT_MS = Number(process.env.PLAID_REFRESH_WAIT_MS ?? 30000);

const investmentItems = connected.filter((i) => i.kind !== 'bank');
if (REFRESH && investmentItems.length) {
  await Promise.all(
    investmentItems.map((inst) =>
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
  savings: 'Savings', 'money market': 'Money market', cd: 'CD',
};
const acctType = (inst, a) => inst.accountLabels?.[a.name] || SUBTYPE_LABELS[(a.subtype || '').toLowerCase()] || a.subtype || a.type || 'Account';

// ---- transactions ----
// Fetched once per institution and shared by the cost-basis rebuild and the
// deposits ledger. 730 days is Plaid's maximum.
const day = 86400000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
function fetchTxns(inst) {
  inst.txnsPromise ??= (async () => {
    let txns = [];
    const secById = {};
    const typeByAccount = {};
    for (let offset = 0; ; ) {
      const r = await plaid.investmentsTransactionsGet({
        access_token: inst.token,
        start_date: isoDay(Date.now() - 730 * day),
        end_date: isoDay(Date.now() + day),
        options: { count: 500, offset },
      });
      for (const s of r.data.securities || []) secById[s.security_id] = s;
      for (const a of r.data.accounts || []) typeByAccount[a.account_id] = acctType(inst, a);
      const batch = r.data.investment_transactions || [];
      txns = txns.concat(batch);
      if (!batch.length || txns.length >= (r.data.total_investment_transactions ?? txns.length)) break;
      offset = txns.length;
    }
    return { txns, secById, typeByAccount };
  })();
  return inst.txnsPromise;
}

// ---- cost basis, rebuilt from transactions ----
// Plaid reports no cost basis for Public or Fidelity holdings, so it is
// rebuilt per account and security from buys, sells, contributions and
// splits, at average cost (what Public's app shows). Checked 2026-10-11: the
// rebuilt share counts matched every Public and Fidelity holding exactly.
//
// Plaid keeps two years of transactions, so data/costbasis.json carries a
// base: each position's shares and cost as of `as_of`, rolled forward once it
// is a year old. Each run replays everything after `as_of` on top of it. A
// holding whose rebuilt share count does not match gets no cost basis (and so
// no gain on the page) rather than a wrong one.
const costbasis = readJSON('costbasis.json', {});
const SHARES_EPS = 0.0005;
function applyTrade(book, tx) {
  if (!tx.security_id) return;
  const qty = Number(tx.quantity) || 0;
  const amount = round2(Math.abs(tx.amount || 0));
  const kind = `${tx.type || ''}/${(tx.subtype || '').toLowerCase()}`;
  const key = `${tx.account_id}|${tx.security_id}`;
  const pos = (book[key] ??= { shares: 0, cost: 0 });
  const remove = (n) => {
    if (pos.shares > SHARES_EPS) pos.cost -= pos.cost * Math.min(n, pos.shares) / pos.shares;
    pos.shares -= n;
    if (pos.shares <= SHARES_EPS) { pos.shares = 0; pos.cost = 0; } // sold out (or history began mid-position)
  };
  if (tx.type === 'buy' || (kind === 'cash/contribution' && qty > 0)) {
    pos.shares += Math.abs(qty);
    pos.cost += amount;
  } else if (tx.type === 'sell') {
    remove(Math.abs(qty));
  } else if (qty && !amount) {
    // A zero-amount change in shares: a split ("Position adjusted"), or a
    // transfer of shares. Cost is unchanged by a split.
    if (qty > 0) pos.shares += qty;
    else remove(-qty);
  }
}
// Plaid gives dates, not times. Within a day sells go first: Public's Roth
// QQQM sells and rebuys most days, the buy spending the sell's proceeds, and
// sells-first reproduces the average cost Public shows. A sell larger than the
// shares held (a same-day round trip on a new position) waits for the day's buys.
function replay(book, rows) {
  const days = new Map();
  for (const tx of rows) (days.get(tx.date) || days.set(tx.date, []).get(tx.date)).push(tx);
  for (const date of [...days.keys()].sort()) {
    const rowsOfDay = days.get(date);
    const deferred = [];
    for (const tx of rowsOfDay.filter((t) => t.type === 'sell')) {
      const held = book[`${tx.account_id}|${tx.security_id}`]?.shares || 0;
      if (held + SHARES_EPS >= Math.abs(Number(tx.quantity) || 0)) applyTrade(book, tx);
      else deferred.push(tx);
    }
    for (const tx of rowsOfDay.filter((t) => t.type !== 'sell')) applyTrade(book, tx);
    for (const tx of deferred) applyTrade(book, tx);
  }
}
async function rebuildCosts(inst) {
  const { txns } = await fetchTxns(inst);
  const state = (costbasis[inst.id] ??= { as_of: null, positions: {} });
  if (!state.as_of || state.as_of < isoDay(Date.now() - 365 * day)) {
    const rollTo = isoDay(Date.now() - 180 * day);
    replay(state.positions, txns.filter((tx) => (!state.as_of || tx.date > state.as_of) && tx.date <= rollTo));
    for (const [k, v] of Object.entries(state.positions)) {
      if (v.shares === 0) delete state.positions[k];
      else state.positions[k] = { shares: Math.round(v.shares * 1e6) / 1e6, cost: round2(v.cost) };
    }
    state.as_of = rollTo;
  }
  const book = JSON.parse(JSON.stringify(state.positions));
  replay(book, txns.filter((tx) => tx.date > state.as_of));
  return book;
}
// The rebuilt position for a holding: same account and security, or failing
// that the one position in the same account with exactly the same share count
// (Plaid files Fidelity's Vanguard total market trust under one security in
// holdings and another in transactions).
function rebuiltFor(book, h, used) {
  const shares = Number(h.quantity) || 0;
  const fits = (v) => v && v.shares > SHARES_EPS && Math.abs(v.shares - shares) <= SHARES_EPS;
  const key = `${h.account_id}|${h.security_id}`;
  if (fits(book[key])) return used.add(key), book[key];
  const alt = Object.entries(book).filter(([k, v]) => k.startsWith(`${h.account_id}|`) && !used.has(k) && fits(v));
  if (alt.length === 1) return used.add(alt[0][0]), alt[0][1];
  return null;
}

async function plaidHoldings(inst) {
  const resp = await plaid.investmentsHoldingsGet({ access_token: inst.token });
  const { holdings = [], securities = [], accounts = [] } = resp.data;
  const secById = Object.fromEntries(securities.map((s) => [s.security_id, s]));
  // Which account each holding sits in, so the page can tag it (Roth IRA,
  // Brokerage). Cash is pooled, so it lists every account it came from.
  const acctNames = Object.fromEntries(accounts.map((a) => [a.account_id, a.name]));
  const label = (name) => inst.accountLabels?.[name] || name;
  const isGrant = (h) => (inst.grantAccounts || []).includes(acctNames[h.account_id]);
  for (const name of inst.grantAccounts || []) {
    if (!accounts.some((a) => a.name === name)) {
      console.warn(`${inst.name}: no account named "${name}", so any granted shares would count as missing a cost. Update institutions.js if it was renamed.`);
    }
  }
  // Transactions are read only when a holding needs its cost rebuilt.
  let book = null;
  if (holdings.some((h) => !isCash(secById[h.security_id] || {}) && !(h.cost_basis > 0) && !isGrant(h))) {
    try {
      book = await rebuildCosts(inst);
    } catch (err) {
      console.warn(`${inst.name}: could not rebuild cost basis (${errCode(err)}) — gains per holding left out.`);
    }
  }
  const used = new Set();
  const basisFrom = { plaid: 0, rebuilt: 0, none: 0 };

  let cash = 0;
  let cashBasis = 0;
  let basisKnown = true;
  const positions = [];
  const cashAccts = new Set();
  for (const h of holdings) {
    const sec = secById[h.security_id] || {};
    const value = round2(h.institution_value ?? (h.quantity ?? 0) * (h.institution_price ?? 0));
    if (!(value > 0)) continue;
    if (isCash(sec)) {
      if (inst.sharesOnly) continue;
      cash += value;
      cashBasis += value; // cash has no gain of its own
      if (acctNames[h.account_id]) cashAccts.add(label(acctNames[h.account_id]));
      continue;
    }
    const grant = isGrant(h);
    const rebuilt = book && !grant && !(h.cost_basis > 0) ? rebuiltFor(book, h, used) : null;
    const basis = grant ? null : h.cost_basis > 0 ? h.cost_basis : rebuilt && rebuilt.cost > 0 ? rebuilt.cost : null;
    if (!grant) {
      basisFrom[h.cost_basis > 0 ? 'plaid' : basis != null ? 'rebuilt' : 'none'] += 1;
      if (basis == null) basisKnown = false;
    }
    positions.push({
      ticker: sec.ticker_symbol || null,
      name: sec.name || 'Unknown holding',
      value,
      quantity: h.quantity ?? null,
      // Public reports 0 here alongside a correct value and quantity.
      price: h.institution_price || (h.quantity ? round2(value / h.quantity) : null),
      cost_basis: basis != null ? round2(basis) : null,
      accounts: acctNames[h.account_id] ? [label(acctNames[h.account_id])] : [],
      ...(grant ? { exclude_from_gains: true } : {}),
    });
  }
  // Some institutions (Public) report part of an account's uninvested cash only
  // in its balance, not as a holding. Per account, anything the balance holds
  // beyond its holdings is counted as cash. Only a positive gap is added: a
  // balance below its holdings is more likely a stale balance than debt.
  const heldByAccount = {};
  for (const h of holdings) {
    if (inst.sharesOnly && isCash(secById[h.security_id] || {})) continue;
    const v = h.institution_value ?? (h.quantity ?? 0) * (h.institution_price ?? 0);
    heldByAccount[h.account_id] = (heldByAccount[h.account_id] || 0) + (v > 0 ? v : 0);
  }
  for (const a of inst.sharesOnly ? [] : accounts) {
    const gap = round2((a.balances?.current ?? 0) - (heldByAccount[a.account_id] || 0));
    if (gap > 0.5) {
      cash += gap;
      cashBasis += gap;
      cashAccts.add(label(a.name));
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
  if (!inst.sharesOnly && Math.abs(acctTotal - total) > 1) {
    console.warn(`${inst.name}: account balances total $${acctTotal.toLocaleString('en-US')} vs holdings $${total.toLocaleString('en-US')}.`);
  }
  console.log(`${inst.name}: cost basis from Plaid for ${basisFrom.plaid}, rebuilt from transactions for ${basisFrom.rebuilt}, missing for ${basisFrom.none}.`);
  // Value build.js leaves out of gains, so total − excluded is what the cost
  // basis is measured against.
  const excluded = positions.filter((p) => p.exclude_from_gains).map((p) => ({ name: p.accounts[0], value: p.value }));

  return {
    name: inst.name,
    date: today,
    total,
    cost_basis: costBasis,
    ...(excluded.length ? { excluded } : {}),
    accounts: accounts.map((a) => ({
      name: label(a.name),
      type: acctType(inst, a),
      // A balance would include the cash a shares-only institution leaves out.
      value: round2(inst.sharesOnly ? heldByAccount[a.account_id] || 0 : a.balances?.current || 0),
    })),
    positions,
  };
}

// ---- bank accounts (Vio's HYSA) ----
// A savings account has no holdings: its value is the balance. /accounts/get
// serves the balance Plaid last fetched from the bank, which Plaid updates
// roughly 1–4 times a day. That's plenty for savings and costs nothing extra,
// so the separately billed on-demand refresh isn't used.
async function bankHoldings(inst) {
  const resp = await plaid.accountsGet({ access_token: inst.token });
  const accounts = (resp.data.accounts || [])
    .filter((a) => a.type === 'depository')
    .map((a) => ({ name: a.name, type: acctType(inst, a), value: round2(a.balances?.current || 0) }));
  const total = round2(accounts.reduce((s, a) => s + a.value, 0));
  if (!(total > 0)) throw new Error('no balance yet');
  console.log(`${inst.name}: ${accounts.length} account${accounts.length === 1 ? '' : 's'}, $${total.toLocaleString('en-US')}.`);
  return {
    name: inst.name,
    date: today,
    total,
    cost_basis: null,
    accounts,
    // One holdings row. build.js measures it against what was deposited, so
    // its gain is the interest.
    positions: [{ ticker: 'HYSA', name: 'High-yield savings', value: total, quantity: null, price: null, cost_basis: null, accounts: accounts.filter((a) => a.value > 0).map((a) => a.name) }],
  };
}

// Each institution is fetched independently. One that fails keeps its last
// good snapshot (with its older date), rather than dropping out of the total —
// otherwise a single Fidelity outage would draw a fake crash on the chart.
const latest = readJSON('latest.json', { institutions: {} });
latest.institutions = latest.institutions || {};
const fresh = [];

const results = await Promise.allSettled(connected.map((inst) => (inst.kind === 'bank' ? bankHoldings(inst) : plaidHoldings(inst))));
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
// method "cost_basis" (Merrill) uses the holdings' cost basis instead and needs
// no ledger.
const deposits = readJSON('deposits.json', {});

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
  // Public's cash rewards count as money in here, but the after-tax toggle
  // treats them as earnings, since the owner didn't deposit them.
  return { counted: true, amount: round2(-tx.amount), reward: /cash reward/i.test(tx.name || '') };
}

// ---- bank deposits (Vio) ----
// From /transactions/sync, which hands over only what changed since the saved
// cursor: added, modified and removed rows. Every page is read before
// anything is kept, and the rows and the cursor are saved together in
// deposits.json. Plaid signs money leaving the account positive.
// - Deposits and withdrawals count. Pending rows don't: a pending row is
//   removed and comes back with a new id once it posts.
// - Interest is the account's gain, so it's left out, as are bank fees, which
//   come off the gain.
// A row is judged once, when Plaid first sends it. To re-judge everything
// under a changed rule, set the cursor to null and the ledger to [] and the
// next run replays Plaid's whole history.
function classifyBank(tx) {
  const pfc = `${tx.personal_finance_category?.primary || ''}/${tx.personal_finance_category?.detailed || ''}`;
  if (/INTEREST/i.test(pfc) || (!tx.personal_finance_category && /\binterest\b/i.test(tx.name || ''))) return { counted: false, why: 'interest' };
  if (/BANK_FEES/i.test(pfc)) return { counted: false, why: 'fee' };
  if (!round2(tx.amount || 0)) return { counted: false, why: 'zero' };
  return { counted: true, amount: round2(-tx.amount) };
}
async function syncBank(inst, start) {
  for (let attempt = 1; ; attempt++) {
    let cursor = start || undefined;
    const out = { added: [], modified: [], removed: [], status: null };
    try {
      for (;;) {
        const r = await plaid.transactionsSync({ access_token: inst.token, cursor, count: 500 });
        out.added.push(...(r.data.added || []));
        out.modified.push(...(r.data.modified || []));
        out.removed.push(...(r.data.removed || []));
        out.status = r.data.transactions_update_status;
        cursor = r.data.next_cursor;
        if (!r.data.has_more) break;
      }
      return { ...out, cursor };
    } catch (err) {
      // The data changed mid-read: start again from the same cursor.
      if (errCode(err) === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 3) continue;
      throw err;
    }
  }
}
async function updateBankLedger(inst, dep) {
  try {
    const sync = await syncBank(inst, dep.cursor);
    const tally = { counted: 0, interest: 0, fee: 0, zero: 0, pending: 0, added: 0, removed: 0, changed: 0 };
    const find = (id) => dep.ledger.findIndex((e) => e.id === id);
    const drop = (id) => {
      const at = find(id);
      if (at !== -1) { dep.ledger.splice(at, 1); tally.removed += 1; }
    };
    for (const tx of [...sync.added, ...sync.modified]) {
      if (tx.pending) { tally.pending += 1; drop(tx.transaction_id); continue; }
      const c = classifyBank(tx);
      if (!c.counted) { tally[c.why] += 1; drop(tx.transaction_id); continue; }
      tally.counted += 1;
      const entry = { id: tx.transaction_id, date: tx.date, amount: c.amount };
      const at = find(entry.id);
      if (at === -1) { dep.ledger.push(entry); tally.added += 1; }
      else if (dep.ledger[at].amount !== entry.amount || dep.ledger[at].date !== entry.date) { dep.ledger[at] = entry; tally.changed += 1; }
    }
    for (const r of sync.removed) drop(r.transaction_id);
    dep.ledger.sort((a, b) => (a.date < b.date ? -1 : 1));
    dep.cursor = sync.cursor;
    if (sync.status === 'HISTORICAL_UPDATE_COMPLETE') dep.history_complete = true;
    // Aggregates only: this repository's Actions logs are public.
    const sum = round2(dep.ledger.reduce((s, e) => s + (Number(e.amount) || 0), 0));
    console.log(
      `${inst.name}: net deposits $${sum.toLocaleString('en-US')}${dep.history_complete ? '' : ' (Plaid is still loading history)'}.` +
        ` This run: ${tally.counted} money movements, ${tally.interest} interest, ${tally.fee} fees, ${tally.pending} pending;` +
        ` ${tally.added} added, ${tally.removed} removed, ${tally.changed} changed.`
    );
  } catch (err) {
    console.warn(`${inst.name}: could not update the deposits ledger (${errCode(err)}) — leaving it unchanged.`);
  }
}

for (const inst of fresh) {
  if (inst.kind === 'bank') {
    const dep = (deposits[inst.id] ??= {
      method: 'ledger',
      note: 'Bank account: deposits come from /transactions/sync. base is 0 because Plaid fetches the account\'s history at link time.',
      base: 0,
      ledger: [],
      cursor: null,
      history_complete: false,
    });
    await updateBankLedger(inst, dep);
    continue;
  }
  const dep = (deposits[inst.id] = deposits[inst.id] || { method: 'ledger', base: null, base_through: null, ledger: [] });
  if (dep.method === 'cost_basis') continue;

  // The first successful run after linking fixes the seam. The base you enter
  // afterwards is "everything deposited up to and including this date".
  if (!dep.base_through) {
    dep.base_through = today;
    console.log(`${inst.name}: base_through set to ${today}. Enter total net deposits up to this date as "base".`);
  }

  try {
    const { txns, secById, typeByAccount } = await fetchTxns(inst);

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
      // The account type is what lets the toggle split principal per account.
      const entry = { id, date: tx.date, amount: c.amount, account: typeByAccount[tx.account_id] || null, ...(c.reward ? { reward: true } : {}) };
      if (at === -1) { dep.ledger.push(entry); tally.added += 1; }
      else if (dep.ledger[at].amount !== c.amount) { dep.ledger[at] = entry; tally.changed += 1; }
      else dep.ledger[at] = entry;
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
writeFileSync(dataPath('costbasis.json'), JSON.stringify(costbasis, null, 2));

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
