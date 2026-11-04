// scripts/link.js
// ONE-TIME setup per institution, run on your own computer:
//
//   node scripts/link.js public      (then fidelity, then merrill)
//
// Opens a Plaid Link page at http://localhost:3000 where you log in to that
// institution. The resulting access token is saved straight into this repo's
// GitHub secrets with the gh CLI (PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV
// too, if they are not there yet), then the refresh workflow is started.
// GitHub never shows a secret again, so a private copy goes to
// ~/.net-worth/plaid-tokens.json, outside the repo and OneDrive, encrypted so
// only this Windows account can read it. The token is never printed.
//
// If an institution later asks you to log in again (ITEM_LOGIN_REQUIRED),
// repair the existing connection instead of making a new one:
//
//   node scripts/link.js fidelity --update
//
// Update mode takes the token from the private copy, or asks for it. It reuses
// the same Plaid Item, so it does not count against the Trial plan's 10-Item
// cap. A fresh link does, so linking an institution that already has a token
// is refused unless --relink is passed.
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import http from 'http';
import { homedir } from 'os';
import { join } from 'path';
import readline from 'readline/promises';
import { Writable } from 'stream';
import { byId, INSTITUTIONS } from './institutions.js';

const inst = byId[(process.argv[2] || '').toLowerCase()];
const update = process.argv.includes('--update');
if (!inst) {
  console.error(`Usage: node scripts/link.js <${INSTITUTIONS.map((i) => i.id).join('|')}> [--update | --relink]`);
  process.exit(1);
}

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

// ---- private copy of each token ----
// Update mode needs the token and GitHub never shows a secret again. It lives
// outside the repo and OneDrive, encrypted with DPAPI (through PowerShell) so
// only this Windows account on this computer can read it.
const tokenDir = join(homedir(), '.net-worth');
const tokenFile = join(tokenDir, 'plaid-tokens.json');
const readTokens = () => (existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, 'utf8')) : {});
function keepPrivateCopy(entry) {
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, JSON.stringify({ ...readTokens(), [inst.id]: entry }, null, 2), { mode: 0o600 });
}
function powershell(script, input) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error('PowerShell could not encrypt or decrypt the token');
  return r.stdout.trim();
}
const seal = (token) => powershell('$input | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString', token);
function savedToken() {
  const sealed = readTokens()[inst.id]?.sealed_token;
  if (!sealed) return null;
  try {
    return powershell("$s = $input | ConvertTo-SecureString; [pscredential]::new('x',$s).GetNetworkCredential().Password", sealed);
  } catch {
    return null;
  }
}

// A second link to the same login is a second Item, and some institutions
// invalidate the first when that happens.
if (!update && !process.argv.includes('--relink') && (readTokens()[inst.id] || (ghOk && existingSecrets().has(inst.secret)))) {
  console.error(
    `${inst.name} is already linked. A new link would use another Item.\n` +
      `Use --update to repair the connection, or --relink to really replace it.`
  );
  process.exit(1);
}

// Plaid's own words only. An uncaught Plaid error would print the whole request
// on its way out, secret included.
function plaidError(err) {
  const d = err?.response?.data;
  if (!d) return err?.code || err?.message || 'unknown error';
  return `${d.error_code || 'error'}${d.error_message ? `: ${d.error_message}` : ''}${d.request_id ? ` (request ${d.request_id})` : ''}`;
}

// Everything asked for here is a key or a token, so what's typed isn't echoed
// and can't sit in the terminal's scrollback.
let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding);
    done();
  },
});
const rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
async function ask(q, env) {
  if (process.env[env]) return process.env[env].trim();
  const answer = rl.question(q);
  muted = true;
  const value = await answer;
  muted = false;
  console.log('');
  return value.trim();
}

