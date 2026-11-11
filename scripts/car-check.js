#!/usr/bin/env node
/**
 * Download one CID's CAR from the configured gateways and verify it, without touching
 * S3 or Mongo. Shows which gateway served it and what is inside.
 *   npm run check:car -- <cid>
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { downloadCar, openVerifiedCar } from '../src/car.js';
import { loadConfig } from '../src/config.js';
import { DiskBudget } from '../src/disk.js';

const cid = process.argv[2];
if (!cid) { console.error('usage: npm run check:car -- <cid>'); process.exit(2); }
const cfg = loadConfig();
fs.mkdirSync(cfg.workDir, { recursive: true });
const dest = path.join(cfg.workDir, `check-${process.pid}.car`);
const budget = new DiskBudget({ dir: cfg.workDir, budgetBytes: cfg.diskBudgetBytes, reserveBytes: cfg.diskReserveBytes });
const t0 = Date.now();
try {
  await budget.assertCanStart();
  // Same as a migration: each gateway's CAR is verified before it is accepted.
  const dl = await downloadCar({ cid, gateways: cfg.sourceGateways, dest, budget, verify: (p) => openVerifiedCar(p, cid) });
  for (const a of dl.attempts) console.log(`skipped ${a.gateway}: ${a.error}`);
  console.log(`downloaded ${dl.bytes} bytes from ${dl.gateway} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const car = dl.verified;
  console.log(`verified: root ok, ${car.blocks} blocks hash-checked, ${car.files.length} files, ${car.bytes} bytes`);
  for (const f of car.files) console.log(`  ${f.path}  ${f.size}`);
  await car.close();
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(dest, { force: true });
}
