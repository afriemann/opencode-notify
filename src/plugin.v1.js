/**
 * opencode-notify – V1 plugin entrypoint (`@opencode-ai/plugin`).
 *
 * Stateless translator: normalizes each recognized V1 event into zero or more
 * `NormalizedEvent`s (see src/core.js) and forwards them to the shared,
 * runtime-agnostic notifier. All actual notification/webhook/state logic
 * lives in core.js — this file knows only V1's raw event shapes.
 *
 * @param {{ client: { app?: { log?: (arg: unknown) => Promise<unknown> } }; $: unknown }} input
 * @param {{
 *   desktop?: boolean;
 *   webhooks?: Array<{ url: string; headers?: Record<string, string> }>;
 *   onClickCommand?: string;
 *   skipIfFocused?: boolean;
 *   notifications?: Record<string, unknown>;
 * }} options
 * @returns {Promise<import('@opencode-ai/plugin').Hooks>}
 */
import { readConfigFile, createNotifier, resolveNotificationConfig, SUPPORTED_KINDS } from './core.js';

export { resolveNotificationConfig };

/** NormalizedEvent kinds this V1 adapter can ever produce (cross-check test). */
export const PRODUCIBLE_KINDS = Object.freeze([
  'session-titled',
  'permission-asked',
  'permission-replied',
  'todos-updated',
  'session-idle',
  'session-failed',
  'prompt-asked',
  'prompt-resolved',
]);
if (PRODUCIBLE_KINDS.some((k) => !SUPPORTED_KINDS.includes(k))) {
  throw new Error('opencode-notify: plugin.v1.js PRODUCIBLE_KINDS contains a kind core.js does not handle');
}

function makeLog(client) {
  return (level, message, extra) => {
    try {
      client?.app?.log?.({ body: { service: 'opencode-notify', level, message, extra } })?.catch?.(() => {});
    } catch {
      // Never throw — a synchronous throw here would propagate as an
      // uncaught exception from event/process handlers.
    }
  };
}

/**
 * Translates one raw V1 event into zero or more NormalizedEvents.
 * @param {{ type: string, properties: Record<string, unknown> }} rawEvent
 * @returns {import('./core.js').NormalizedEvent[]}
 */
export function normalizeV1Event(rawEvent) {
  switch (rawEvent.type) {
    case 'session.created':
    case 'session.updated': {
      const { id, title } = rawEvent.properties.info;
      return [{ kind: 'session-titled', sessionID: id, title }];
    }

    case 'permission.asked': {
      const { id: requestID, sessionID, permission } = rawEvent.properties;
      return [{ kind: 'permission-asked', sessionID, requestID, description: permission }];
    }

    case 'permission.replied': {
      const { requestID } = rawEvent.properties;
      return [{ kind: 'permission-replied', requestID }];
    }

    case 'todo.updated': {
      const { sessionID, todos } = rawEvent.properties;
      return [{ kind: 'todos-updated', sessionID, todos }];
    }

    case 'session.idle': {
      const { sessionID } = rawEvent.properties;
      return [{ kind: 'session-idle', sessionID }];
    }

    case 'session.error': {
      const { sessionID = 'unknown' } = rawEvent.properties;
      return [{ kind: 'session-failed', sessionID }];
    }

    case 'question.asked': {
      const { id: requestID, sessionID, questions = [] } = rawEvent.properties;
      return [{
        kind: 'prompt-asked',
        sessionID,
        requestID,
        title: questions[0]?.header,
        body: questions[0]?.question,
      }];
    }

    case 'question.replied':
    case 'question.rejected': {
      const { requestID } = rawEvent.properties;
      return [{ kind: 'prompt-resolved', requestID }];
    }

    default:
      return [];
  }
}

export default async function opencodeNotify({ client }, options = {}) {
  const log = makeLog(client);

  // When loaded via auto-discovery (symlink in plugins/), opencode cannot
  // pass options from opencode.jsonc. Read the optional config file and
  // merge it under any caller-supplied options.
  const fileOptions = await readConfigFile(log);
  const resolved = { ...fileOptions, ...options };

  const notifier = createNotifier(resolved, { log });

  return {
    async event({ event }) {
      let normalized;
      try {
        normalized = normalizeV1Event(event);
      } catch (err) {
        log('error', `event normalization failed for '${event?.type}': ${err?.message ?? err}`);
        return;
      }
      for (const e of normalized) {
        try {
          await notifier.handle(e);
        } catch (err) {
          log('error', `event handling failed for '${event?.type}': ${err?.message ?? err}`);
        }
      }
    },
  };
}
