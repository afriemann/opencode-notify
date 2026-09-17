# opencode V2 Compatibility — `opencode-notify`

**Date:** 2026-09-16
**Change:** `v2-plugin-migration` (supersedes the earlier `v2-compat-audit` change)

## Correction to the prior audit

The prior `v2-compat-audit` change tested against `opencode-ai@dev`, which
is V1's own prerelease channel, not the real V2 product. The real, separately
versioned V2 is `@opencode/cli` / `@opencode/plugin` (stable, 2.0.3/2.0.4).
V1 plugin implementations do not run under it at all. This change performs a
real port and replaces the prior audit's conclusion.

## What changed

- `src/index.js` renamed to `src/plugin.v1.js` (unchanged V1 behavior).
- New `src/core.js`: extracts every OS-process-spawning back-end (Linux
  D-Bus, macOS `terminal-notifier`, Windows PowerShell toast), window-focus
  detection (xprop/Hyprland/Sway), webhook dispatch, config-file reading, and
  all per-session/per-request state into a runtime-agnostic module consuming
  a `NormalizedEvent` union — neither `@opencode-ai/plugin` nor
  `@opencode/plugin` is ever imported there.
- New `src/plugin.v2.js`: a stateless V2 adapter translating V2's raw event
  stream (`ctx.event.subscribe`) into the same `NormalizedEvent` vocabulary.

This plugin has **five distinct V1 event domains** to map, not just a
transport change — a thin-adapter-only split (as used for `opencode-redact`)
wasn't viable here since the payload shapes differ per event type, not just
per runtime. See `design.md` for the full architecture rationale.

## Event mapping (V1 → V2)

| Concern | V1 | V2 | Notes |
|---|---|---|---|
| Session title | `session.created`/`session.updated` | `session.created` (title optional) / `session.renamed` | V2 has **no `session.updated`**; session ID on `session.created` comes only from `durable.aggregateID`, not a `data` field |
| Permission request | `permission.asked` (single `permission` string) | `permission.asked` (`action`+`resources[]`+optional `message`) | Notification text is **composed**, not carried verbatim — V1's descriptive string doesn't exist on V2 |
| Permission reply | `permission.replied` | `permission.replied` | Same shape (`requestID`) |
| Todo completion | `todo.updated` | **no event source exists** | Permanent, accepted gap — see below |
| Task finished | `session.idle` | `session.idle` | Same shape |
| Session failure | `session.error` (no message) | `session.execution.failed` (`error.message`, `error.type`) | Net improvement: V2 carries a real error message V1 never had |
| User input request | `question.asked`/`replied`/`rejected` | `form.created`/`replied`/`cancelled` | Reduced-scope mapping — see below |

## Permanent gap: todo-completion notifications on V2

No `todo.*` event exists anywhere in the V2 event manifest (confirmed by
reading the installed `@opencode/schema` 2.0.4 `event-manifest.d.ts` in
full — no `todo` domain at all). This mirrors the same finding already made
independently in the `opencode-auto-instruct` V2 port. There is no
alternative event to map onto; this is not a design gap to be revisited, it
is an absent capability on the host.

**Behavior on V2:** todo-completion notifications never fire, regardless of
configuration. If `notifications.todoCompleted` is explicitly present in the
resolved config (the config file only, on V2 — inline `opencode.jsonc`
options are a V1-only capability for now, see below) — whatever its value — exactly one
warning is logged at plugin startup noting the limitation, so a user who
believes they configured this feature isn't silently unaware it has no
effect. No warning is logged when the setting was never mentioned, so users
who never touched it (the default, `todoCompleted: true`) are not nagged on
every start.

## Reduced-scope mapping: question → form

V2 replaces V1's simple question/options mechanism with a materially richer
`form.*` domain — a structured multi-field builder with typed fields
(`string`/`number`/multiselect/etc.), per-field `required`/`when`
conditional visibility, and free-text answers. A desktop notification is a
two-line strapline; a full 1:1 mapping of that richness is not merely hard,
it is the wrong target for a notification.

**In scope:** `form.created` → a notification using the form's `title`
(a *required* field on V2 — more reliable than V1's optional
`questions[0].header`) and the first field's `title`/`description` as the
body. `form.replied`/`form.cancelled` → dismiss the notification, keyed by
the form's `id` — dismiss-on-reply is **fully preserved**, not reduced.

**Deliberately out of scope:** per-field rendering, `when` conditional
evaluation, and — load-bearing for security — **the user's answer content
(`form.replied.data.answer`) is never included in any notification or
webhook payload.** Piping free-text user input to arbitrary
user-configured webhook URLs would create a data-egress channel V1 never
had.

## Verification status

| Item | Status |
|---|---|
| Plugin loads on the real V2 host (`@opencode/cli` 2.0.3) via `.opencode/plugins/` auto-discovery | ✅ Confirmed live — no `PluginModule.LoadError`, unlike the still-V1-shaped comparison plugins present in the same test environment |
| `setup()` runs; the event-subscribe loop starts and processes real session-lifecycle events without error | ✅ Confirmed live across two separate runs |
| Todo-warning fires only when explicitly configured, never otherwise | ✅ Confirmed live (no warning fired with an unconfigured `notifications` object) and unit-tested (Tier 3) |
| Every event-type normalization (V1 and V2, all 8 kinds) | ✅ Unit tested (Tier 2) against fixtures built from the exact confirmed schema shapes |
| Todo transition detection, permission race fix, dismiss-on-reply | ✅ Unit tested (Tier 1), including the ported pre-existing `permission-notifications.test.js` suite unchanged |
| A real `permission.asked`/`permission.replied` round-trip observed live on the real V2 host | ⚠️ Not captured — this sandbox environment auto-approved the simple shell commands used to try to trigger a permission prompt, so no live permission event was observed in this session. Covered instead by Tier 2's exact-shape unit test (built from the schema, not guessed) and by the unchanged, already-passing `permission-notifications.test.js` suite via the V1 path. |
| A real `session.execution.failed` observed live on the real V2 host | ⚠️ Not captured — no failure was induced in this session (would require e.g. an invalid API key). Covered by a Tier 2 unit test built from the exact confirmed schema shape. |
| Design.md's Open Questions 1-3 (execution.failed coverage parity, aggregateID-as-session-id, session.renamed firing on first title assignment) | Not resolved live in this session; recorded as open follow-ups, not silently assumed. |

## How to reproduce this test

```bash
mkdir -p /tmp/opencode-notify-v2-test/.opencode/plugins /tmp/opencode-notify-v2-test/.opencode/lib
cp src/plugin.v2.js /tmp/opencode-notify-v2-test/.opencode/plugins/
cp src/core.js /tmp/opencode-notify-v2-test/.opencode/lib/
# .opencode/plugins/ scans every .js file placed directly inside it as its
# own candidate plugin -- shared modules must live in a sibling directory.
sed -i "s#from './core.js'#from '../lib/core.js'#" /tmp/opencode-notify-v2-test/.opencode/plugins/plugin.v2.js

cd /tmp/opencode-notify-v2-test
echo '{ "name": "scratch", "type": "module" }' > package.json
opencode-v2-real plugin list   # confirms auto-discovery found the plugin
opencode-v2-real run "..." --print-logs --log-level debug --standalone
# --standalone is required to see server-side plugin log output at all.
```
