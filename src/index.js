/**
 * opencode-notify – opencode plugin
 *
 * Sends desktop notifications and optional webhook events when opencode:
 *   - requests a user permission  (`permission.updated`)
 *   - finalizes a todo (status transitions to `completed`) (`todo.updated`)
 *
 * Session titles are cached on `session.created` / `session.updated` so that
 * event handlers never need an async API call.
 */

import notifier from 'node-notifier';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Application ID used by Windows toast notifications for grouping. */
const APP_ID = 'opencode-notify';

/** Absolute path to the bundled icon, resolved relative to this source file. */
const ICON_PATH = new URL('../assets/opencode.png', import.meta.url).pathname;

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
 * @param {{ title: string; message: string }} opts
 */
function sendDesktopNotification({ title, message }) {
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
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * opencode plugin factory.
 *
 * @param {{ client: unknown; $: unknown }} input  – opencode plugin input (unused directly)
 * @param {{ desktop?: boolean; webhooks?: Array<{ url: string; headers?: Record<string, string> }> }} options
 * @returns {Promise<import('@opencode-ai/plugin').Hooks>}
 */
export default async function opencodeNotify(_input, options = {}) {
  const desktopEnabled = options.desktop ?? true;
  const webhooks = options.webhooks ?? [];

  /**
   * Cache of sessionID → session title.
   * Populated by `session.created` and `session.updated`; consumed by
   * `permission.updated` and `todo.updated`.
   *
   * @type {Map<string, string>}
   */
  const sessionTitleCache = new Map();

  /**
   * Cache of sessionID → Map<todoID, status>.
   * Tracks the last-known status of each todo per session so the `todo.updated`
   * handler can detect transitions to `"completed"`.
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
            sendDesktopNotification({
              title: 'opencode \u2013 Permission Request',
              message: `${permission.title}\n${sessionTitle}`,
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

          for (const todo of todos) {
            const prevStatus = sessionTodos.get(todo.id);
            const isNewlyCompleted =
              !isFirstSeen && prevStatus !== 'completed' && todo.status === 'completed';

            if (isNewlyCompleted) {
              if (desktopEnabled) {
                sendDesktopNotification({
                  title: 'opencode \u2013 Todo Done',
                  message: `${todo.content}\n${sessionTitle}`,
                });
              }

              if (webhooks.length > 0) {
                await dispatchWebhooks(webhooks, {
                  event: 'todo_completed',
                  sessionID,
                  sessionTitle,
                  todoID: todo.id,
                  todoContent: todo.content,
                });
              }
            }

            // Update the tracker
            sessionTodos.set(todo.id, todo.status);
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
