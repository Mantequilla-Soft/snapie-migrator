# Deployment

The migrator runs under pm2 behind nginx. It keeps its job history in
`data/migrator.db`, and uses `work/` for one CAR at a time (two at most).

## 0. Two instances

The same code runs on two servers. Only their `.env` differs.

| | **Supernode** (temporary) | **Hotnode** (permanent) |
|---|---|---|
| Job | The backlog: copying everything already on the supernode's IPFS. People use this one. | The hotnode's own copies of new videos (service API, snapie-migrator#8) |
| Downloads from | `LOCAL_GATEWAY`: the supernode's own IPFS, from disk | `LOCAL_GATEWAY`: the hotnode's own IPFS |
| Writes to | **Garage directly**, on the same machine (`S3_ENDPOINT=http://127.0.0.1:3900`) | Buttercloud (`S3_ENDPOINT=https://…`), as before |
| Internet traffic per video | none, except the small playback read-back | the video once, hotnode → Buttercloud → supernode |
| Public page | yes, behind nginx (section 3) | no: `HOST=127.0.0.1` and no nginx site. Reach the page through an SSH tunnel if needed. |
| `MIGRATOR_SERVICE_TOKEN` | unset | set |
| GitHub environment | `supernode` | `hotnode` |

Why it is safe for both to write the same bucket and the same Mongo:
- the backlog skips videos younger than `BACKLOG_MIN_AGE_DAYS`, which are the hotnode's;
- every Mongo write only applies if the document hasn't changed since it was read;
- uploads skip objects that are already identical.

If both ever copy the same video, the second one finds it done.

**Buttercloud's usage counter.** The supernode writes into Garage without going
through Buttercloud, so the bucket's `current_usage_bytes` in Buttercloud doesn't
count those bytes. The objects themselves are fine: Buttercloud reads Garage live,
so listing and public playback through `s3.3speak.tv` and Bunny see them at once.
`admin-9eab69` is a house account, so nothing is billed from that counter;
recount it once the bulk migration is over.

**When the supernode's IPFS repos are retired,** stop the supernode instance
(`pm2 delete snapie-migrator`) and remove the `supernode` environment's `VPS_HOST`
secret. The deploy then skips it. Keep `data/migrator.db` as the record of what it copied.

## 1. One-time setup

- [ ] Node.js **22.12 or newer** (`node -v`). `better-sqlite3` and `vitest` need
      it, and on Node 20 the app crashes on boot. The deploy script refuses an old
      Node. If the server must keep Node 20 for other apps (the player's CI uses
      20), install 22 alongside it with nvm and point pm2 at it: add
      `interpreter: '/home/<user>/.nvm/versions/node/v22.x.y/bin/node'` to
      `ecosystem.config.cjs`. `better-sqlite3` ships prebuilt binaries for Linux
      x64; if `npm ci` tries to compile it, install `build-essential` and
      `python3` first.
- [ ] pm2: `npm i -g pm2`, plus `pm2 startup` once so it starts again after a reboot.
- [ ] Get the code onto the VPS, for example into `/var/www/snapie-migrator`, then:
      ```bash
      cd /var/www/snapie-migrator
      npm ci --omit=dev
      cp .env.example .env && chmod 600 .env
      ```
- [ ] Fill in `.env` (section 2).
- [ ] `work/` must sit on a disk with room for `DISK_BUDGET_GB` (default 20 GB) on
      top of `DISK_RESERVE_GB`. The migrator refuses new work rather than fill the
      disk, but it can only count space on the disk `WORK_DIR` is on.

## 2. `.env`

`.env.example` lists every setting. These are the ones that matter:

```bash
PUBLIC_BASE_URL=https://migrator.example.tld   # exactly what the browser shows, no trailing slash
SESSION_SECRET=                                # openssl rand -base64 48
ALLOWED_USERS=meno                             # comma-separated Hive accounts that may act

MONGODB_URI=                                   # same database as the player
S3_ENDPOINT=                                   # Buttercloud gateway, https://…
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_BUCKET=                                     # MUST equal the player's S3_BUCKET
S3_CDN_HOST=buttercloud.b-cdn.net              # MUST equal the player's S3_CDN_HOST

HOTNODE_GATEWAY=https://hotipfs-1.3speak.tv    # the hotnode itself, never its Bunny zone
PLAYER_BASE_URL=https://play.3speak.tv         # optional: confirms each migration with the player
```

The app checks `.env` at start and refuses to run, listing every problem, if
something is wrong. That includes a bucket name or CDN host the player would
reject.

**`LOCAL_GATEWAY`** is this server's own IPFS gateway, tried before every other
source. Plain http is allowed for localhost. It must answer the trustless CAR form
(`Accept: application/vnd.ipld.car`), which Kubo's gateway does. Check it with
`npm run check:car -- <cid>`: the output must say `from http://127.0.0.1:…`. It is
only used to download for migrations. **Check IPFS** and **Revert** ask
`IPFS_GATEWAYS`, which must list permanent nodes only.

### Supernode `.env` (on top of the above)

```bash
PUBLIC_BASE_URL=https://<its public address>   # what the browser shows
LOCAL_GATEWAY=http://127.0.0.1:8080            # the supernode's Kubo gateway port
IPFS_GATEWAYS=http://127.0.0.1:8080,https://ipfs.3speak.tv,https://ipfs-audio.3speak.tv   # permanent: fine for Check IPFS here

# Garage on this machine, not Buttercloud: nothing leaves the server.
S3_ENDPOINT=http://127.0.0.1:3900              # Garage's S3 API (s3_api.api_bind_addr in garage.toml)
S3_REGION=garage                               # must equal s3_api.s3_region in garage.toml
S3_ACCESS_KEY_ID=                              # a Garage key for this bucket only, see below
S3_SECRET_ACCESS_KEY=
S3_BUCKET=admin-9eab69                         # Buttercloud uses the same name on Garage, with no prefix
# leave MIGRATOR_SERVICE_TOKEN unset
```

A Garage key that can use this one bucket and nothing else:

```bash
garage key create snapie-migrator
garage bucket allow --read --write admin-9eab69 --key snapie-migrator
garage bucket info admin-9eab69                # the key is listed with RW
```

Garage's write permission also allows deletes. The migrator has no delete calls,
but keep the key on this server only.

### Hotnode `.env` (on top of the above)

```bash
HOST=127.0.0.1                                 # no public page; no nginx site
PUBLIC_BASE_URL=http://localhost:3020          # the page through an SSH tunnel: ssh -L 3020:127.0.0.1:3020 <hotnode>
LOCAL_GATEWAY=http://127.0.0.1:8080            # the hotnode's Kubo gateway port
S3_ENDPOINT=https://…                          # Buttercloud, with the bucket owner's API key
MIGRATOR_SERVICE_TOKEN=                        # openssl rand -hex 32; the same value goes in the hotnode's .env
```

## 3. nginx

The app listens on `127.0.0.1:3020`, and only nginx reaches it. The live progress
stream (`/api/events`) must not be buffered.

```nginx
server {
    listen 443 ssl http2;
    server_name migrator.example.tld;
    # ssl_certificate … (certbot --nginx -d migrator.example.tld)

    client_max_body_size 256k;     # the API only takes small JSON bodies

    location /api/events {
        proxy_pass http://127.0.0.1:3020;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:3020;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- **Never proxy `SERVICE_PORT` (3021).** It is the hotnode's API and only listens
  on 127.0.0.1.
- The session cookie is `Secure`, so the site must be served over **https**.
  Otherwise login seems to succeed but the browser drops the cookie.

## 4. Start

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs snapie-migrator      # expect: "[migrator] https://… on 127.0.0.1:3020, bucket …"
```

To restart after a code or `.env` change, run `pm2 restart snapie-migrator`.
Running items are put back in the queue on shutdown and start again on boot. A
restarted item downloads again, but skips every upload that already went through.

## 5. First run: check each step on `coolmole` before going wider

Run these in order, and stop at the first one that fails.

1. **The S3 path:** `npm run smoke:s3`. Every line must say `ok`. On the
   supernode this is the test that matters most. It proves that Garage accepts the
   migrator's uploads and gives back the ETags the migrator predicts (these checks
   were first proven through Buttercloud, not on Garage directly). It also proves
   that what is written straight into Garage is served publicly through
   Buttercloud, Bunny and s3.3speak.tv. It uploads about
   9 MB under `_smoke/<time>/` with the exact upload calls the migrator uses. Then
   it fetches the files back through the Bunny zone and s3.3speak.tv, and checks
   for the CORS header browsers need. It deletes nothing, so remove `_smoke/` by
   hand afterwards if you want.
