import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { baseEnv } from './helpers/env.js';

const problemsOf = (env) => {
  try { loadConfig(env); } catch (e) { if (e instanceof ConfigError) return e.problems; throw e; }
  return [];
};

describe('loadConfig', () => {
  it('loads a complete environment with defaults', () => {
    const c = loadConfig(baseEnv());
    expect(c.allowedUsers).toEqual(['meno', 'coolmole']);
    expect(c.s3).toMatchObject({ bucket: 'videos-test', cdnHost: 'buttercloud.b-cdn.net', directHost: 's3.3speak.tv', region: 'us-east-1' });
    expect(c.sourceGateways).toEqual(['https://hotipfs-1.3speak.tv', 'https://ipfs.3speak.tv', 'https://ipfs-audio.3speak.tv']);
    expect(c.maxConcurrent).toBe(1);
    expect(c.host).toBe('127.0.0.1');
    expect(c.diskBudgetBytes).toBe(20 * 1024 ** 3);
    expect(c.diskReserveBytes).toBe(5 * 1024 ** 3);
    expect(c.serviceToken).toBeNull();
    expect(c.playerBaseUrl).toBeNull();
    expect(Object.isFrozen(c)).toBe(true);
  });

  it('lists every problem at once, not just the first', () => {
    const p = problemsOf({});
    for (const name of ['PUBLIC_BASE_URL', 'SESSION_SECRET', 'MONGODB_URI', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      expect(p).toContain(`${name} is required`);
    }
    expect(p).toContain('ALLOWED_USERS must list at least one Hive account');
  });

  it.each([
    ['S3_BUCKET', 'Videos_Bad', 'would be rejected by the player'],
    ['S3_BUCKET', 'a', 'would be rejected by the player'],
    ['S3_CDN_HOST', 'https://buttercloud.b-cdn.net', 'not a bare host name'],
    ['S3_CDN_HOST', 'localhost', 'not a bare host name'],
    ['S3_DIRECT_HOST', 'other.example.com', 'must be s3.3speak.tv'],
    ['SESSION_SECRET', 'short', 'at least 32 characters'],
    ['ALLOWED_USERS', 'meno,Not A User', 'is not a Hive account name'],
    ['MAX_CONCURRENT', '3', 'MAX_CONCURRENT must be an integer between 1 and 2'],
    ['MAX_CONCURRENT', '0', 'MAX_CONCURRENT must be an integer between 1 and 2'],
    ['DISK_BUDGET_GB', 'lots', 'DISK_BUDGET_GB must be a number'],
    ['DISK_RESERVE_GB', '-1', 'DISK_RESERVE_GB must be a number'],
    ['HOTNODE_GATEWAY', 'https://hotipfs-3speak-1.b-cdn.net', 'not a Bunny zone'],
    ['S3_ENDPOINT', 'http://s3-gateway.test', 'must be https'],
    ['IPFS_GATEWAYS', 'nonsense', 'is not a URL'],
    ['MIGRATOR_SERVICE_TOKEN', 'tooshort', 'at least 32 characters when set'],
  ])('rejects %s=%s', (name, value, message) => {
    expect(problemsOf(baseEnv({ [name]: value })).join('\n')).toContain(message);
  });

  it('allows http only for localhost (local MinIO in development)', () => {
    expect(loadConfig(baseEnv({ S3_ENDPOINT: 'http://localhost:9000' })).s3.endpoint).toBe('http://localhost:9000');
  });

  it('strips trailing slashes from base URLs', () => {
    const c = loadConfig(baseEnv({ PUBLIC_BASE_URL: 'https://migrator.test/', IPFS_GATEWAYS: 'https://a.test/, https://b.test//' }));
    expect(c.publicBaseUrl).toBe('https://migrator.test');
    expect(c.sourceGateways).toEqual(['https://hotipfs-1.3speak.tv', 'https://a.test', 'https://b.test']);
  });

  it('works without a hotnode gateway', () => {
    expect(loadConfig(baseEnv({ HOTNODE_GATEWAY: '' })).sourceGateways[0]).toBe('https://ipfs.3speak.tv');
  });

  it('turns the rate limit into bytes per second', () => {
    expect(loadConfig(baseEnv({ DOWNLOAD_RATE_LIMIT_MBPS: '80' })).downloadRateBytesPerSec).toBe(10_000_000);
  });
});
