# opencode-notify

opencode plugin that sends desktop notifications and optional webhook events when opencode finalizes a todo, requests a permission, finishes a session, encounters an error, or asks the user a question.

## Installation

Clone the repository to your `~/.config/opencode/plugins` directory and link the `index.js`:

```bash
git clone git@github.com:afriemann/opencode-notify ~/.config/opencode/plugins/opencode-notify
cd ~/.config/opencode/plugins
ln -s opencode-notify/src/index.js opencode-notify.js
```

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
| `webhooks` | `WebhookTarget[]` | `[]` | List of webhook targets to POST to |
| `onClickCommand` | `string` | — | Shell command to run when the user clicks the "Focus opencode" action (Linux only). The literal string `${NODE_PID}` is replaced at runtime with the plugin's Node.js process PID. |
| `notifications` | `object` | `{}` | Per-event notification toggles. All keys default to `true`; set a key to `false` to disable that event for **both** desktop and webhook channels. |

### Per-event toggles (`notifications` object)

| Key | Opencode event | Default | Description |
|-----|----------------|---------|-------------|
| `taskFinished` | `session.idle` | `true` | "Task Done" — fired when a session becomes idle |
| `questionAsked` | `question.asked` | `true` | Question prompt — fired when opencode asks the user a question |
| `permissionRequested` | `permission.asked` | `true` | Permission request — fired when opencode needs user approval |
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

## Focus Detection

When `skipIfFocused` is `true` (the default), the plugin suppresses desktop notifications if the opencode window is already focused — no point notifying you when you're already looking at it.

> **Note:** `permission.asked` and `question.asked` always bypass focus suppression — permission requests and questions are always delivered to the user regardless of the `skipIfFocused` setting.

Focus is detected by obtaining the focused window's owner PID (via [`get-windows`](https://github.com/sindresorhus/get-windows) on X11/XWayland, or compositor IPC on native Wayland) and then walking `/proc` upward from the opencode Node process — checking whether the focused window's PID appears in opencode's ancestor chain (opencode → shell → terminal emulator → display server).

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

## Click to Focus (Linux)

On Linux, every desktop notification includes a **"Focus opencode"** action button.
Notifications are sent via `gdbus call … org.freedesktop.Notifications.Notify` directly — no dependency on `notify-send`. `gdbus` is part of GLib (`glib2` / `libglib2.0-bin`), which is present on virtually every Linux desktop.

- **Permission notifications** use `urgency=critical`, which may cause your compositor to raise the opencode window automatically. When the user approves or rejects the request, the notification is automatically dismissed.
- **Todo notifications** use default urgency.
- If `onClickCommand` is set and non-empty, it is executed via `child_process.exec` when the user clicks the action. If `onClickCommand` is absent or empty the click is a no-op (the action button is still shown but does nothing beyond dismissing the notification).

### Example — Hyprland v0.55+

Hyprland v0.55 introduced `hl.dsp.focus({ window })` via `hyprctl eval`. To focus the opencode window by PID, set `onClickCommand` in your `opencode.jsonc`:

```jsonc
["path/to/opencode-notify/src/index.js", {
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
