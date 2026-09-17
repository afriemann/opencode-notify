// src/plugin.v2.js — opencode-notify, V2 plugin entrypoint
//
// Stateless translator over the runtime-agnostic notifier (src/core.js):
// normalizes V2's raw event stream into the same NormalizedEvent vocabulary
// src/plugin.v1.js produces, per design.md's mapping table. Deliberately does
// NOT import `@opencode/plugin` at runtime (matching the established pattern
// from opencode-use/opencode-auto-instruct/opencode-redact): `Plugin.define`
// is a verified identity function, and the package is an optional peer --
// importing it at runtime would risk failing this plugin closed for any user
// who hasn't installed it.
//
// @typedef {import("@opencode/plugin").Plugin} Plugin

import { readConfigFile, createNotifier, SUPPORTED_KINDS } from './core.js';

const PLUGIN_NAME = 'opencode-notify';

/** NormalizedEvent kinds this V2 adapter can ever produce (cross-check test).
 * Deliberately excludes 'todos-updated' -- no todo domain exists in V2's
 * event manifest at all (design.md's permanent-gap decision). */
export const PRODUCIBLE_KINDS = Object.freeze([
  'session-titled',
  'permission-asked',
  'permission-replied',
  'session-idle',
  'session-failed',
  'prompt-asked',
  'prompt-resolved',
]);
if (PRODUCIBLE_KINDS.some((k) => !SUPPORTED_KINDS.includes(k))) {
  throw new Error('opencode-notify: plugin.v2.js PRODUCIBLE_KINDS contains a kind core.js does not handle');
}

function makeLog() {
  return (level, message) => {
    process.stderr.write(`[${PLUGIN_NAME}] [${level}] ${message}\n`);
  };
}

/**
 * Translates one raw V2 event into zero or more NormalizedEvents. Returns
 * `[]` for any unmapped/unrecognized event type -- callers must check this
 * BEFORE any `await`, since V2's stream carries high-frequency token-level
 * events (design.md's resilience section).
 *
 * @param {{ type: string, data?: Record<string, unknown>, durable?: { aggregateID?: string } }} rawEvent
 * @returns {import('./core.js').NormalizedEvent[]}
 */
export function normalizeV2Event(rawEvent) {
  switch (rawEvent.type) {
    case 'session.created': {
      // design.md: no data.id/sessionID field on this event -- the session
      // ID is only available via durable.aggregateID. title is optional;
      // emit nothing when absent/empty rather than caching a blank title.
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

    case 'session.idle': {
      const { sessionID } = rawEvent.data ?? {};
      return [{ kind: 'session-idle', sessionID }];
    }

    case 'session.execution.failed': {
      const { sessionID, error } = rawEvent.data ?? {};
      return [{ kind: 'session-failed', sessionID: sessionID ?? 'unknown', errorMessage: error?.message }];
    }

    case 'form.created': {
      // design.md: nested under data.form, unlike form.replied/form.cancelled.
      const form = rawEvent.data?.form ?? {};
      const { id: requestID, sessionID, title, fields = [] } = form;
      const body = fields[0]?.title ?? fields[0]?.description;
      return [{ kind: 'prompt-asked', sessionID, requestID, title, body }];
    }

    case 'form.replied':
    case 'form.cancelled': {
      // Flat shape -- data.id, not data.form.id. Deliberately never reads
      // data.answer (design.md: free-text user input must never reach a
      // notification or webhook payload).
      const { id: requestID } = rawEvent.data ?? {};
      return [{ kind: 'prompt-resolved', requestID }];
    }

    default:
      return [];
  }
}

export default {
  id: PLUGIN_NAME,

  /**
   * @param {{ event: { subscribe(opts: { signal: AbortSignal }): AsyncIterable<unknown> } }} ctx
   * @param {{ _todoConfiguredExplicitly?: boolean }} [testOverrides] test-only seam, never used by the real host
   */
  async setup(ctx, testOverrides = {}) {
    const log = makeLog();
    const fileOptions = await readConfigFile(log);
    // No inline `options` parameter exists in V2's setup(ctx) signature the
    // way V1's factory took a second argument -- V2 plugins configure via
    // ctx.storage or the config file. This plugin currently only supports
    // the config-file path on V2; inline `opencode.jsonc`-driven options
    // are a documented V1-only capability for now (see docs/v2-compat-audit.md).
    const resolved = { ...fileOptions };

    // design.md's opt-in-only todo warning: only when the key was
    // EXPLICITLY present in the resolved config, never merely because it
    // defaults to enabled.
    const todoConfiguredExplicitly =
      testOverrides._todoConfiguredExplicitly ?? Object.prototype.hasOwnProperty.call(resolved.notifications ?? {}, 'todoCompleted');
    if (todoConfiguredExplicitly) {
      log('warn', 'Todo-completion notifications are not available on this runtime (no todo event source exists on opencode V2); this setting has no effect here.');
    }

    const notifier = createNotifier(resolved, { log });

    const controller = new AbortController();

    (async () => {
      try {
        for await (const rawEvent of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const normalized = normalizeV2Event(rawEvent);
            if (normalized.length === 0) continue; // unmapped/high-frequency types: no await, no cost
            for (const event of normalized) {
              await notifier.handle(event);
            }
          } catch (err) {
            log('error', `event handling failed for '${rawEvent?.type}': ${err?.message ?? err}`);
          }
        }
      } catch (err) {
        if (err?.name !== 'AbortError') {
          log('error', `event subscription loop terminated unexpectedly: ${err?.message ?? err}`);
        }
      }
    })();

    return async () => {
      controller.abort();
    };
  },
};