2. **The sources:**
   `npm run check:car -- QmUaWTmYmQ7NGi7Cq1YndpzjB1UNTmmgnhk1AxDTC8DS2g`.
   This should say `downloaded … from` the first source that has the CID, then
   `verified`. With `LOCAL_GATEWAY` set, that should be the local gateway for any
   video this server holds.
3. **Login:** open the site and log in with Keychain. The badge must say
   **Can migrate**.
4. **Dry run:** load `coolmole`, select one video, and press **Dry run**. Read the
   `$set` it shows.
5. **One video:** migrate it. When it's done, press **Play** on its row. The
   real player opens in a panel that lists where every playlist and segment
   came from. It starts in **Assigned source only** (strict) mode, with no
   fallback. Expect "Strict: every segment came from the S3 copy". **Like a
   viewer** shows normal playback: there, one or two segments from an IPFS
   gateway mean S3 was slow for them at that moment. (This needs `PLAYER_BASE_URL` and a player with source
   reporting, SnapieVideoPlayer #64. Without it, use DevTools' Network tab: the
   segments come from `buttercloud.b-cdn.net` or `s3.3speak.tv`, through the
   player's `/seg`.)
6. **Back out:** press **Check IPFS** (it should be done, with no errors), then
   **Revert**. The video plays from IPFS again, and the S3 copy stays.
7. **The whole channel:** select all eligible videos and migrate.

## 6. Day to day

- **Logs:** `pm2 logs snapie-migrator`. Every item also has its own event log:
  click it in the queue.
- **Failed items:** the item's events show why. Network failures are retried 3
  times on their own. Verification failures are never retried, because they mean
  the data was wrong and someone should look at it.
- **Giving or taking access:** edit `ALLOWED_USERS`, then
  `pm2 restart snapie-migrator`. The list is checked on every request, so after
  the restart a removed account can't act any more, even with a session still
  open.
- **History:** `data/migrator.db` (SQLite). Back it up with the server; it is the
  record of who migrated what, and when.
- **Nothing to clean up:** `work/` is emptied after every item and at every start.
- **The backlog** (many channels, unattended):
  - Its pace is set in `.env`: `BACKLOG_DAILY_GB`, `BACKLOG_HOURS`, `BACKLOG_MIN_AGE_DAYS`. Restart after changing them.
  - It survives restarts.
  - If it shows **Paused** with "N videos failed in a row", something upstream is
    probably down (a gateway, Buttercloud). Check one failed item's events, fix the
    cause, then press **Resume**.
  - Before a large run, add the channels while the backlog is paused. Each channel's
    expected size shows once it is listed, which tells you whether the bucket has
    room.

## 7. CI/CD

The pipeline lives in `.github/workflows/`:

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every pull request to `master` | lint and tests on Node 22 and 24, and actionlint on the workflows. The player is checked out next to the migrator, so the drift test runs the migrator's `s3_url` through the player's own `s3Parts` (it fails, not skips, if the player is missing). Also shellcheck of `scripts/deploy.sh` and `npm audit` of production dependencies (high or critical fails). |
| `deploy.yml` | every push to `master`, or by hand | runs `ci.yml` first (nothing untested deploys), then deploys to each server in turn: `supernode`, then `hotnode` (section 0). For each one it SSHes in and runs `scripts/deploy.sh <sha>`, taken from the commit being deployed. A server whose environment has no `VPS_HOST` yet is skipped with a notice. |
| `dependabot.yml` | weekly (npm) and monthly (actions) | opens update PRs, which go through CI like any other. |

**`scripts/deploy.sh`** checks out the commit, runs `npm ci --omit=dev` and
`pm2 startOrRestart`. It then waits for `/api/status` to report **that commit**
as the running version. A port that answers with the old version doesn't count.
If the new commit doesn't come up healthy, the script checks out the previous
commit again, restarts, and the workflow fails. Running migrations go back in the
queue on every restart and resume on boot.

### One-time CI/CD setup

- [ ] Do the server setup from sections 1–4 by hand once. The deploy refuses to
      run where there is no `.env`.
- [ ] The deploy user must be able to run `git`, `npm`, `pm2` and `curl` over a
      non-interactive SSH session. An nvm install is loaded automatically.
- [ ] The deploy user must be able to `git fetch` the repo. A public repo works as
      is; for a private one, add a read-only deploy key on the server.
- [ ] Two environments (Settings → Environments): `supernode` and `hotnode`. In
      **each**, add the environment secrets `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY`
      (a private key whose public half is in that server's deploy user's
      `authorized_keys`), and optionally `VPS_PORT`. Set up only `supernode` for now;
      `hotnode` is skipped until it has a `VPS_HOST`.
- [ ] **No repository-level `VPS_*` secrets.** An environment without its own
      `VPS_HOST` would fall back to the repository's, and both jobs would deploy to
      the same server.
- [ ] Optional environment variable `DEPLOY_PATH` per environment (default
      `/var/www/snapie-migrator`).
- [ ] Add required reviewers to an environment if a person should approve each
      deploy there. The old `production` environment is no longer used and can be
      deleted.

### Rollback by hand

The deploy rolls back on its own when a commit doesn't come up. To go back to an
older commit that did come up but misbehaves, revert it in a PR, or on the server:

```bash
cd /var/www/snapie-migrator
bash scripts/deploy.sh <last-good-sha>
```

### Known audit findings

`npm audit` reports three **low** advisories in `elliptic`, which comes in
through `@hiveio/dhive`. There is no fix upstream. The advisory is about
producing signatures; the migrator only uses dhive to recover the key from a
Keychain signature, and never signs anything. CI fails on high or critical
advisories only.

## 8. Before pushing a change

`npm run lint && npm test`
