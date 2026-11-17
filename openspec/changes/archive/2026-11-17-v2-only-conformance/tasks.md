# Tasks

## 1. V1 and todo removal

- [x] 1.1 Delete `src/plugin.v1.js`, `src/normalize-v1.js`, `src/plugin.v1.test.js`; point `main` and `exports["."]` at `src/plugin.v2.js`, drop `./v1` and the V1 peer, make `@opencode/plugin` a required peer, add `engines.node >=22.5`; verify "The package main entry resolves to the V2 plugin"
- [x] 1.2 Move `normalizeV2Event`, `PRODUCIBLE_KINDS` and the subscribe `types` list to `src/normalize-v2.js`; `plugin.v2.js` uses `Plugin.define` and exports only `default`; verify "plugin.v2.js exports only default"
- [x] 1.3 Remove the todo path from `core.js` (`todos-updated` kind, todo state cache, todo case); verify "No todo notifications fire on a runtime with no todo event source" and the two startup-warning scenarios
- [x] 1.4 Re-point `permission-notifications.test.js`, `terminal-bell.test.js`, `plugin-conformance.test.js` to V2 and delete V1 cases; verify the full suite passes

## 2. Correctness

- [x] 2.1 Map `session.execution.succeeded` instead of `session.idle` and filter `ctx.event.subscribe` by `types`; verify "Notifies when session execution succeeds"
- [x] 2.2 Look up the title on a cache miss, cache the fallback on failure; verify "Title is looked up when no title event was observed" and "A failed lookup is not retried for every event"
- [x] 2.3 Map `session.deleted` and discard title and handle caches; verify "Session deletion discards the session's state"
- [x] 2.4 Merge `ctx.options` over file options with per-category `notifications` merge, remove `testOverrides`; verify "Plugin option overrides the config file" and "Notification categories merge individually"
- [x] 2.5 Add notifier `dispose()` tracking monitor children and call it from V2 cleanup; verify "Unload stops running monitors" and "A notification sent during unload starts no monitor"

## 3. Logging

- [x] 3.1 Write the V2 logger as one JSON line to stderr, wrapped in try/catch; verify a stderr-capturing test parses `{service, level, message}`
- [x] 3.2 Convert every `core.js` log site to constant messages with `{errorName, code}` extras; verify a failing-webhook test logs only the host and no URL path or error message
- [x] 3.3 Add setup info, resolved-config info and per-event debug logs; verify none contains webhook URLs, titles or answer text

## 4. Docs and CI

- [x] 4.1 Make `README.md` and `core.js` header comments V2-only and delete `docs/v2-compat-audit.md`; verify `grep -rni "v1" README.md src docs` finds no runtime references
- [x] 4.2 Set the `ci.yml` matrix to `["22.5"]` and pin `actions/setup-node` by commit SHA; verify the SHA resolves to a commit with `gh api`

## Workflow follow-up

- Archive the change after review.
