# Snapie Migrator — Spec

An internal web app that copies a Hive channel's 3Speak videos from IPFS to the
Buttercloud S3 bucket. It then adds fields to their Mongo entries so that
SnapieVideoPlayer plays them from S3. It runs on a VPS (possibly the hotnode
server) under pm2. The page is public, but only Hive accounts listed in `.env`
can act, after logging in with Hive Keychain.

**Why:** the IPFS repos can't scale any more. Before any of them can be retired,
the content must be safe in S3, and it must still be possible to bring it back
on IPFS later.

**Scope:** the migrator copies to S3 and updates Mongo. It never unpins,
deletes from IPFS, deletes from S3, or changes an existing Mongo field.

---

## 1. What the player needs (the contract)

Source: `SnapieVideoPlayer/server.js` (`storagePlan`, `getVideoUrlsFor*Status`)
and `hlsGateways.js` (`s3Parts`, `s3Url`).

### Where the CID comes from

| Collection | Ready when | Manifest |
|---|---|---|
| `videos` (legacy, `MONGODB_COLLECTION_LEGACY`) | `status` ∈ `published`, `publish_later`, `publish_manual`, `scheduled` | `video_v2` = `ipfs://<cid>/<path>` (usually `manifest.m3u8`) |
| `embed-video` (`MONGODB_COLLECTION_NEW`) | `status` = `published`, and not an expired story | `ipfs://<manifest_cid>/manifest.m3u8` |

Channel lookup: `{ owner: <username> }` in both collections.

### How the player picks a source

| `storage_state` | `s3_url` | Player plays from |
|---|---|---|
| absent | — | IPFS chain as today (hot CDN → IPFS CDN → supernode → ipfs-audio) |
| `hot` | absent | same as above |
| `hot` | valid | IPFS chain, with S3 as the backup |
| `archived` / `promoting` | valid | **S3 Bunny zone → s3.3speak.tv → IPFS** |
| anything | invalid | IPFS, with a warning in the player log |

A **valid** `s3_url` is `https://<S3_CDN_HOST or s3.3speak.tv>/<S3_BUCKET>/<cid>/<file>`.
The first path segment after the bucket must be the video's own CID. The player
builds every other S3 URL from that CID path. So the objects must sit at
`<bucket>/<cid>/<same relative path as on IPFS>`.

IPFS stays the last fallback even for `archived` videos. That is why revert
(§6) first checks that the CID is actually live.

### Fields the migrator writes (added only, never overwritten)

```js
storage_state:   'archived',            // 'hot' when the hotnode calls with mode=hot (§8)
s3_url:          'https://<S3_CDN_HOST>/<S3_BUCKET>/<cid>/manifest.m3u8',
s3_car_url:      'https://s3.3speak.tv/<S3_BUCKET>/car/<cid>.car',
s3_bytes:        <total bytes of the files in the directory>,
s3_files:        <number of files>,
s3_migrated_at:  <Date>,
s3_migrated_by:  '<hive username>' | 'service:hotnode',
```

`video_v2`, `manifest_cid`, `status` and every other existing field are never
touched. Older apps keep working exactly as before.

`S3_BUCKET` and `S3_CDN_HOST` must be the same values the player uses. On boot,
the migrator checks them with the same regexes the player uses and refuses to
start if they fail.

---

## 2. Keeping the CID identical (the CAR copy)

To bring a video back on IPFS with **the same CID** (people may be pinning it
too), a plain copy of the files is not enough. `ipfs add` only gives the same
CID with the same chunker, CID version, raw-leaves and layout settings, and old
3Speak uploads used several different ones. So the migrator stores two copies:

