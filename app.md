# Net Worth — technical notes

A static dashboard on GitHub Pages (`https://mufiq123.github.io/net-worth/`). No server, no
client-side API calls, no runtime secrets. A GitHub Action pulls from Plaid, rebuilds a single HTML file, commits the data it fetched, and deploys.
The pipeline is the O.A. Investments one (`../oa-investments/app.md`), extended from one Plaid
Item to three.

```
cron (6 entries) → gate job → fetch.js → build.js → dist/index.html → deploy-pages
                                  ↓
                     data/{latest,history,deposits}.json  (committed back to main)
```

## Files

| Path | Role |
|---|---|
| `scripts/institutions.js` | The three institutions and the secret holding each access token. |
| `scripts/fetch.js` | Plaid → `data/*.json`. The only thing that touches credentials. |
| `scripts/build.js` | `data/*.json` → `dist/index.html`. Pure function of the data; no network. |
| `scripts/link.js` | Local Plaid Link flow per institution; saves the token as a GitHub secret. |
| `data/latest.json` | Per-institution snapshot: total, cost basis, accounts, positions. |
| `data/history.json` | `[{date, value, by: {public, fidelity, merrill}}]`, one point per month. |
| `data/deposits.json` | Per-institution net-deposit method and ledger. See below. |
| `.github/workflows/daily.yml` | Schedule, gate, fetch, build, commit, deploy. |

## Institutions

| id | Accounts | Secret | Gains method |
|---|---|---|---|
| `public` | Brokerage, Roth IRA | `PLAID_TOKEN_PUBLIC` | ledger |
| `fidelity` | 401(k) | `PLAID_TOKEN_FIDELITY` | ledger |
| `merrill` | ESPP, Visa equity plan | `PLAID_TOKEN_MERRILL` | cost basis |

An institution whose secret isn't set is skipped, so the page works with any subset linked.
One login is one Plaid Item, and Items aren't refunded on delete, so broken connections are
repaired with `link.js --update` (same Item) rather than relinked.

## Design decisions

**Per-institution failover.** Each institution is fetched on its own. One that fails keeps its
last snapshot, with its older date, rather than dropping out of the total. Otherwise one
Fidelity outage would draw a crash of the 401(k)'s full value on the chart and then a rally
the next day. The whole run aborts only when *every* institution fails. Staleness is judged
per institution in the browser from `data-asof` (a `{name: date}` map), so an Item stuck on
`ITEM_LOGIN_REQUIRED` shows up as "Fidelity was last updated N days ago" rather than hiding
inside a fresh-looking total.

**Refresh once, wait once.** `/investments/refresh` goes to all three Items together, then a
single 30s wait, rather than 90s in sequence.

**Cash is one holding.** Securities with `type: cash` or `is_cash_equivalent` (`CUR:USD`,
SPAXX-style money market funds) become one `Cash` position per institution, and `build.js`
merges that across institutions like any other holding. `fetch.js` logs whenever account
balances and holdings disagree by more than $1, which is the sign that cash is being reported
outside the holdings.

**Account dropdown.** An institution with more than one funded account (Public: Roth IRA and
Brokerage) renders as a `<details>` element, so it opens and closes without script. Empty
sub-accounts that Plaid lists (Treasury, Bond, …) are left out, and the balances inside carry
`.money` so the privacy toggle covers them.

**Holding chips.** Each holding is tagged with its institution in that institution's colour.
Positions from an institution with more than one funded account also get an account chip
(`--a1` Roth IRA violet, `--a2` Brokerage pink); `fetch.js` records each position's
`accounts` for this. A tag's tint is derived from its colour with `color-mix()`.

**Holdings merge in build, not fetch.** `latest.json` keeps positions per institution, and
the combined list is derived at build time, keyed by ticker, or by name when there is none
(401(k) collective trusts often have no ticker). Each row carries tags for the institutions
it came from. Keeping the raw split means the merge rule can change without re-fetching.

**Data quirks handled.** Public reports `institution_price: 0` next to correct values and
quantities, so price falls back to value ÷ quantity. Public also keeps some uninvested cash
only in an account's balance, so per account, any positive balance-minus-holdings gap is
counted as cash. Fidelity's 401(k) trusts have no real tickers; Plaid invents ones like
`TRP.LRG.CAP.GR.TR.D`, and `DISPLAY` in `build.js` maps known ones to readable names. Names are
"Issuer - Fund" and usually shortened to the fund. When the suffix is a label rather than a
name (lowercase like "contribution", or "…shares of beneficial interest"), the issuer part is
kept instead.

