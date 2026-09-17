/**
 * opencode-notify – runtime-agnostic core.
 *
 * Holds every notification behavior that does NOT depend on which opencode
 * plugin API (V1 or V2) is hosting this plugin: OS notification back-ends
 * (Linux D-Bus, macOS `terminal-notifier`, Windows PowerShell toast), window-
 * focus detection (xprop/Hyprland/Sway), webhook dispatch, config-file
 * reading, and all per-session/per-request state (title cache, todo
 * transition tracking, notification-handle caches, the permission-reply race
 * fix).
 *
 * Consumes a `NormalizedEvent` union (design.md) instead of either runtime's
 * raw event shape — neither `@opencode-ai/plugin` nor `@opencode/plugin` is
 * ever imported here. `src/plugin.v1.js` and `src/plugin.v2.js` are the only
 * files that know each runtime's raw event shapes; both translate into this
 * module's vocabulary and call `notifier.handle(normalizedEvent)`.
 */

import { open, readFile } from 'node:fs/promises';
import { spawn, exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// NormalizedEvent kinds this core module handles (design.md's table).
// Each adapter exports its own PRODUCIBLE_KINDS subset for the cross-check
// test asserting it never claims to produce a kind core doesn't handle.
// ---------------------------------------------------------------------------

export const SUPPORTED_KINDS = Object.freeze([
  'session-titled',
  'permission-asked',
  'permission-replied',
  'todos-updated',
  'session-idle',
  'session-failed',
  'prompt-asked',
  'prompt-resolved',
]);

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
 * is loaded via auto-discovery. When opencode loads a plugin by path rather
 * than npm name, it cannot pass options from `opencode.jsonc`, so we fall
 * back to this file.
 *
 * The file is optional — absence is not an error and results in all defaults.
 */
export const CONFIG_FILE_PATH = join(homedir(), '.config', 'opencode', 'opencode-notify.json');

/**
 * Reads and parses the optional per-user config file. Returns a (possibly
 * empty) options object. Any read or parse error is logged via the injected
 * `log` function and treated as "no config" so the plugin still starts with
 * defaults.
 *
 * @param {(level: string, message: string, extra?: Record<string, unknown>) => void} log
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readConfigFile(log) {
  try {
    const raw = await readFile(CONFIG_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log('warn', 'Config file must be a JSON object; ignoring.', { path: CONFIG_FILE_PATH });
      return {};
    }
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('error', `Could not read config file (${CONFIG_FILE_PATH}): ${err.message}`, { path: CONFIG_FILE_PATH });
    }
    return {};
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a per-event notification config value that may be either the
 * legacy boolean shorthand (enable/disable only) or an object of overrides
 * for that event's notification behaviour (e.g. `urgency`, `expireTimeoutMs`).
 *
 * @template {{ enabled: boolean }} T
 * @param {boolean | Partial<T> | null | undefined} value
 * @param {T} defaults
 * @returns {T}
 */
export function resolveNotificationConfig(value, defaults) {
  if (typeof value === 'boolean') {
    return { ...defaults, enabled: value };
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ...defaults, ...value };
  }
  return defaults;
}

