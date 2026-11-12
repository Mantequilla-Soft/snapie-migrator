/**
 * Configuration from the environment, checked once at boot.
 *
 * A wrong value here can make every migration useless (the player would ignore our
 * s3_url and keep playing from IPFS), so a bad config refuses to start with the full
 * list of problems instead of running half-configured.
 */

// Copied from SnapieVideoPlayer/hlsGateways.js (S3_BUCKET / S3_CDN_HOST checks). The
// player turns S3 playback off when these fail, so we must never write URLs it rejects.
export const PLAYER_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,62}$/;
export const PLAYER_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
// The player's direct S3 host is a constant, not configurable there.
export const PLAYER_S3_DIRECT_HOST = 's3.3speak.tv';
// The hotnode's Bunny zone, the player's first gateway (HLS_GATEWAYS[0] in its server.js).
export const PLAYER_HOT_ZONE = 'hotipfs-3speak-1.b-cdn.net';

// Hive account names: 3–16 chars, dot-separated segments, each starting with a letter.
export const HIVE_USER_RE = /^(?=.{3,16}$)[a-z][a-z0-9-]*[a-z0-9](\.[a-z][a-z0-9-]*[a-z0-9])*$/;

export const MAX_CONCURRENT_LIMIT = 2;

/** `"01-09"` (UTC, end exclusive, may wrap past midnight) → { start, end }, or null for any time. */
export function parseHours(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new TypeError(`"${s}" is not HH-HH`);
  const [start, end] = [Number(m[1]), Number(m[2])];
  if (start > 23 || end > 24 || start === end % 24) throw new TypeError(`"${s}" is not a window of UTC hours`);
  return { start, end: end % 24 };
}

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const GB = 1024 ** 3;

