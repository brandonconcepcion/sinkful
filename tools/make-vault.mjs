#!/usr/bin/env node
// Sets up saving for the hosted copy: creates a secret Gist holding your sink (seeded from
// data/sinkful.json) and writes vault.json, which holds the Gist id + token encrypted with
// your password. Commit vault.json; the password and token never leave this machine unencrypted.
//
//   node tools/make-vault.mjs                 # new Gist
//   node tools/make-vault.mjs --gist <id>     # keep an existing Gist (new password or token)
//
// The token should be a fine-grained personal access token with only
// "Account permissions > Gists: Read and write": https://github.com/settings/personal-access-tokens/new
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITERATIONS = 600_000;

function ask(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    if (hidden) process.stdout.write('\n');
    resolve(answer.trim());
  }));
}

async function github(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
async function encrypt(obj, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(data)) };
}

const gistFlag = process.argv.indexOf('--gist');
let gistId = gistFlag > -1 ? process.argv[gistFlag + 1] : null;

const token = await ask('GitHub token (Gists read/write): ', { hidden: true });
if (!token) throw new Error('No token given');

if (gistId) {
  await github(`/gists/${gistId}`, token);
  console.log(`Using existing Gist ${gistId}`);
} else {
  let content;
  try {
    content = await readFile(join(ROOT, 'data', 'sinkful.json'), 'utf8');
    console.log('Seeding the Gist with your current sink from data/sinkful.json');
  } catch {
    content = JSON.stringify({ tasks: null, rev: 0 });
  }
  const gist = await github('/gists', token, {
    method: 'POST',
    body: JSON.stringify({ description: 'Sinkful save data', public: false, files: { 'sinkful.json': { content } } }),
  });
  gistId = gist.id;
  console.log(`Created secret Gist: ${gist.html_url}`);
}

let password;
for (;;) {
  password = await ask('Choose a password for the site: ', { hidden: true });
  if (password.length < 10) { console.log('Use at least 10 characters (vault.json is public, so length is what keeps it safe).'); continue; }
  if (await ask('Type it again: ', { hidden: true }) === password) break;
  console.log("Those didn't match, try again.");
}

const vault = await encrypt({ token, gistId }, password);
await writeFile(join(ROOT, 'vault.json'), `${JSON.stringify(vault, null, 2)}\n`);
console.log('Wrote vault.json. Commit and push it to update the site.');
