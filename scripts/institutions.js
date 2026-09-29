// scripts/institutions.js
// The three connected institutions. Each is its own Plaid Item with its own
// access token, stored as the GitHub secret named in `secret`. An institution
// whose secret is not set yet is simply skipped, so accounts can be linked one
// at a time and the page works with whatever is connected so far.
export const INSTITUTIONS = [
  { id: 'public', name: 'Public', secret: 'PLAID_TOKEN_PUBLIC' },
  { id: 'fidelity', name: 'Fidelity', secret: 'PLAID_TOKEN_FIDELITY' },
  { id: 'merrill', name: 'Merrill', secret: 'PLAID_TOKEN_MERRILL' },
];

export const byId = Object.fromEntries(INSTITUTIONS.map((i) => [i.id, i]));