/**
 * Returns `true` when no graphical/D-Bus session is detectable on Linux.
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
// D-Bus constants (Linux)
// ---------------------------------------------------------------------------

const DBUS_DEST = 'org.freedesktop.Notifications';
const DBUS_PATH = '/org/freedesktop/Notifications';
const DBUS_IFACE = 'org.freedesktop.Notifications';

// ---------------------------------------------------------------------------
// sendDesktopNotification (Linux / macOS / Windows back-ends, unchanged from V1)
// ---------------------------------------------------------------------------

function sendDesktopNotification({ title, message, urgency, groupId, onClickCommand, expireTimeoutMs }, log, notificationState) {
  if (notificationState.desktopUnavailable) {
    return Promise.resolve(null);
  }
  if (process.platform === 'linux') {
    return sendDesktopNotificationLinux({ title, message, urgency, onClickCommand, expireTimeoutMs }, log, notificationState);
  }
  if (process.platform === 'darwin') {
    return sendDesktopNotificationMac({ title, message, groupId }, log, notificationState);
  }
  return sendDesktopNotificationWindows({ title, message }, log, notificationState);
}

function sendDesktopNotificationMac({ title, message, groupId }, log, notificationState) {
  const resolvedGroupId = groupId ?? randomUUID();
  const args = ['-title', title, '-message', message, '-appIcon', ICON_PATH, '-group', resolvedGroupId];

  let child;
  try {
    child = spawn('terminal-notifier', args, { stdio: 'ignore' });
  } catch (err) {
    notificationState.desktopUnavailable = true;
    log('error', `Failed to spawn terminal-notifier: ${err.message}`);
    return Promise.resolve(null);
  }
  child.on('error', (err) => {
    notificationState.desktopUnavailable = true;
    log('error', `terminal-notifier error: ${err.message}`);
  });
  child.unref();

  return Promise.resolve({ platform: 'darwin', groupId: resolvedGroupId });
}

function sendDesktopNotificationWindows({ title, message }, log, notificationState) {
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

  const encoded = Buffer.from(ps, 'utf16le').toString('base64');

  let child;
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore' });
  } catch (err) {
    notificationState.desktopUnavailable = true;
    log('error', `Failed to spawn powershell for toast notification: ${err.message}`);
    return Promise.resolve(null);
  }
  child.on('error', (err) => {
    notificationState.desktopUnavailable = true;
    log('error', `powershell toast error: ${err.message}`);
  });
  child.unref();

  return Promise.resolve({ platform: 'other', groupId: null });
}

function sendDesktopNotificationLinux({ title, message, urgency, onClickCommand, expireTimeoutMs }, log, notificationState) {
  const urgencyByte = urgency === 'critical' ? 2 : urgency === 'low' ? 0 : 1;
  const hintsArg = `{'urgency': <byte ${urgencyByte}>}`;
  const expireTimeoutArg = String(expireTimeoutMs ?? 0);
  const args = [
    'call', '--session',
    '--dest', DBUS_DEST,
    '--object-path', DBUS_PATH,
    '--method', `${DBUS_IFACE}.Notify`,
    'opencode', '0', ICON_PATH, title, message,
    "['default', 'Focus opencode']",
    hintsArg, expireTimeoutArg,
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gdbus', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      notificationState.desktopUnavailable = true;
      log('error', `Failed to spawn gdbus: ${err.message}`);
      resolve(null);
      return;
    }

    child.on('error', (err) => {
      notificationState.desktopUnavailable = true;
      log('error', `gdbus Notify failed: ${err.message}`);
      resolve(null);
    });

    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });

    child.stdout.on('close', () => {
      const match = stdout.match(/\(uint32 (\d+),\)/);
      if (!match) {
        log('error', `gdbus Notify returned unexpected output: ${stdout.trim()}`);
        resolve(null);
        return;
      }
      const id = Number(match[1]);
      resolve({ platform: 'linux', id });

      if (onClickCommand) {
        subscribeLinuxActionInvoked(id, onClickCommand, log);
      }
    });

    child.stderr.on('data', (chunk) => {
      log('error', `gdbus Notify stderr: ${chunk.toString().trim()}`);
    });
  });
}

function subscribeLinuxActionInvoked(id, onClickCommand, log) {
  let monitor;
  try {
    monitor = spawn('gdbus', ['monitor', '--session', '--dest', DBUS_DEST, '--object-path', DBUS_PATH], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    log('error', `Failed to spawn gdbus monitor: ${err.message}`);
    return;
  }

  monitor.on('error', (err) => {
    log('error', `gdbus monitor error: ${err.message}`);
  });

  let buffer = '';
  monitor.stdout.setEncoding('utf8');
  monitor.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const actionMatch = line.match(/ActionInvoked \(uint32 (\d+), '([^']+)'\)/);
      if (actionMatch && Number(actionMatch[1]) === id && actionMatch[2] === 'default') {
        const cmd = onClickCommand.replaceAll('${NODE_PID}', String(process.pid));
        exec(cmd, (err) => {
          if (err) log('error', `onClickCommand failed: ${err.message}`);
        });
        monitor.kill();
        return;
      }

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

function closeDesktopNotification(handle, log) {
  if (!handle) return;

  if (handle.platform === 'linux') {
    const args = ['call', '--session', '--dest', DBUS_DEST, '--object-path', DBUS_PATH, '--method', `${DBUS_IFACE}.CloseNotification`, String(handle.id)];
    let child;
    try {
      child = spawn('gdbus', args, { stdio: 'ignore' });
    } catch (err) {
      log('error', `closeDesktopNotification failed to spawn gdbus: ${err.message}`);
      return;
    }
    child.on('error', (err) => {
      log('error', `gdbus CloseNotification error: ${err.message}`);
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
      log('error', `closeDesktopNotification (macOS) failed to spawn terminal-notifier: ${err.message}`);
      return;
    }
    child.on('error', (err) => {
      log('error', `terminal-notifier -remove error: ${err.message}`);
    });
    child.unref();
    return;
  }
  // 'other' (Windows, etc.) — no reliable dismiss mechanism
}

async function dispatchWebhooks(webhooks, payload, log) {
  try {
    const body = JSON.stringify(payload);
    const requests = webhooks.map(({ url, headers = {} }) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }).catch((err) => {
        log('error', `Webhook POST to ${url} failed: ${err.message}`);
      }),
    );
    await Promise.allSettled(requests);
  } catch (err) {
    log('error', `Webhook dispatch failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Terminal bell
// ---------------------------------------------------------------------------

/**
 * Rings the terminal bell (ASCII BEL, `\x07`) by writing directly to the
 * controlling terminal device (`/dev/tty`) rather than `process.stdout` —
 * writing to this plugin's own stdout would interleave with (or be silently
 * swallowed by) opencode's own TUI rendering pipeline, since that stream is
 * not the real terminal screen buffer opencode itself owns.
 *
 * This is a deliberately terminal-mediated, window-manager-agnostic
 * mechanism: terminal emulators that implement "bell requests attention"
 * behaviour (Ghostty >=1.2.0, kitty, foot, alacritty, wezterm, xterm,
 * gnome-terminal, ...) mark their own window urgent/attention-requesting
 * using whichever protocol is correct for the current platform and window
 * manager (Wayland `xdg_activation_v1`, X11 `_NET_WM_STATE_DEMANDS_ATTENTION`,
 * etc.) — this plugin needs no compositor- or WM-specific IPC code at all.
 * A terminal with no such support just beeps (or does nothing); this is a
 * cheap, best-effort addition to the desktop-notification channel, not a
 * replacement for it.
 *
 * POSIX-only (no-op on `win32`, which has no `/dev/tty` equivalent). Silent
 * and best-effort: a missing controlling terminal (no TTY attached, running
 * headless, etc.) is logged once via `notificationState.bellUnavailable` and
 * never retried for the remainder of the process, so an unavailable TTY
 * doesn't spam the log once per event.
 *
 * @param {(level: string, message: string, extra?: Record<string, unknown>) => void} log
 * @param {{ bellUnavailable: boolean }} notificationState
 * @returns {Promise<void>}
 */