1. **The CAR export** of the whole DAG:
   `GET <gateway>/ipfs/<cid>/` with `Accept: application/vnd.ipld.car` and
   **no query string**. The hotnode's nginx 302-redirects `?format=car` and the
   bare `/ipfs/<cid>`, but serves the header form. Checked on 2026-11-11 with
   `QmUaWTmY…DS2g` on hotipfs-1 and the supernode: the same 2,282,867 bytes
   from both, root = CID, 16/16 block hashes OK, all 4 files read back. A copy
   with one byte flipped failed with 1 bad hash, and a truncated copy failed to
   parse. It holds
   the exact original blocks, so `ipfs dag import <cid>.car` brings back the
   identical CID on any node, whatever the add settings were. It is stored at
   `<bucket>/car/<cid>.car`, outside the `<cid>/` folder the player serves.
2. **The unpacked files**, at `<bucket>/<cid>/<path>`, for playback.

The CAR also gives us verification for free (§4): every block is hashed and
checked against its CID, so a gateway can't hand us corrupt or partial data
without the job failing.

---

## 3. Pipeline (one video)

Each stage is saved to SQLite, so a restart picks up where it stopped (§7).

1. **Resolve.** Read the Mongo document again and get the CID and the manifest
   path. Skip it (and show the reason) when:
   - it isn't ready, or is failed or deleted
   - it has no CID (a dead video)
   - (legacy) `video_v2` is not `ipfs://<cid>[/<path>]`: a bare CID or an https
     source. The player's `storagePlan` only finds a CID in `ipfs://…`, so the
     video would keep playing from IPFS whatever we wrote.
   - an expired story (the player shows a placeholder clip instead)
   - it is `promoting`, has an unknown `storage_state`, or already has any
     `s3_*` field
   - it already has `storage_state: 'archived'` with a valid `s3_url`

   Videos on the hotnode (`hot`, or no state) **are** eligible.
2. **Check disk space.** Refuse the job if `free space in WORK_DIR − DISK_RESERVE_GB`,
   or the remaining `DISK_BUDGET_GB` (default 20), is smaller than the expected
   size. The download also stops, cleans up and fails as "out of space" if it
   goes over the budget partway through.
3. **Download the CAR**, streamed to `WORK_DIR/<jobItemId>.car`. Sources are
   tried in order:
   - `HOTNODE_GATEWAY` (`https://hotipfs-1.3speak.tv`: for videos still on the hotnode)
   - `https://ipfs.3speak.tv`
   - `https://ipfs-audio.3speak.tv`

   Each source has its own timeout. If a source fails, the next one is tried
   from the beginning. Bytes downloaded count towards the progress bar.
4. **Verify the CAR.**
   - It has exactly one root, and that root is the CID.
   - Every block's multihash, computed again, matches its CID.
   - The UnixFS walk of the whole directory from the root succeeds. A missing
     block fails the job, so a gateway's partial answer can never pass.

   The result is the complete file list: path, size, and SHA-256 and MD5
   computed while walking.
5. **Upload.**
   - Every file is streamed out of the CAR to `<cid>/<path>`, so nothing is
     unpacked onto disk and the job only needs about 1× the video's size.
   - Each file gets the right `Content-Type` (`m3u8` →
     `application/vnd.apple.mpegurl`, `ts` → `video/mp2t`, `mp4`, `jpg`/`png`, …)
     and `Cache-Control: public, max-age=31536000, immutable`.
   - Then the CAR goes to `car/<cid>.car`.
   - Files ≤ 5 GB use a single PUT, so MinIO returns an MD5 ETag. Larger ones
     use multipart, which Buttercloud's gateway supports.
   - Objects already present with the same size and MD5 are skipped, so a
     resumed job doesn't upload them again.
6. **Check S3.** All of these must pass:
   - `ListObjectsV2` on `<cid>/` returns exactly the expected keys, with no
     missing keys and none extra.
   - Every object's `HEAD` size matches.
   - Every single-part object's ETag equals the MD5 we computed. Multipart
     objects (the large CAR) are compared by size plus a full read-back SHA-256.
   - A playback check over HTTPS through **the Bunny zone and through
     s3.3speak.tv**: download the master manifest, every variant playlist, and
     the first and last segment of each variant. Each one's hash must match the
     source.
