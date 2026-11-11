#!/usr/bin/env bash
# Deploy one commit on the VPS, and roll back by itself if it doesn't come up.
#
#   cd /var/www/snapie-migrator && bash deploy.sh <sha>
#
# Run from the app folder (the GitHub workflow extracts this script from the commit
# being deployed, so the deploy logic always matches the code it ships). Steps:
#   1. refuse to start without a .env (the first setup is manual, see DEPLOYMENT.md)
#   2. check out <sha>, npm ci without dev dependencies, pm2 start-or-restart
#   3. healthy = /api/status answers AND reports <sha> as the running version
#   4. not healthy → check out the previous commit again, restart, and exit 1
# A restart puts running migrations back in the queue; they resume on boot.
set -euo pipefail

SHA="${1:?usage: deploy.sh <commit sha>}"
APP=snapie-migrator
HEALTH_TRIES="${HEALTH_TRIES:-30}"
HEALTH_WAIT="${HEALTH_WAIT:-1}"

log() { printf '[deploy] %s\n' "$*"; }

# Non-interactive SSH doesn't load nvm; do it here if that's how Node was installed.
if ! command -v pm2 >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.nvm/nvm.sh"
fi
for tool in git node npm pm2 curl; do
  command -v "$tool" >/dev/null 2>&1 || { log "$tool is not on PATH for $(whoami) over SSH"; exit 2; }
done

# better-sqlite3 is a native module built for Node 22+: on older Node the app
# segfaults on boot. Refuse here, with the reason, instead of a pm2 crash loop.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { log "Node $(node -v) is too old: the migrator needs Node 22.12 or newer"; exit 2; }

[ -f ecosystem.config.cjs ] || { log "run me from the app folder (no ecosystem.config.cjs in $PWD)"; exit 2; }
[ -f .env ] || { log "no .env in $PWD: do the first setup by hand (DEPLOYMENT.md), then deploy"; exit 2; }

PORT="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]"' || true)"
PORT="${PORT:-3020}"
PREV="$(git rev-parse HEAD)"

install_and_restart() {
  git checkout --force --quiet "$1"
  npm ci --omit=dev --no-audit --no-fund
  pm2 startOrRestart ecosystem.config.cjs
}

# Healthy only if the app answers with the commit we just deployed.
healthy() {
  local want="$1" body
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if body="$(curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/status" 2>/dev/null)" \
      && printf '%s' "$body" | grep -q "\"version\":\"${want}\""; then
      return 0
    fi
    sleep "$HEALTH_WAIT"
  done
  return 1
}

log "deploying ${SHA:0:7} (running: ${PREV:0:7})"
if install_and_restart "$SHA" && healthy "$SHA"; then
  pm2 save >/dev/null
  log "${SHA:0:7} is live"
  exit 0
fi

log "${SHA:0:7} did not come up healthy; rolling back to ${PREV:0:7}"
pm2 logs "$APP" --lines 40 --nostream 2>/dev/null || true
if install_and_restart "$PREV" && healthy "$PREV"; then
  pm2 save >/dev/null
  log "rolled back: ${PREV:0:7} is live again"
else
  log "ROLLBACK FAILED: ${PREV:0:7} is not healthy either; look at the server now"
fi
exit 1