async function ringTerminalBell(log, notificationState) {
  if (notificationState.bellUnavailable || process.platform === 'win32') return;

  let handle;
  try {
    handle = await open('/dev/tty', 'w');
    await handle.write('\x07');
  } catch (err) {
    notificationState.bellUnavailable = true;
    log('info', `Terminal bell unavailable (no controlling tty?): ${err.message}`);
    return;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Shared focus-gated dispatch for the two independent attention channels
 * (desktop notification and terminal bell) used by the `session-idle` and
 * `session-failed` handlers — both suppress on focus identically and differ
 * only in what `sendDesktop` sends, so the gating logic lives here once
 * rather than being copy-pasted per event.
 *
 * @param {object} input
 * @param {boolean} input.desktopEnabled
 * @param {boolean} input.terminalBellEnabled
 * @param {boolean} input.skipIfFocused  Resolved `skipIfFocused` option (`resolved.skipIfFocused !== false`)
 * @param {() => void} input.sendDesktop  Invoked (only if `desktopEnabled`) when not suppressed by focus
 * @param {(level: string, message: string, extra?: Record<string, unknown>) => void} input.log
 * @param {{ bellUnavailable: boolean }} input.notificationState
 * @returns {Promise<void>}
 */
async function fireFocusGatedNotification({
  desktopEnabled,
  terminalBellEnabled,
  skipIfFocused,
  sendDesktop,
  log,
  notificationState,
}) {
  if (!desktopEnabled && !terminalBellEnabled) return;

  const skip = skipIfFocused && (await isOpencodeWindowFocused());
  if (skip) return;

  if (desktopEnabled) sendDesktop();
  if (terminalBellEnabled) await ringTerminalBell(log, notificationState);
}

// ---------------------------------------------------------------------------
// Focus detection (unchanged from V1)
// ---------------------------------------------------------------------------

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
      break;
    }
  }
  return ancestors;
}

