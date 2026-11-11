# Lessons

## Confirm the page reloaded before blaming the server
- In the Phase 3 browser run I blamed HTTP caching for stale IDs. The page had never
  reloaded: navigating to the same URL with only a different `#hash` keeps the
  document, its state and its open dialogs.
- Rule: in browser checks, change the path or query (`?run=N`) to force a load, and
  confirm the reload (fresh element state, new request in the server log) before
  diagnosing anything server-side.

## Run the real thing, not only the unit tests
- 184 tests passed, but the first browser run still found a login bug (a challenge
  split on ':' breaks when the host has a port) and two layout bugs.
- Rule: every phase that ships UI or HTTP gets an end-to-end run against a harness
  with the real modules before it is called done.

## Read the dependencies' engines before writing ours
- I set `engines.node` to >=20.11 from one API the code uses. better-sqlite3 13
  needs Node 22, and on 20 it segfaults; CI on Node 20 caught it.
- Rule: derive `engines` from `node -p` over every dependency's own `engines` (the
  strictest wins), and test the oldest supported Node in CI.

