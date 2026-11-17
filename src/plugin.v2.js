// src/plugin.v2.js - opencode-notify, V2 plugin entrypoint
//
// Translates opencode's raw V2 event stream (src/normalize-v2.js) into the
// notifier's event vocabulary (src/core.js). Exports only `default`.

import { readFile } from 'node:fs/promises';
import { Plugin } from '@opencode/plugin';
import { readConfigFile, createNotifier, mergeOptions, errInfo } from './core.js';
import { normalizeV2Event, SUBSCRIBED_EVENT_TYPES } from './normalize-v2.js';

const PLUGIN_NAME = 'opencode-notify';

/** One JSON line per entry on stderr; never throws. */
function log(level, message, extra) {
  try {
    process.stderr.write(`${JSON.stringify({ service: PLUGIN_NAME, level, message, ...extra })}\n`);
  } catch {
    // logging must never break event handling
  }
}

async function readPackageVersion() {
  try {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    return version;
  } catch {
    return 'unknown';
  }
}

const hasKeys = (value) => value !== null && typeof value === 'object' && Object.keys(value).length > 0;

export default Plugin.define({
  id: PLUGIN_NAME,

  async setup(ctx) {
    const fileOptions = await readConfigFile(log);
    const resolved = mergeOptions(fileOptions, ctx.options);
    const configSources = [hasKeys(fileOptions) && 'file', hasKeys(ctx.options) && 'options'].filter(Boolean);
    if (configSources.length === 0) configSources.push('defaults');

    log('info', 'Plugin setup complete', {
      version: await readPackageVersion(),
      runtime: 'v2',
      appVersion: ctx.app?.version,
    });
    log('info', 'Resolved configuration', {
      sources: configSources,
      desktop: resolved.desktop ?? true,
      terminalBell: resolved.terminalBell ?? true,
      skipIfFocused: resolved.skipIfFocused !== false,
      webhookCount: resolved.webhooks?.length ?? 0,
      hasOnClickCommand: Boolean(resolved.onClickCommand),
    });

    // Only warn when the key was explicitly configured, never merely because
    // it would default to enabled.
    if (Object.prototype.hasOwnProperty.call(resolved.notifications ?? {}, 'todoCompleted')) {
      log('warn', 'Todo-completion notifications are not available on this runtime (no todo event source exists on opencode V2); this setting has no effect here.');
    }

    const notifier = createNotifier(resolved, {
      log,
      lookupSessionTitle: async (sessionID) => (await ctx.session.get({ sessionID }))?.title,
    });

    const controller = new AbortController();

    const loop = (async () => {
      try {
        for await (const rawEvent of ctx.event.subscribe({ signal: controller.signal, types: [...SUBSCRIBED_EVENT_TYPES] })) {
          try {
            const normalized = normalizeV2Event(rawEvent);
            if (normalized.length === 0) continue;
            log('debug', 'Event mapped', { eventType: rawEvent.type, kinds: normalized.map((e) => e.kind) });
            for (const event of normalized) {
              await notifier.handle(event);
            }
          } catch (err) {
            log('error', 'Event handling failed', { eventType: rawEvent?.type, ...errInfo(err) });
          }
        }
      } catch (err) {
        if (err?.name !== 'AbortError') {
          log('error', 'Event subscription loop terminated unexpectedly', errInfo(err));
        }
      }
    })();

    return async () => {
      controller.abort();
      notifier.dispose(); // before awaiting the loop: an in-flight handler must start no new process
      await loop;
    };
  },
});
