## Why

opencode's real V2 product (`@opencode/cli` / `@opencode/plugin`) does not
run V1 plugin implementations at all; this plugin (currently V1-only,
`@opencode-ai/plugin`) needs a genuine port to `Plugin.define`-shape
(`{id, setup(ctx)}`) before V1's documented, time-boxed compatibility
bridge closes. This plugin has no existing OpenSpec capability specs (the
prior `v2-compat-audit` change was a tasks-only compatibility audit against
the wrong V2 target, `opencode-ai@dev`, and is being superseded); this
change is the first to describe its behavior as specs, alongside the port.

## What Changes

- Rename `src/index.js` → `src/plugin.v1.js` (V1 adapter, behavior
  unchanged) and add `src/plugin.v2.js` (V2 adapter), sharing the plugin's
  event-handling logic, notification back-ends, and focus-detection helpers
  via extraction into a runtime-agnostic `src/core.js` (the V1/V2 event
  shapes and dispatch mechanisms differ enough that a thin-adapter-only
  split, as used for `opencode-redact`, is not viable here — see design.md).
- V1's single generic `event({event})` hook maps to V2's
  `ctx.event.subscribe({signal})` async-iterator hook, with V2's own event
  types and payload shapes (confirmed against the installed
  `@opencode/schema` 2.0.4 `event-manifest.d.ts`, not guessed):
  - `session.created`/`session.updated` (title cache) — real V2 events with
    a `data.title` field.
  - `permission.asked`/`permission.replied` — real V2 events, but with a
    **different payload shape**: V1's single `permission.permission`
    descriptive string is replaced by `data.action` + `data.resources[]` +
    an optional `data.message`; the notification text must be recomposed
    from these fields, not carried over verbatim.
  - `todo.updated` — **confirmed to have no V2 event source at all** (no
    todo domain exists in the V2 event manifest, consistent with the
    `opencode-auto-instruct` finding). Todo-completion notifications cannot
    fire on V2; this is an accepted, documented gap, not silently dropped.
  - `session.idle` — real V2 event, same concept.
  - `session.error` — **no direct V2 equivalent by that name**; the closest
    real event is `session.execution.failed` (`data.error.{type,message,status}`).
    A design decision is needed on whether this is an acceptable substitute.
  - Question-asked (`question.asked`/`replied`/`rejected`) — **no V2
    `question.*` event exists**; V2 replaces this whole mechanism with a
    richer `form.*` domain (`form.created`/`form.replied`/`form.cancelled`,
    a structured multi-field form builder, not a simple question/options
    list). A design decision is needed on how much of this to map.
- Desktop-notification back-ends (Linux D-Bus, macOS `terminal-notifier`,
  Windows PowerShell toast) and focus-detection (`xprop`/Hyprland/Sway) are
  entirely OS-process-spawning code with no opencode-runtime dependency —
  these move into `src/core.js` unchanged.

## Capabilities

### New Capabilities
- `notification-dispatch`: describes this plugin's full current behavior
  (desktop notifications, webhook dispatch, focus-suppression, dismiss-on-
  reply) in runtime-neutral terms, since no prior OpenSpec capability specs
  exist for this repo, plus the V2-specific scope limitations (no todo
  notifications, recomposed permission text, form-based question mapping).

## Impact

- `src/index.js` (renamed), `src/core.js` (new, extracted), `src/plugin.v1.js`
  (new, thin V1 adapter), `src/plugin.v2.js` (new, V2 adapter), `package.json`
  (subpath exports, new optional peer/dev dependency), `src/*.test.js` (import
  path updates, new V2 adapter-conformance tests), `docs/v2-compat-audit.md`
  (rewritten).
- No behavior change for existing V1 users.
