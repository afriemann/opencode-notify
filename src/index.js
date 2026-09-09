/**
 * opencode-notify – opencode plugin
 *
 * Sends desktop notifications and optional webhook events when opencode:
 *   - requests a user permission  (`permission.asked`)
 *   - finalizes a todo (status transitions to `completed`) (`todo.updated`)
 *   - becomes idle after a session task finishes (`session.idle`)
 *   - encounters a session error (`session.error`)
 *   - poses a question to the user (`question.asked`)
 *
 * When a permission request is replied to (`permission.replied`) the
 * corresponding notification is programmatically dismissed.
 *
 * Session titles are cached on `session.created` / `session.updated` so that
 * event handlers never need an async API call.
 *
 * ## Notification back-ends
 *
 * ### Linux
 * Uses `gdbus call … org.freedesktop.Notifications.Notify` directly (no
 * dependency on `notify-send`).  The call returns the numeric notification ID
 * synchronously, which is used later to dismiss the notification via
 * `org.freedesktop.Notifications.CloseNotification`.  Action-button clicks
 * ("Focus opencode") are detected by subscribing to the `ActionInvoked` D-Bus
 * signal with a short-lived `gdbus monitor` process.
 *
 * ### macOS
 * Spawns `terminal-notifier` directly (must be installed, e.g. via Homebrew).
 * A caller-supplied `groupId` string is passed as `-group <groupId>` and later
 * used to dismiss via `terminal-notifier -remove <groupId>`.
 *
 * ### Windows / other
 * Spawns PowerShell with an inline WinRT script (Windows 10+ built-in, no
 * extra dependencies).  Dismiss is a no-op (no reliable cross-platform
 * mechanism exists).
 */