const clientId = await ask('Plaid Client ID (hidden as you paste): ', 'PLAID_CLIENT_ID');
const secret = await ask('Plaid Secret (hidden as you paste): ', 'PLAID_SECRET');
const envName = (process.env.PLAID_ENV || 'production').trim();
const envMap = {
  sandbox: PlaidEnvironments.sandbox,
  production: PlaidEnvironments.production,
};
if (!envMap[envName]) {
  console.error(`Unknown PLAID_ENV "${envName}".`);
  process.exit(1);
}

let existingToken = null;
if (update) {
  existingToken = savedToken() || (await ask(`Current ${inst.secret} value (hidden as you paste): `, 'PLAID_ACCESS_TOKEN'));
  if (!existingToken) {
    console.error('Update mode needs the current access token.');
    process.exit(1);
  }
}
// Left open, this keeps the terminal in raw mode and Ctrl+C can't stop the server.
rl.close();

const plaid = new PlaidApi(
  new Configuration({
    basePath: envMap[envName],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret } },
  })
);

let linkToken;
try {
  const linkResp = await plaid.linkTokenCreate({
    user: { client_user_id: 'net-worth-owner' },
    client_name: 'Net Worth',
    country_codes: ['US'],
    language: 'en',
    // Update mode takes the existing token and no products list.
    ...(update ? { access_token: existingToken } : { products: ['investments'] }),
  });
  linkToken = linkResp.data.link_token;
} catch (err) {
  console.error(`Could not start Plaid Link. ${plaidError(err)}`);
  process.exit(1);
}

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

// What was linked, and the session id Plaid support asks for, exist only in
// Link's onSuccess metadata. No tokens in here.
function reportLinked(m = {}) {
  const accounts = (m.accounts || []).map((a) => `${a.name} (${a.subtype || a.type})`).join(', ') || 'none reported';
  console.log(
    `\nLinked ${m.institution?.name || 'an unnamed institution'} (${m.institution?.institution_id || 'no id'}).` +
      `\nAccounts: ${accounts}.\nSession: ${m.link_session_id || 'none'}.`
  );
}

