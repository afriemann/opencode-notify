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
 * empty) options object.  Any read or parse error is logged to stderr and
 * treated as "no config" so the plugin still starts with defaults.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function readConfigFile() {
  try {
    const raw = await readFile(CONFIG_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('[opencode-notify] Config file must be a JSON object; ignoring.');
      return {};
    }
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[opencode-notify] Could not read config file (${CONFIG_FILE_PATH}):`, err.message);
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
 * }} opts
 * @returns {Promise<NotificationHandle | null>}
 */
function sendDesktopNotification({ title, message, urgency, groupId, onClickCommand }) {
  if (process.platform === 'linux') {
    return sendDesktopNotificationLinux({ title, message, urgency, onClickCommand });
  }

  if (process.platform === 'darwin') {
    return sendDesktopNotificationMac({ title, message, groupId });
  }

  return sendDesktopNotificationWindows({ title, message });
}

/**
 * macOS implementation — spawns `terminal-notifier` directly.
 * Requires `terminal-notifier` to be installed (e.g. `brew install terminal-notifier`).
 *
 * @param {{ title: string; message: string; groupId?: string }} opts
 * @returns {Promise<NotificationHandle | null>}
 */
function sendDesktopNotificationMac({ title, message, groupId }) {
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
    console.error('[opencode-notify] Failed to spawn terminal-notifier:', err);
    return Promise.resolve(null);
  }
  child.on('error', (err) => {
    console.error('[opencode-notify] terminal-notifier error:', err);
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
 * @returns {Promise<NotificationHandle | null>}
 */
function sendDesktopNotificationWindows({ title, message }) {
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
    console.error('[opencode-notify] Failed to spawn powershell for toast notification:', err);
    return Promise.resolve(null);
  }
  child.on('error', (err) => {
    console.error('[opencode-notify] powershell toast error:', err);
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
 * @param {{
 *   title: string;
 *   message: string;
 *   urgency?: string;
 *   onClickCommand?: string;
 * }} opts
 * @returns {Promise<NotificationHandle | null>}
 */
function sendDesktopNotificationLinux({ title, message, urgency, onClickCommand }) {
  // Map string urgency name → D-Bus byte value
  const urgencyByte = urgency === 'critical' ? 2 : urgency === 'low' ? 0 : 1;
  const hintsArg = `{'urgency': <byte ${urgencyByte}>}`;

  // expire_timeout: 0 = notification server decides (never expires for critical)
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
    '0',                      // expire_timeout
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gdbus', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.error('[opencode-notify] Failed to spawn gdbus:', err);
      resolve(null);
      return;
    }

    child.on('error', (err) => {
      console.error('[opencode-notify] gdbus Notify failed:', err);
      resolve(null);
    });

    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });

    child.stdout.on('close', () => {
      // D-Bus Notify returns "(uint32 NNN,)"
      const match = stdout.match(/\(uint32 (\d+),\)/);
      if (!match) {
        console.error('[opencode-notify] gdbus Notify returned unexpected output:', stdout.trim());
        resolve(null);
        return;
      }
      const id = Number(match[1]);
      resolve({ platform: 'linux', id });

      // Fire-and-forget: subscribe to ActionInvoked so the "Focus opencode"
      // button still works.  The monitor process exits on its own once the
      // notification is dismissed or times out.
      if (onClickCommand) {
        subscribeLinuxActionInvoked(id, onClickCommand);
      }
    });

    child.stderr.on('data', (chunk) => {
      console.error('[opencode-notify] gdbus Notify stderr:', chunk.toString().trim());
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
 */
function subscribeLinuxActionInvoked(id, onClickCommand) {
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
    console.error('[opencode-notify] Failed to spawn gdbus monitor:', err);
    return;
  }

  monitor.on('error', (err) => {
    console.error('[opencode-notify] gdbus monitor error:', err);
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
          if (err) console.error('[opencode-notify] onClickCommand failed:', err);
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
 * @returns {void}
 */
function closeDesktopNotification(handle) {
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
      console.error('[opencode-notify] closeDesktopNotification failed to spawn gdbus:', err);
      return;
    }
    child.on('error', (err) => {
      console.error('[opencode-notify] gdbus CloseNotification error:', err);
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
      console.error('[opencode-notify] closeDesktopNotification (macOS) failed to spawn terminal-notifier:', err);
      return;
    }
    child.on('error', (err) => {
      console.error('[opencode-notify] terminal-notifier -remove error:', err);
    });
    child.unref();
    return;
  }

  // 'other' (Windows, etc.) — no reliable dismiss mechanism
}

/**
 * POSTs `payload` as JSON to every configured webhook URL, concurrently.
 * Errors are logged to stderr and never propagate.
 *
 * @param {Array<{ url: string; headers?: Record<string, string> }>} webhooks
 * @param {Record<string, unknown>} payload
 */
async function dispatchWebhooks(webhooks, payload) {
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
        console.error(`[opencode-notify] Webhook POST to ${url} failed:`, err);
      }),
    );

    await Promise.allSettled(requests);
  } catch (err) {
    console.error('[opencode-notify] Webhook dispatch failed:', err);
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
 *   1. Obtain the focused window's owner PID via get-windows (X11 / XWayland),
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
    // get-windows won't work — try compositor IPC instead.
    const nativeWayland = Boolean(process.env.WAYLAND_DISPLAY && !process.env.DISPLAY);

    let windowOwnerPid = null;

    if (!nativeWayland) {
      // X11 or XWayland: get-windows queries the active window via Xlib/XCB.
      const { activeWindow } = await import('get-windows');
      const activeWindowResult = await activeWindow();
      if (activeWindowResult != null) {
        windowOwnerPid = activeWindowResult.owner.processId;
      }
    }

    // Compositor IPC fallbacks — used when get-windows returns nothing
    // (including on native Wayland where get-windows is skipped entirely).
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
 * @param {{ client: unknown; $: unknown }} input  – opencode plugin input (unused directly)
 * @param {{
 *   desktop?: boolean;
 *   webhooks?: Array<{ url: string; headers?: Record<string, string> }>;
 *   onClickCommand?: string;
 *   skipIfFocused?: boolean; // Defaults to true — suppress desktop notifications when the opencode window is focused
 * }} options
 * @returns {Promise<import('@opencode-ai/plugin').Hooks>}
 */
export default async function opencodeNotify(_input, options = {}) {
  // When loaded via auto-discovery (symlink in plugins/), opencode cannot pass
  // options from opencode.jsonc.  Read the optional config file and merge it
  // under any caller-supplied options so the explicit form always takes
  // precedence (npm-name install with inline options wins over the file).
  const fileOptions = await readConfigFile();
  const resolved = { ...fileOptions, ...options };

  const desktopEnabled = resolved.desktop ?? true;
  const webhooks = resolved.webhooks ?? [];
  const onClickCommand = resolved.onClickCommand;

  /**
   * Per-event notification toggles.  Each key defaults to `true`; set to
   * `false` in the config file (or inline options) to silence that event
   * for both desktop and webhook channels.
   *
   * Supported keys (all under a `notifications` object):
   *   - `taskFinished`         → session.idle
   *   - `questionAsked`        → question.asked
   *   - `permissionRequested`  → permission.asked
   *   - `todoCompleted`        → todo.updated
   *   - `sessionError`         → session.error
   */
  const notifCfg = resolved.notifications ?? {};
  const notifyTaskFinished        = notifCfg.taskFinished        ?? true;
  const notifyQuestionAsked       = notifCfg.questionAsked       ?? true;
  const notifyPermissionRequested = notifCfg.permissionRequested ?? true;
  const notifyTodoCompleted       = notifCfg.todoCompleted       ?? true;
  const notifySessionError        = notifCfg.sessionError        ?? true;

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
              closeDesktopNotification(permissionNotifHandleCache.get(requestID));
              permissionNotifHandleCache.delete(requestID);
            }

            const handle = await sendDesktopNotification({
              title: 'opencode \u2013 Permission Request',
              message: `${permission.permission}\n${sessionTitle}`,
              urgency: 'critical',
              groupId: requestID,
              onClickCommand,
            });
            if (handle !== null) {
              permissionNotifHandleCache.set(requestID, handle);
            }
          }

          if (webhooks.length > 0) {
            await dispatchWebhooks(webhooks, {
              event: 'permission_request',
              sessionID,
              sessionTitle,
              permissionTitle: permission.permission,
            });
          }
          break;
        }

        // -----------------------------------------------------------------
        // Permission replied — dismiss the in-flight notification
        // -----------------------------------------------------------------
        case 'permission.replied': {
          const { requestID } = event.properties;
          closeDesktopNotification(permissionNotifHandleCache.get(requestID));
          permissionNotifHandleCache.delete(requestID);
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
                });
              }

              if (webhooks.length > 0) {
                await dispatchWebhooks(webhooks, {
                  event: 'todo_completed',
                  sessionID,
                  sessionTitle,
                  todoContent: todo.content,
                });
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
              });
            }
          }

          if (webhooks.length > 0) {
            await dispatchWebhooks(webhooks, {
              event: 'session_idle',
              sessionID,
              sessionTitle,
            });
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
              });
            }
          }

          if (webhooks.length > 0) {
            await dispatchWebhooks(webhooks, {
              event: 'session_error',
              sessionID,
              sessionTitle,
            });
          }
          break;
        }

        // -----------------------------------------------------------------
        // Question asked
        // -----------------------------------------------------------------
        case 'question.asked': {
          if (!notifyQuestionAsked) break;

          const { sessionID, questions = [] } = event.properties;
          const sessionTitle = resolveSessionTitle(sessionTitleCache, sessionID);
          const notifTitle = questions[0]?.header
            ? `opencode \u2013 ${questions[0].header}`
            : 'opencode \u2013 Question';
          const notifMessage = questions[0]?.question ?? sessionTitle;

          if (desktopEnabled) {
            // questions must always reach the user regardless of focus state
            sendDesktopNotification({
              title: notifTitle,
              message: notifMessage,
              onClickCommand,
            });
          }

          if (webhooks.length > 0) {
            await dispatchWebhooks(webhooks, {
              event: 'question_asked',
              sessionID,
              sessionTitle,
              questionHeader: questions[0]?.header,
              questionBody: questions[0]?.question,
            });
          }
          break;
        }

        // Silently ignore any future event types
        default:
          break;
      }
    },
  };
}
