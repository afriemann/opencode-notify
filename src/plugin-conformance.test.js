import { jest } from '@jest/globals';

let SUPPORTED_KINDS;
let PluginV2;
let pluginModule;
let PRODUCIBLE_KINDS;
let SUBSCRIBED_EVENT_TYPES;
let normalizeV2Event;

beforeAll(async () => {
  // The developer's real per-user config file must never influence these
  // tests: report it as absent and pass every other read through.
  const actualFs = await import('node:fs/promises');
  jest.unstable_mockModule('node:fs/promises', () => ({
    ...actualFs,
    readFile: (path, ...rest) => (
      String(path).endsWith('opencode-notify.json')
        ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
        : actualFs.readFile(path, ...rest)
    ),
  }));
  ({ SUPPORTED_KINDS } = await import('./core.js'));
  ({ PRODUCIBLE_KINDS, SUBSCRIBED_EVENT_TYPES, normalizeV2Event } = await import('./normalize-v2.js'));
  pluginModule = await import('./plugin.v2.js');
  PluginV2 = pluginModule.default;
});

// spec: openspec/specs/plugin/spec.md
describe('module export surface', () => {
  it('plugin.v2.js exports only default', () => {
    expect(Object.keys(pluginModule)).toEqual(['default']);
  });

  // spec: openspec/specs/plugin/spec.md
  it('The package main entry resolves to the V2 plugin', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.main).toBe('src/plugin.v2.js');
    expect(pkg.exports['.']).toBe('./src/plugin.v2.js');
    expect(pkg.exports['./v1']).toBeUndefined();
  });

  it('the default export is a plugin definition with a stable id', () => {
    expect(PluginV2.id).toBe('opencode-notify');
    expect(typeof PluginV2.setup).toBe('function');
  });
});

describe('kind-subset cross-check (design.md)', () => {
  it('every kind the adapter can produce is one core.js handles', () => {
    for (const kind of PRODUCIBLE_KINDS) {
      expect(SUPPORTED_KINDS).toContain(kind);
    }
  });

  it('the todo kind no longer exists', () => {
    expect(SUPPORTED_KINDS).not.toContain('todos-updated');
  });
});

const CANNED_EVENTS = {
  'session.created': { type: 'session.created', durable: { aggregateID: 's1' }, data: { title: 'T' } },
  'session.renamed': { type: 'session.renamed', data: { sessionID: 's1', title: 'T' } },
  'session.deleted': { type: 'session.deleted', data: { sessionID: 's1' } },
  'session.execution.succeeded': { type: 'session.execution.succeeded', data: { sessionID: 's1' } },
  'session.execution.failed': { type: 'session.execution.failed', data: { sessionID: 's1' } },
  'permission.asked': { type: 'permission.asked', data: { sessionID: 's1', id: 'r1', action: 'read', resources: [] } },
  'permission.replied': { type: 'permission.replied', data: { requestID: 'r1' } },
  'form.created': { type: 'form.created', data: { form: { id: 'r1', sessionID: 's1', title: 'T', fields: [] } } },
  'form.replied': { type: 'form.replied', data: { id: 'r1' } },
  'form.cancelled': { type: 'form.cancelled', data: { id: 'r1' } },
};

describe('subscription filter', () => {
  it('lists exactly the event types the normalizer maps', () => {
    expect([...SUBSCRIBED_EVENT_TYPES].sort()).toEqual(Object.keys(CANNED_EVENTS).sort());
    for (const type of SUBSCRIBED_EVENT_TYPES) {
      expect(normalizeV2Event(CANNED_EVENTS[type]).length).toBeGreaterThan(0);
    }
  });

  it('does not include events V2 never publishes', () => {
    expect(SUBSCRIBED_EVENT_TYPES).not.toContain('session.idle');
  });
});