const page = `<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f6fa;color:#16202c">
<div style="text-align:center;max-width:420px;padding:32px">
<h2>Net Worth</h2>
<p>${update ? 'Click below to reconnect' : 'Click below, then log in to'} your ${inst.name} account.</p>
${inst.linkHint && !update ? `<p style="color:#6b7888;font-size:14px">${inst.linkHint}</p>` : ''}
<button id="b" style="font-size:18px;padding:14px 28px;border-radius:12px;border:none;background:#3f82c4;color:#fff;cursor:pointer">${update ? 'Reconnect' : 'Connect'} ${inst.name}</button>
<p id="s" style="color:#6b7888;margin-top:16px"></p>
</div>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const s = document.getElementById('s');
const b = document.getElementById('b');
if (!window.Plaid) {
  s.textContent = "Plaid's script didn't load. Check your connection or ad blocker, then reload this page.";
  throw new Error('Plaid Link script did not load');
}
// The Item already exists once onSuccess fires, so saving again with the same
// public token is the way out of a failed save. Connecting again would use
// another Item.
async function save(pt, metadata) {
  s.textContent = 'Saving…';
  try {
    const r = await fetch('/exchange', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ public_token: pt, metadata }) });
    const j = await r.json();
    if (j.ok) {
      s.textContent = 'Done — check your terminal. You can close this tab.';
      b.disabled = true;
      return;
    }
    s.textContent = 'Error: ' + (j.error || 'unknown') + ' Your login worked, so use Save again rather than connecting again.';
  } catch {
    s.textContent = 'The script in your terminal is not answering. Your login worked. Check the terminal before connecting again.';
  }
  b.textContent = 'Save again';
  b.onclick = () => save(pt, metadata);
}
const h = Plaid.create({ token: ${JSON.stringify(linkToken)}, onSuccess: save, onEvent: (name, meta) => {
  // Plaid's error screen gives no reason; the event stream carries the code.
  if (name === 'ERROR' || name === 'FAIL_OAUTH' || name === 'CLOSE_OAUTH' || name === 'HANDOFF' || name === 'SELECT_INSTITUTION' || name === 'OPEN_OAUTH')
    fetch('/log', { method: 'POST', body: JSON.stringify({ event: name, meta }) });
}, onExit: (e, meta) => {
  fetch('/log', { method: 'POST', body: JSON.stringify({ event: 'EXIT', error: e, meta }) });
  s.textContent = e ? 'Closed: ' + (e.error_code || '') + ' ' + (e.error_message || e.display_message || '') + ' — details are in your terminal. You can try again with the button above.' : 'Closed. You can try again with the button above.';
} });
b.onclick = () => h.open();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/log') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { event, meta = {}, error } = JSON.parse(body);
        const inst = meta.institution_name || meta.institution?.name || '';
        const code = error?.error_code || meta.error_code;
        const msg = error?.error_message || meta.error_message;
        console.log(
          `[link] ${event}${inst ? ` · ${inst}` : ''}${code ? ` · ${error?.error_type || meta.error_type || ''} ${code}` : ''}${msg ? ` · ${msg}` : ''}` +
            (meta.link_session_id ? ` · session ${meta.link_session_id}` : '') +
            (meta.request_id ? ` · request ${meta.request_id}` : '') +
            (event === 'EXIT' && meta.status ? ` · status ${meta.status}` : '')
        );
      } catch {}
      res.writeHead(204);
      res.end();
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/exchange') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { public_token, metadata } = JSON.parse(body);
        if (update) {
          // The token is unchanged in update mode; the Item is simply healthy again.
          reportLinked(metadata);
          console.log(`\n${inst.name} reconnected. ${inst.secret} is unchanged.`);
        } else {
          const ex = await plaid.itemPublicTokenExchange({ public_token });
          // Saved before the page hears back, so a closed tab can't lose it.
          let copied = true;
          try {
            keepPrivateCopy({
              sealed_token: seal(ex.data.access_token),
              item_id: ex.data.item_id,
              institution_id: metadata?.institution?.institution_id ?? null,
              link_session_id: metadata?.link_session_id ?? null,
              linked_at: new Date().toISOString(),
            });
          } catch (err) {
            copied = false;
            console.warn(`\nCould not keep a private copy (${err.code || err.message}).`);
          }
          const saved = saveToken(ex.data.access_token);
          // Within 30 minutes Plaid returns the same token for the same public
          // token, so the page's Save again recovers this without a new Item.
          if (!copied && !saved) throw new Error('The token could not be saved to GitHub or to this computer.');
          reportLinked(metadata);
          console.log(
            copied
              ? `\nAn encrypted copy of the token is in ${tokenFile}.`
              : `\nNo private copy was kept, so --update will ask for the token. It can't be read back from GitHub.`
          );
          if (!saved) {
            console.log(
              `It is NOT in GitHub yet. To add it, run this in PowerShell (it prints nothing):\n` +
                `  $s = (Get-Content -Raw "${tokenFile}" | ConvertFrom-Json).${inst.id}.sealed_token | ConvertTo-SecureString; [pscredential]::new('x',$s).GetNetworkCredential().Password | gh secret set ${inst.secret}`
            );
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        const why = plaidError(err);
        console.error(`\nCould not finish linking. ${why}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: why }));
      }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(page);
});

server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? 'Port 3000 is in use. If an earlier link window is still open, press Ctrl+C there, then run this again.'
      : `Could not start the local page (${err.code || err.message}).`
  );
  process.exit(1);
});

// localhost only: the page holds a link token and /exchange spends the secret.
server.listen(3000, 'localhost', () => {
  console.log(`\nOpen http://localhost:3000 in your browser and click "${update ? 'Reconnect' : 'Connect'} ${inst.name}".`);
  if (inst.linkHint && !update) console.log(inst.linkHint);
  console.log('');
});
