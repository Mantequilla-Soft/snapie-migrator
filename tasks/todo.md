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
- [x] auth.js: challenge / verify with dhive, allowlist, signed cookie, service token from loopback only (+ negative tests)
- [x] server.js: routes from §8, server-side auth on every route that changes something, SSE
- [x] Dry run (§5), Check IPFS + Revert (§6)
- [x] UI: login, channel table + select all, dry-run → confirm, progress bars, history, disk meter

## Phase 4: deploy + acceptance
- [x] README + DEPLOYMENT (pm2, nginx, env)
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

### Phase 3 (2026-11-11)
- `npm test`: 184 passed. `npm run lint`: clean.
- auth.js: Keychain challenge/verify (posting key, enough weight alone, Hive API
  failover), HMAC session cookie (HttpOnly, Secure, SameSite=Strict, 12 h), and the
  allowed list checked on every request. server.js: open read routes, allowed-only
  actions, JSON + same-origin for every request that changes something, SSE.
  actions.js: Check IPFS and Revert as queue items. dryRun.js. public/: the page.
- Design changes from the spec (SPEC updated): the service API gets its own
  127.0.0.1 listener (behind a local nginx every request comes from 127.0.0.1);
  Check IPFS and Revert run as queue jobs.
- Mutation checks: switching off any of these fails a test: the loopback check (tested
  over a real connection from the LAN address), the allowed list, the origin check,
  the posting-key check, burning the challenge, the liveness check before revert.
- Browser run (harness: in-memory Mongo, fake S3, local gateway serving the real CAR
  of QmUaWTmY…, a stand-in for the Keychain extension): login, dry run, migrating 2 videos
  that share a CID (the second skipped all 5 uploads), revert (the document back to
  its 8 original fields, S3 untouched), the view-only account (every action disabled
  with the reason), phone width with no sideways scroll.
- Bugs found in the browser run: login failed whenever PUBLIC_BASE_URL had a port
  (the challenge was split on ':'), now looked up by the whole string with a
  test; the session block showed while logged out (`display:flex` beat `hidden`);
  `confirm()` replaced by the page's own dialog; the disk meter only updated every
  15 s.
- A wrong lead, for the record: the stale IDs in one run came from my navigation
  (only the #hash changed, so the page never reloaded), not from caching. `no-store`
  on /api stays anyway: it is live state.
- Not done: nothing has touched the real Buttercloud, Mongo or Keychain yet (Phase 4).

### Phase 4, local part (2026-11-11)
- README.md and DEPLOYMENT.md (setup, .env, nginx with an unbuffered SSE location,
  pm2, a step-by-step first run on coolmole, day-to-day operations, updating).
- The app now listens on 127.0.0.1 by default (`HOST`), so only nginx reaches it;
  pm2 starts in the project folder (`cwd`); Node >= 20.11 (`import.meta.dirname`) (WRONG: see the CI/CD entry, it is 22.12).
- `src/index.js` booted for real (it had only been exercised through the harness):
  both listeners answer, SIGTERM exits cleanly in 19 ms and releases the ports, and a
  bad .env is refused with every problem listed (exit 1).
- I checked the guide's claims against the code and corrected two: changing
  ALLOWED_USERS needs a restart; in DevTools the S3 zone shows up inside /hls?u=.
- Left for the VPS (needs the real credentials): smoke:s3, check:car, a real
  Keychain login, the coolmole run (DEPLOYMENT.md section 5).

### CI/CD (2026-11-11)
- ci.yml (PRs, and called by deploy): lint + tests on Node 20 and 22, with the player
  checked out so the drift test runs (it fails, not skips, if the player is missing);
  shellcheck of deploy.sh; npm audit (prod deps, high+).
- deploy.yml (push to master / by hand): CI first, then SSH → scripts/deploy.sh taken
  from the deployed commit. No cancelling halfway; `production` environment.
- deploy.sh: refuses without .env or tools on PATH (loads nvm); npm ci --omit=dev,
  pm2 startOrRestart; healthy = /api/status reports the new SHA; otherwise rolls back
  to the previous commit and exits 1.
- /api/status now reports `version` (the running commit).
- Simulated on a throwaway clone with stub pm2/npm and a fake app: a good deploy is
  live; a commit that crashes on boot rolls back by itself (exit 1); a pm2 that
  doesn't restart is caught by the version check; a missing .env or tool exits 2
  with the reason.
- Not verified here: shellcheck and actionlint aren't installed locally. They run on
  GitHub on the first PR.
- Audit: 3 low advisories (elliptic via dhive, no fix upstream; it's about signing,
  and we only verify). Documented in DEPLOYMENT.md.
- First GitHub run: Node 22 green; Node 20 segfaulted in the two SQLite test files.
  better-sqlite3 13 requires Node >= 22 (vitest 5 needs 22.12+ too). I had set
  engines to >=20.11 without checking the dependencies' own engines. Fixed: engines
  >=22.12, CI on 22 and 24, deploy.sh refuses an older Node, docs corrected. The
  deploy was skipped because CI failed, as designed.
- Ruleset not created: the org's plan doesn't allow branch rules on private repos
  (HTTP 403).


## Backlog (issue #9, 2026-11-12)
- [x] queue.js: `priority` column (migrated in place on an existing db), ORDER BY priority, id; enqueue({ priority, jobId }) appends to a job
- [x] backlog.js: tables (backlog_channels, backlog_videos, settings), add / list / feed / settle / pause / remove / retry, rolling 24 h cap, hours window, later retries (6 h, 24 h), pause after 5 failures in a row, catch-up on boot
- [x] config.js: BACKLOG_DAILY_GB, BACKLOG_HOURS, BACKLOG_MIN_AGE_DAYS
- [x] server.js: /api/backlog routes + SSE "backlog" event; index.js wiring
- [x] UI: Backlog section, add form, pause/resume, channel table, channel dialog
- [x] tests: backlog.test.js (real Queue + fake run), server routes, config
- [x] docs: SPEC §16, README, DEPLOYMENT, .env.example
- [x] end to end: local run against real Mongo/S3 with a tiny channel list, in the browser

### Review (2026-11-12)
- 232 tests (20 new backlog/priority tests, 3 server, 1 config). Mutation check: ordering by id
  instead of priority fails 2 tests; not resetting the failure streak fails 1.
- Browser run on the harness (real app, pipeline and queue; in-memory Mongo, fake S3,
  local gateway). The run found and fixed:
  - a wrong harness CAR made every video fail verification. That showed the
    5-in-a-row auto-pause working, with the reason on the page;
  - a channel whose videos all failed read "Done": now "Done, N failed" in red;
  - the daily cap read "53.69 GB" for 50 (GiB vs the page's GB): the cap is now decimal GB;
  - the wait reason repeated the numbers ("0.0 GB … cap 0 GB"): now plain words;
  - "null" printed in the channel dialog, and in the existing item dialog
    (replaceChildren turns null into text): children are filtered;
  - at 390px the backlog table squeezed into the 34px checkbox column of the shared
    mobile rule: overridden;
  - "Paused: paused by @meno": now "Paused by @meno".
- Copies checked in the harness: Mongo has `archived` + `s3_*`, `s3_migrated_by` is
  the account that added the channel, and the objects are in the fake S3.
- Not done here: a run on the real VPS (needs the deploy first).