describe('V2 adapter normalization', () => {
  it('session.created with a title -> session-titled, sessionID from durable.aggregateID', () => {
    expect(normalizeV2Event({ type: 'session.created', durable: { aggregateID: 's1' }, data: { title: 'My Session' } }))
      .toEqual([{ kind: 'session-titled', sessionID: 's1', title: 'My Session' }]);
  });

  it('session.created with NO title produces nothing (design.md: let core\'s fallback apply)', () => {
    expect(normalizeV2Event({ type: 'session.created', durable: { aggregateID: 's1' }, data: {} })).toEqual([]);
  });

  it('session.renamed -> session-titled (V2 has no session.updated)', () => {
    expect(normalizeV2Event({ type: 'session.renamed', data: { sessionID: 's1', title: 'Renamed' } }))
      .toEqual([{ kind: 'session-titled', sessionID: 's1', title: 'Renamed' }]);
  });

  it('session.deleted -> session-deleted, with the session ID from data or durable.aggregateID', () => {
    expect(normalizeV2Event({ type: 'session.deleted', data: { sessionID: 's1' } }))
      .toEqual([{ kind: 'session-deleted', sessionID: 's1' }]);
    expect(normalizeV2Event({ type: 'session.deleted', durable: { aggregateID: 's2' }, data: {} }))
      .toEqual([{ kind: 'session-deleted', sessionID: 's2' }]);
  });

  it('permission.asked composes description from action + resources', () => {
    expect(normalizeV2Event({
      type: 'permission.asked',
      data: { sessionID: 's1', id: 'req-1', action: 'read', resources: ['/etc/passwd', '/etc/shadow'] },
    })).toEqual([{ kind: 'permission-asked', sessionID: 's1', requestID: 'req-1', description: 'read /etc/passwd, /etc/shadow' }]);
  });

  it('permission.asked appends an optional message on its own line', () => {
    expect(normalizeV2Event({
      type: 'permission.asked',
      data: { sessionID: 's1', id: 'req-1', action: 'write', resources: ['/tmp/x'], message: 'careful' },
    })).toEqual([{ kind: 'permission-asked', sessionID: 's1', requestID: 'req-1', description: 'write /tmp/x\ncareful' }]);
  });

  it('permission.replied -> permission-replied, field name is requestID', () => {
    expect(normalizeV2Event({ type: 'permission.replied', data: { sessionID: 's1', requestID: 'req-1', reply: 'once' } }))
      .toEqual([{ kind: 'permission-replied', requestID: 'req-1' }]);
  });

  it('session.execution.succeeded -> session-idle', () => {
    expect(normalizeV2Event({ type: 'session.execution.succeeded', data: { sessionID: 's1' } }))
      .toEqual([{ kind: 'session-idle', sessionID: 's1' }]);
  });

  it('session.idle is never published on V2 and is not mapped', () => {
    expect(normalizeV2Event({ type: 'session.idle', data: { sessionID: 's1' } })).toEqual([]);
  });

  it('session.execution.failed -> session-failed, carrying error.message', () => {
    expect(normalizeV2Event({
      type: 'session.execution.failed',
      data: { sessionID: 's1', error: { type: 'ProviderError', message: 'invalid API key' } },
    })).toEqual([{ kind: 'session-failed', sessionID: 's1', errorMessage: 'invalid API key' }]);
  });

  it('form.created reads the nested data.form shape, unlike form.replied/cancelled', () => {
    expect(normalizeV2Event({
      type: 'form.created',
      data: { form: { id: 'req-1', sessionID: 's1', title: 'Pick one', fields: [{ title: 'A or B?' }] } },
    })).toEqual([{ kind: 'prompt-asked', sessionID: 's1', requestID: 'req-1', title: 'Pick one', body: 'A or B?' }]);
  });

  it('form.replied / form.cancelled read the FLAT data.id shape, and never surface data.answer', () => {
    expect(normalizeV2Event({ type: 'form.replied', data: { id: 'req-1', sessionID: 's1', answer: 'super secret answer' } }))
      .toEqual([{ kind: 'prompt-resolved', requestID: 'req-1' }]);
    expect(normalizeV2Event({ type: 'form.cancelled', data: { id: 'req-1', sessionID: 's1' } }))
      .toEqual([{ kind: 'prompt-resolved', requestID: 'req-1' }]);
  });

  it('unrecognized and high-frequency event types produce nothing', () => {
    expect(normalizeV2Event({ type: 'session.text.delta', data: {} })).toEqual([]);
    expect(normalizeV2Event({ type: 'session.tool.input.delta', data: {} })).toEqual([]);
  });
});