export function loadConfig(env = process.env) {
  const problems = [];
  const str = (name, fallback = '') => String(env[name] ?? fallback).trim();
  const required = (name) => {
    const v = str(name);
    if (!v) problems.push(`${name} is required`);
    return v;
  };
  const num = (name, fallback, { min = 0, max = Infinity, int = false } = {}) => {
    const raw = str(name);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
      problems.push(`${name} must be ${int ? 'an integer' : 'a number'} between ${min} and ${max} (got "${raw}")`);
      return fallback;
    }
    return n;
  };
  const httpsBase = (name, value) => {
    let u;
    try { u = new URL(value); } catch (_) { problems.push(`${name}: "${value}" is not a URL`); return null; }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
      problems.push(`${name}: "${value}" must be https`);
      return null;
    }
    return value.replace(/\/+$/, '');
  };
  const urlList = (name, fallback) =>
    str(name, fallback).split(',').map((s) => s.trim()).filter(Boolean)
      .map((v) => httpsBase(name, v)).filter(Boolean);

  // --- web / auth ---
  const port = num('PORT', 3020, { min: 1, max: 65535, int: true });
  // Behind nginx on the same machine: listen on loopback only, so nothing reaches the
  // app around nginx. Set HOST=0.0.0.0 only without a proxy in front.
  const host = str('HOST', '127.0.0.1');
  const publicBaseRaw = required('PUBLIC_BASE_URL');
  const publicBaseUrl = publicBaseRaw ? httpsBase('PUBLIC_BASE_URL', publicBaseRaw) : null;
  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret && sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');

  const allowedUsers = str('ALLOWED_USERS').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
  if (!allowedUsers.length) problems.push('ALLOWED_USERS must list at least one Hive account');
  for (const u of allowedUsers) if (!HIVE_USER_RE.test(u)) problems.push(`ALLOWED_USERS: "${u}" is not a Hive account name`);

  const serviceToken = str('MIGRATOR_SERVICE_TOKEN');
  if (serviceToken && serviceToken.length < 32) problems.push('MIGRATOR_SERVICE_TOKEN must be at least 32 characters when set');
  // The service API listens on 127.0.0.1 only, on its own port that nginx never proxies.
  const servicePort = num('SERVICE_PORT', 3021, { min: 1, max: 65535, int: true });
  if (serviceToken && servicePort === port) problems.push('SERVICE_PORT must differ from PORT');

  // --- mongo ---
  const mongo = {
    uri: required('MONGODB_URI'),
    database: str('MONGODB_DATABASE', 'threespeak'),
    legacyCollection: str('MONGODB_COLLECTION_LEGACY', 'videos'),
    embedCollection: str('MONGODB_COLLECTION_NEW', 'embed-video'),
  };

  // --- s3 ---
  const bucket = required('S3_BUCKET');
  if (bucket && !PLAYER_BUCKET_RE.test(bucket)) problems.push(`S3_BUCKET "${bucket}" would be rejected by the player`);
  const cdnHost = str('S3_CDN_HOST', 'buttercloud.b-cdn.net').toLowerCase();
  if (!PLAYER_HOST_RE.test(cdnHost)) problems.push(`S3_CDN_HOST "${cdnHost}" is not a bare host name (the player would turn S3 off)`);
  const directHost = str('S3_DIRECT_HOST', PLAYER_S3_DIRECT_HOST).toLowerCase();
  if (directHost !== PLAYER_S3_DIRECT_HOST) problems.push(`S3_DIRECT_HOST must be ${PLAYER_S3_DIRECT_HOST}: the player only accepts that direct host`);
  const endpointRaw = required('S3_ENDPOINT');
  const s3 = {
    endpoint: endpointRaw ? httpsBase('S3_ENDPOINT', endpointRaw) : null,
    region: str('S3_REGION', 'us-east-1'),
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    bucket,
    cdnHost,
    directHost,
  };

  // --- sources / checks ---
  // This server's own IPFS gateway, tried before anything else: on the supernode a
  // migration then reads from local disk instead of the internet (two instances, see
  // DEPLOYMENT.md). It must answer the trustless CAR form (Accept: application/vnd.ipld.car).
  const localRaw = str('LOCAL_GATEWAY');
  const localGateway = localRaw ? httpsBase('LOCAL_GATEWAY', localRaw) : null;
  if (localGateway && /\.b-cdn\.net$/i.test(new URL(localGateway).hostname)) {
    problems.push('LOCAL_GATEWAY must be an IPFS node, not a Bunny zone (Bunny returns an empty CAR)');
  }
  const hotnodeRaw = str('HOTNODE_GATEWAY');
  const hotnodeGateway = hotnodeRaw ? httpsBase('HOTNODE_GATEWAY', hotnodeRaw) : null;
  if (hotnodeGateway && /\.b-cdn\.net$/i.test(new URL(hotnodeGateway).hostname)) {
    problems.push('HOTNODE_GATEWAY must be the hotnode itself, not a Bunny zone (Bunny returns an empty CAR)');
  }
  const ipfsGateways = urlList('IPFS_GATEWAYS', 'https://ipfs.3speak.tv,https://ipfs-audio.3speak.tv');
  if (!ipfsGateways.length) problems.push('IPFS_GATEWAYS must list at least one gateway');
  const playerRaw = str('PLAYER_BASE_URL');
  const playerBaseUrl = playerRaw ? httpsBase('PLAYER_BASE_URL', playerRaw) : null;
  const hiveApiNodes = urlList('HIVE_API_NODES', 'https://api.hive.blog,https://api.deathwing.me,https://anyx.io');
  if (!hiveApiNodes.length) problems.push('HIVE_API_NODES must list at least one node');

  // --- disk / pace ---
  const maxConcurrent = num('MAX_CONCURRENT', 1, { min: 1, max: MAX_CONCURRENT_LIMIT, int: true });
  const rateMbps = num('DOWNLOAD_RATE_LIMIT_MBPS', 0, { min: 0 });
  const diskBudgetGb = num('DISK_BUDGET_GB', 20, { min: 1 });
  const diskReserveGb = num('DISK_RESERVE_GB', 5, { min: 0 });

  // --- backlog (issue #9) ---
  const backlogDailyGb = num('BACKLOG_DAILY_GB', 50, { min: 0 });   // decimal GB (1e9), as the page shows it
  const backlogMinAgeDays = num('BACKLOG_MIN_AGE_DAYS', 7, { min: 0, max: 3650 });
  let backlogHours = null;
  try { backlogHours = parseHours(str('BACKLOG_HOURS')); } catch (e) { problems.push(`BACKLOG_HOURS: ${e.message} (e.g. 01-09, in UTC)`); }

  // Every num()/required() call must sit above this line, or its problem is lost.
  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    port,
    host,
    publicBaseUrl,
    sessionSecret,
    allowedUsers: Object.freeze(allowedUsers),
    serviceToken: serviceToken || null,
    servicePort,
    mongo: Object.freeze(mongo),
    s3: Object.freeze(s3),
    localGateway,
    hotnodeGateway,
    // The permanent IPFS nodes (no hotnode): "is this CID live?" is asked of these.
    ipfsGateways: Object.freeze(ipfsGateways),
    // Download order: this server's own node, then the hotnode (videos still hot), then
    // the supernode chain. A gateway listed twice is tried once.
    sourceGateways: Object.freeze([...new Set([localGateway, hotnodeGateway, ...ipfsGateways].filter(Boolean))]),
    playerBaseUrl,
    hiveApiNodes: Object.freeze(hiveApiNodes),
    workDir: str('WORK_DIR', './work'),
    dataDir: str('DATA_DIR', './data'),
    diskBudgetBytes: diskBudgetGb * GB,
    diskReserveBytes: diskReserveGb * GB,
    maxConcurrent,
    downloadRateBytesPerSec: rateMbps ? Math.floor((rateMbps * 1e6) / 8) : 0,
    backlog: Object.freeze({ dailyBytes: backlogDailyGb * 1e9, hours: backlogHours, minAgeDays: backlogMinAgeDays }),
  });
}
