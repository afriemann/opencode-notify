/**
 * opencode-notify – V1 raw-event normalization.
 *
 * Split out of `src/plugin.v1.js` so that module's export surface can stay at
 * exactly `default` (opencode's V1 legacy-plugin loader speculatively invokes
 * every top-level named export that is a function as an independent plugin
 * factory; `normalizeV1Event`'s positional `rawEvent` parameter does not match
 * that call shape and crashes the whole file's load — see the openspec
 * change `fix-v1-loader-named-export-crash` for the full root-cause analysis).
 */
import { SUPPORTED_KINDS } from './core.js';

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
  throw new Error('opencode-notify: normalize-v1.js PRODUCIBLE_KINDS contains a kind core.js does not handle');
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