import { readFile } from 'node:fs/promises';
import { spawn, exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Application ID used by Windows toast notifications for grouping. */
const APP_ID = 'opencode-notify';

/** Absolute path to the bundled icon, resolved relative to this source file. */
const ICON_PATH = new URL('./assets/opencode.png', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

/**
 * The conventional config file path for per-user configuration when the plugin
 * is loaded via auto-discovery (the `*.js` symlink in `plugins/`).  When
 * opencode loads a plugin by path rather than npm name, it cannot pass options
 * from `opencode.jsonc`, so we fall back to this file.
 *
 * The file is optional — absence is not an error and results in all defaults.
 */
const CONFIG_FILE_PATH = join(homedir(), '.config', 'opencode', 'opencode-notify.json');

/**
 * Reads and parses the optional per-user config file.  Returns a (possibly
 * empty) options object.  Any read or parse error is logged via
 * `client.app.log` and treated as "no config" so the plugin still starts
 * with defaults.
 *
 * @param {unknown} client
 * @returns {Promise<Record<string, unknown>>}
 */
async function readConfigFile(client) {
  try {
    const raw = await readFile(CONFIG_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logPluginError(client, 'warn', 'Config file must be a JSON object; ignoring.', {
        path: CONFIG_FILE_PATH,
      });
      return {};
    }
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logPluginError(client, 'error', `Could not read config file (${CONFIG_FILE_PATH}): ${err.message}`, {
        path: CONFIG_FILE_PATH,
      });
    }
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable session label, using the cached title when
 * available or falling back to the first eight characters of the session ID.
 *
 * @param {Map<string, string>} sessionTitleCache
 * @param {string} sessionID
 * @returns {string}
 */
function resolveSessionTitle(sessionTitleCache, sessionID) {
  return sessionTitleCache.get(sessionID) ?? `Session ${sessionID.slice(0, 8)}`;
}

/**
 * Routes a diagnostic message through opencode's structured logging endpoint
 * (`client.app.log`) instead of `console.*`. The plugin runs inside opencode's
 * own Node.js process, so any direct `console.*` write is rendered straight
 * into the TUI's terminal buffer and corrupts it; `client.app.log` posts to
 * opencode's internal log pipeline instead, which never touches the terminal.
 *
 * Fire-and-forget: never throws, never rejects visibly, and never falls back
 * to `console.*` — a failure to log must not itself become a TUI-polluting
 * error.
 *
 * @param {{ app?: { log?: (arg: unknown) => Promise<unknown> } } | undefined} client
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {void}
 */
function logPluginError(client, level, message, extra) {
  try {
    client?.app?.log?.({
      body: {
        service: 'opencode-notify',
        level,
        message,
        extra,
      },
    })?.catch?.(() => {});
  } catch {
    // Never throw — see doc comment above. A synchronous throw here would
    // propagate out of `child.on('error', ...)` handlers as an uncaught
    // exception, which is exactly the host-crashing failure mode this
    // helper exists to prevent.
  }
}

/**
 * Resolves a per-event notification config value that may be either the
 * legacy boolean shorthand (enable/disable only) or an object of overrides
 * for that event's notification behaviour (e.g. `urgency`, `expireTimeoutMs`).
 * Always returns a fully-populated object: `defaults` merged under any
 * object-shape overrides, or `{ ...defaults, enabled: value }` for a boolean,
 * or `defaults` unchanged for `undefined`/`null`/an array.
 *
 * @template {{ enabled: boolean }} T
 * @param {boolean | Partial<T> | null | undefined} value
 * @param {T} defaults
 * @returns {T}
 */
function resolveNotificationConfig(value, defaults) {
  if (typeof value === 'boolean') {
    return { ...defaults, enabled: value };
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ...defaults, ...value };
  }
  return defaults;
}
export { resolveNotificationConfig };

/**
 * Returns `true` when no graphical/D-Bus session is detectable on Linux —
 * i.e. `DISPLAY`, `WAYLAND_DISPLAY`, and `DBUS_SESSION_BUS_ADDRESS` are all
 * unset. This is the common case for opencode running on a bare tty with no
 * desktop environment, where `gdbus call --session ...` (and any other
 * desktop-notification backend) has no daemon to talk to. Used to disable
 * desktop notifications proactively, before ever attempting a spawn.
 *
 * @returns {boolean}
 */
function isDesktopEnvironmentUnavailable() {
  return (
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY &&
    !process.env.DBUS_SESSION_BUS_ADDRESS
  );
}

// ---------------------------------------------------------------------------
// Opaque notification handle
// ---------------------------------------------------------------------------

/**
 * An opaque handle returned by `sendDesktopNotification` and consumed by
 * `closeDesktopNotification`.  Callers must not inspect the shape — it is
 * platform-specific.
 *
 * - Linux:          `{ platform: 'linux',   id: number }`
 * - macOS:          `{ platform: 'darwin',  groupId: string }`
 * - Windows/other:  `{ platform: 'other',   groupId: null }` (no dismiss mechanism)
 *
 * @typedef {{ platform: 'linux'; id: number }
 *           | { platform: 'darwin'; groupId: string }
 *           | { platform: 'other'; groupId: null }} NotificationHandle
 */

// ---------------------------------------------------------------------------
// D-Bus constants (Linux)
// ---------------------------------------------------------------------------

const DBUS_DEST    = 'org.freedesktop.Notifications';
const DBUS_PATH    = '/org/freedesktop/Notifications';
const DBUS_IFACE   = 'org.freedesktop.Notifications';

// ---------------------------------------------------------------------------
// sendDesktopNotification
// ---------------------------------------------------------------------------

/**
 * Sends a desktop notification, swallowing any errors to stderr so the plugin
 * never crashes opencode.
 *
 * Returns a `Promise<NotificationHandle | null>` so that callers that need to
 * dismiss the notification later can obtain the opaque handle.  Fire-and-forget
 * callers may ignore the return value — the Promise never rejects.
 *
 * ### Linux
 * Sends via `gdbus call … Notify` (no dependency on `notify-send`).  The
 * numeric notification ID is returned by the D-Bus call and resolves the
 * Promise immediately.  A separate short-lived `gdbus monitor` process listens
 * for the `ActionInvoked` signal so the "Focus opencode" action button still
 * works.
 *
 * ### macOS
 * Spawns `terminal-notifier` with `-group <groupId>` so the notification can
 * later be dismissed by group.  If no `groupId` is supplied a random UUID is used.
 *
 * ### Windows / other
 * Spawns PowerShell with an inline WinRT script (Windows 10+, no extra deps).
 * The handle is returned for API consistency but `closeDesktopNotification`
 * is a no-op on these platforms.
 *
 * @param {{
 *   title: string;
 *   message: string;
 *   urgency?: string;
 *   groupId?: string;
 *   onClickCommand?: string;
 *   expireTimeoutMs?: number;
 * }} opts
 * @param {unknown} client
 * @param {{ desktopUnavailable: boolean }} notificationState
 * @returns {Promise<NotificationHandle | null>}
 */
function sendDesktopNotification({ title, message, urgency, groupId, onClickCommand, expireTimeoutMs }, client, notificationState) {
  if (notificationState.desktopUnavailable) {
    return Promise.resolve(null);
  }

  if (process.platform === 'linux') {
    return sendDesktopNotificationLinux({ title, message, urgency, onClickCommand, expireTimeoutMs }, client, notificationState);
  }

  if (process.platform === 'darwin') {
    return sendDesktopNotificationMac({ title, message, groupId }, client, notificationState);
  }

  return sendDesktopNotificationWindows({ title, message }, client, notificationState);
}

/**
 * macOS implementation — spawns `terminal-notifier` directly.
 * Requires `terminal-notifier` to be installed (e.g. `brew install terminal-notifier`).
 *
 * @param {{ title: string; message: string; groupId?: string }} opts
 * @param {unknown} client
 * @param {{ desktopUnavailable: boolean }} notificationState
 * @returns {Promise<NotificationHandle | null>}
 */
function sendDesktopNotificationMac({ title, message, groupId }, client, notificationState) {
  const resolvedGroupId = groupId ?? randomUUID();
  const args = [
    '-title',   title,
    '-message', message,
    '-appIcon', ICON_PATH,
    '-group',   resolvedGroupId,
  ];

  let child;
  try {
    child = spawn('terminal-notifier', args, { stdio: 'ignore' });
  } catch (err) {
    notificationState.desktopUnavailable = true;
    logPluginError(client, 'error', `Failed to spawn terminal-notifier: ${err.message}`);
    return Promise.resolve(null);
  }
  child.on('error', (err) => {
    notificationState.desktopUnavailable = true;
    logPluginError(client, 'error', `terminal-notifier error: ${err.message}`);
  });
  child.unref();

  return Promise.resolve({ platform: 'darwin', groupId: resolvedGroupId });
}

/**
 * Windows / other implementation — sends a Toast notification via an inline
 * PowerShell WinRT script (Windows 10+ built-in, no extra dependencies).
 * Dismiss is a no-op on this platform.
 *
 * @param {{ title: string; message: string }} opts
 * @param {unknown} client
 * @param {{ desktopUnavailable: boolean }} notificationState
 * @returns {Promise<NotificationHandle | null>}
 */
function sendDesktopNotificationWindows({ title, message }, client, notificationState) {
  // Escape XML special chars before embedding in the toast XML template.
  const escXml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const ps = [
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${escXml(title)}</text><text>${escXml(message)}</text></binding></visual></toast>')`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)`,
  ].join('\n');

  // Use -EncodedCommand (base64 UTF-16LE) to avoid Windows CreateProcess
  // command-line quoting mangling the double-quotes inside the XML template.
  // Available since PowerShell 2.0 (Windows 7+).
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');

  let child;
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore' });
  } catch (err) {
    notificationState.desktopUnavailable = true;
    logPluginError(client, 'error', `Failed to spawn powershell for toast notification: ${err.message}`);
    return Promise.resolve(null);
  }
  child.on('error', (err) => {
    notificationState.desktopUnavailable = true;
    logPluginError(client, 'error', `powershell toast error: ${err.message}`);
  });
  child.unref();

  return Promise.resolve({ platform: 'other', groupId: null });
}

/**
 * Linux implementation of `sendDesktopNotification`.
 * Uses `gdbus call … org.freedesktop.Notifications.Notify` directly so that
 * no dependency on `notify-send` is required.
 *
 * The D-Bus `Notify` method signature:
 *   Notify(app_name, replaces_id, app_icon, summary, body,
 *          actions[], hints{sv}, expire_timeout) → uint id
 *
 * Actions are an interleaved array of [key, label, …]; we use the conventional
 * `'default'` key for the primary "Focus opencode" action.
 *
 * Urgency is passed as a D-Bus hint: `{'urgency': <byte N>}` where
 *   0 = low, 1 = normal, 2 = critical.
 *
 * `expire_timeout` is passed straight through in milliseconds, matching the
 * D-Bus `Notify` signature. Note that several notification daemons ignore it
 * regardless of urgency (GNOME Shell, Notify OSD), and some ignore it
 * specifically for `critical`-urgency notifications (KDE Plasma) — see
 * `man notify-send`. Callers that need a reliable auto-dismiss across daemons
 * must also arrange to call `closeDesktopNotification` themselves after this
 * many milliseconds (see the `permission.asked` handler).
 *
 * @param {{
 *   title: string;
 *   message: string;
 *   urgency?: string;
 *   onClickCommand?: string;
 *   expireTimeoutMs?: number;
 * }} opts
 * @param {unknown} client
 * @param {{ desktopUnavailable: boolean }} notificationState
 * @returns {Promise<NotificationHandle | null>}
 */
function sendDesktopNotificationLinux({ title, message, urgency, onClickCommand, expireTimeoutMs }, client, notificationState) {
  // Map string urgency name → D-Bus byte value
  const urgencyByte = urgency === 'critical' ? 2 : urgency === 'low' ? 0 : 1;
  const hintsArg = `{'urgency': <byte ${urgencyByte}>}`;

  // expire_timeout in milliseconds; 0 = notification server decides (may mean
  // "never expires"). Defaults to 0 (native behaviour unchanged) when omitted.
  const expireTimeoutArg = String(expireTimeoutMs ?? 0);
  const args = [
    'call', '--session',
    '--dest', DBUS_DEST,
    '--object-path', DBUS_PATH,
    '--method', `${DBUS_IFACE}.Notify`,
    'opencode',               // app_name
    '0',                      // replaces_id (0 = new notification)
    ICON_PATH,                // app_icon
    title,                    // summary
    message,                  // body
    "['default', 'Focus opencode']", // actions
    hintsArg,                 // hints
    expireTimeoutArg,         // expire_timeout
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gdbus', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      notificationState.desktopUnavailable = true;
      logPluginError(client, 'error', `Failed to spawn gdbus: ${err.message}`);
      resolve(null);
      return;
    }

    child.on('error', (err) => {
      notificationState.desktopUnavailable = true;
      logPluginError(client, 'error', `gdbus Notify failed: ${err.message}`);
      resolve(null);
    });

    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });

    child.stdout.on('close', () => {
      // D-Bus Notify returns "(uint32 NNN,)"
      const match = stdout.match(/\(uint32 (\d+),\)/);
      if (!match) {
        logPluginError(client, 'error', `gdbus Notify returned unexpected output: ${stdout.trim()}`);
        resolve(null);
        return;
      }
      const id = Number(match[1]);
      resolve({ platform: 'linux', id });

      // Fire-and-forget: subscribe to ActionInvoked so the "Focus opencode"
      // button still works.  The monitor process exits on its own once the
      // notification is dismissed or times out.
      if (onClickCommand) {
        subscribeLinuxActionInvoked(id, onClickCommand, client);
      }
    });

    child.stderr.on('data', (chunk) => {
      logPluginError(client, 'error', `gdbus Notify stderr: ${chunk.toString().trim()}`);
    });
  });
}

