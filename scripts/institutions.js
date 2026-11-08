// scripts/institutions.js
// The connected institutions. Each is a Plaid Item with its own access token,
// stored as the GitHub secret named in `secret`; one whose secret is not set yet
// is simply skipped.
//
// `afterTax` is what the page's after-tax toggle takes off, as the owner set it:
// onTotal is a rate on the whole value, onGains a rate on gains only, and
// onGainsByAccount the same per account type. Principal is never taxed.
//
// `kind: 'bank'` marks a bank account (Vio's HYSA): its value is the balance
// and its deposits come from bank transactions, not investment data.
//
// `short` is the name in the header line and the allocation legend, where it
// differs from `name` (which the Accounts card shows).
export const INSTITUTIONS = [
  {
    id: 'public',
    name: 'Public',
    secret: 'PLAID_TOKEN_PUBLIC',
    afterTax: { onGainsByAccount: { 'Roth IRA': 0.4, Brokerage: 0.27 } },
  },
  { id: 'fidelity', name: 'Fidelity', secret: 'PLAID_TOKEN_FIDELITY', afterTax: { onTotal: 0.4 } },
  {
    id: 'merrill',
    name: 'Merrill',
    secret: 'PLAID_TOKEN_MERRILL',
    linkHint: 'In Plaid\'s search, pick "Merrill Lynch - Benefits" (the benefits.ml.com login), not "Merrill" or "Ascensus - Merrill Lynch".',
    // Plaid's account names, and what the page calls them.
    accountLabels: { 'Visa ESPP LIIA': 'ESPP', 'Visa Equity Plan': 'Equity' },
    // Granted shares have no cost basis by design: they count in the total but
    // stay out of invested, gains and return.
    grantAccounts: ['Visa Equity Plan'],
    // Only shares and their value count. Any cash in these accounts is left out.
    sharesOnly: true,
    // Unvested grants are left out of the after-tax total altogether.
    afterTax: { onGains: 0.33 },
  },
  {
    id: 'vio',
    name: 'Vio HYSA',
    short: 'HYSA',
    secret: 'PLAID_TOKEN_VIO',
    kind: 'bank',
    products: ['transactions'],
    linkHint: 'In Plaid\'s search, pick "Vio Bank". If your login isn\'t accepted there, try "Vio Bank - New". A failed login doesn\'t use up an Item.',
    // Interest is the gain; deposits are never taxed.
    afterTax: { onGains: 0.27 },
  },
];

export const byId = Object.fromEntries(INSTITUTIONS.map((i) => [i.id, i]));
