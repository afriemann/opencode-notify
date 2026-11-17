# Design

## Decisions

1. **Notifier lifecycle.** `createNotifier` returns `dispose()`. Live `gdbus monitor` children are tracked in a notifier-scoped set. After `dispose`, nothing new is spawned: a `disposed` flag is checked after the async send. Pending expiry timers are cleared. V2 cleanup aborts the subscription loop, awaits it, then disposes. Monitors have no lifetime cap, because a cap would break click-to-focus on non-expiring permission notifications. Desktop notifications already open at unload are left alone.

2. **Subscribe filter.** `src/normalize-v2.js` exports the `types` list next to `normalizeV2Event` and `PRODUCIBLE_KINDS`. `ctx.event.subscribe({types})` uses it, so filter and mapper cannot drift. `session.idle` is dropped.

3. **Title lookup.** On a cache miss, one `ctx.session.get({sessionID})` runs (response unwrapped, `.title`) under a short timeout. Concurrent misses share one in-flight promise. A failure falls back to `Session <first 8 chars>`, and the fallback is cached so it is not retried per event. `session.deleted` evicts the title and also that session's permission/prompt handle caches. Handles store their `sessionID` for this. The eviction guards against a missing `sessionID`.

4. **Options precedence.** `ctx.options` is merged over file options. Top-level keys are replaced by `ctx.options`, except `notifications`, which merges per category key. The explicit-`todoCompleted` startup warning checks the merged result.

5. **Test seam.** `Plugin.define` setup takes only `ctx`. The `testOverrides` parameter is removed. Tests drive the plugin through `ctx.options` and a faked `ctx`. `@opencode/plugin` becomes a required peer, so the runtime import of `Plugin.define` (an identity function) is safe.

6. **Logging contract.** One JSON line to stderr: `{service, level, message, ...extra}`, wrapped in try/catch so logging never throws. Messages are constants. `extra` allows only identifiers, counts, host, and `{errorName, code}`. It never carries webhook URLs or paths, raw error messages, subprocess output, titles, descriptions or answers. Notification and webhook payload content, including the failure error message, is unchanged.

## Rationale

- One derived `types` list prevents filter/mapper drift.
- The post-await flag closes the race where an in-flight send spawns a monitor after unload.
- Caching the fallback bounds lookups while `session.get` fails.
- Constant messages and allow-listed extras make leaks structurally impossible.
