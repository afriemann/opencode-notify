# opencode V2 Compatibility Audit — `opencode-notify`

**Date:** 2026-09-15
**Tested against:** `opencode-ai@dev` (`0.0.0-dev-202609142154`), via the
`opencode2` sandbox command. See the shared
`reality/opencode-v2-sandbox-plugin-compat` memory atom and `opencode-use`'s
`docs/v2-compat-audit.md` for the general V2 background — not repeated in
full here.

**Note:** the primary local checkout (`~/git/opencode-notify`) was also
found stale relative to `origin/main` (5 commits behind, missing recent
`permission.asked`/`permission.replied` handling improvements) — fast-
forwarded during this session.

## What "opencode V2" is

See `opencode-use`'s audit doc for the full background. V2 (`packages/core`)
is confirmed live today only for the catalog domain via `opencode debug v2`
— the V1 plugin runtime (this plugin's `event` hook) is unaffected so far.

## Hook registered by this plugin (`src/index.js`)

| Hook | Purpose |
|---|---|
| `event` | Listens to all opencode events; sends desktop notifications (via direct `gdbus`/D-Bus calls to `org.freedesktop.Notifications.Notify`, no `notify-send` dependency) and optional webhook events for `session.created`/`updated`, `permission.asked`/`replied`, `todo.updated`, `session.idle`, `session.error`, and question-asked events |

## Empirical test result

**Setup:** scratch project (`/tmp/opencode/v2-sandbox/test-notify`) with
`opencode.json` pointing `plugin` at this repo's `src/index.js` (worktree,
unmodified, current `origin/main` content).

**Methodological note:** this plugin has no explicit success-path log call
for the notification-send path (only for the config-load-failure and
no-graphical-session-fallback paths, both of which don't apply here since a
real graphical session — `DISPLAY`/`WAYLAND_DISPLAY`/`DBUS_SESSION_BUS_ADDRESS`
were all set) — so `--print-logs` alone gives no direct confirmation.
Instead, `dbus-monitor` was run in parallel to observe the actual D-Bus
method call the plugin makes:

```bash
dbus-monitor --session "interface='org.freedesktop.Notifications',member='Notify'" &
opencode2 run "Use the bash tool to run: python3 -c 'print(1+1)'" --print-logs --log-level DEBUG
```

**Result — direct positive evidence via the real D-Bus call:**

`dbus-monitor` captured an actual `org.freedesktop.Notifications.Notify`
method call originating from this worktree's plugin path
(`.../opencode-notify/.worktrees/v2-compat-audit/src/assets/opencode.png`),
with the exact expected content:

```
member=Notify
  string "opencode"
  string ".../opencode-notify/.worktrees/v2-compat-audit/src/assets/opencode.png"
  string "opencode – Permission Request"
  string "bash\nRun python3 one-liner (print 1+1)"
  array [ string "default", string "Focus opencode" ]
  array [ dict entry( string "urgency" variant byte 2 ) ]
```

This confirms the `event` hook fired on `permission.asked`, correctly built
the notification title/message, and successfully invoked the D-Bus
notification API end-to-end. (A second, near-identical call was also
captured from the globally-installed vendor copy of this same plugin,
loaded independently via opencode's auto-discovery — expected, not a bug.)

| Hook | Result | Evidence |
|---|---|---|
| `event` (permission.asked → desktop notification) | ✅ Pass (direct evidence) | Real `org.freedesktop.Notifications.Notify` D-Bus call captured via `dbus-monitor`, with correct title, message, and urgency |

No `opencode-notify` errors were logged. The only unrelated failure observed
was the already-known `~/.config/opencode/plugins/opencode-openspec.js`
load failure (`command.trim is not a function`), tracked in that repo's own
audit.

## Cross-reference against the documented V2 plugin API

V2's plugin API (`packages/plugin/src/v2/{effect,promise}/README.md`)
documents only `agent`/`catalog`/`command`/`integration`/`reference`/`skill`
`.transform()` hooks and `aisdk.sdk`/`aisdk.language` runtime hooks. There is
no documented V2 equivalent for a generic `event` hook. Empirically, it still
works today on the V1 plugin runtime, alongside V2's (so-far catalog-only)
migration.

## Risk rating and recommended action

Risk = likelihood × impact of this hook breaking on a future V2 migration.

| Hook | Risk | Recommended action |
|---|---|---|
| `event` | Medium | This plugin's entire mechanism (desktop + webhook notifications) depends on it. No V2-documented equivalent for a generic event stream exists yet. Re-test on each `dev` bump using the `dbus-monitor` technique above, since this plugin has no success-path log of its own. |

**Overall:** No action needed today — confirmed working against the current
`dev` prerelease with direct D-Bus-level evidence. Re-run this test after
refreshing `~/opencode-v2-sandbox` periodically.

## How to reproduce this test

```bash
cd ~/opencode-v2-sandbox && npm install opencode-ai@dev && node node_modules/opencode-ai/postinstall.mjs
opencode2 --version

mkdir -p /tmp/opencode-notify-v2-test && cd /tmp/opencode-notify-v2-test
cat > opencode.json << 'EOF'
{ "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-notify/src/index.js"] }
EOF

# Capture the D-Bus call in parallel (this plugin has no success-path log):
dbus-monitor --session "interface='org.freedesktop.Notifications',member='Notify'" &
MONITOR_PID=$!

opencode2 run "Use the bash tool to run: python3 -c 'print(1+1)'" --print-logs --log-level DEBUG

wait $MONITOR_PID 2>/dev/null
# Inspect the captured Notify call for the expected title/message/urgency.
```
