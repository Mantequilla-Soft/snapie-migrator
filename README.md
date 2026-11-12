# Snapie Migrator

An internal tool that copies a Hive channel's 3Speak videos from IPFS into the
Buttercloud S3 bucket, checks every byte, and then marks them in Mongo so that
SnapieVideoPlayer plays them from S3.

It never unpins anything from IPFS, never deletes anything from S3, and never
changes an existing Mongo field. It only adds `storage_state`, `s3_url` and a few
`s3_*` fields. **Revert** removes exactly those.

- **Design and the reasons behind it:** [SPEC.md](SPEC.md)
- **Putting it on a VPS:** [DEPLOYMENT.md](DEPLOYMENT.md)

## How a video is migrated

1. **Resolve.** Read the Mongo entry again: it may have changed since it was queued.
2. **Download** the video as a CAR file: the hotnode first, then the supernode,
   then ipfs-audio.
3. **Verify** the CAR: the right root CID, every block's hash, and the whole
   folder readable.
4. **Upload** the files to `<bucket>/<cid>/…` and the CAR to `<bucket>/car/<cid>.car`.
5. **Check** that S3 has exactly those objects, matching ETag for ETag. Then
   download the playlists and the first and last segments back through the Bunny
   zone and through s3.3speak.tv.
6. **Mongo:** a conditional update, written only if the entry is still as it was
   read in step 1.
7. **Player check** (optional): the player's own API must now return the S3 URL.

The local CAR is deleted whatever happens. The CAR kept in S3 can bring the video
back on IPFS under the same CID with `ipfs dag import`.

## Seeing where a video plays from

With `PLAYER_BASE_URL` set, every row has a **Play** button. It opens the real
player and lists where each playlist and segment really came from: the S3 zone,
S3 direct, the hotnode, or an IPFS gateway. A migrated video that has quietly
fallen back to IPFS plays just as well, and this is how you tell.

## Migrating many channels: the backlog

Paste a list of Hive usernames into **Backlog** and the migrator works through
them on its own, slowly:

- **One channel at a time,** in the order they were added. Each channel is listed
  when its turn comes, and each video is checked again right before it is queued.
- **It only fills idle time.** At most `MAX_CONCURRENT` backlog videos are in the
  queue at once, and manual migrations always go first.
- **It is paced:** at most `BACKLOG_DAILY_GB` copied in any 24 h, and optionally
  only during `BACKLOG_HOURS` (UTC). Pause and Resume are on the page.
- **Videos it leaves alone:**
  - videos younger than `BACKLOG_MIN_AGE_DAYS`, which the hotnode copies;
  - videos bigger than the disk budget;
  - anything a manual run would refuse.

  Each one is listed with the reason.
- **Unattended failures:**
  - network errors, a full disk and the like are tried again after 6 h and then 24 h;
  - a verification failure stays failed until someone presses **Retry failed**;
  - 5 failures in a row pause the whole backlog, with the last error as the reason.

Adding a channel that has finished lists it again and picks up its newer videos.

## Who can do what

Anyone can open the page and look at channels and jobs. To act, log in with Hive
Keychain (posting key) as an account in `ALLOWED_USERS`. Any other account sees
the page read-only, with the buttons disabled. The same goes for the backlog:
anyone can see it, and only allowed accounts can add channels, pause, resume,
remove or retry. The videos it copies are recorded as migrated by whoever added
the channel.

The hotnode can queue copies through a separate API on `127.0.0.1:SERVICE_PORT`,
using a Bearer token (`MIGRATOR_SERVICE_TOKEN`). That port is never exposed through
nginx.

## Commands

| | |
|---|---|
| `npm start` | run the app (pm2 runs `ecosystem.config.cjs`) |
| `npm test` | the test suite (in-memory Mongo, a fake S3, real CAR fixtures) |
| `npm run lint` | eslint |
| `npm run smoke:s3` | check that the real Buttercloud setup accepts what the migrator sends, and serves it back with CORS |
| `npm run check:car -- <cid>` | download and verify one CID from the configured gateways, without touching S3 or Mongo |

## Layout

```
src/
  index.js          entry: config → Mongo → S3 → queue → listeners; clean shutdown
  config.js         .env parsing and validation (uses the player's own bucket and host rules)
  playerContract.js the fields the player reads, the s3_url builder, conditional filters
  catalog.js        a channel's videos from both collections, and eligibility
  car.js            CAR download (gateway fallback, disk budget) and verification
  s3.js             uploads sized for Buttercloud's gateway, with locally predicted ETags
  readback.js       the HTTPS playback check through the zone and the direct host
  pipeline.js       one migration, stage by stage
  actions.js        Check IPFS and Revert
  queue.js          SQLite job queue: at most 2 at once, retries, cancel, resume
  dryRun.js         the plan shown before every migration
  auth.js           Keychain login and sessions
  server.js         the public app and the loopback service app
public/             the page (plain HTML, CSS and JS, no build step); sources.js sorts the player's source reports
scripts/            smoke:s3, check:car
```
