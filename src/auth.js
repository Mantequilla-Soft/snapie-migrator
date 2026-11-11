/**
 * Login with Hive Keychain (SPEC §9).
 *
 *  1. GET challenge: a one-time string naming this site, the account and a nonce.
 *  2. Keychain signs it with the account's POSTING key (requestSignBuffer signs the
 *     SHA-256 of the string).
 *  3. We recover the public key from the signature and require it to be one of the
 *     account's posting keys on chain, with enough weight on its own.
 *  4. A signed session cookie follows. `authorized` = the account is in ALLOWED_USERS;
 *     everyone else is logged in but can't act.
 *
 * The service token (the hotnode, phase 2) is checked separately and only on the
 * loopback-only service listener (see server.js).
 */
import crypto from 'node:crypto';
import { Signature, cryptoUtils } from '@hiveio/dhive';
import { HIVE_USER_RE } from './config.js';

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 3600_000;
export const COOKIE = 'migrator_session';
const MAX_PENDING = 1000;

const b64u = (b) => Buffer.from(b).toString('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Ask the Hive API nodes in turn for the account's posting authority. */
export async function fetchPostingAuthority(user, nodes, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const errors = [];
  for (const node of nodes) {
    try {
      const res = await fetchImpl(node, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'condenser_api.get_accounts', params: [[user]] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error.message ?? 'rpc error');
      const acct = body.result?.[0];
      if (!acct) return null;   // a definite answer: no such account
      return acct.posting;
    } catch (e) {
      errors.push(`${node}: ${e.message}`);
    }
  }
  throw new Error(`no Hive API node answered (${errors.join('; ')})`);
}

export function createAuth(cfg, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const pending = new Map();   // the exact challenge string → { user, exp }
  const host = new URL(cfg.publicBaseUrl).host;
  const allowed = new Set(cfg.allowedUsers);
  const sign = (payload) => crypto.createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url');

  const prune = () => { const t = now(); for (const [k, v] of pending) if (v.exp <= t) pending.delete(k); };

  return {
    challenge(rawUser) {
      const user = String(rawUser ?? '').trim().toLowerCase();
      if (!HIVE_USER_RE.test(user)) throw new TypeError('not a Hive account name');
      prune();
      if (pending.size >= MAX_PENDING) throw new Error('too many pending logins, try again in a few minutes');
      const nonce = b64u(crypto.randomBytes(18));
      const message = `snapie-migrator:${host}:${user}:${nonce}:${now()}`;
      pending.set(message, { user, exp: now() + CHALLENGE_TTL_MS });
      return { user, message, expiresInMs: CHALLENGE_TTL_MS };
    },

    /** → { user, authorized } or throws with the reason. The challenge is burnt either way. */
    async verify({ user: rawUser, message, signature }) {
      const user = String(rawUser ?? '').trim().toLowerCase();
      // Looked up by the whole string: the host may contain ':' (a port), so no parsing.
      const entry = pending.get(String(message ?? ''));
      pending.delete(String(message ?? ''));
      if (!entry || entry.user !== user) throw new Error('unknown or already used challenge');
      if (entry.exp <= now()) throw new Error('challenge expired');

      let key;
      try {
        key = Signature.fromString(String(signature)).recover(cryptoUtils.sha256(message)).toString();
      } catch (e) {
        throw new Error('not a valid signature', { cause: e });
      }
      const posting = await fetchPostingAuthority(user, cfg.hiveApiNodes, { fetchImpl });
      if (!posting) throw new Error('no such Hive account');
      // The key must be able to sign alone: weight ≥ threshold.
      const ok = (posting.key_auths ?? []).some(([k, w]) => k === key && w >= posting.weight_threshold);
      if (!ok) throw new Error('the signature is not from this account\'s posting key');
      return { user, authorized: allowed.has(user) };
    },

    /** Cookie value for a verified login. */
    issue(user) {
      const payload = b64u(JSON.stringify({ u: user, exp: now() + SESSION_TTL_MS }));
      return `${payload}.${sign(payload)}`;
    },

    /** → { user, authorized } from a cookie value, or null. ALLOWED_USERS is checked on every request. */
    session(value) {
      const [payload, mac] = String(value ?? '').split('.');
      if (!payload || !mac || !safeEqual(mac, sign(payload))) return null;
      let data;
      try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (_) { return null; }
      if (!data?.u || !(data.exp > now())) return null;
      return { user: data.u, authorized: allowed.has(data.u) };
    },

    serviceOk(header) {
      if (!cfg.serviceToken) return false;
      const m = String(header ?? '').match(/^Bearer (.+)$/);
      return !!m && safeEqual(m[1], cfg.serviceToken);
    },

    pendingCount: () => pending.size,
  };
}