describe('V2 lifecycle', () => {
  function makeFakeCtx(events = [], extra = {}) {
    let resolveNext;
    const queue = [...events];
    const subscribeOptions = [];
    const ctx = {
      app: { name: 'opencode', version: '2.2.7' },
      options: undefined,
      session: { get: jest.fn().mockResolvedValue({ title: 'Host title' }) },
      event: {
        subscribe(opts) {
          subscribeOptions.push(opts);
          opts.signal.addEventListener('abort', () => resolveNext?.({ done: true, value: undefined }), { once: true });
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  return new Promise((resolve) => {
                    if (queue.length > 0) {
                      resolve({ done: false, value: queue.shift() });
                      return;
                    }
                    resolveNext = resolve;
                  });
                },
              };
            },
          };
        },
      },
      ...extra,
    };
    return { ctx, subscribeOptions };
  }

  /** Runs `setup` against `ctx`, lets queued events drain, and returns the parsed stderr JSON lines. */
  async function runSetup(ctx) {
    const original = process.stderr.write.bind(process.stderr);
    const lines = [];
    process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
    let cleanup;
    try {
      cleanup = await PluginV2.setup(ctx);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.stderr.write = original;
      await cleanup?.();
    }
    return lines.map((l) => JSON.parse(l));
  }

  it('setup() returns a cleanup function without awaiting the subscribe loop', async () => {
    const { ctx } = makeFakeCtx();
    const cleanup = await PluginV2.setup(ctx);
    expect(typeof cleanup).toBe('function');
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('subscribes only to the mapped event types', async () => {
    const { ctx, subscribeOptions } = makeFakeCtx();
    await runSetup(ctx);
    expect(subscribeOptions).toHaveLength(1);
    expect(subscribeOptions[0].types).toEqual([...SUBSCRIBED_EVENT_TYPES]);
    expect(subscribeOptions[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('writes every log entry as one JSON line with the service name', async () => {
    const { ctx } = makeFakeCtx();
    const entries = await runSetup(ctx);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatchObject({ service: 'opencode-notify' });
      expect(['debug', 'info', 'warn', 'error']).toContain(entry.level);
      expect(typeof entry.message).toBe('string');
    }
  });

  it('logs setup with the plugin runtime and host version', async () => {
    const { ctx } = makeFakeCtx();
    const entries = await runSetup(ctx);
    const setupEntry = entries.find((e) => e.message === 'Plugin setup complete');
    expect(setupEntry).toMatchObject({ level: 'info', runtime: 'v2', appVersion: '2.2.7' });
    expect(typeof setupEntry.version).toBe('string');
  });

  it('logs the resolved config source without secret values', async () => {
    const { ctx } = makeFakeCtx([], {
      options: { desktop: false, onClickCommand: 'secret-command', webhooks: [{ url: 'https://hooks.example.com/SECRET-TOKEN' }] },
    });
    const entries = await runSetup(ctx);
    const resolvedEntry = entries.find((e) => e.message === 'Resolved configuration');
    expect(resolvedEntry).toMatchObject({ level: 'info', sources: ['options'], desktop: false, webhookCount: 1, hasOnClickCommand: true });
    expect(JSON.stringify(entries)).not.toMatch(/SECRET-TOKEN|secret-command/);
  });

  it('reports the defaults source when neither the config file nor options are present', async () => {
    const { ctx } = makeFakeCtx();
    const entries = await runSetup(ctx);
    expect(entries.find((e) => e.message === 'Resolved configuration')).toMatchObject({ sources: ['defaults'] });
  });

  it('applies plugin options: a disabled terminal bell and desktop produce no notification work', async () => {
    const { ctx } = makeFakeCtx([CANNED_EVENTS['session.execution.succeeded']], {
      options: { desktop: false, terminalBell: false, notifications: { taskFinished: false } },
    });
    const entries = await runSetup(ctx);
    expect(entries.find((e) => e.message === 'Resolved configuration')).toMatchObject({ desktop: false, terminalBell: false });
    expect(entries.filter((e) => e.level === 'error')).toEqual([]);
  });

  // spec: openspec/specs/notification-dispatch/spec.md
  it('A startup warning is emitted only when todo notifications were explicitly configured', async () => {
    const { ctx } = makeFakeCtx([], { options: { notifications: { todoCompleted: true } } });
    const entries = await runSetup(ctx);

    expect(entries.filter((e) => e.level === 'warn' && /Todo-completion/.test(e.message))).toHaveLength(1);
  });

  // spec: openspec/specs/notification-dispatch/spec.md
  it('No startup warning when todo notifications were never configured', async () => {
    const { ctx } = makeFakeCtx();
    const entries = await runSetup(ctx);

    expect(entries.filter((e) => e.level === 'warn')).toEqual([]);
  });

  // spec: openspec/specs/notification-dispatch/spec.md
  it('Notifies when session execution succeeds', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock;
    try {
      const { ctx } = makeFakeCtx([{ type: 'session.execution.succeeded', data: { sessionID: 's1' } }], {
        options: { desktop: false, terminalBell: false, skipIfFocused: false, webhooks: [{ url: 'https://hooks.example.com/x' }] },
      });
      await runSetup(ctx);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ event: 'session_idle', sessionID: 's1' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('logs each mapped event at debug level with only its type and kinds', async () => {
    const { ctx } = makeFakeCtx(
      [{ type: 'session.renamed', data: { sessionID: 's1', title: 'Private title' } }],
      { options: { desktop: false, terminalBell: false } },
    );
    const entries = await runSetup(ctx);
    const debugEntry = entries.find((e) => e.level === 'debug');
    expect(debugEntry).toMatchObject({ eventType: 'session.renamed', kinds: ['session-titled'] });
    expect(JSON.stringify(entries)).not.toContain('Private title');
  });

  it('looks up an unknown session title through the host', async () => {
    const { ctx } = makeFakeCtx(
      [CANNED_EVENTS['permission.asked']],
      { options: { desktop: false, terminalBell: false } },
    );
    await runSetup(ctx);
    expect(ctx.session.get).toHaveBeenCalledWith({ sessionID: 's1' });
  });

  it('a throwing handler does not terminate the subscription -- a later event is still processed', async () => {
    // resources: null defeats normalizeV2Event's default-parameter guard
    // (defaults apply only to `undefined`), so this throws inside the
    // normalizer; if the loop died after the first throw only ONE failure
    // would be logged.
    const malformed = (id) => ({ type: 'permission.asked', data: { sessionID: 's1', action: 'read', resources: null, id } });
    const { ctx } = makeFakeCtx([malformed('req-1'), malformed('req-2')]);
    const entries = await runSetup(ctx);

    const failures = entries.filter((e) => e.message === 'Event handling failed');
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ level: 'error', eventType: 'permission.asked', errorName: 'TypeError' });
    expect(entries.filter((e) => e.message === 'Event subscription loop terminated unexpectedly')).toHaveLength(0);
  });
});