7. **Update Mongo.** One conditional `updateOne`:

   ```js
   filter: { _id, <video_v2 | manifest_cid>: <value seen in step 1>,
             storage_state: <value seen in step 1, or { $exists: false }> }
   update: { $set: { ...§1 fields } }
   ```

   If `matchedCount` is 0, the document changed during the migration. The job
   fails with "changed during migration" and leaves the S3 objects in place,
   which does no harm.
8. **Confirm with the player** (when `PLAYER_BASE_URL` is set): call the
   player's watch API for `owner/permlink`. It must now return the S3 zone URL
   (or `s3: true` for mode=hot). If not, the job is marked "migrated, player
   check failed" in red. That points to a config mismatch, not a lost video.
9. **Clean up.** Delete the local CAR. This happens on every exit path:
   success, failure and cancel.

A video only counts as **done** after steps 4, 6 and 7 pass (and 8, when it is
configured).

---

## 4. What "verified" means

| Risk | What catches it |
|---|---|
| Gateway returns corrupt or truncated data | the block hash check plus the full DAG walk (step 4) |
| A file not uploaded, or uploaded with the wrong bytes | List + HEAD + MD5 ETag (step 6) |
| Bucket, CDN or CORS set up wrong for playback | read-back over HTTPS through the zone and the direct host (step 6) |
| Mongo changed by someone else during the job | conditional update (step 7) |
| Player not reading our fields as expected | player API check (step 8) |
| CID not revivable | the CAR is stored and checked against the root CID |

---

## 5. Dry run

Every **Migrate** opens a dry run first, and the real run only starts after
**Confirm**. A dry run lists, for each selected video:

- whether it is eligible, and if not, why
- the CID and the target keys
- whether `car/<cid>.car` or `<cid>/` already exists in S3
- the exact `$set` the Mongo update would apply
- any field names in §1 the document already has (a conflict: blocked)

A dry run never writes to S3 or Mongo, and never downloads anything heavier
than a `HEAD`.

---

## 6. Revert (per video)

**Revert** sends playback back to IPFS by removing the migrator's own fields
(§1) with a conditional `$unset`. It is only allowed after a **liveness check**
passes:

- The CAR is streamed from `ipfs.3speak.tv` (falling back to ipfs-audio)
  without saving it.
- The same block-hash and DAG-walk checks as step 4 must pass, so we know the
  whole video is still on IPFS and not just the root.

The check runs as its own button (**Check IPFS**) and is run again
automatically by **Revert**. S3 objects are never deleted.

---

## 7. Jobs, concurrency and restarts

- **State:** SQLite (`better-sqlite3`) in `DATA_DIR/migrator.db`, with tables
  `jobs` (who, when, channel, mode) and `items` (collection, `_id`, CID, stage,
  bytes, error, attempts, timestamps). The full log of every attempt is kept.
- **Concurrency:** `MAX_CONCURRENT` (default 1, hard limit 2) across all jobs,
  so migrations can't starve the server's own video traffic. There is an
  optional `DOWNLOAD_RATE_LIMIT_MBPS`.
- **Restart:** on boot, items left in an unfinished stage go back to `queued`
  and the leftover files in `WORK_DIR` are deleted. Because uploads skip
  objects already present (step 5), a restarted item only redoes the download
  and verify.
- **Retries:** network failures are retried 3 times with backoff. Verification
  failures are not retried automatically; they are shown in red.
- **Cancel:** per item or per job. It stops after the current stage and cleans
  up. It never cancels in the middle of the Mongo update.

---

