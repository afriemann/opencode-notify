# opencode-notify

opencode plugin that sends desktop notifications and optional webhook events when opencode finalizes a todo, requests a permission, finishes a session, encounters an error, or asks the user a question.

## Installation

Both opencode V1 (`@opencode-ai/plugin`) and V2 (`@opencode/cli` /
`@opencode/plugin`) are supported, via separate entrypoint files.

**V1:** clone the repository to your `~/.config/opencode/plugins` directory and link `plugin.v1.js`:

```bash
git clone git@github.com:afriemann/opencode-notify ~/.config/opencode/plugins/opencode-notify
cd ~/.config/opencode/plugins
ln -s opencode-notify/src/plugin.v1.js opencode-notify.js
```

**V2:** drop `src/plugin.v2.js` into a project's or the global
`.opencode/plugins/` directory, with `src/core.js` (and its own relative
import path adjusted) in a sibling `.opencode/lib/` directory —
`.opencode/plugins/` scans every `.js` file placed directly inside it as its
own candidate plugin, so shared modules must never live alongside it.

On V2, **todo-completion notifications never fire** — no such event exists
on that runtime (see `docs/v2-compat-audit.md`) — and question/form
notifications use a reduced-scope mapping (notification only, using the
form's title; the user's typed answer is never included in any notification
or webhook payload).

opencode will then automatically load the plugin on startup.

### macOS prerequisite

The plugin sends notifications on macOS by spawning [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) directly. Install it once via Homebrew:

```bash
brew install terminal-notifier
```

To configure options, create `~/.config/opencode/opencode-notify.json`:

```json
{
  "desktop": true,
  "skipIfFocused": true,
  "webhooks": [
    { "url": "https://example.com/webhook" }
  ],
  "onClickCommand": "echo -ne '\007'"
}
```