**Two ways to measure what went in.**
- *Ledger* (Public, Fidelity): `base` + id-keyed ledger, as on O.A. Investments. The
  difference is that `base_through` is set automatically, on the first successful run after
  linking. `base` is then whatever you deposited up to that date, so there's no seam to work
  out by hand. Counted kinds default to `cash/deposit`, `cash/contribution` and
  `cash/withdrawal`, and can be overridden per institution with a `count` array in
  `deposits.json`. Amounts are signed by meaning (withdrawal negative) rather than by Plaid's
  sign, because Plaid's convention differs between cash rows and buy rows. A zero-amount share
  transfer is valued at quantity × price. Every run logs the transaction kinds it saw for each
  institution, so a 401(k) that reports payroll contributions as, say, `buy/contribution` shows
  up in the log and can be added to `count`.
- *Cost basis* (Merrill): RSU vests never arrive as cash deposits, so a ledger would count every
  vested share as pure gain. Summing holdings' `cost_basis` (ESPP purchase price, RSU value at
  vest) is the right "invested" figure for equity compensation. Cash counts at face value. If
  any holding lacks a cost basis, the figure is `null` rather than understated.

**Combined gains need every institution.** The stats row appears only when every linked
institution has an invested figure. A total that silently left one out would overstate the
gain. Per-institution gains show in the Accounts card as soon as each is known.

**Hosting: public repo + GitHub Pages.** GitHub Free only serves Pages from a public repo, and
the owner chose that over Cloudflare Access. So the page, `data/*.json` and the Actions logs
are all public, as on O.A. Investments. `fetch.js` logs totals and transaction-kind counts,
never individual transactions. `noindex` keeps it out of search engines but doesn't protect
anything.

**Monthly history.** `history.json` holds one point per month. The current month's point is
overwritten on each run, so it follows the headline total and freezes at the month's last run.

**Backfill (2026-09-28), from statements not kept in the repo.**
- *Public:* the month-end value is the closing "total priced portfolio" on each Apex statement,
  brokerage (5OF, opened Oct 2025) plus Roth (5OD, opened Jan 2026). July 2026 has no point,
  because the brokerage sent one combined Jul–Aug statement. Net deposits of $18,062.79
  through Aug 31 = ACH deposits + journals in − ACH disbursements − journals out + Public's
  IRA contribution match, taken from each statement's "Funds Paid and Received". CONTRIBUTION
  rows repeat their ACH rows and cash-sweep XFERs net to zero, so neither is counted.
  `base_through` is Aug 31, so Plaid's ledger adds September.
- *Fidelity:* NetBenefits `history.csv` (Jul 2025 onward) records shares per transaction, and
  adding them up gives exactly Plaid's current share counts. Month-end value = shares held ×
  that fund's price at its latest contribution or exchange (amount ÷ shares). That price is
  up to two weeks old, so these points are close, not exact. Net deposits = the sum of
  `Contributions` rows, $19,417.04 (employee + match; the one dividend is income).

**Inherited unchanged from O.A. Investments:** DST-correct six-cron + gate schedule, history
`continue-on-error` on fetch, themed custom properties (a neutral palette: blue `--accent` only for the chart line, green and
red for gains and losses, and one colour per institution, `--c1..3`, for the allocation bar,
legend and badge letter), the privacy blur, and the
snapping chart scrubber. The x-axis reads in days ("Sep 28") until the history spans about 300
days, then switches to months.

## Secrets

`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_TOKEN_PUBLIC`,
`PLAID_TOKEN_FIDELITY`, `PLAID_TOKEN_MERRILL`. `link.js` writes the Plaid ones through `gh secret set`. Plaid access
is read-only and cannot move money.

## Known limitations

- **Merrill isn't linked yet.** "Merrill Lynch - Benefits" goes through Merrill Lynch's
  own connection. The first attempt (2026-09-28) failed with `INSTITUTION_NOT_RESPONDING`, and
  Plaid lists a 45% success rate for it. Retry `link.js merrill` later; no code change is
  needed when it works.
- **Merrill Benefits OnLine may not be supported by Plaid.** Equity-plan portals are
  often not reachable by aggregators. If it isn't in Plaid Link, the fallback is a hand-kept
  share count for Visa (`V`), priced from a market feed. Not built.
- **Unvested RSUs aren't counted.** Plaid reports what's in the account, so only vested
  shares appear.
- **Prices are end-of-day** (Plaid investments update about once a day after close).
- **Ledger kinds for the 401(k) are unconfirmed** until the first run's log shows what
  Fidelity reports.
- **History starts at the first link.** Plaid provides no past balances, so the chart begins
  on day one.
