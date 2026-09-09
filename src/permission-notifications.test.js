import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

/**
 * Fake `spawn`-returned child process: a plain EventEmitter with `stdout`/
 * `stderr` sub-emitters and a no-op `unref`, matching the shape the plugin
 * consumes (`child.on('error'|'close', …)`, `child.stdout.on('data'|'close', …)`).
 */
function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = jest.fn();
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = jest.fn();
  child.unref = jest.fn();
  return child;
}

const notifyCalls = [];
const closeCalls = [];

const spawnMock = jest.fn((command, args) => {
  const child = createFakeChild();
  if (command === 'gdbus' && args[0] === 'call' && args.some((arg) => arg === 'org.freedesktop.Notifications.Notify')) {
    notifyCalls.push({ args, child });
  } else if (
    command === 'gdbus' &&
    args[0] === 'call' &&
    args.some((arg) => arg === 'org.freedesktop.Notifications.CloseNotification')
  ) {
    closeCalls.push(args);
  }
  return child;
});

jest.unstable_mockModule('node:child_process', () => ({
  spawn: spawnMock,
  exec: jest.fn(),
}));

let opencodeNotify;

beforeAll(async () => {
  ({ default: opencodeNotify } = await import('./index.js'));
});

/** Resolves the given fake Notify child with the given numeric notification id. */
function resolveNotify(notifyEntry, id) {
  notifyEntry.child.stdout.emit('data', `(uint32 ${id},)\n`);
  notifyEntry.child.stdout.emit('close');
}

describe('permission notification desktop behaviour (Linux)', () => {
  const originalPlatform = process.platform;
  const originalDisplay = process.env.DISPLAY;
  const client = { app: { log: jest.fn().mockResolvedValue(undefined) } };

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.DISPLAY = ':0';
    notifyCalls.length = 0;
    closeCalls.length = 0;
    spawnMock.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.DISPLAY = originalDisplay;
    jest.useRealTimers();
  });

  it('sends permission requests with normal urgency and the configured expire timeout by default', async () => {
    const hooks = await opencodeNotify({ client }, {});

    const asked = hooks.event({
      event: {
        type: 'permission.asked',
        properties: { id: 'req-1', sessionID: 'sess-1', permission: 'bash' },
      },
    });

    expect(notifyCalls).toHaveLength(1);
    resolveNotify(notifyCalls[0], 1);
    await asked;

    const hintsArg = notifyCalls[0].args.at(-2);
    const expireTimeoutArg = notifyCalls[0].args.at(-1);
    expect(hintsArg).toBe("{'urgency': <byte 1>}"); // 1 = normal, not 2 = critical
    expect(expireTimeoutArg).toBe('20000');
  });

  it('honors a configured urgency and expireTimeoutMs override', async () => {
    const hooks = await opencodeNotify(
      { client },
      { notifications: { permissionRequested: { urgency: 'critical', expireTimeoutMs: 5000 } } },
    );

    const asked = hooks.event({
      event: {
        type: 'permission.asked',
        properties: { id: 'req-2', sessionID: 'sess-1', permission: 'bash' },
      },
    });

    resolveNotify(notifyCalls[0], 2);
    await asked;

    const hintsArg = notifyCalls[0].args.at(-2);
    const expireTimeoutArg = notifyCalls[0].args.at(-1);
    expect(hintsArg).toBe("{'urgency': <byte 2>}");
    expect(expireTimeoutArg).toBe('5000');
  });

  it('closes the notification immediately if the reply races ahead of the async notify call', async () => {
    const hooks = await opencodeNotify({ client }, {});

    // Do NOT await yet — the handler suspends at `await sendDesktopNotification`,
    // but the synchronous portion (including the `spawn` call) has already run.
    const asked = hooks.event({
      event: {
        type: 'permission.asked',
        properties: { id: 'req-3', sessionID: 'sess-1', permission: 'bash' },
      },
    });
    expect(notifyCalls).toHaveLength(1);

    // The reply arrives before the notify call has resolved — this is the
    // race that occurs with opencode's "auto"/allow-all permission mode,
    // which replies near-instantly.
    await hooks.event({ event: { type: 'permission.replied', properties: { requestID: 'req-3' } } });
    expect(closeCalls).toHaveLength(0); // nothing to close yet — no handle cached

    resolveNotify(notifyCalls[0], 3);
    await asked;

    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]).toContain('3');
  });

  it('auto-dismisses the notification after expireTimeoutMs if never replied to', async () => {
    jest.useFakeTimers();
    const hooks = await opencodeNotify(
      { client },
      { notifications: { permissionRequested: { expireTimeoutMs: 5000 } } },
    );

    const asked = hooks.event({
      event: {
        type: 'permission.asked',
        properties: { id: 'req-4', sessionID: 'sess-1', permission: 'bash' },
      },
    });
    resolveNotify(notifyCalls[0], 4);
    await asked;

    expect(closeCalls).toHaveLength(0);
    jest.advanceTimersByTime(4999);
    expect(closeCalls).toHaveLength(0);
    jest.advanceTimersByTime(1);
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]).toContain('4');
  });

  it('does not auto-dismiss when expireTimeoutMs is 0', async () => {
    jest.useFakeTimers();
    const hooks = await opencodeNotify(
      { client },
      { notifications: { permissionRequested: { expireTimeoutMs: 0 } } },
    );

    const asked = hooks.event({
      event: {
        type: 'permission.asked',
        properties: { id: 'req-5', sessionID: 'sess-1', permission: 'bash' },
      },
    });
    resolveNotify(notifyCalls[0], 5);
    await asked;

    jest.advanceTimersByTime(60_000);
    expect(closeCalls).toHaveLength(0);
  });

  it('does not remember an early reply when desktop notifications are disabled (no unbounded leak)', async () => {
    // With desktop notifications off, `permission.asked` never sends a
    // notification and therefore never consumes an early-reply marker — so
    // `permission.replied` must not record one either, or it would
    // accumulate for the lifetime of the process with no consumer.
    const addSpy = jest.spyOn(Set.prototype, 'add');
    const hooks = await opencodeNotify({ client }, { desktop: false });

    await hooks.event({
      event: { type: 'permission.replied', properties: { requestID: 'req-6' } },
    });

    expect(addSpy).not.toHaveBeenCalledWith('req-6');
    addSpy.mockRestore();
  });

  it('does not remember an early reply when permission notifications are disabled entirely (no unbounded leak)', async () => {
    const addSpy = jest.spyOn(Set.prototype, 'add');
    const hooks = await opencodeNotify({ client }, { notifications: { permissionRequested: false } });

    await hooks.event({
      event: { type: 'permission.replied', properties: { requestID: 'req-7' } },
    });

    expect(addSpy).not.toHaveBeenCalledWith('req-7');
    addSpy.mockRestore();
  });
});