/**
 * Spawns a `gdbus monitor` process that listens for the `ActionInvoked` signal
 * on the given notification `id`.  When the `'default'` action key is received,
 * `onClickCommand` is executed (fire-and-forget).  The monitor exits naturally
 * once the notification is closed.
 *
 * @param {number} id             Numeric notification ID returned by Notify.
 * @param {string} onClickCommand Shell command to execute; `${NODE_PID}` is
 *                                substituted with `process.pid`.
 * @param {unknown} client
 */
function subscribeLinuxActionInvoked(id, onClickCommand, client) {
  let monitor;
  try {
    monitor = spawn('gdbus', [
      'monitor', '--session',
      '--dest', DBUS_DEST,
      '--object-path', DBUS_PATH,
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    logPluginError(client, 'error', `Failed to spawn gdbus monitor: ${err.message}`);
    return;
  }

  monitor.on('error', (err) => {
    logPluginError(client, 'error', `gdbus monitor error: ${err.message}`);
  });

  let buffer = '';
  monitor.stdout.setEncoding('utf8');
  monitor.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      // ActionInvoked line format:
      //   /org/…: org.freedesktop.Notifications.ActionInvoked (uint32 NNN, 'key')
      const actionMatch = line.match(/ActionInvoked \(uint32 (\d+), '([^']+)'\)/);
      if (actionMatch && Number(actionMatch[1]) === id && actionMatch[2] === 'default') {
        const cmd = onClickCommand.replaceAll('${NODE_PID}', String(process.pid));
        exec(cmd, (err) => {
          if (err) logPluginError(client, 'error', `onClickCommand failed: ${err.message}`);
        });
        monitor.kill();
        return;
      }

      // NotificationClosed: no more events for this ID — clean up
      const closedMatch = line.match(/NotificationClosed \(uint32 (\d+), uint32 \d+\)/);
      if (closedMatch && Number(closedMatch[1]) === id) {
        monitor.kill();
        return;
      }
    }
  });

  monitor.on('close', () => {
    monitor.unref();
  });
}

