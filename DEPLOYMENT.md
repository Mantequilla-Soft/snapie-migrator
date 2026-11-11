# Deployment

The migrator runs under pm2 behind nginx, on the hotnode server or any VPS with
good bandwidth to the IPFS nodes and to Buttercloud. It keeps its job history in
`data/migrator.db`, and uses `work/` for one CAR at a time (two at most).

## 1. One-time setup

- [ ] Node.js **20.11 or newer** (`node -v`). `better-sqlite3` ships prebuilt
      binaries for Linux x64. If `npm ci` tries to compile it, install
      `build-essential` and `python3` first.
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

**If the migrator runs on the hotnode server itself,** `HOTNODE_GATEWAY` can be the
local gateway (for example `http://127.0.0.1:8080`, since plain http is allowed for
localhost). Downloads then don't go out over the internet at all.

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

1. **The S3 path:** `npm run smoke:s3`. Every line must say `ok`. It uploads about
   9 MB under `_smoke/<time>/` with the exact upload calls the migrator uses. Then
   it fetches the files back through the Bunny zone and s3.3speak.tv, and checks
   for the CORS header browsers need. It deletes nothing, so remove `_smoke/` by
   hand afterwards if you want.
2. **The sources:**
   `npm run check:car -- QmUaWTmYmQ7NGi7Cq1YndpzjB1UNTmmgnhk1AxDTC8DS2g`.
   This should say `downloaded … from https://hotipfs-1.3speak.tv`, then
   `verified`.
3. **Login:** open the site and log in with Keychain. The badge must say
   **Can migrate**.
4. **Dry run:** load `coolmole`, select one video, and press **Dry run**. Read the
   `$set` it shows.
5. **One video:** migrate it. When it's done, open it in the player with DevTools'
   Network tab. The manifest request is the player's
   `/hls?u=https%3A%2F%2Fbuttercloud.b-cdn.net%2F…&s3=1`, and the segments come
   from `buttercloud.b-cdn.net`, directly or through the player's `/seg`. Nothing
   should come from an IPFS gateway.
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

## 7. CI/CD

The pipeline lives in `.github/workflows/`:

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every pull request to `master` | lint and tests on Node 20 and 22. The player is checked out next to the migrator, so the drift test runs the migrator's `s3_url` through the player's own `s3Parts` (it fails, not skips, if the player is missing). Also shellcheck of `scripts/deploy.sh` and `npm audit` of production dependencies (high or critical fails). |
| `deploy.yml` | every push to `master`, or by hand | runs `ci.yml` first (nothing untested deploys), then SSHes into the VPS and runs `scripts/deploy.sh <sha>`, taken from the commit being deployed. |
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
- [ ] Repository secrets (Settings → Secrets → Actions), the same three as the
      player:
      `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (a private key whose public half is in
      the deploy user's `authorized_keys`), and optionally `VPS_PORT`.
- [ ] Optional repository variable `DEPLOY_PATH` (default `/var/www/snapie-migrator`).
- [ ] The `production` environment is created on the first deploy. Add required
      reviewers there if a person should approve each deploy.

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
