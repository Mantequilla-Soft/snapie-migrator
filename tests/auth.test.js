import { describe, expect, it } from 'vitest';
import { CHALLENGE_TTL_MS, SESSION_TTL_MS, createAuth } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { baseEnv } from './helpers/env.js';
import { fakeHive, signWith } from './helpers/hive.js';

const cfg = loadConfig(baseEnv({ HIVE_API_NODES: 'https://node-a.test,https://node-b.test', MIGRATOR_SERVICE_TOKEN: 't'.repeat(40) }));
const accounts = {
  meno: { seeds: ['meno-posting'] },
  stranger: { seeds: ['stranger-posting'] },
  multisig: { seeds: ['ms-1'], threshold: 2, weight: 1 },
};

function setup(over = {}) {
  let t = 1_000_000;
  const hive = fakeHive(accounts, over);
  const auth = createAuth(cfg, { fetchImpl: hive.fetchImpl, now: () => t });
  return { auth, hive, advance: (ms) => { t += ms; } };
}
const login = async (auth, user, seed = `${user}-posting`) => {
  const { message } = auth.challenge(user);
  return auth.verify({ user, message, signature: signWith(seed, message) });
};

describe('Keychain login', () => {
  it('the challenge names this site and the account', () => {
    const { message } = setup().auth.challenge('Meno');
    expect(message).toMatch(/^snapie-migrator:migrator\.test:meno:[A-Za-z0-9_-]+:\d+$/);
  });

  it('works when the public URL has a port (the host then contains a colon)', async () => {
    const withPort = createAuth(loadConfig(baseEnv({ PUBLIC_BASE_URL: 'http://localhost:3020', HIVE_API_NODES: 'https://node-a.test' })), { fetchImpl: fakeHive(accounts).fetchImpl });
    const { message } = withPort.challenge('meno');
    expect(message).toContain('localhost:3020');
    expect(await withPort.verify({ user: 'meno', message, signature: signWith('meno-posting', message) })).toEqual({ user: 'meno', authorized: true });
  });

  it('a posting-key signature of an allowed account → authorized', async () => {
    expect(await login(setup().auth, 'meno')).toEqual({ user: 'meno', authorized: true });
  });

  it('a valid account that is not allowed logs in but is not authorized', async () => {
    expect(await login(setup().auth, 'stranger')).toEqual({ user: 'stranger', authorized: false });
  });

  it('rejects a signature from another key', async () => {
    await expect(login(setup().auth, 'meno', 'someone-else')).rejects.toThrow("not from this account's posting key");
  });

  it('rejects a key that cannot sign alone (multisig posting authority)', async () => {
    await expect(login(setup().auth, 'multisig', 'ms-1')).rejects.toThrow('posting key');
  });

  it('a challenge works once', async () => {
    const { auth } = setup();
    const { message } = auth.challenge('meno');
    const signature = signWith('meno-posting', message);
    await auth.verify({ user: 'meno', message, signature });
    await expect(auth.verify({ user: 'meno', message, signature })).rejects.toThrow('already used');
  });

  it('a challenge expires', async () => {
    const { auth, advance } = setup();
    const { message } = auth.challenge('meno');
    advance(CHALLENGE_TTL_MS + 1);
    await expect(auth.verify({ user: 'meno', message, signature: signWith('meno-posting', message) })).rejects.toThrow('expired');
  });

  it("a challenge can't be used for another account", async () => {
    const { auth } = setup();
    const { message } = auth.challenge('stranger');
    await expect(auth.verify({ user: 'meno', message, signature: signWith('meno-posting', message) })).rejects.toThrow('unknown or already used');
  });

  it('garbage signatures and unknown accounts are refused', async () => {
    const { auth } = setup();
    const a = auth.challenge('meno');
    await expect(auth.verify({ user: 'meno', message: a.message, signature: 'zz' })).rejects.toThrow('not a valid signature');
    const b = auth.challenge('nobody');
    await expect(auth.verify({ user: 'nobody', message: b.message, signature: signWith('x', b.message) })).rejects.toThrow('no such Hive account');
    expect(() => auth.challenge('{"$gt":""}')).toThrow('not a Hive account name');
  });

  it('fails over to the next Hive API node', async () => {
    const { auth, hive } = setup({ failFirst: 1 });
    expect((await login(auth, 'meno')).authorized).toBe(true);
    expect(hive.calls).toEqual(['https://node-a.test', 'https://node-b.test']);
  });
});

describe('sessions', () => {
  it('round-trips, and re-checks the allowed list each time', () => {
    const { auth } = setup();
    expect(auth.session(auth.issue('meno'))).toEqual({ user: 'meno', authorized: true });
    expect(auth.session(auth.issue('stranger'))).toEqual({ user: 'stranger', authorized: false });
  });

  it('rejects tampered, foreign and expired cookies', () => {
    const { auth, advance } = setup();
    const v = auth.issue('stranger');
    const [payload, mac] = v.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'meno', exp: 9e15 })).toString('base64url');
    expect(auth.session(`${forged}.${mac}`)).toBeNull();
    expect(auth.session(`${payload}.x${mac.slice(1)}`)).toBeNull();
    const other = createAuth(loadConfig(baseEnv({ SESSION_SECRET: 'y'.repeat(40) })));
    expect(other.session(v)).toBeNull();
    advance(SESSION_TTL_MS + 1);
    expect(auth.session(v)).toBeNull();
    expect(auth.session(undefined)).toBeNull();
  });

  it('service token: exact match only, and never when none is configured', () => {
    const { auth } = setup();
    expect(auth.serviceOk(`Bearer ${'t'.repeat(40)}`)).toBe(true);
    expect(auth.serviceOk(`Bearer ${'t'.repeat(39)}`)).toBe(false);
    expect(auth.serviceOk('t'.repeat(40))).toBe(false);
    expect(createAuth(loadConfig(baseEnv())).serviceOk('Bearer anything')).toBe(false);
  });
});