async function getXpropActiveWindowPid() {
  const windowId = await new Promise((resolve) => {
    const child = spawn('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { stdio: ['ignore', 'pipe', 'ignore'] });
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
    const child = spawn('xprop', ['-id', windowId, '_NET_WM_PID'], { stdio: ['ignore', 'pipe', 'ignore'] });
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

async function getHyprlandActiveWindowPid() {
  return new Promise((resolve) => {
    const child = spawn('hyprctl', ['activewindow', '-j'], { stdio: ['ignore', 'pipe', 'ignore'] });
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

async function getSwaymsgActiveWindowPid() {
  return new Promise((resolve) => {
    const child = spawn('swaymsg', ['-t', 'get_tree'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        function findFocusedPid(node) {
          if (node === null || typeof node !== 'object') return null;
          if (node.focused === true && typeof node.pid === 'number') return node.pid;
          for (const value of Object.values(node)) {
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

async function isOpencodeWindowFocused() {
  try {
    const nativeWayland = Boolean(process.env.WAYLAND_DISPLAY && !process.env.DISPLAY);
    let windowOwnerPid = null;

    if (!nativeWayland) {
      windowOwnerPid = await getXpropActiveWindowPid();
    }
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
      const ancestors = await collectLinuxAncestorPids(process.pid);
      return ancestors.has(windowOwnerPid);
    }
    return windowOwnerPid === process.pid || windowOwnerPid === process.ppid;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// createNotifier — the single runtime-agnostic entry point
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   desktop?: boolean;
 *   terminalBell?: boolean;
 *   webhooks?: Array<{ url: string; headers?: Record<string, string> }>;
 *   onClickCommand?: string;
 *   skipIfFocused?: boolean;
 *   notifications?: Record<string, unknown>;
 *   _todoConfiguredExplicitly?: boolean;
 * }} resolved  Already-merged config (file + inline options); see each adapter.
 * @param {{ log: (level: string, message: string, extra?: Record<string, unknown>) => void }} deps
 */
export function createNotifier(resolved, { log }) {
  const desktopEnabled = resolved.desktop ?? true;
  const webhooks = resolved.webhooks ?? [];
  const onClickCommand = resolved.onClickCommand;

  /**
   * Enables the terminal-bell channel (see `ringTerminalBell`). Independent
   * of `desktopEnabled` — the bell needs no `DISPLAY`/`WAYLAND_DISPLAY`/D-Bus
   * session, so it works over SSH and in other headless-desktop contexts
   * where desktop notifications are unavailable.
   */
  const terminalBellEnabled = resolved.terminalBell ?? true;

  const notificationState = { desktopUnavailable: false, bellUnavailable: false };
  if (desktopEnabled && isDesktopEnvironmentUnavailable()) {
    notificationState.desktopUnavailable = true;
    log('info', 'No graphical session detected (DISPLAY, WAYLAND_DISPLAY, and DBUS_SESSION_BUS_ADDRESS are all unset); desktop notifications disabled for this session.');
  }

  const notifCfg = resolved.notifications ?? {};
  const notifyTaskFinished = notifCfg.taskFinished ?? true;
  const notifyQuestionAsked = notifCfg.questionAsked ?? true;
  const notifyTodoCompleted = notifCfg.todoCompleted ?? true;
  const notifySessionError = notifCfg.sessionError ?? true;

  const permissionCfg = resolveNotificationConfig(notifCfg.permissionRequested, {
    enabled: true,
    urgency: 'critical',
    expireTimeoutMs: 0,
  });
  const notifyPermissionRequested = permissionCfg.enabled;

  /** @type {Map<string, string>} sessionID -> title */
  const sessionTitleCache = new Map();
  /** @type {Map<string, Map<string, string>>} sessionID -> (todoContent -> status) */
  const todoStateCache = new Map();
  /** @type {Map<string, unknown>} requestID -> NotificationHandle */
  const permissionNotifHandleCache = new Map();
  /** @type {Set<string>} requestIDs replied-to before their notify call resolved */
  const permissionRepliedEarlyCache = new Set();
  /** @type {Map<string, unknown>} requestID -> NotificationHandle */
  const promptNotifHandleCache = new Map();

  function resolveSessionTitle(sessionID) {
    return sessionTitleCache.get(sessionID) ?? `Session ${sessionID.slice(0, 8)}`;
  }

  /**
   * @param {import('./normalized-event.js').NormalizedEvent} event
   */
  async function handle(event) {
    switch (event.kind) {
      case 'session-titled': {
        if (event.title) {
          sessionTitleCache.set(event.sessionID, event.title);
        }
        break;
      }

      case 'permission-asked': {
        if (!notifyPermissionRequested) break;
        const { sessionID, requestID, description } = event;
        const sessionTitle = resolveSessionTitle(sessionID);

        if (desktopEnabled) {
          if (permissionNotifHandleCache.has(requestID)) {
            closeDesktopNotification(permissionNotifHandleCache.get(requestID), log);
            permissionNotifHandleCache.delete(requestID);
          }

          const notifHandle = await sendDesktopNotification({
            title: 'opencode \u2013 Permission Request',
            message: `${description}\n${sessionTitle}`,
            urgency: permissionCfg.urgency,
            expireTimeoutMs: permissionCfg.expireTimeoutMs,
            groupId: requestID,
            onClickCommand,
          }, log, notificationState);

          const repliedEarly = permissionRepliedEarlyCache.delete(requestID);
          if (notifHandle !== null) {
            if (repliedEarly) {
              closeDesktopNotification(notifHandle, log);
            } else {
              permissionNotifHandleCache.set(requestID, notifHandle);
              if (permissionCfg.expireTimeoutMs > 0) {
                const timer = setTimeout(() => {
                  if (permissionNotifHandleCache.get(requestID) === notifHandle) {
                    closeDesktopNotification(notifHandle, log);
                    permissionNotifHandleCache.delete(requestID);
                  }
                }, permissionCfg.expireTimeoutMs);
                timer.unref?.();
              }
            }
          }
        }

        if (terminalBellEnabled) {
          // permission requests always ring the bell regardless of focus,
          // mirroring the desktop-notification behaviour above.
          await ringTerminalBell(log, notificationState);
        }

        if (webhooks.length > 0) {
          await dispatchWebhooks(webhooks, {
            event: 'permission_request',
            sessionID,
            sessionTitle,
            permissionTitle: description,
          }, log);
        }
        break;
      }

      case 'permission-replied': {
        const { requestID } = event;
        if (permissionNotifHandleCache.has(requestID)) {
          closeDesktopNotification(permissionNotifHandleCache.get(requestID), log);
          permissionNotifHandleCache.delete(requestID);
        } else if (desktopEnabled && notifyPermissionRequested) {
          permissionRepliedEarlyCache.add(requestID);
        }
        break;
      }

      case 'todos-updated': {
        if (!notifyTodoCompleted) break;
        const { sessionID, todos } = event;
        const sessionTitle = resolveSessionTitle(sessionID);

        let sessionTodos = todoStateCache.get(sessionID);
        const isFirstSeen = !sessionTodos;
        if (isFirstSeen) {
          sessionTodos = new Map();
          todoStateCache.set(sessionID, sessionTodos);
        }

        const skip = (desktopEnabled || terminalBellEnabled) && resolved.skipIfFocused !== false && (await isOpencodeWindowFocused());

        for (const todo of todos) {
          const prevStatus = sessionTodos.get(todo.content);
          const isNewlyCompleted = !isFirstSeen && prevStatus !== 'completed' && todo.status === 'completed';

          if (isNewlyCompleted) {
            if (!skip) {
              if (desktopEnabled) {
                sendDesktopNotification({ title: 'opencode \u2013 Todo Done', message: `${todo.content}\n${sessionTitle}`, onClickCommand }, log, notificationState);
              }
              if (terminalBellEnabled) {
                await ringTerminalBell(log, notificationState);
              }
            }
            if (webhooks.length > 0) {
              await dispatchWebhooks(webhooks, { event: 'todo_completed', sessionID, sessionTitle, todoContent: todo.content }, log);
            }
          }
          sessionTodos.set(todo.content, todo.status);
        }
        break;
      }

      case 'session-idle': {
        if (!notifyTaskFinished) break;
        const { sessionID } = event;
        const sessionTitle = resolveSessionTitle(sessionID);

        await fireFocusGatedNotification({
          desktopEnabled,
          terminalBellEnabled,
          skipIfFocused: resolved.skipIfFocused !== false,
          sendDesktop: () => sendDesktopNotification({ title: 'opencode \u2013 Task Done', message: sessionTitle, onClickCommand }, log, notificationState),
          log,
          notificationState,
        });
        if (webhooks.length > 0) {
          await dispatchWebhooks(webhooks, { event: 'session_idle', sessionID, sessionTitle }, log);
        }
        break;
      }

      case 'session-failed': {
        if (!notifySessionError) break;
        const { sessionID = 'unknown', errorMessage } = event;
        const sessionTitle = resolveSessionTitle(sessionID);

        await fireFocusGatedNotification({
          desktopEnabled,
          terminalBellEnabled,
          skipIfFocused: resolved.skipIfFocused !== false,
          sendDesktop: () => sendDesktopNotification({
            title: 'opencode \u2013 Session Error',
            message: errorMessage ? `${sessionTitle}\n${errorMessage}` : sessionTitle,
            urgency: 'critical',
            onClickCommand,
          }, log, notificationState),
          log,
          notificationState,
        });
        if (webhooks.length > 0) {
          await dispatchWebhooks(webhooks, { event: 'session_error', sessionID, sessionTitle, ...(errorMessage ? { errorMessage } : {}) }, log);
        }
        break;
      }

      case 'prompt-asked': {
        if (!notifyQuestionAsked) break;
        const { sessionID, requestID, title, body } = event;
        const sessionTitle = resolveSessionTitle(sessionID);
        const notifTitle = title ? `opencode \u2013 ${title}` : 'opencode \u2013 Question';
        const notifMessage = body ?? sessionTitle;

        if (desktopEnabled) {
          if (promptNotifHandleCache.has(requestID)) {
            closeDesktopNotification(promptNotifHandleCache.get(requestID), log);
            promptNotifHandleCache.delete(requestID);
          }

          const notifHandle = await sendDesktopNotification({ title: notifTitle, message: notifMessage, onClickCommand }, log, notificationState);
          if (notifHandle !== null) {
            promptNotifHandleCache.set(requestID, notifHandle);
          }
        }

        if (terminalBellEnabled) {
          // questions must always ring the bell regardless of focus state,
          // mirroring the desktop-notification behaviour above.
          await ringTerminalBell(log, notificationState);
        }

        if (webhooks.length > 0) {
          await dispatchWebhooks(webhooks, { event: 'question_asked', sessionID, sessionTitle, questionHeader: title, questionBody: body }, log);
        }
        break;
      }

      case 'prompt-resolved': {
        const { requestID } = event;
        closeDesktopNotification(promptNotifHandleCache.get(requestID), log);
        promptNotifHandleCache.delete(requestID);
        break;
      }

      default:
        break;
    }
  }

  return { handle, notificationState };
}
