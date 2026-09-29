# Net Worth

One-page dashboard of personal investments at **Public** (brokerage + Roth IRA), **Fidelity**
(401(k)) and **Merrill** (ESPP + Visa equity plan). A GitHub Action pulls from Plaid three
times a day, rebuilds the page and publishes it on GitHub Pages at
https://mufiq123.github.io/net-worth/. The repo and the page are public, like O.A. Investments. Technical notes are in [`app.md`](app.md).

Uses the same Plaid account as O.A. Investments: 3 more Items, 4 of the Trial plan's 10 in
total. Only a *successful* connection creates an Item; a failed or cancelled login does not.

## Setup

All commands run from this folder in PowerShell.

### 1. Link the three institutions

```powershell
npm install
node scripts/link.js public
node scripts/link.js fidelity
node scripts/link.js merrill
```

Each run asks for the Plaid client ID and secret (the same ones as O.A. Investments), then
says to open http://localhost:3000. Click **Connect**, find the institution in Plaid's
search, and log in. When it finishes, the script:

- saves the token as a GitHub secret (`PLAID_TOKEN_PUBLIC` / `_FIDELITY` / `_MERRILL`), plus
  `PLAID_CLIENT_ID`, `PLAID_SECRET` and `PLAID_ENV` the first time;
- starts the refresh workflow, which records that institution's first snapshot.

Search tips:
- **Fidelity 401(k):** if Plaid lists "Fidelity NetBenefits" separately, pick that one. Your
  401(k) lives there, not at fidelity.com.
- **Merrill equity plan:** pick "Merrill Benefits Online" if it's listed. That's the
  benefits.ml.com login, not Merrill Edge. If Plaid doesn't list it, stop and don't link a
  different Merrill login to try it out, because each connection uses up an Item.

### 2. Net deposits and history (done)

The history and deposit totals were backfilled from statements on 2026-09-28. `app.md`
describes how. There's nothing to enter; later deposits come from Plaid.

### Later: an institution asks you to log in again

The page's banner will say something like "Fidelity was last updated N days ago", and the
Actions log will show `ITEM_LOGIN_REQUIRED`. Repair the existing connection, which doesn't use
a new Item:

```powershell
$env:PLAID_ACCESS_TOKEN="<the token>"; node scripts/link.js fidelity --update
```

GitHub won't show a secret after it's saved, so you need your own copy of the token for this.
Save the three tokens in a password manager when you link them. If you've lost a token, a
fresh link works too, but it uses an Item.
