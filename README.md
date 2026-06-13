# opencode-notify

opencode plugin that sends desktop notifications and optional webhook events when opencode requests a permission or a session finishes.

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

// task_done
{ "event": "task_done", "sessionID": "ses_...", "sessionTitle": "Fix the login bug" }
```

## Events

The plugin handles the following opencode events:

- **`permission.updated`** — fired when opencode raises a permission request that requires user approval. Triggers a `permission_request` notification.
- **`session.idle`** — fired when a session finishes its current task and becomes idle. Triggers a `task_done` notification.