The file is optional — omitting it uses the defaults listed in [Options](#options). If the plugin is installed as an npm package and loaded via the `"plugin"` key in `opencode.jsonc`, inline options passed there take precedence over the config file.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `desktop` | `boolean` | `true` | Enable desktop notifications |
| `skipIfFocused` | `boolean` | `true` | Suppress desktop notifications when the opencode window is already focused. See [Focus Detection](#focus-detection) for platform caveats. |
| `terminalBell` | `boolean` | `true` | Ring the terminal bell (`\x07` to `/dev/tty`) on notification-worthy events. See [Terminal Bell](#terminal-bell). |
| `webhooks` | `WebhookTarget[]` | `[]` | List of webhook targets to POST to |
| `onClickCommand` | `string` | — | Shell command to run when the user clicks the "Focus opencode" action (Linux only). The literal string `${NODE_PID}` is replaced at runtime with the plugin's Node.js process PID. |
| `notifications` | `object` | `{}` | Per-event notification toggles. All keys default to `true`; set a key to `false` to disable that event for **all channels** (desktop, terminal bell, and webhook). |

### Per-event toggles (`notifications` object)

| Key | Opencode event | Default | Description |
|-----|----------------|---------|-------------|
| `taskFinished` | `session.idle` | `true` | "Task Done" — fired when a session becomes idle |
| `questionAsked` | `question.asked` | `true` | Question prompt — fired when opencode asks the user a question |
| `permissionRequested` | `permission.asked` | `true` | Permission request — fired when opencode needs user approval. Also accepts an object — see [Permission request options](#permission-request-options) |
| `todoCompleted` | `todo.updated` | `true` | Todo done — fired when an individual todo transitions to `completed` |
| `sessionError` | `session.error` | `true` | Session error — fired when a session encounters an error |

**Example** — disable "Task Done" and todo notifications:

```json
{
  "notifications": {
    "taskFinished": false,
    "todoCompleted": false
  }
}
```

#### Permission request options

`permissionRequested` accepts either a boolean (enable/disable, as above) or an object with additional overrides:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the notification |
| `urgency` | `'low' \| 'normal' \| 'critical'` | `'critical'` | Desktop notification urgency |
| `expireTimeoutMs` | `number` | `0` | Opt-in hard auto-dismiss timeout in milliseconds, independent of any reply. `0` (default) disables it. |

**Why the safe default:** a pending permission request may still need a real human decision. This plugin cannot tell whether opencode's "auto"/allow-all permission mode or its "normal" manual mode is active — that toggle is client/TUI-local state, never sent to the server or included in the `permission.asked`/`permission.replied` event payloads — so it defaults to `critical` urgency and no auto-dismiss timer, exactly as if every request might need your attention.

The notification is still dismissed **immediately** the moment opencode actually replies to the request — whether that reply comes back near-instantly (allow-all mode) or after you click approve/deny (normal mode) — so a burst of auto-approved permission requests in allow-all mode does not pile up as a wall of notifications you have to click through. This close-on-reply also survives a race where the reply arrives before the notification has finished being sent to the OS.

`expireTimeoutMs` is available if you also want a hard safety-net timeout that fires even if no reply is ever received (e.g. a crashed or abandoned session) — set it explicitly if you want that behavior; it is off by default because it would otherwise dismiss a still-pending request before you've had a chance to act on it.

**Example** — lower urgency with a safety-net auto-dismiss (only recommended if you exclusively run in allow-all mode):

```json
{
  "notifications": {
    "permissionRequested": {
      "urgency": "normal",
      "expireTimeoutMs": 8000
    }
  }
}
```

## Focus Detection

When `skipIfFocused` is `true` (the default), the plugin suppresses desktop notifications if the opencode window is already focused — no point notifying you when you're already looking at it.

> **Note:** `permission.asked` and `question.asked` always bypass focus suppression — permission requests and questions are always delivered to the user regardless of the `skipIfFocused` setting.

Focus is detected by obtaining the focused window's owner PID (via `xprop` querying `_NET_ACTIVE_WINDOW` / `_NET_WM_PID` on X11/XWayland, or compositor IPC on native Wayland) and then walking `/proc` upward from the opencode Node process — checking whether the focused window's PID appears in opencode's ancestor chain (opencode → shell → terminal emulator → display server).

| Platform | Support |
|----------|---------|
| Linux (X11 or XWayland) | ✅ Full support |
| Linux (native Wayland, Hyprland) | ✅ Full support via `hyprctl activewindow` |
| Linux (native Wayland, Sway) | ✅ Full support via `swaymsg -t get_tree` |
| Linux (native Wayland, other compositors) | ⚠️ Unsupported — logs a warning to stderr and sends the notification anyway |
| macOS | ✅ Full support |
| Windows | ✅ Full support |

If detection fails for any reason (no active window returned, unexpected error), the plugin logs a warning to stderr and sends the notification — notifications are never silently dropped.

To disable focus detection and always notify: set `skipIfFocused: false`.

## Terminal Bell

When `terminalBell` is `true` (the default), the plugin rings the ASCII terminal bell (`\x07`) by writing directly to `/dev/tty` on every notification-worthy event — the same channels and focus-suppression rules as [Focus Detection](#focus-detection) apply (`permission.asked` and `question.asked` always ring the bell; the others respect `skipIfFocused`).

This is deliberately a **terminal-mediated, window-manager-agnostic** mechanism, distinct from the desktop-notification channel above: it writes to the controlling TTY device rather than `process.stdout` (writing to this plugin's own stdout would interleave with, or be swallowed by, opencode's own TUI rendering), and it needs no `DISPLAY`/`WAYLAND_DISPLAY`/D-Bus session — so it also works over SSH.

What happens when the bell rings depends entirely on your terminal emulator and window manager/compositor — this plugin sends only the raw `BEL` byte and does no window-manager-specific work itself:

| Terminal | Behavior |
|----------|----------|
| Ghostty ≥ 1.2.0 | Marks the window/workspace as requesting attention (`bell-features` config, enabled by default) |
| kitty, foot, alacritty, wezterm, xterm, gnome-terminal | Typically request window-manager attention on an unfocused bell (exact behavior varies by version/config) |
| Ghostty ≤ 1.1.x, or any terminal with bell support disabled | No-op — the byte is simply ignored |

If your terminal doesn't support bell-triggered attention, set `terminalBell: false` to skip the (harmless) write, or configure your terminal's bell behavior directly.

## Click to Focus (Linux)

On Linux, every desktop notification includes a **"Focus opencode"** action button.
Notifications are sent via `gdbus call … org.freedesktop.Notifications.Notify` directly — no dependency on `notify-send`. `gdbus` is part of GLib (`glib2` / `libglib2.0-bin`), which is present on virtually every Linux desktop.

- **Permission notifications** use `urgency=critical` by default with no auto-dismiss timer (configurable — see [Permission request options](#permission-request-options)). The notification is dismissed immediately once opencode actually replies to the request — whether that's a near-instant allow-all-mode reply or a manual approve/deny click — rather than requiring a manual dismissal or an artificial timeout.
- **Todo notifications** use default urgency.
- If `onClickCommand` is set and non-empty, it is executed via `child_process.exec` when the user clicks the action. If `onClickCommand` is absent or empty the click is a no-op (the action button is still shown but does nothing beyond dismissing the notification).

### Example — Hyprland v0.55+

Hyprland v0.55 introduced `hl.dsp.focus({ window })` via `hyprctl eval`. To focus the opencode window by PID, set `onClickCommand` in your `opencode.jsonc`:

```jsonc
["path/to/opencode-notify/src/plugin.v1.js", {
  "desktop": true,
  "onClickCommand": "hyprctl eval \"hl.dsp.focus({ window = 'pid:${NODE_PID}' })\""
}]
```

The plugin substitutes `${NODE_PID}` with `process.pid` at the moment the notification action fires, so the running opencode process is targeted correctly. `${NODE_PID}` is a placeholder in the config string — the plugin never passes it literally to the shell.

### WebhookTarget

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | yes | URL to POST the event payload to |
| `headers` | `object` | no | Additional HTTP headers (e.g. auth) |

## Webhook Payload

The plugin POSTs a JSON body to each configured webhook URL. Five event shapes are emitted:

```json
// permission_request
{ "event": "permission_request", "sessionID": "ses_...", "sessionTitle": "Fix the login bug", "permissionTitle": "Run bash: rm -rf dist/" }

// todo_completed
{ "event": "todo_completed", "sessionID": "ses_...", "sessionTitle": "Fix the login bug", "todoContent": "Implement the fix" }

// session_idle
{ "event": "session_idle", "sessionID": "ses_...", "sessionTitle": "Fix the login bug" }

// session_error
{ "event": "session_error", "sessionID": "ses_...", "sessionTitle": "Fix the login bug" }

// question_asked
{ "event": "question_asked", "sessionID": "ses_...", "sessionTitle": "Fix the login bug", "questionHeader": "Choose an approach", "questionBody": "Which refactoring strategy would you prefer?" }
```

## Events

The plugin handles the following opencode events. Each notifying event can be individually disabled via the [`notifications` option](#per-event-toggles-notifications-object).

- **`permission.asked`** — fired when opencode raises a permission request that requires user approval. Triggers a `permission_request` notification. Focus suppression is always bypassed so permission requests always reach the user. Disable with `notifications.permissionRequested: false`.
- **`permission.replied`** — fired when a permission request is answered (approved or rejected). The corresponding `permission_request` notification is programmatically dismissed.
- **`todo.updated`** — fired when a todo transitions to `completed`. Triggers a `todo_completed` notification. Disable with `notifications.todoCompleted: false`.
- **`session.idle`** — fired when a session finishes and the agent becomes idle. Triggers a `session_idle` notification ("Task Done"). Disable with `notifications.taskFinished: false`.
- **`session.error`** — fired when a session encounters an error. Triggers a `session_error` notification ("Session Error"). Disable with `notifications.sessionError: false`.
- **`question.asked`** — fired when opencode asks the user a question. Triggers a `question_asked` notification. Focus suppression is **always bypassed** for this event so questions always reach the user. Disable with `notifications.questionAsked: false`.
