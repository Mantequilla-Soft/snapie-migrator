# Snapie Migrator: build plan

Spec: ../SPEC.md. Rule: **a video is "done" only when the CAR is verified, the S3 checks pass and the conditional Mongo update matched (plus the player check, when configured). Otherwise it stays as it was and the failure is shown in red.**

## Phase 0: approval
- [x] User approves SPEC.md (and answers §15 open items): keep the CAR, the name stays, hotnode = hotipfs-1

## Phase 1: foundations
- [x] Scaffold: package.json (ESM, Node 20), eslint, vitest, .env.example, .gitignore, ecosystem.config.cjs
- [x] config.js: env parse + validation with the player's S3_BUCKET / S3_CDN_HOST regexes
- [x] playerContract.js: field set, s3_url / car url builders, conditional filters (+ tests)
- [x] catalog.js: channel listing for both collections + eligibility (+ tests for every status)

## Phase 2: the core pipeline
- [x] car.js: CAR download with gateway fallback + timeouts + byte progress + disk budget abort
- [x] car.js: verify (root, block hashes, full UnixFS walk), file list with SHA-256 / MD5 (+ fixtures: good, truncated, tampered, wrong root, missing block)
- [x] s3.js: streaming put with content-types and cache headers, skip-if-identical, list / head / ETag check, HTTPS read-back via the zone and the direct host
- [x] pipeline.js: stages 1–9, cleanup on every exit path
- [x] queue.js: SQLite schema, concurrency limit (hard limit 2), resume on boot, cancel, retries
- [x] Integration test: in-memory Mongo + local S3 + stub gateway, kill and resume at each stage

- [x] scripts/s3-smoke.js (`npm run smoke:s3`) and scripts/car-check.js (`npm run check:car -- <cid>`)
- [ ] **On the VPS: `npm run smoke:s3` must pass before Phase 4** (real Buttercloud gateway, zone, CORS)

## Phase 3: auth + API + UI
- [ ] auth.js: challenge / verify with dhive, allowlist, signed cookie, service token from loopback only (+ negative tests)
- [ ] server.js: routes from §8, server-side auth on every route that changes something, SSE
- [ ] Dry run (§5), Check IPFS + Revert (§6)
- [ ] UI: login, channel table + select all, dry-run → confirm, progress bars, history, disk meter

## Phase 4: deploy + acceptance
- [ ] README + DEPLOYMENT (pm2, nginx, env)
- [ ] VPS: dry run on coolmole → migrate 1 → check S3 playback in DevTools → Check IPFS → Revert → migrate the whole channel

## Review

### Phase 1 (2026-11-11)
- `npm test`: 80 passed. `npm run lint`: clean.
- The player cross-check (tests/playerContract.test.js) loads SnapieVideoPlayer/hlsGateways.js
  from next door and runs our s3_url through the player's own `s3Parts`. Mutation check:
  dropping the host check in our `parseS3Url` fails 2 tests, one of them the cross-check.
  It is skipped when the player repo is not next to this one (e.g. on the VPS).
- The tests caught a bug: DISK_BUDGET_GB / DISK_RESERVE_GB were read after the
  problems check, so a bad value was quietly replaced with the default. Now every
  value is read above the check (with a comment marking the line).
- New rule found in the player: a legacy `video_v2` that is a bare CID or an https URL
  can't be served from S3 (`storagePlan` reads the CID from `ipfs://` only), so those
  videos are ineligible, with that reason shown. Added to SPEC §3.
- Not done yet: anything that touches S3, IPFS or a real Mongo (Phase 2).

### Phase 2 (2026-11-11)
- `npm test`: 141 passed. `npm run lint`: clean.
- Modules: car.js (download with gateway fallback, idle timeout, disk budget,
  throttle; verify root, every block hash, full walk), s3.js (buffered PUT/multipart
  with Content-MD5, ETags predicted locally), readback.js (HTTPS playback check via
  the zone and the direct host), pipeline.js (stages 1–9, cleanup on every way out),
  queue.js (SQLite, ≤2 concurrent, one CID at a time, retry/backoff, cancel, resume),
  disk.js, throttle.js.
- Tests: real CARs built in tests (good, truncated, tampered, wrong root, missing
  block, not a directory, garbage); a fake S3 server driven by the real AWS SDK
  (Content-MD5, multipart ETags, paged listing, fault switches); the pipeline end to
  end on in-memory Mongo.
- Mutation checks: switching off each safety layer fails at least one test:
  block hashes, the S3 response ETag, the per-object listing check, the object count
  check, the HTTPS read-back, the conditional Mongo filter, the local cleanup. The
  listing checks first survived (the upload ETag catches the same corruption
  sooner), so I added tests where an object is damaged, lost or added *after*
  upload.
- Bugs the tests caught: the CAR verifier's progress overwrote the pipeline's stage
  name; the disk budget counted the next write twice when it didn't re-measure.
- Live: `check:car` downloads and verifies QmUaWTmY…DS2g from hotipfs-1 directly
  (2,282,867 bytes, 3.4 s, 16 blocks, 4 files).
- Risk: the local buttercloud checkout buffers bodies, forwards with a 30 s timeout,
  and has no raw body parser configured. I can't tell whether production matches,
  hence `smoke:s3`, which must pass on the VPS before any real migration.
