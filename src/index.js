/**
 * opencode-notify – opencode plugin
 *
 * Sends desktop notifications and optional webhook events when opencode:
 *   - requests a user permission  (`permission.updated`)
 *   - finalizes a todo (status transitions to `completed`) (`todo.updated`)
 *   - becomes idle after a session task finishes (`session.idle`)
 *   - encounters a session error (`session.error`)
 *   - poses a question to the user (`question.asked`)
 *
 * Session titles are cached on `session.created` / `session.updated` so that
 * event handlers never need an async API call.
 *
 * On Linux, notifications include a "Focus opencode" action button powered by
 * `notify-send --wait`.  Clicking the action runs `options.onClickCommand`
 * (if set) with `${NODE_PID}` substituted by the actual Node.js process PID.
 */

import { readFile } from 'node:fs/promises';
import { spawn, exec } from 'node:child_process';
import notifier from 'node-notifier';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Application ID used by Windows toast notifications for grouping. */
const APP_ID = 'opencode-notify';

/** Absolute path to the bundled icon, resolved relative to this source file. */
const ICON_PATH = new URL('./assets/opencode.png', import.meta.url).pathname;

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
 * Sends a desktop notification, swallowing any errors to stderr so the plugin
 * never crashes opencode.
 *
 * On Linux, uses `notify-send --wait` with a "Focus opencode" action button so
 * the user can click back into opencode.  Stdout is read asynchronously; if
 * the action key `'default'` is received and `onClickCommand` is a non-empty
 * string, the command is executed via `child_process.exec` (fire-and-forget).
 * The function itself remains **synchronous** — all subprocess handling happens
 * in callbacks without blocking the caller.
 *
 * On non-Linux platforms the existing `node-notifier` path is used unchanged.
 *
 * @param {{
 *   title: string;
 *   message: string;
 *   urgency?: string;
 *   onClickCommand?: string;
 * }} opts
 */
function sendDesktopNotification({ title, message, urgency, onClickCommand }) {
  if (process.platform === 'linux') {
    // Build notify-send argument list
    const args = ['--wait', '-A', 'default=Focus opencode', '--icon', ICON_PATH];
    if (urgency) {
      args.push(`--urgency=${urgency}`);
    }
    args.push('--', title, message);

    let child;
    try {
      child = spawn('notify-send', args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err) {
      console.error('[opencode-notify] Desktop notification failed:', err);
      return;
    }

    child.on('error', (err) => {
      console.error('[opencode-notify] Failed to spawn notify-send:', err);
    });

    // Read stdout line-by-line to detect the action key
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) fragment
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        // 'default' is the action key we passed to -A (default=Focus opencode)
        if (line === 'default' && onClickCommand) {
          const cmd = onClickCommand.replaceAll('${NODE_PID}', String(process.pid));
          exec(cmd, (err) => {
            if (err) {
              console.error('[opencode-notify] onClickCommand failed:', err);
            }
          });
        }
      }
    });

    child.stdout.on('error', (err) => {
      console.error('[opencode-notify] notify-send stdout error:', err);
    });

    child.stdout.on('close', () => {
      // Flush any unterminated final line
      if (buffer === 'default' && onClickCommand) {
        const cmd = onClickCommand.replaceAll('${NODE_PID}', String(process.pid));
        exec(cmd, (err) => {
          if (err) console.error('[opencode-notify] onClickCommand failed:', err);
        });
      }
      child.unref();
    });
  } else {
    // Non-Linux: use node-notifier (unchanged behaviour)
    try {
      notifier.notify({
        title,
        message,
        icon: ICON_PATH,
        appID: APP_ID, // Windows only; silently ignored on other platforms
      });
    } catch (err) {
      console.error('[opencode-notify] Desktop notification failed:', err);
    }
  }
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
 * all ancestor PIDs (including `startPid` itself).  Falls back to a single
 * parent hop via `process.ppid` when `/proc` is unavailable.
 *
 * @param {number} startPid
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
      // /proc unavailable — fall back to single-hop
      ancestors.add(process.ppid);
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
 * Returns `true` when the currently focused window appears to belong to the
 * terminal emulator that is hosting this Node.js process (i.e. the user is
 * already looking at the opencode window), and `false` otherwise.
 *
 * Always returns `false` on error so that notifications are sent rather than
 * silently dropped.
 *
 * @returns {Promise<boolean>}
 */
async function isOpencodeWindowFocused() {
  try {
    // Wayland-only guard: if running native Wayland with no XWayland,
    // get-windows won't work — try Hyprland IPC first.
    const nativeWayland = Boolean(process.env.WAYLAND_DISPLAY && !process.env.DISPLAY);

    let windowOwnerPid = null;

    if (!nativeWayland) {
      const { activeWindow } = await import('get-windows');
      const activeWindowResult = await activeWindow();
      if (activeWindowResult != null) {
        windowOwnerPid = activeWindowResult.owner.processId;
      }
    }

    // Fallback: Hyprland IPC (works on native Wayland)
    if (windowOwnerPid == null && process.env.HYPRLAND_INSTANCE_SIGNATURE) {
      windowOwnerPid = await getHyprlandActiveWindowPid();
    }

    if (windowOwnerPid == null) {
      console.error(
        '[opencode-notify] Could not detect active window; sending notification anyway',
      );
      return false;
    }

    let ancestors;
    if (process.platform === 'linux') {
      ancestors = await collectLinuxAncestorPids(process.pid);
    } else {
      // Best-effort single hop for non-Linux platforms
      ancestors = new Set([process.pid, process.ppid]);
    }

    return ancestors.has(windowOwnerPid);
  } catch (err) {
    console.error(
      `[opencode-notify] Window focus detection failed: ${err.message}; sending notification anyway`,
    );
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
  const desktopEnabled = options.desktop ?? true;
  const webhooks = options.webhooks ?? [];
  const onClickCommand = options.onClickCommand;

  /**
   * Cache of sessionID → session title.
   * Populated by `session.created` and `session.updated`; consumed by
   * `permission.updated` and `todo.updated`.
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
        case 'permission.updated': {
          const permission = event.properties;
          const { sessionID } = permission;
          const sessionTitle = resolveSessionTitle(sessionTitleCache, sessionID);

          if (desktopEnabled) {
            // permission requests always notify regardless of focus — the terminal
            // is almost always focused when a permission fires
            sendDesktopNotification({
              title: 'opencode \u2013 Permission Request',
              message: `${permission.title}\n${sessionTitle}`,
              urgency: 'critical',
              onClickCommand,
            });
          }

          if (webhooks.length > 0) {
            await dispatchWebhooks(webhooks, {
              event: 'permission_request',
              sessionID,
              sessionTitle,
              permissionTitle: permission.title,
            });
          }
          break;
        }

        // -----------------------------------------------------------------
        // Todo completed
        // -----------------------------------------------------------------
        case 'todo.updated': {
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
            options.skipIfFocused !== false &&
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
          const { sessionID } = event.properties;
          const sessionTitle = resolveSessionTitle(sessionTitleCache, sessionID);

          if (desktopEnabled) {
            const skip =
              options.skipIfFocused !== false && (await isOpencodeWindowFocused());
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
          const { sessionID = 'unknown' } = event.properties;
          const sessionTitle = resolveSessionTitle(sessionTitleCache, sessionID);

          if (desktopEnabled) {
            const skip =
              options.skipIfFocused !== false && (await isOpencodeWindowFocused());
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
