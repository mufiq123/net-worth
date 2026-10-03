// scripts/institutions.js
// The connected institutions. Public and Fidelity are Plaid Items, each with
// its own access token stored as the GitHub secret named in `secret`; one whose
// secret is not set yet is simply skipped. Merrill can't be reached through
// Plaid, so it is `manual`: share counts are kept by hand in data/merrill.json
// and valued at the day's market price.
export const INSTITUTIONS = [
  { id: 'public', name: 'Public', secret: 'PLAID_TOKEN_PUBLIC' },
  { id: 'fidelity', name: 'Fidelity', secret: 'PLAID_TOKEN_FIDELITY' },
  { id: 'merrill', name: 'Merrill', source: 'manual', config: 'merrill.json' },
];

export const byId = Object.fromEntries(INSTITUTIONS.map((i) => [i.id, i]));
