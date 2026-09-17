/**
 * opencode-notify – V1 plugin entrypoint (`@opencode-ai/plugin`).
 *
 * Stateless translator: normalizes each recognized V1 event into zero or more
 * `NormalizedEvent`s (see src/core.js) and forwards them to the shared,
 * runtime-agnostic notifier. All actual notification/webhook/state logic
 * lives in core.js — this file knows only V1's raw event shapes.
 *
 * This module MUST export exactly one top-level binding, `default`. opencode's
 * V1 legacy-plugin loader speculatively invokes every top-level named export
 * that is a function as an independent plugin factory, using the same
 * `PluginInput`-shaped argument it passes to the real default export; a named
 * export with a positional, type-assuming parameter throws on that mismatched
 * call and crashes the load of the whole file. See the openspec change
 * `fix-v1-loader-named-export-crash` for the full root-cause analysis.
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
import { readConfigFile, createNotifier } from './core.js';
import { normalizeV1Event } from './normalize-v1.js';

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