## 8. HTTP API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /` | — | the single-page UI |
| `GET /api/auth/challenge?user=` | — | a one-time challenge string (expires in 5 min) |
| `POST /api/auth/verify` | — | `{ user, challenge, signature }` → session cookie |
| `POST /api/auth/logout` | session | |
| `GET /api/me` | — | `{ user, authorized }` (drives which buttons are enabled) |
| `GET /api/channel/:user` | — | the channel's videos from both collections, with eligibility and storage state |
| `POST /api/dry-run` | allowlisted | `{ items: [{collection, id}] }` → the plan from §5 |
| `POST /api/jobs` | allowlisted **or** service | `{ items, mode: 'archived' \| 'hot' }` → job id |
| `GET /api/jobs`, `GET /api/jobs/:id` | — | status and history |
| `POST /api/jobs/:id/cancel`, `POST /api/items/:id/cancel` | allowlisted | |
| `POST /api/items/check-ipfs` | allowlisted | `{ collection, id }` → the liveness result from §6 |
| `POST /api/items/revert` | allowlisted | `{ collection, id }` |
| `GET /api/events` | — | an SSE stream of job and item progress |

Read-only routes are open, as agreed (public page, buttons disabled). Every
route that changes something checks authorization **on the server**.
Disabling a button in the UI is only cosmetic.

**`mode: 'hot'`** is for the hotnode later on. It does the same copy but writes
`storage_state: 'hot'`, so the player keeps playing from the hotnode with S3 as
the backup. When the hotnode later unpins, it flips the state to `archived`
(that can be another small endpoint when we get there).

**Service auth (phase 2, the hotnode on the same VPS):** the hotnode sends
`Authorization: Bearer <MIGRATOR_SERVICE_TOKEN>`. It is accepted **only** when
the TCP peer is loopback (`req.socket.remoteAddress`, never `X-Forwarded-For`)
and the token is set. `s3_migrated_by` is set to `service:hotnode`.

---

## 9. Login (Hive Keychain, posting key)

1. The client asks for `/api/auth/challenge?user=meno`. The server stores a
   random nonce and returns
   `snapie-migrator:<host>:<user>:<nonce>:<timestamp>`.
2. The client calls
   `hive_keychain.requestSignBuffer(user, challenge, 'Posting', cb)`.
3. The server checks that the challenge is unexpired and unused, and burns it.
   It recovers the public key from the signature (`@hiveio/dhive`) and fetches
   the account's posting `key_auths` from the chain, using a list of API nodes
   with failover. The recovered key must be one of them.
4. If `user` is in `ALLOWED_USERS`, the session is `authorized`. Otherwise the
   user is logged in but every action stays disabled.
5. Session: a signed `httpOnly`, `Secure`, `SameSite=Strict` cookie lasting 12
   hours. Every request that changes something must also send
   `Content-Type: application/json`, which together with `SameSite` blocks
   CSRF.

`ALLOWED_USERS` is read at boot. Changing it means a pm2 restart.

---

## 10. UI (one page)

- **Header:** a Keychain login button or the logged-in user, plus an
  `authorized` / `view only` badge.
- **Channel box:** enter a Hive username and press Load. It shows a table:
  checkbox, thumbnail, title, collection, status, storage (`IPFS` / `hot` /
  `archived ✓`), size when known, and CID. There is a **Select all eligible**
  checkbox, and ineligible rows are greyed out with the reason as a tooltip.
- **Actions:** **Dry run** and **Migrate selected**. Migrate opens the dry-run
  result first, then **Confirm**.
- **Job panel:**
  - Overall bar: videos done / total and bytes done / total.
  - Per video: the current stage (`download → verify → upload n/m → check →
    mongo → player check → done`) with its own bar, speed and time remaining.
  - Errors in red, with the message.
  - Live over SSE, and it picks up again after a page reload.
- **Per row, once migrated:** **Check IPFS** and **Revert**.
- **History:** past jobs and their items.
- **Disk:** used / budget, live.
- Built with plain HTML, CSS and JS served by Express. No build step.

---

## 11. Configuration (`.env`)

