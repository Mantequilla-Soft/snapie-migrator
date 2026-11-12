# Lessons

## Confirm the page reloaded before blaming the server
- In the Phase 3 browser run I blamed HTTP caching for stale IDs. The page had never
  reloaded: navigating to the same URL with only a different `#hash` keeps the
  document, its state and its open dialogs.
- Rule: in browser checks, change the path or query (`?run=N`) to force a load, and
  confirm the reload (fresh element state, new request in the server log) before
  diagnosing anything server-side.
- It happened again (strict-mode check): `browser_navigate` to `/#coolmole` while
  already on `/#coolmole` kept the old page, so the new toggle was missing and the
  frame had no `strict=1`. Rule, made concrete: after changing anything under
  `public/`, the first browser step is `location.reload()` or a new `?run=N`, then
  check that one new element exists before testing behaviour.

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


## A 200 from a gateway is not the content
- The hotnode answers HTTP 200 with a 57-byte, header-only CAR for a CID it doesn't
  have (the Bunny zone did the same in the very first spike, and I noted it without
  acting on it). The pipeline treated a bad CAR as final, so one empty answer from
  the first gateway failed a migration that the next gateway could have served.
- Rule: with several sources, a source's answer only counts once it has been
  verified; a verification failure moves on to the next source. Fail for good only
  when every source has failed.

## A new table inherits the shared mobile rules
- The backlog table looked fine on desktop. At 390px it squeezed every column into
  the 34px checkbox column, because the shared `.table` rule for phones assumes the
  videos table's layout.
- Rule: every new table or list gets a screenshot at phone width (390px) before it
  is called done, and its `@media` overrides sit next to its own styles.
