/**
 * Entry point (pm2 runs this): config → Mongo → S3 → queue → listeners.
 * On SIGTERM/SIGINT: stop listening, put running items back in the queue, close.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { runAny } from './actions.js';
import { createAuth } from './auth.js';
import { ConfigError, loadConfig } from './config.js';
import { DiskBudget } from './disk.js';
import { Queue } from './queue.js';
import { createBucket } from './s3.js';
import { createApp, createServiceApp } from './server.js';
import { Throttle } from './throttle.js';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(1); }
  throw e;
}

fs.mkdirSync(cfg.workDir, { recursive: true });
const mongo = await MongoClient.connect(cfg.mongo.uri, { serverSelectionTimeoutMS: 10_000 });
const db = mongo.db(cfg.mongo.database);
const bucket = createBucket(cfg.s3);
const budget = new DiskBudget({ dir: cfg.workDir, budgetBytes: cfg.diskBudgetBytes, reserveBytes: cfg.diskReserveBytes });
await budget.free();
const throttle = new Throttle(cfg.downloadRateBytesPerSec);
const pipelineDeps = { cfg, db, bucket, budget, throttle };
const queue = new Queue({
  dbPath: path.join(cfg.dataDir, 'migrator.db'), workDir: cfg.workDir, maxConcurrent: cfg.maxConcurrent,
  deps: pipelineDeps, run: runAny,
});
const auth = createAuth(cfg);
const deps = { ...pipelineDeps, queue, auth };

const { requeued } = queue.start();
const server = createApp(deps).listen(cfg.port, () => {
  console.log(`[migrator] ${cfg.publicBaseUrl} on :${cfg.port}, bucket ${cfg.s3.bucket}, ${cfg.maxConcurrent} at a time, allowed: ${cfg.allowedUsers.join(', ')}`);
  if (requeued) console.log(`[migrator] ${requeued} interrupted item(s) queued again`);
});
const service = cfg.serviceToken
  ? createServiceApp(deps).listen(cfg.servicePort, '127.0.0.1', () => console.log(`[migrator] service API on 127.0.0.1:${cfg.servicePort}`))
  : null;

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[migrator] ${signal}: stopping; running items go back to the queue`);
  server.close();
  service?.close();
  server.closeAllConnections?.();
  await queue.stop();
  await mongo.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