```bash
PORT=3020
PUBLIC_BASE_URL=https://migrator.example.tld
SESSION_SECRET=                    # long random
ALLOWED_USERS=meno,coolmole
MIGRATOR_SERVICE_TOKEN=            # phase 2, optional

MONGODB_URI=
MONGODB_DATABASE=threespeak
MONGODB_COLLECTION_LEGACY=videos
MONGODB_COLLECTION_NEW=embed-video

S3_ENDPOINT=                       # Buttercloud gateway
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_BUCKET=                         # MUST equal the player's S3_BUCKET
S3_CDN_HOST=buttercloud.b-cdn.net  # MUST equal the player's S3_CDN_HOST
S3_DIRECT_HOST=s3.3speak.tv

HOTNODE_GATEWAY=https://hotipfs-1.3speak.tv   # tried first (direct, not the Bunny zone)
IPFS_GATEWAYS=https://ipfs.3speak.tv,https://ipfs-audio.3speak.tv
PLAYER_BASE_URL=                   # optional, enables step 8
HIVE_API_NODES=https://api.hive.blog,https://api.deathwing.me,https://anyx.io

WORK_DIR=./work
DATA_DIR=./data
DISK_BUDGET_GB=20
DISK_RESERVE_GB=5
MAX_CONCURRENT=1                   # hard limit 2
DOWNLOAD_RATE_LIMIT_MBPS=          # optional
```

---

## 12. Stack and layout

Node 20+, ESM, Express. Dependencies:

- `mongodb`
- `@aws-sdk/client-s3`
- `@ipld/car`, `ipfs-unixfs-exporter`, `multiformats` (CAR read and verify)
- `better-sqlite3`
- `@hiveio/dhive`
- `cookie-signature` or `iron-session`

Tests use `vitest`. pm2 runs it from `ecosystem.config.cjs`.

```
src/
  server.js           routes, sessions, SSE
  config.js           env parse + validation (player-compatible regexes)
  auth.js             challenge / verify / allowlist / service token
  catalog.js          Mongo channel listing + eligibility (mirrors player rules)
  playerContract.js   the §1 fields, s3_url builders, conditional filters
  car.js              download with fallback, verify, walk
  s3.js               put/head/list/readback
  pipeline.js         per-item stages
  queue.js            SQLite state, concurrency, resume, cancel
  disk.js             budget accounting
public/               index.html, app.js, style.css
tests/
```

`catalog.js` and `playerContract.js` carry a comment pointing to the player
functions they mirror. A test pins the player's own example documents, so the
two can't drift without someone noticing.

---

## 13. Testing

- **Unit:**
  - eligibility for every status and collection
  - `s3_url` building and validation, run against the player's regexes
  - the conditional filters
  - disk budget accounting
- **CAR:** fixtures for a good CAR, a truncated CAR, a CAR with a tampered
  block, a CAR with the wrong root, and a DAG with a missing block. Only the
  good one passes.
- **Integration:** in-memory Mongo, a local MinIO (or `s3rver`) and a stubbed
  gateway, running the whole pipeline, plus a resume after a kill at each stage.
- **Auth:** a signature from the wrong key, a reused challenge, an expired
  challenge, a non-allowlisted user, and the service token from a non-loopback
  peer. All must be rejected.
- **Live acceptance, on `coolmole`:**
  1. dry run
  2. migrate one video
  3. the player plays it from S3, confirmed in DevTools
  4. Check IPFS, then Revert, and it plays from IPFS again
  5. migrate the whole channel

---

## 14. Out of scope (v1)

- Unpinning anything, and deleting anything from S3.
- The broken-owner assets the player finds through `hive_author` /
  `hive_permlink`. They don't show up under `owner`, so they aren't listed.
- The hotnode integration itself. Only the API is ready for it.
- Several gateways or several buckets.

## 15. Resolved / open items

1. ~~Hotnode gateway~~: `https://hotipfs-1.3speak.tv`, using the header form
   (§2). The Bunny hot zone returns an empty CAR, so it is never used as a
   download source.
2. **Repo name:** `snapie-migrator` is a placeholder; rename if you like.
