import { jest } from '@jest/globals';
import { SUPPORTED_KINDS } from './core.js';
import { PRODUCIBLE_KINDS as V1_KINDS, normalizeV1Event } from './normalize-v1.js';
import PluginV2, { PRODUCIBLE_KINDS as V2_KINDS, normalizeV2Event } from './plugin.v2.js';

// spec: openspec/changes/fix-v1-loader-named-export-crash/specs/plugin/spec.md
describe('module export surface (opencode V1 legacy-plugin loader safety)', () => {
  it('plugin.v1.js exports only default -- no named export reachable', async () => {
    const mod = await import('./plugin.v1.js');
    expect(Object.keys(mod)).toEqual(['default']);
  });
});

describe('kind-subset cross-check (design.md)', () => {
  it('every kind either adapter can produce is one core.js handles', () => {
    for (const kind of V1_KINDS) {
      expect(SUPPORTED_KINDS).toContain(kind);
    }
    for (const kind of V2_KINDS) {
      expect(SUPPORTED_KINDS).toContain(kind);
    }
  });

  it('V2 deliberately cannot produce todos-updated (no V2 todo event source exists)', () => {
    expect(V2_KINDS).not.toContain('todos-updated');
    expect(V1_KINDS).toContain('todos-updated');
  });
});

describe('Tier 2 — V1 adapter normalization', () => {
  it('session.created/session.updated -> session-titled', () => {
    expect(normalizeV1Event({ type: 'session.created', properties: { info: { id: 's1', title: 'My Session' } } }))
      .toEqual([{ kind: 'session-titled', sessionID: 's1', title: 'My Session' }]);
    expect(normalizeV1Event({ type: 'session.updated', properties: { info: { id: 's1', title: 'Renamed' } } }))
      .toEqual([{ kind: 'session-titled', sessionID: 's1', title: 'Renamed' }]);
  });

  it('permission.asked -> permission-asked, using the raw permission string verbatim', () => {
    expect(normalizeV1Event({ type: 'permission.asked', properties: { id: 'req-1', sessionID: 's1', permission: 'bash' } }))
      .toEqual([{ kind: 'permission-asked', sessionID: 's1', requestID: 'req-1', description: 'bash' }]);
  });

  it('permission.replied -> permission-replied', () => {
    expect(normalizeV1Event({ type: 'permission.replied', properties: { requestID: 'req-1' } }))
      .toEqual([{ kind: 'permission-replied', requestID: 'req-1' }]);
  });

  it('todo.updated -> todos-updated, passing the todos array through unchanged', () => {
    const todos = [{ content: 'a', status: 'completed' }];
    expect(normalizeV1Event({ type: 'todo.updated', properties: { sessionID: 's1', todos } }))
      .toEqual([{ kind: 'todos-updated', sessionID: 's1', todos }]);
  });

  it('session.idle -> session-idle', () => {
    expect(normalizeV1Event({ type: 'session.idle', properties: { sessionID: 's1' } }))
      .toEqual([{ kind: 'session-idle', sessionID: 's1' }]);
  });

  it('session.error -> session-failed, with no errorMessage (V1 never carried one)', () => {
    expect(normalizeV1Event({ type: 'session.error', properties: { sessionID: 's1' } }))
      .toEqual([{ kind: 'session-failed', sessionID: 's1' }]);
  });

  it('question.asked -> prompt-asked, using the first question header/question', () => {
    expect(normalizeV1Event({
      type: 'question.asked',
      properties: { id: 'req-1', sessionID: 's1', questions: [{ header: 'Pick one', question: 'A or B?' }] },
    })).toEqual([{ kind: 'prompt-asked', sessionID: 's1', requestID: 'req-1', title: 'Pick one', body: 'A or B?' }]);
  });

  it('question.replied / question.rejected -> prompt-resolved', () => {
    expect(normalizeV1Event({ type: 'question.replied', properties: { requestID: 'req-1' } }))
      .toEqual([{ kind: 'prompt-resolved', requestID: 'req-1' }]);
    expect(normalizeV1Event({ type: 'question.rejected', properties: { requestID: 'req-1' } }))
      .toEqual([{ kind: 'prompt-resolved', requestID: 'req-1' }]);
  });

  it('unrecognized event types produce nothing', () => {
    expect(normalizeV1Event({ type: 'something.unknown', properties: {} })).toEqual([]);
  });
});

describe('Tier 2 — V2 adapter normalization', () => {
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

  it('session.idle -> session-idle', () => {
    expect(normalizeV2Event({ type: 'session.idle', data: { sessionID: 's1' } }))
      .toEqual([{ kind: 'session-idle', sessionID: 's1' }]);
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

describe('Tier 3 — V2 lifecycle', () => {
  function makeFakeCtx(events) {
    let resolveNext;
    const queue = [...events];
    const iterator = {
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
    return {
      ctx: {
        event: {
          subscribe({ signal }) {
            signal.addEventListener('abort', () => resolveNext?.({ done: true, value: undefined }), { once: true });
            return iterator;
          },
        },
      },
    };
  }

  it("setup() returns without awaiting the subscribe loop (returns a cleanup function immediately)", async () => {
    const { ctx } = makeFakeCtx([]);
    const cleanup = await PluginV2.setup(ctx, { _todoConfiguredExplicitly: false });
    expect(typeof cleanup).toBe('function');
    await cleanup();
  });

  it('cleanup aborts the subscription without an unhandled rejection', async () => {
    const { ctx } = makeFakeCtx([]);
    const cleanup = await PluginV2.setup(ctx, { _todoConfiguredExplicitly: false });
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('the todo warning fires exactly once when explicitly configured, never when unconfigured', async () => {
    const original = process.stderr.write.bind(process.stderr);
    const lines = [];
    process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
    try {
      const { ctx: ctxA } = makeFakeCtx([]);
      const cleanupA = await PluginV2.setup(ctxA, { _todoConfiguredExplicitly: true });
      await cleanupA();

      const { ctx: ctxB } = makeFakeCtx([]);
      const cleanupB = await PluginV2.setup(ctxB, { _todoConfiguredExplicitly: false });
      await cleanupB();
    } finally {
      process.stderr.write = original;
    }
    const todoWarnings = lines.filter((l) => l.includes('Todo-completion notifications are not available'));
    expect(todoWarnings).toHaveLength(1);
  });

  it('a throwing handler does not terminate the subscription -- a later event is still processed', async () => {
    // Both events are malformed the same way (resources: null, which
    // normalizeV2Event's default-parameter guard does NOT catch, since
    // defaults only apply to `undefined`, not `null` -- this throws inside
    // normalizeV2Event itself, not inside notifier.handle). If the loop
    // died after the first throw, only ONE "event handling failed" log line
    // would ever appear; if it correctly continues, BOTH do.
    const malformed = (id) => ({
      type: 'permission.asked',
      data: { sessionID: 's1', action: 'read', resources: null, id },
    });
    const { ctx, } = makeFakeCtx([malformed('req-1'), malformed('req-2')]);

    const original = process.stderr.write.bind(process.stderr);
    const lines = [];
    process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
    let cleanup;
    try {
      cleanup = await PluginV2.setup(ctx, { _todoConfiguredExplicitly: false });
      // Let the detached loop's microtasks/promises settle for both queued events.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.stderr.write = original;
      await cleanup?.();
    }

    const failureLines = lines.filter((l) => l.includes('event handling failed'));
    expect(failureLines).toHaveLength(2);
    const terminatedLines = lines.filter((l) => l.includes('event subscription loop terminated unexpectedly'));
    expect(terminatedLines).toHaveLength(0);
  });
});
