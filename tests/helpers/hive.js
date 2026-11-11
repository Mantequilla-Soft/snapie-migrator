// A fake Hive API for login tests: accounts with posting keys from seeds.
import { PrivateKey, cryptoUtils } from '@hiveio/dhive';

export const keyOf = (seed) => PrivateKey.fromSeed(seed);
export const signWith = (seed, message) => keyOf(seed).sign(cryptoUtils.sha256(message)).toString();

/** accounts: { name: { seeds: [...], threshold?, weight? } } → fetchImpl for condenser_api.get_accounts */
export function fakeHive(accounts, { failFirst = 0 } = {}) {
  let failures = failFirst;
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (failures > 0) { failures--; return new Response('bad gateway', { status: 502 }); }
    const [name] = JSON.parse(opts.body).params[0];
    const a = accounts[name];
    const result = a ? [{
      name,
      posting: {
        weight_threshold: a.threshold ?? 1,
        account_auths: [],
        key_auths: a.seeds.map((s) => [keyOf(s).createPublic().toString(), a.weight ?? 1]),
      },
    }] : [];
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  };
  return { fetchImpl, calls };
}
