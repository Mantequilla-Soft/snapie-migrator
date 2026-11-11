// A complete, valid environment for loadConfig; tests override single keys.
export const CID = 'QmUaWTmYmQ7NGi7Cq1YndpzjB1UNTmmgnhk1AxDTC8DS2g';
export const CID2 = 'QmSUSaQCXdtaSWdafK6nrkwkv6MQeEbjNSBJ84G3NodKmY';

export const baseEnv = (over = {}) => ({
  PORT: '3020',
  PUBLIC_BASE_URL: 'https://migrator.test',
  SESSION_SECRET: 'x'.repeat(40),
  ALLOWED_USERS: 'meno, CoolMole',
  MONGODB_URI: 'mongodb://localhost:27017',
  S3_ENDPOINT: 'https://s3-gateway.test',
  S3_ACCESS_KEY_ID: 'AKIATEST',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET: 'videos-test',
  S3_CDN_HOST: 'buttercloud.b-cdn.net',
  HOTNODE_GATEWAY: 'https://hotipfs-1.3speak.tv',
  ...over,
});
