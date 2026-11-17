# Proposal

## Product intent

A developer runs opencode V2 and works in other windows. The plugin alerts them (desktop, terminal bell, webhook) when opencode needs permission or an answer, finishes, or fails, and dismisses notifications once they reply. Must keep: all three channels, focus gating, click-to-focus, the config file. Trust model: the user's webhook URLs and commands are trusted; free-text answers never appear in a notification or webhook payload.

## Why

The plugin deviates from the opencode plugin guidelines (issue #22): it still ships a V1 runtime that is no longer needed, the V2 adapter maps an event V2 never publishes so the task-finished notification never fires, and logging leaks variable data and webhook URLs.

## What Changes

- **BREAKING** Remove the V1 runtime (`plugin.v1.js`, `normalize-v1.js`, the `./v1` export, V1 peer dependency, V1 docs and tests).
- Remove the todo-completion notification path; `notifications.todoCompleted` stays accepted but ignored, with the existing startup warning when it is set.
- `plugin.v2.js` uses `Plugin.define`, exports only `default`; normalisation moves to `normalize-v2.js`.
- Task-finished fires on `session.execution.succeeded` (`session.idle` is no longer mapped); the subscription is filtered to the mapped events.
- Session titles are looked up on a cache miss; per-session state is evicted on `session.deleted`.
- Plugin options (`ctx.options`) override config-file options.
- Spawned D-Bus monitors are stopped when the plugin unloads; nothing spawns after unload.
- Logging becomes one JSON line per entry with constant messages; webhook URLs, raw error messages and subprocess output are never logged; setup, resolved-config and per-event debug logs are added.
- `engines.node >=22.5`; CI tests Node 22.5 with `setup-node` pinned by commit SHA.

## Capabilities

### Modified Capabilities

- `plugin`: the V1 entrypoint requirements are removed and replaced by a V2 entrypoint export-surface requirement.
- `notification-dispatch`: todo-completion notification removed; todo-unsupported, session-title tracking modified; plugin-options precedence and unload cleanup added.

## Impact

`src/core.js`, `src/plugin.v2.js`, new `src/normalize-v2.js`, tests, `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/v2-compat-audit.md` (deleted). Consumers importing `./v1` or `plugin.v1.js` break; the `./v2` export and `src/plugin.v2.js` path are unchanged.
