# opencode-notify

opencode plugin that sends desktop notifications and optional webhook events when opencode finalizes a todo or requests a permission.

## Installation

Add the plugin to your `~/.config/opencode/opencode.jsonc`:

```json
"plugin": [
  ["path/to/opencode-notify/src/index.js", {
    "desktop": true,
    "webhooks": [
      {
        "url": "https://example.com/hook",
        "headers": { "Authorization": "Bearer TOKEN" }
      }
    ]
  }]
]
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `desktop` | `boolean` | `true` | Enable desktop notifications |
| `webhooks` | `WebhookTarget[]` | `[]` | List of webhook targets to POST to |
| `onClickCommand` | `string` | — | Shell command to run when the user clicks the "Focus opencode" action (Linux only). The literal string `${NODE_PID}` is replaced at runtime with the plugin's Node.js process PID. |

## Click to Focus (Linux)

On Linux, every desktop notification includes a **"Focus opencode"** action button rendered by `notify-send --wait`.

> **Requires** `notify-send` to be installed (`libnotify-bin` on Debian/Ubuntu, `libnotify` on Arch).

- **Permission notifications** use `--urgency=critical`, which may cause your compositor to raise the opencode window automatically.
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

The plugin POSTs a JSON body to each configured webhook URL. Two event shapes are emitted:

```json
// permission_request
{ "event": "permission_request", "sessionID": "ses_...", "sessionTitle": "Fix the login bug", "permissionTitle": "Run bash: rm -rf dist/" }

// todo_completed
{ "event": "todo_completed", "sessionID": "ses_...", "sessionTitle": "Fix the login bug", "todoID": "...", "todoContent": "Implement the fix" }
```

## Events

The plugin handles the following opencode events:

- **`permission.updated`** — fired when opencode raises a permission request that requires user approval. Triggers a `permission_request` notification.
- **`todo.updated`** — fired when a todo transitions to `completed`. Triggers a `todo_completed` notification.