// ---------------------------------------------------------------------------
// closeDesktopNotification
// ---------------------------------------------------------------------------

/**
 * Programmatically dismisses a previously sent notification.
 *
 * - Linux:  calls `gdbus … CloseNotification <id>` (fire-and-forget).
 * - macOS:  spawns `terminal-notifier -remove <groupId>`.
 * - Other:  no-op (no reliable mechanism).
 *
 * Passing `null` or `undefined` is always a safe no-op.
 *
 * @param {NotificationHandle | null | undefined} handle
 * @param {unknown} client
 * @returns {void}
 */
function closeDesktopNotification(handle, client) {
  if (!handle) return;

  if (handle.platform === 'linux') {
    const args = [
      'call', '--session',
      '--dest', DBUS_DEST,
      '--object-path', DBUS_PATH,
      '--method', `${DBUS_IFACE}.CloseNotification`,
      String(handle.id),
    ];
    let child;
    try {
      child = spawn('gdbus', args, { stdio: 'ignore' });
    } catch (err) {
      logPluginError(client, 'error', `closeDesktopNotification failed to spawn gdbus: ${err.message}`);
      return;
    }
    child.on('error', (err) => {
      logPluginError(client, 'error', `gdbus CloseNotification error: ${err.message}`);
    });
    child.unref();
    return;
  }

  if (handle.platform === 'darwin') {
    const args = ['-remove', handle.groupId];
    let child;
    try {
      child = spawn('terminal-notifier', args, { stdio: 'ignore' });
    } catch (err) {
      logPluginError(client, 'error', `closeDesktopNotification (macOS) failed to spawn terminal-notifier: ${err.message}`);
      return;
    }
    child.on('error', (err) => {
      logPluginError(client, 'error', `terminal-notifier -remove error: ${err.message}`);
    });
    child.unref();
    return;
  }

  // 'other' (Windows, etc.) — no reliable dismiss mechanism
}

/**
 * POSTs `payload` as JSON to every configured webhook URL, concurrently.
 * Errors are logged via `client.app.log` and never propagate.
 *
 * @param {Array<{ url: string; headers?: Record<string, string> }>} webhooks
 * @param {Record<string, unknown>} payload
 * @param {unknown} client
 */
