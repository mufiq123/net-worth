// scripts/link.js
// ONE-TIME setup per institution, run on your own computer:
//
//   node scripts/link.js public      (then fidelity, then merrill)
//
// Opens a Plaid Link page at http://localhost:3000 where you log in to that
// institution. The resulting access token is saved straight into this repo's
// GitHub secrets with the gh CLI (PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV
// too, if they are not there yet), then the refresh workflow is started.
// The token is also printed, since GitHub never shows a secret again.
//
// If an institution later asks you to log in again (ITEM_LOGIN_REQUIRED),
// repair the existing connection instead of making a new one:
//
//   $env:PLAID_ACCESS_TOKEN="<current token>"; node scripts/link.js fidelity --update
//
// Update mode reuses the same Plaid Item, so it does not count against the
// Trial plan's 10-Item cap. A fresh link does.
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { spawnSync } from 'child_process';
import http from 'http';
import readline from 'readline/promises';
import { byId, INSTITUTIONS } from './institutions.js';

const inst = byId[(process.argv[2] || '').toLowerCase()];
const update = process.argv.includes('--update');
if (!inst) {
  console.error(`Usage: node scripts/link.js <${INSTITUTIONS.map((i) => i.id).join('|')}> [--update]`);
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, env) => (process.env[env] || (await rl.question(q))).trim();

const clientId = await ask('Plaid Client ID: ', 'PLAID_CLIENT_ID');
const secret = await ask('Plaid Secret: ', 'PLAID_SECRET');
const envName = (process.env.PLAID_ENV || 'production').trim();
const envMap = {
  sandbox: PlaidEnvironments.sandbox,
  development: PlaidEnvironments.development,
  production: PlaidEnvironments.production,
};
if (!envMap[envName]) {
  console.error(`Unknown PLAID_ENV "${envName}".`);
  process.exit(1);
}

let existingToken = null;
if (update) {
  existingToken = await ask(`Current ${inst.secret} value: `, 'PLAID_ACCESS_TOKEN');
  if (!existingToken) {
    console.error('Update mode needs the current access token.');
    process.exit(1);
  }
}

const plaid = new PlaidApi(
  new Configuration({
    basePath: envMap[envName],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret } },
  })
);

const linkResp = await plaid.linkTokenCreate({
  user: { client_user_id: 'net-worth-owner' },
  client_name: 'Net Worth',
  country_codes: ['US'],
  language: 'en',
  // Update mode takes the existing token and no products list.
  ...(update ? { access_token: existingToken } : { products: ['investments'] }),
});
const linkToken = linkResp.data.link_token;

// ---- gh helpers ----
const gh = (args, input) => spawnSync('gh', args, { input, encoding: 'utf8' });
const ghOk = gh(['auth', 'status']).status === 0;
const setSecret = (name, value) => {
  const r = gh(['secret', 'set', name], value);
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || `gh secret set ${name} failed`);
};
const existingSecrets = () => {
  const r = gh(['secret', 'list', '--json', 'name']);
  try { return new Set(JSON.parse(r.stdout).map((s) => s.name)); } catch { return new Set(); }
};

function saveToken(accessToken) {
  if (!ghOk) return false;
  try {
    const have = existingSecrets();
    setSecret(inst.secret, accessToken);
    if (!have.has('PLAID_CLIENT_ID')) setSecret('PLAID_CLIENT_ID', clientId);
    if (!have.has('PLAID_SECRET')) setSecret('PLAID_SECRET', secret);
    if (!have.has('PLAID_ENV')) setSecret('PLAID_ENV', envName);
    console.log(`\nSaved ${inst.secret} to this repo's GitHub secrets.`);
    const run = gh(['workflow', 'run', 'daily.yml']);
    console.log(run.status === 0
      ? 'Started the refresh workflow — watch it with: gh run watch'
      : 'Could not start the workflow automatically; run it from the Actions tab.');
    return true;
  } catch (err) {
    console.warn(`\nCould not save with gh (${err.message}).`);
    return false;
  }
}

const page = `<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f6fa;color:#16202c">
<div style="text-align:center;max-width:420px;padding:32px">
<h2>Net Worth</h2>
<p>${update ? 'Click below to reconnect' : 'Click below, then log in to'} your ${inst.name} account.</p>
<button id="b" style="font-size:18px;padding:14px 28px;border-radius:12px;border:none;background:#3f82c4;color:#fff;cursor:pointer">${update ? 'Reconnect' : 'Connect'} ${inst.name}</button>
<p id="s" style="color:#6b7888;margin-top:16px"></p>
</div>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const s = document.getElementById('s');
const h = Plaid.create({ token: ${JSON.stringify(linkToken)}, onSuccess: async (pt) => {
  s.textContent = 'Saving…';
  const r = await fetch('/exchange', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ public_token: pt }) });
  const j = await r.json();
  s.textContent = j.ok ? 'Done — check your terminal. You can close this tab.' : ('Error: ' + (j.error || 'unknown'));
}, onExit: (e) => { if (e) s.textContent = 'Closed: ' + (e.error_message || e.display_message || ''); } });
document.getElementById('b').onclick = () => h.open();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/exchange') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        if (update) {
          // The token is unchanged in update mode; the Item is simply healthy again.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          console.log(`\n${inst.name} reconnected. ${inst.secret} is unchanged.`);
        } else {
          const { public_token } = JSON.parse(body);
          const ex = await plaid.itemPublicTokenExchange({ public_token });
          const accessToken = ex.data.access_token;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          const saved = saveToken(accessToken);
          // Printed either way: GitHub never shows a secret again, and this
          // token is what --update needs if the connection later breaks.
          console.log('\n============================================');
          console.log(`Your ${inst.secret}${saved ? ' — keep a copy in your password manager' : ' (save as a GitHub secret)'}:`);
          console.log(accessToken);
          console.log('============================================');
        }
        rl.close();
        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.response?.data?.error_message || String(err) }));
      }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(page);
});

server.listen(3000, () => {
  console.log(`\nOpen http://localhost:3000 in your browser and click "${update ? 'Reconnect' : 'Connect'} ${inst.name}".\n`);
});
