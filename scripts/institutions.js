// scripts/institutions.js
// The connected institutions. Each is a Plaid Item with its own access token,
// stored as the GitHub secret named in `secret`; one whose secret is not set yet
// is simply skipped.
export const INSTITUTIONS = [
  { id: 'public', name: 'Public', secret: 'PLAID_TOKEN_PUBLIC' },
  { id: 'fidelity', name: 'Fidelity', secret: 'PLAID_TOKEN_FIDELITY' },
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
  },
];

export const byId = Object.fromEntries(INSTITUTIONS.map((i) => [i.id, i]));
