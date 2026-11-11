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
- [ ] car.js: CAR download with gateway fallback + timeouts + byte progress + disk budget abort
- [ ] car.js: verify (root, block hashes, full UnixFS walk), file list with SHA-256 / MD5 (+ fixtures: good, truncated, tampered, wrong root, missing block)
- [ ] s3.js: streaming put with content-types and cache headers, skip-if-identical, list / head / ETag check, HTTPS read-back via the zone and the direct host
- [ ] pipeline.js: stages 1–9, cleanup on every exit path
- [ ] queue.js: SQLite schema, concurrency limit (hard limit 2), resume on boot, cancel, retries
- [ ] Integration test: in-memory Mongo + local S3 + stub gateway, kill and resume at each stage

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
