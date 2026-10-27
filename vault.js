// Password gate for the hosted copy (GitHub Pages has no server, so there's nowhere to keep
// a real login). vault.json holds a GitHub token + Gist id, AES-GCM encrypted with a key
// derived from the password; tools/make-vault.mjs creates it. Unlocking decrypts it in the
// browser, and the sink is then saved to that secret Gist. Without vault.json (e.g. any other
// static server) there's no gate and the sink lives in localStorage.
const REMEMBER_KEY = 'sinkful.cloud.v1';

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function decryptVault(vault, password) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64(vault.salt), iterations: vault.iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(vault.iv) }, key, b64(vault.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// Forget this device's unlocked credentials (wrong/revoked token, or "lock").
export function forgetCloud() {
  localStorage.removeItem(REMEMBER_KEY);
}

// Resolves to { token, gistId } once unlocked, or null when this deployment has no vault.
export async function unlockCloud() {
  try {
    const saved = JSON.parse(localStorage.getItem(REMEMBER_KEY));
    if (saved?.token && saved?.gistId) return saved;
  } catch { /* fall through to the gate */ }

  let vault;
  try {
    const res = await fetch('vault.json', { cache: 'no-store' });
    if (!res.ok) return null;
    vault = await res.json();
  } catch { return null; }
  // WebCrypto only exists on https (or localhost).
  if (!window.isSecureContext && location.protocol === 'http:') {
    location.replace(location.href.replace(/^http:/, 'https:'));
    return new Promise(() => {});
  }

  const gate = document.getElementById('gate');
  const form = gate.querySelector('form');
  const input = gate.querySelector('input[type=password]');
  const remember = gate.querySelector('input[type=checkbox]');
  const error = gate.querySelector('.gate-error');
  gate.classList.remove('hidden');
  input.focus();
  return new Promise((resolve) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      form.classList.add('busy');
      error.textContent = '';
      try {
        const creds = await decryptVault(vault, input.value);
        if (remember.checked) localStorage.setItem(REMEMBER_KEY, JSON.stringify(creds));
        gate.classList.add('hidden');
        resolve(creds);
      } catch {
        error.textContent = 'Not quite. Try again?';
        form.classList.remove('shake');
        void form.offsetWidth; // restart the animation
        form.classList.add('shake');
        input.select();
      } finally {
        form.classList.remove('busy');
      }
    });
  });
}