async function dispatchWebhooks(webhooks, payload, client) {
  try {
    const body = JSON.stringify(payload);
    const requests = webhooks.map(({ url, headers = {} }) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body,
      }).catch((err) => {
        logPluginError(client, 'error', `Webhook POST to ${url} failed: ${err.message}`);
      }),
    );

    await Promise.allSettled(requests);
  } catch (err) {
    logPluginError(client, 'error', `Webhook dispatch failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Focus detection
// ---------------------------------------------------------------------------

/**
 * Walks the Linux `/proc` tree from `startPid` upward, returning a Set of
 * all ancestor PIDs (including `startPid` itself).  Falls back gracefully
 * when `/proc` is unavailable — the set will contain at least `startPid` itself.
 *
 * @param {number} startPid  PID to start the upward walk from
 * @returns {Promise<Set<number>>}
 */
async function collectLinuxAncestorPids(startPid) {
  const ancestors = new Set();
  let pid = startPid;
  while (pid > 1) {
    ancestors.add(pid);
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^PPid:\s*(\d+)/m);
      if (!match) break;
      pid = Number(match[1]);
    } catch {
      // /proc unavailable — startPid is already in the set; stop here.
      break;
    }
  }
  return ancestors;
}

/**
 * Returns the PID of the currently focused window on X11 / XWayland by
 * querying two standard X11 properties via `xprop`:
 *
 *   1. `xprop -root _NET_ACTIVE_WINDOW` — reads the active window ID from the
 *      root window.
 *   2. `xprop -id <id> _NET_WM_PID` — reads the owner PID for that window.
 *
 * Returns `null` if `xprop` is unavailable, no window is active, or the
 * focused window does not advertise `_NET_WM_PID`.
 *
 * @returns {Promise<number | null>}
 */
async function getXpropActiveWindowPid() {
  const windowId = await new Promise((resolve) => {
    const child = spawn('xprop', ['-root', '_NET_ACTIVE_WINDOW'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const match = output.match(/0x[0-9a-fA-F]+/);
      resolve(match ? match[0] : null);
    });
  });

  if (!windowId) return null;

  return new Promise((resolve) => {
    const child = spawn('xprop', ['-id', windowId, '_NET_WM_PID'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const match = output.match(/\d+/);
      resolve(match ? parseInt(match[0], 10) : null);
    });
  });
}

/**
 * Returns the PID of the currently focused window via Hyprland's IPC, or
 * `null` if Hyprland is not running, `hyprctl` is unavailable, or the call
 * fails for any reason.
 *
 * @returns {Promise<number | null>}
 */
async function getHyprlandActiveWindowPid() {
  return new Promise((resolve) => {
    const child = spawn('hyprctl', ['activewindow', '-j'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const { pid } = JSON.parse(output);
        resolve(typeof pid === 'number' ? pid : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Returns the PID of the currently focused window via Sway's IPC, or
 * `null` if Sway is not running, `swaymsg` is unavailable, or the call
 * fails for any reason.
 *
 * Uses `swaymsg -t get_tree` and walks the JSON tree for the focused node —
 * `get_focused_view` does not exist in Sway's IPC spec.
 *
 * @returns {Promise<number | null>}
 */
async function getSwaymsgActiveWindowPid() {
  return new Promise((resolve) => {
    const child = spawn('swaymsg', ['-t', 'get_tree'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        /** @param {unknown} node */
        function findFocusedPid(node) {
          if (node === null || typeof node !== 'object') return null;
          const n = /** @type {Record<string, unknown>} */ (node);
          if (n.focused === true && typeof n.pid === 'number') return n.pid;
          for (const value of Object.values(n)) {
            if (Array.isArray(value)) {
              for (const item of value) {
                const found = findFocusedPid(item);
                if (found !== null) return found;
              }
            } else if (value !== null && typeof value === 'object') {
              const found = findFocusedPid(value);
              if (found !== null) return found;
            }
          }
          return null;
        }
        resolve(findFocusedPid(JSON.parse(output)));
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Returns `true` when the currently focused window belongs to the same
 * terminal session that is hosting this Node.js process (i.e. the user is
 * already looking at the opencode window), and `false` otherwise.
 *
 * Strategy (Linux):
 *   1. Obtain the focused window's owner PID via xprop (X11 / XWayland),
 *      Hyprland IPC, or Sway IPC — whichever is available.
 *   2. Walk `/proc` upward from `process.pid` to collect all ancestor PIDs
 *      (the chain: opencode → shell → terminal emulator → display server).
 *   3. Return `true` iff the focused window's PID is in that ancestor chain —
 *      i.e. the terminal emulator (or one of its parents) is the focused window.
 *
 * Always returns `false` on error so that notifications are sent rather than
 * silently dropped.
 *
 * @returns {Promise<boolean>}
 */
async function isOpencodeWindowFocused() {
  try {
    // Wayland-only guard: if running native Wayland with no XWayland,
    // xprop won't work — try compositor IPC instead.
    const nativeWayland = Boolean(process.env.WAYLAND_DISPLAY && !process.env.DISPLAY);

    let windowOwnerPid = null;

    if (!nativeWayland) {
      // X11 or XWayland: query _NET_ACTIVE_WINDOW → _NET_WM_PID via xprop.
      windowOwnerPid = await getXpropActiveWindowPid();
    }

    // Compositor IPC fallbacks — used when xprop returns nothing
    // (including on native Wayland where xprop is skipped entirely).
    if (windowOwnerPid == null && process.env.HYPRLAND_INSTANCE_SIGNATURE) {
      windowOwnerPid = await getHyprlandActiveWindowPid();
    }

    if (windowOwnerPid == null && process.env.SWAYSOCK) {
      windowOwnerPid = await getSwaymsgActiveWindowPid();
    }

    if (windowOwnerPid == null) {
      return false;
    }

    if (process.platform === 'linux') {
      // Walk upward from process.pid (the opencode Node process).  The chain
      // goes: opencode → shell → terminal emulator → display server.
      // If the focused window's PID appears in that ancestry chain, the user
      // is looking at the terminal session that hosts opencode.
      const ancestors = await collectLinuxAncestorPids(process.pid);
      return ancestors.has(windowOwnerPid);
    } else {
      // Non-Linux: no /proc equivalent for deep ancestry.  Best-effort: match
      // if the focused window belongs to the opencode process itself or its
      // direct parent (the terminal emulator that spawned it).
      return windowOwnerPid === process.pid || windowOwnerPid === process.ppid;
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * opencode plugin factory.
 *
 * @param {{ client: { app?: { log?: (arg: unknown) => Promise<unknown> } }; $: unknown }} input  – opencode plugin input; only `client` is consumed
 * @param {{
 *   desktop?: boolean;
 *   webhooks?: Array<{ url: string; headers?: Record<string, string> }>;
 *   onClickCommand?: string;
 *   skipIfFocused?: boolean; // Defaults to true — suppress desktop notifications when the opencode window is focused
 * }} options
 * @returns {Promise<import('@opencode-ai/plugin').Hooks>}
 */
export default async function opencodeNotify({ client }, options = {}) {
  // When loaded via auto-discovery (symlink in plugins/), opencode cannot pass
  // options from opencode.jsonc.  Read the optional config file and merge it
  // under any caller-supplied options so the explicit form always takes
  // precedence (npm-name install with inline options wins over the file).
  const fileOptions = await readConfigFile(client);
  const resolved = { ...fileOptions, ...options };

  const desktopEnabled = resolved.desktop ?? true;
  const webhooks = resolved.webhooks ?? [];
  const onClickCommand = resolved.onClickCommand;

  /**
   * Per-instance desktop-notification circuit breaker. Once a spawn attempt
   * for the platform's notification backend fails (binary missing, no
   * daemon/session bus reachable, etc.), this flips to `true` and every
   * subsequent `sendDesktopNotification` call short-circuits immediately —
   * so a missing notification daemon logs at most once per process
   * lifetime instead of once per event.
   *
   * @type {{ desktopUnavailable: boolean }}
   */
  const notificationState = { desktopUnavailable: false };

  if (desktopEnabled && isDesktopEnvironmentUnavailable()) {
    notificationState.desktopUnavailable = true;
    logPluginError(
      client,
      'info',
      'No graphical session detected (DISPLAY, WAYLAND_DISPLAY, and DBUS_SESSION_BUS_ADDRESS are all unset); desktop notifications disabled for this session.',
    );
  }

  /**
   * Per-event notification toggles.  Each key defaults to `true`; set to
   * `false` in the config file (or inline options) to silence that event
   * for both desktop and webhook channels.
   *
   * Supported keys (all under a `notifications` object):
   *   - `taskFinished`         → session.idle
   *   - `questionAsked`        → question.asked
   *   - `permissionRequested`  → permission.asked (boolean, or an object —
   *                              see `resolveNotificationConfig`)
   *   - `todoCompleted`        → todo.updated
   *   - `sessionError`         → session.error
   */
  const notifCfg = resolved.notifications ?? {};
  const notifyTaskFinished        = notifCfg.taskFinished        ?? true;
  const notifyQuestionAsked       = notifCfg.questionAsked       ?? true;
  const notifyTodoCompleted       = notifCfg.todoCompleted       ?? true;
  const notifySessionError        = notifCfg.sessionError        ?? true;

  /**
   * Permission-request notification config. Accepts either a boolean
   * (legacy enable/disable shorthand) or an object with `enabled`, `urgency`,
   * and `expireTimeoutMs` overrides.
   *
   * Defaults: `urgency: 'normal'` (not `'critical'`) and
   * `expireTimeoutMs: 20000` (auto-dismiss after 20s) rather than never
   * expiring. This matters because opencode's "auto"/allow-all permission
   * mode replies to a permission request almost instantly — if the plugin's
   * async notification send races behind that reply, a `critical` /
   * never-expiring notification is left on screen indefinitely. See the
   * `permission.asked`/`permission.replied` handlers below for the
   * complementary race fix.
   */
  const permissionCfg = resolveNotificationConfig(notifCfg.permissionRequested, {
    enabled: true,
    urgency: 'normal',
    expireTimeoutMs: 20000,
  });
  const notifyPermissionRequested = permissionCfg.enabled;

  /**
   * Cache of sessionID → session title.
   * Populated by `session.created` and `session.updated`; consumed by
   * `permission.asked` and `todo.updated`.
   *
   * @type {Map<string, string>}
   */
  const sessionTitleCache = new Map();

  /**
   * Cache of sessionID → Map<todoContent, status>.
   * Tracks the last-known status of each todo per session so the `todo.updated`
   * handler can detect transitions to `"completed"`. Uses todo content as the
   * key because `todo.updated` payloads do not include an `id` field.
   *
   * @type {Map<string, Map<string, string>>}
   */
  const todoStateCache = new Map();

  /**
   * Cache of permission requestID → NotificationHandle.
   * Populated when a `permission.asked` notification is sent; consumed (and
   * deleted) when the corresponding `permission.replied` event fires so the
   * in-flight notification can be dismissed.
   *
   * @type {Map<string, NotificationHandle>}
   */
  const permissionNotifHandleCache = new Map();

  /**
   * Set of permission requestIDs that received a `permission.replied` event
   * before their `permission.asked` notification finished sending (i.e.
   * before `permissionNotifHandleCache` had a handle to close). This race
   * happens routinely under opencode's "auto"/allow-all permission mode,
   * which replies to a request almost instantly — well within the time it
   * takes to spawn `gdbus`/`terminal-notifier` and get a handle back. Without
   * this cache, such a notification would never be closed and would linger
   * on screen indefinitely (worse, permanently, given `critical` urgency
   * previously never expired). Consumed the moment the notify call resolves
   * — see the `permission.asked` handler.
   *
   * @type {Set<string>}
   */
  const permissionRepliedEarlyCache = new Set();

  /**
   * Cache of question requestID → NotificationHandle.
   * Populated when a `question.asked` notification is sent; consumed (and
   * deleted) when the corresponding `question.replied` or `question.rejected`
   * event fires so the in-flight notification can be dismissed.
   *
   * @type {Map<string, NotificationHandle>}
   */
  const questionNotifHandleCache = new Map();

  return {
    /**
     * Handles all opencode events.  Unrecognised event types are silently
     * ignored so the plugin remains forward-compatible.
     *
     * @param {{ event: import('@opencode-ai/plugin').Event }} param0
     */
    async event({ event }) {
      switch (event.type) {
        // -----------------------------------------------------------------
        // Keep the title cache up to date
        // -----------------------------------------------------------------
        case 'session.created':
        case 'session.updated': {
          const { id, title } = event.properties.info;
          sessionTitleCache.set(id, title);
          break;
        }

        // -----------------------------------------------------------------
        // Permission request
        // -----------------------------------------------------------------
        case 'permission.asked': {
          if (!notifyPermissionRequested) break;

          const permission = event.properties;
          const { id: requestID, sessionID } = permission;
          const sessionTitle = resolveSessionTitle(sessionTitleCache, sessionID);

          if (desktopEnabled) {
            // permission requests always notify regardless of focus — the terminal
            // is almost always focused when a permission fires.
            // Await the handle so we can dismiss the notification on permission.replied.
            // If a duplicate permission.asked arrives for the same requestID,
            // close the previous notification first.
            if (permissionNotifHandleCache.has(requestID)) {
              closeDesktopNotification(permissionNotifHandleCache.get(requestID), client);
              permissionNotifHandleCache.delete(requestID);
            }

            const handle = await sendDesktopNotification({
              title: 'opencode \u2013 Permission Request',
              message: `${permission.permission}\n${sessionTitle}`,
              urgency: permissionCfg.urgency,
              expireTimeoutMs: permissionCfg.expireTimeoutMs,
              groupId: requestID,
              onClickCommand,
            }, client, notificationState);

            // If `permission.replied` already fired while we were awaiting the
            // notify call above (the race described on `permissionRepliedEarlyCache`),
            // close the notification immediately instead of caching it as open.
            const repliedEarly = permissionRepliedEarlyCache.delete(requestID);
            if (handle !== null) {
              if (repliedEarly) {
                closeDesktopNotification(handle, client);
              } else {
                permissionNotifHandleCache.set(requestID, handle);

                // Cross-platform (Linux + macOS) fallback auto-dismiss: several
                // notification daemons ignore the native `expire_timeout` hint
                // entirely, or specifically for `critical` urgency (see
                // `sendDesktopNotificationLinux`), so we also close the
                // notification ourselves after `expireTimeoutMs`.
                if (permissionCfg.expireTimeoutMs > 0) {
                  const timer = setTimeout(() => {
                    if (permissionNotifHandleCache.get(requestID) === handle) {
                      closeDesktopNotification(handle, client);
                      permissionNotifHandleCache.delete(requestID);
                    }
                  }, permissionCfg.expireTimeoutMs);
                  timer.unref?.();
                }
              }
            }
          }

          if (webhooks.length > 0) {
            await dispatchWebhooks(webhooks, {
              event: 'permission_request',
              sessionID,
              sessionTitle,
              permissionTitle: permission.permission,
            }, client);
          }
          break;
        }

        // -----------------------------------------------------------------
        // Permission replied — dismiss the in-flight notification
        // -----------------------------------------------------------------
        case 'permission.replied': {
          const { requestID } = event.properties;
          if (permissionNotifHandleCache.has(requestID)) {
            closeDesktopNotification(permissionNotifHandleCache.get(requestID), client);
            permissionNotifHandleCache.delete(requestID);
          } else if (desktopEnabled && notifyPermissionRequested) {
            // The notify call for this request hasn't resolved yet (see the
            // race documented on `permissionRepliedEarlyCache`) — remember it
            // so `permission.asked` closes the notification the instant it's
            // created instead of leaving it cached as still-open. Only worth
            // remembering when a notify call could plausibly still be in
            // flight — otherwise (desktop notifications disabled entirely,
            // or this event silenced) this Set would grow unboundedly for
            // the lifetime of the process with entries that are never
            // consumed, since `permission.asked` never reaches the code that
            // deletes them.
            permissionRepliedEarlyCache.add(requestID);
          }
          break;
        }

        // -----------------------------------------------------------------
        // Todo completed
        // -----------------------------------------------------------------
        case 'todo.updated': {
          if (!notifyTodoCompleted) break;

          const { sessionID, todos } = event.properties;
          const sessionTitle = resolveSessionTitle(sessionTitleCache, sessionID);

          // Get or create the per-session state map
          let sessionTodos = todoStateCache.get(sessionID);
          const isFirstSeen = !sessionTodos;
          if (isFirstSeen) {
            // First time we see this session's todos: initialise the cache but
            // do NOT fire for already-completed items (they were completed
            // before the plugin started).
            sessionTodos = new Map();
            todoStateCache.set(sessionID, sessionTodos);
          }

          const skip =
            desktopEnabled &&
            resolved.skipIfFocused !== false &&
            (await isOpencodeWindowFocused());

          for (const todo of todos) {
            const prevStatus = sessionTodos.get(todo.content);
            const isNewlyCompleted =
              !isFirstSeen && prevStatus !== 'completed' && todo.status === 'completed';

            if (isNewlyCompleted) {
              if (desktopEnabled && !skip) {
                sendDesktopNotification({
                  title: 'opencode \u2013 Todo Done',
                  message: `${todo.content}\n${sessionTitle}`,
                  onClickCommand,
                }, client, notificationState);
              }

              if (webhooks.length > 0) {
                await dispatchWebhooks(webhooks, {
                  event: 'todo_completed',
                  sessionID,
                  sessionTitle,
                  todoContent: todo.content,
                }, client);
              }
            }

            // Update the tracker
            sessionTodos.set(todo.content, todo.status);
          }
          break;
        }

        // -----------------------------------------------------------------
        // Session idle (task finished)
        // -----------------------------------------------------------------
        case 'session.idle': {
          if (!notifyTaskFinished) break;

          const { sessionID } = event.properties;
          const sessionTitle = resolveSessionTitle(sessionTitleCache, sessionID);

          if (desktopEnabled) {
            const skip =
              resolved.skipIfFocused !== false && (await isOpencodeWindowFocused());
            if (!skip) {
              sendDesktopNotification({
                title: 'opencode \u2013 Task Done',
                message: sessionTitle,
                onClickCommand,
              }, client, notificationState);
            }
          }

          if (webhooks.length > 0) {
            await dispatchWebhooks(webhooks, {
              event: 'session_idle',
              sessionID,
              sessionTitle,
            }, client);
          }
          break;
        }

        // -----------------------------------------------------------------
        // Session error
        // -----------------------------------------------------------------
        case 'session.error': {
          if (!notifySessionError) break;

          const { sessionID = 'unknown' } = event.properties;
          const sessionTitle = resolveSessionTitle(sessionTitleCache, sessionID);

          if (desktopEnabled) {
            const skip =
              resolved.skipIfFocused !== false && (await isOpencodeWindowFocused());
            if (!skip) {
              sendDesktopNotification({
                title: 'opencode \u2013 Session Error',
                message: sessionTitle,
                urgency: 'critical',
                onClickCommand,
              }, client, notificationState);
            }
          }

          if (webhooks.length > 0) {
            await dispatchWebhooks(webhooks, {
              event: 'session_error',
              sessionID,
              sessionTitle,
            }, client);
          }
          break;
        }

        // -----------------------------------------------------------------
        // Question asked
        // -----------------------------------------------------------------
        case 'question.asked': {
          if (!notifyQuestionAsked) break;

          const { id: requestID, sessionID, questions = [] } = event.properties;
          const sessionTitle = resolveSessionTitle(sessionTitleCache, sessionID);
          const notifTitle = questions[0]?.header
            ? `opencode \u2013 ${questions[0].header}`
            : 'opencode \u2013 Question';
          const notifMessage = questions[0]?.question ?? sessionTitle;

          if (desktopEnabled) {
            // questions must always reach the user regardless of focus state.
            // Await the handle so we can dismiss the notification on question.replied
            // or question.rejected. If a duplicate question.asked arrives for the
            // same requestID, close the previous notification first.
            if (questionNotifHandleCache.has(requestID)) {
              closeDesktopNotification(questionNotifHandleCache.get(requestID), client);
              questionNotifHandleCache.delete(requestID);
            }

            const handle = await sendDesktopNotification({
              title: notifTitle,
              message: notifMessage,
              onClickCommand,
            }, client, notificationState);
            if (handle !== null) {
              questionNotifHandleCache.set(requestID, handle);
            }
          }

          if (webhooks.length > 0) {
            await dispatchWebhooks(webhooks, {
              event: 'question_asked',
              sessionID,
              sessionTitle,
              questionHeader: questions[0]?.header,
              questionBody: questions[0]?.question,
            }, client);
          }
          break;
        }

        // -----------------------------------------------------------------
        // Question replied / rejected — dismiss the in-flight notification
        // -----------------------------------------------------------------
        case 'question.replied':
        case 'question.rejected': {
          const { requestID } = event.properties;
          closeDesktopNotification(questionNotifHandleCache.get(requestID), client);
          questionNotifHandleCache.delete(requestID);
          break;
        }

        // Silently ignore any future event types
        default:
          break;
      }
    },
  };
}
