// scripts/probe-transactions.js
//
// TEMPORARY, READ-ONLY diagnostic. Lists every investment transaction Plaid
// returns for each linked institution, so the deposits ledger rules can be
// checked against real rows. Writes nothing to data/ and deploys nothing.
//
// This repository and its Actions logs are public, so the rows are never
// printed: they are encrypted to the RSA public key passed in PROBE_PUBKEY
// (base64 DER) and uploaded as a short-lived artifact that only the holder of
// the private key can read. The log shows counts only.
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { writeFileSync } from 'fs';
import { publicEncrypt, randomBytes, createCipheriv, createPublicKey, constants } from 'crypto';
import { INSTITUTIONS } from './institutions.js';

const { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV = 'production', PROBE_PUBKEY } = process.env;
if (!PROBE_PUBKEY) throw new Error('PROBE_PUBKEY is required');

const plaid = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[PLAID_ENV],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': PLAID_CLIENT_ID, 'PLAID-SECRET': PLAID_SECRET } },
  })
);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const out = {};

for (const inst of INSTITUTIONS.filter((i) => i.secret && process.env[i.secret])) {
  const token = process.env[inst.secret];
  try {
    let txns = [];
    const secs = {};
    let accounts = [];
    for (let offset = 0; ; ) {
      const r = await plaid.investmentsTransactionsGet({
        access_token: token,
        start_date: isoDay(Date.now() - 730 * 86400000),
        end_date: isoDay(Date.now() + 86400000),
        options: { count: 500, offset },
      });
      for (const s of r.data.securities || []) secs[s.security_id] = s;
      accounts = r.data.accounts || accounts;
      const batch = r.data.investment_transactions || [];
      txns = txns.concat(batch);
      if (!batch.length || txns.length >= (r.data.total_investment_transactions ?? txns.length)) break;
      offset = txns.length;
    }
    const acct = Object.fromEntries(accounts.map((a) => [a.account_id, `${a.name} (${a.subtype})`]));
    out[inst.id] = txns
      .map((t) => {
        const s = secs[t.security_id] || {};
        return {
          id: t.investment_transaction_id, date: t.date, account: acct[t.account_id], type: t.type, subtype: t.subtype,
          amount: t.amount, quantity: t.quantity, price: t.price, fees: t.fees, name: t.name,
          sec: t.security_id ? { ticker: s.ticker_symbol, name: s.name, type: s.type, cash_eq: s.is_cash_equivalent } : null,
        };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    console.log(`${inst.name}: ${txns.length} transactions.`);
  } catch (err) {
    console.log(`${inst.name}: failed (${err?.response?.data?.error_code || err.message}).`);
  }
}

const key = randomBytes(32);
const iv = randomBytes(12);
const c = createCipheriv('aes-256-gcm', key, iv);
const body = Buffer.concat([c.update(JSON.stringify(out)), c.final()]);
const pub = createPublicKey({ key: Buffer.from(PROBE_PUBKEY, 'base64'), format: 'der', type: 'spki' });
const wrapped = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
writeFileSync('probe.enc.json', JSON.stringify({ k: wrapped.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), d: body.toString('base64') }));
console.log('Wrote encrypted probe.enc.json.');
