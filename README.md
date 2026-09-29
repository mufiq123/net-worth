# Net Worth

One-page dashboard of personal investments at **Public** (brokerage + Roth IRA), **Fidelity**
(401(k)) and **Merrill** (ESPP + Visa equity plan). A GitHub Action pulls from Plaid three
times a day, rebuilds the page and deploys it to Cloudflare Pages, where Cloudflare Access
limits it to your email address. Technical notes are in [`app.md`](app.md).

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

### 2. Enter net deposits (for the gains figures)

The first run after each link sets `base_through` in `data/deposits.json` to that day. Then
fill in `base` for that institution: the total you put in, minus anything taken out, up to
and including that date. After that the ledger adds new deposits by itself.

- **Public:** deposits to the brokerage account plus Roth contributions, minus withdrawals.
- **Fidelity:** your 401(k) contributions plus employer match, minus withdrawals and loans.
  NetBenefits shows this under *Balance → Contributions*.
- **Merrill:** nothing to enter. It uses cost basis (ESPP purchase price, RSU value at vest).

`git pull` first so you have the dates the workflow wrote. Edit the file, then commit and push.
The gain figures stay hidden until every linked institution has its number.

### 3. Hosting (Cloudflare Pages + Access)

Do these in order. The workflow deploys only once the Cloudflare secrets exist, so turning on
Access before adding them means the page is never public, even for a moment.

1. Create a free Cloudflare account, then run this once:
   ```powershell
   npx wrangler login
   npx wrangler pages project create net-worth --production-branch main
   ```
   Note the `*.pages.dev` address it prints. It's `net-worth.pages.dev` unless that name was
   taken.
2. Lock it down: *Zero Trust → Access → Applications → Add → Self-hosted*.
   - Domains: `net-worth.pages.dev` and `*.net-worth.pages.dev` (use your address from step 1).
   - Policy: **Allow**, *Include → Emails →* your address.
   - Login method: One-time PIN (a code is emailed to you).
   - Session duration: e.g. 1 month, so the home-screen app doesn't ask you to log in often.

   Zero Trust's free plan may ask for a card when you sign up. It isn't charged.
3. Make an API token: *My Profile → API Tokens → Create Token → Custom*, with permission
   **Account → Cloudflare Pages → Edit**. Save it and your Account ID (shown on the Workers &
   Pages overview) as secrets:
   ```powershell
   gh secret set CLOUDFLARE_API_TOKEN
   gh secret set CLOUDFLARE_ACCOUNT_ID
   ```
4. Deploy: `gh workflow run daily.yml`, then open the address. Cloudflare should ask for your
   email before it shows anything.

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
