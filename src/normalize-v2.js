// src/normalize-v2.js - translates raw opencode V2 events into the
// NormalizedEvent vocabulary consumed by src/core.js.

/** NormalizedEvent kinds the normalizer can produce. */
export const PRODUCIBLE_KINDS = Object.freeze([
  'session-titled',
  'permission-asked',
  'permission-replied',
  'session-idle',
  'session-failed',
  'session-deleted',
  'prompt-asked',
  'prompt-resolved',
]);

/** Raw V2 event types normalizeV2Event maps; used as the subscription filter. */
export const SUBSCRIBED_EVENT_TYPES = Object.freeze([
  'session.created',
  'session.renamed',
  'session.deleted',
  'session.execution.succeeded',
  'session.execution.failed',
  'permission.asked',
  'permission.replied',
  'form.created',
  'form.replied',
  'form.cancelled',
]);

/**
 * Translates one raw V2 event into zero or more NormalizedEvents. Returns
 * `[]` for any unmapped event type.
 *
 * @param {{ type: string, data?: Record<string, any>, durable?: { aggregateID?: string } }} rawEvent
 * @returns {import('./core.js').NormalizedEvent[]}
 */
export function normalizeV2Event(rawEvent) {
  switch (rawEvent.type) {
    case 'session.created': {
      // The session ID is only available via durable.aggregateID; title is
      // optional, so emit nothing rather than caching a blank title.
      const sessionID = rawEvent.durable?.aggregateID;
      const title = rawEvent.data?.title;
      if (!sessionID || !title) return [];
      return [{ kind: 'session-titled', sessionID, title }];
    }

    case 'session.renamed': {
      const { sessionID, title } = rawEvent.data ?? {};
      if (!sessionID || !title) return [];
      return [{ kind: 'session-titled', sessionID, title }];
    }

    case 'session.deleted': {
      const sessionID = rawEvent.data?.sessionID ?? rawEvent.durable?.aggregateID;
      return [{ kind: 'session-deleted', sessionID }];
    }

    case 'permission.asked': {
      const { sessionID, action, resources = [], message, id: requestID } = rawEvent.data ?? {};
      const description = message
        ? `${action} ${resources.join(', ')}\n${message}`
        : `${action} ${resources.join(', ')}`;
      return [{ kind: 'permission-asked', sessionID, requestID, description }];
    }

    case 'permission.replied': {
      const { requestID } = rawEvent.data ?? {};
      return [{ kind: 'permission-replied', requestID }];
    }

    case 'session.execution.succeeded': {
      const { sessionID } = rawEvent.data ?? {};
      return [{ kind: 'session-idle', sessionID }];
    }

    case 'session.execution.failed': {
      const { sessionID, error } = rawEvent.data ?? {};
      return [{ kind: 'session-failed', sessionID: sessionID ?? 'unknown', errorMessage: error?.message }];
    }

    case 'form.created': {
      // Nested under data.form, unlike form.replied/form.cancelled.
      const form = rawEvent.data?.form ?? {};
      const { id: requestID, sessionID, title, fields = [] } = form;
      const body = fields[0]?.title ?? fields[0]?.description;
      return [{ kind: 'prompt-asked', sessionID, requestID, title, body }];
    }

    case 'form.replied':
    case 'form.cancelled': {
      // Flat shape (data.id). Never reads data.answer: free-text user input
      // must not reach a notification or webhook payload.
      const { id: requestID } = rawEvent.data ?? {};
      return [{ kind: 'prompt-resolved', requestID }];
    }

    default:
      return [];
  }
}
