import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

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
const spawnMock = jest.fn((command, args) => {
  const child = createFakeChild();
  if (command === 'gdbus' && args[0] === 'call' && args.some((a) => a === 'org.freedesktop.Notifications.Notify')) {
    notifyCalls.push({ args, child });
    // Resolve immediately with a fake notification id for these tests.
    queueMicrotask(() => {
      child.stdout.emit('data', `(uint32 ${notifyCalls.length},)\n`);
      child.stdout.emit('close');
    });
  }
  return child;
});

jest.unstable_mockModule('node:child_process', () => ({ spawn: spawnMock, exec: jest.fn() }));

let createNotifier;
let mergeOptions;

beforeAll(async () => {
  ({ createNotifier, mergeOptions } = await import('./core.js'));
});

describe('core.js — todo events are not notified', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.DISPLAY = ':0';
    notifyCalls.length = 0;
    spawnMock.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  // spec: openspec/specs/notification-dispatch/spec.md
  it('No todo notifications fire on a runtime with no todo event source', async () => {
    const log = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false }, { log });
    await notifier.handle({ kind: 'todos-updated', sessionID: 's1', todos: [{ content: 'task', status: 'in_progress' }] });
    await notifier.handle({ kind: 'todos-updated', sessionID: 's1', todos: [{ content: 'task', status: 'completed' }] });
    expect(notifyCalls).toHaveLength(0);
  });
});

describe('core.js — session-failed', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.DISPLAY = ':0';
    notifyCalls.length = 0;
    spawnMock.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('includes the error message in the notification body when available ', async () => {
    const log = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false }, { log });
    await notifier.handle({ kind: 'session-failed', sessionID: 's1', errorMessage: 'invalid API key' });
    expect(notifyCalls).toHaveLength(1);
    // Notify args: [..., title, message, actions, hints, expireTimeout]
    const message = notifyCalls[0].args.at(-4);
    expect(message).toContain('invalid API key');
  });

  it('omits the error message line when none is available ', async () => {
    const log = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false }, { log });
    await notifier.handle({ kind: 'session-failed', sessionID: 's1' });
    expect(notifyCalls).toHaveLength(1);
    const message = notifyCalls[0].args.at(-4);
    expect(message).not.toContain('\n');
  });

  it('does not notify when sessionError is disabled', async () => {
    const log = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false, notifications: { sessionError: false } }, { log });
    await notifier.handle({ kind: 'session-failed', sessionID: 's1', errorMessage: 'boom' });
    expect(notifyCalls).toHaveLength(0);
  });
});

describe('core.js — prompt (question/form) dismiss-on-reply', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.DISPLAY = ':0';
    notifyCalls.length = 0;
    spawnMock.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('notifies on prompt-asked and dismisses on prompt-resolved', async () => {
    const log = jest.fn();
    const notifier = createNotifier({}, { log });
    await notifier.handle({ kind: 'prompt-asked', sessionID: 's1', requestID: 'req-1', title: 'Pick', body: 'A or B?' });
    expect(notifyCalls).toHaveLength(1);

    const closeCalls = [];
    spawnMock.mockImplementationOnce((command, args) => {
      if (command === 'gdbus' && args.some((a) => a === 'org.freedesktop.Notifications.CloseNotification')) {
        closeCalls.push(args);
      }
      return createFakeChild();
    });
    await notifier.handle({ kind: 'prompt-resolved', requestID: 'req-1' });
    expect(closeCalls).toHaveLength(1);
  });
});

describe('core.js — session-titled with an empty title', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.DISPLAY = ':0';
    notifyCalls.length = 0;
    spawnMock.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  // spec: openspec/specs/notification-dispatch/spec.md
  it('Falls back to a truncated session ID when no title is known', async () => {
    const log = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false }, { log });
    // An empty-string title must not be cached -- deliberately different
    // from the pre-port monolith's unconditional cache-set, per the
    // Session Title Tracking requirement's "non-empty title" scenario.
    await notifier.handle({ kind: 'session-titled', sessionID: 'session-12345678', title: '' });
    await notifier.handle({ kind: 'session-idle', sessionID: 'session-12345678' });

    expect(notifyCalls).toHaveLength(1);
    const message = notifyCalls[0].args.at(-4);
    expect(message).toBe('Session session-'); // fallback: first 8 chars of the session ID
    expect(message).not.toBe('');
  });
});


describe('core.js — session title lookup and session deletion', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.DISPLAY = ':0';
    notifyCalls.length = 0;
    spawnMock.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  const body = (i) => notifyCalls[i].args.at(-4);

  // spec: openspec/specs/notification-dispatch/spec.md
  it('Title is cached when a session is created or renamed', async () => {
    const lookupSessionTitle = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false }, { log: jest.fn(), lookupSessionTitle });
    await notifier.handle({ kind: 'session-titled', sessionID: 's1', title: 'Created title' });
    await notifier.handle({ kind: 'session-idle', sessionID: 's1' });
    await notifier.handle({ kind: 'session-titled', sessionID: 's1', title: 'Renamed title' });
    await notifier.handle({ kind: 'session-idle', sessionID: 's1' });

    expect([body(0), body(1)]).toEqual(['Created title', 'Renamed title']);
    expect(lookupSessionTitle).not.toHaveBeenCalled();
  });

  // spec: openspec/specs/notification-dispatch/spec.md
  it('Title is looked up when no title event was observed', async () => {
    const lookupSessionTitle = jest.fn().mockResolvedValue('Looked up title');
    const notifier = createNotifier({ skipIfFocused: false }, { log: jest.fn(), lookupSessionTitle });
    await notifier.handle({ kind: 'session-idle', sessionID: 'session-12345678' });
    await notifier.handle({ kind: 'session-idle', sessionID: 'session-12345678' });

    expect(body(0)).toBe('Looked up title');
    expect(body(1)).toBe('Looked up title');
    expect(lookupSessionTitle).toHaveBeenCalledTimes(1);
  });

  it('A failed lookup is not retried for every event', async () => {
    const lookupSessionTitle = jest.fn().mockRejectedValue(new Error('host unavailable'));
    const notifier = createNotifier({ skipIfFocused: false }, { log: jest.fn(), lookupSessionTitle });
    await notifier.handle({ kind: 'session-idle', sessionID: 'session-12345678' });
    await notifier.handle({ kind: 'session-idle', sessionID: 'session-12345678' });

    expect(body(0)).toBe('Session session-');
    expect(lookupSessionTitle).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight lookup between concurrent misses', async () => {
    let resolveLookup;
    const lookupSessionTitle = jest.fn(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const notifier = createNotifier({ skipIfFocused: false }, { log: jest.fn(), lookupSessionTitle });
    const first = notifier.handle({ kind: 'session-idle', sessionID: 's1' });
    const second = notifier.handle({ kind: 'session-idle', sessionID: 's1' });
    await Promise.resolve();
    resolveLookup('Shared');
    await Promise.all([first, second]);

    expect(lookupSessionTitle).toHaveBeenCalledTimes(1);
    expect(notifyCalls).toHaveLength(2);
  });

  it('Session deletion discards the session\'s state', async () => {
    const lookupSessionTitle = jest.fn().mockResolvedValue('Looked up title');
    const notifier = createNotifier({ skipIfFocused: false }, { log: jest.fn(), lookupSessionTitle });
    await notifier.handle({ kind: 'permission-asked', sessionID: 's1', requestID: 'req-1', description: 'bash' });
    await notifier.handle({ kind: 'session-deleted', sessionID: 's1' });

    const closeCalls = [];
    spawnMock.mockImplementationOnce((command, args) => {
      if (args.some((a) => a === 'org.freedesktop.Notifications.CloseNotification')) closeCalls.push(args);
      return createFakeChild();
    });
    await notifier.handle({ kind: 'permission-replied', requestID: 'req-1' });
    expect(closeCalls).toHaveLength(0); // the handle was discarded with the session

    await notifier.handle({ kind: 'session-idle', sessionID: 's1' });
    expect(lookupSessionTitle).toHaveBeenCalledTimes(2); // title was discarded too
  });

  it('a lookup still in flight when its session is deleted does not repopulate the cache', async () => {
    let resolveLookup;
    const lookupSessionTitle = jest.fn(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const notifier = createNotifier({ skipIfFocused: false }, { log: jest.fn(), lookupSessionTitle });
    const first = notifier.handle({ kind: 'session-idle', sessionID: 's1' });
    await Promise.resolve();
    await notifier.handle({ kind: 'session-deleted', sessionID: 's1' });
    resolveLookup('Late title');
    await first;

    lookupSessionTitle.mockResolvedValue('Second');
    await notifier.handle({ kind: 'session-idle', sessionID: 's1' });
    expect(lookupSessionTitle).toHaveBeenCalledTimes(2);
  });

  it('ignores a session-deleted event without a session ID', async () => {
    const notifier = createNotifier({}, { log: jest.fn() });
    await expect(notifier.handle({ kind: 'session-deleted' })).resolves.toBeUndefined();
  });
});

describe('core.js — dispose', () => {
  const originalPlatform = process.platform;
  const monitors = [];

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.DISPLAY = ':0';
    notifyCalls.length = 0;
    monitors.length = 0;
    spawnMock.mockReset();
    spawnMock.mockImplementation((command, args) => {
      const child = createFakeChild();
      child.kill = jest.fn();
      if (command === 'gdbus' && args[0] === 'call' && args.some((a) => a === 'org.freedesktop.Notifications.Notify')) {
        notifyCalls.push({ args, child });
        queueMicrotask(() => {
          child.stdout.emit('data', `(uint32 ${notifyCalls.length},)\n`);
          child.stdout.emit('close');
        });
      } else if (command === 'gdbus' && args[0] === 'monitor') {
        monitors.push(child);
      }
      return child;
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  // spec: openspec/specs/notification-dispatch/spec.md
  it('Unload stops running monitors', async () => {
    const notifier = createNotifier({ skipIfFocused: false, onClickCommand: 'focus' }, { log: jest.fn() });
    await notifier.handle({ kind: 'session-idle', sessionID: 's1' });
    await notifier.handle({ kind: 'session-idle', sessionID: 's2' });
    expect(monitors).toHaveLength(2);

    notifier.dispose();
    expect(monitors[0].kill).toHaveBeenCalled();
    expect(monitors[1].kill).toHaveBeenCalled();
  });

  it('A notification sent during unload starts no monitor', async () => {
    const notifier = createNotifier({ skipIfFocused: false, onClickCommand: 'focus' }, { log: jest.fn() });
    const pending = notifier.handle({ kind: 'session-idle', sessionID: 's1' });
    notifier.dispose();
    await pending;

    expect(monitors).toHaveLength(0);
  });

  it('dispose is idempotent and clears a pending permission expiry timer', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'] });
    try {
      const notifier = createNotifier(
        { terminalBell: false, notifications: { permissionRequested: { expireTimeoutMs: 5000 } } },
        { log: jest.fn() },
      );
      await notifier.handle({ kind: 'permission-asked', sessionID: 's1', requestID: 'req-1', description: 'bash' });
      spawnMock.mockClear();
      notifier.dispose();
      notifier.dispose();
      jest.advanceTimersByTime(6000);
      expect(spawnMock).not.toHaveBeenCalled(); // no CloseNotification after unload
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('core.js — logs never carry variable data', () => {
  const originalPlatform = process.platform;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.DISPLAY = ':0';
    notifyCalls.length = 0;
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => createFakeChild());
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    globalThis.fetch = originalFetch;
  });

  it('a failing webhook logs only its host, never the URL path, token or error message', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED https://hooks.example.com/services/SECRET-TOKEN'));
    const log = jest.fn();
    const notifier = createNotifier(
      { desktop: false, terminalBell: false, skipIfFocused: false, webhooks: [{ url: 'https://hooks.example.com/services/SECRET-TOKEN' }] },
      { log },
    );
    await notifier.handle({ kind: 'session-idle', sessionID: 's1' });

    expect(log).toHaveBeenCalledTimes(1);
    const [level, message, extra] = log.mock.calls[0];
    expect(level).toBe('error');
    expect(extra).toMatchObject({ host: 'hooks.example.com', errorName: 'Error' });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET-TOKEN|ECONNREFUSED/);
    expect(message).not.toContain('hooks.example.com');
  });

  it('unexpected gdbus output logs only its size, not its content', async () => {
    spawnMock.mockImplementation((command, args) => {
      const child = createFakeChild();
      if (command === 'gdbus' && args[0] === 'call') {
        queueMicrotask(() => {
          child.stdout.emit('data', 'secret-looking garbage');
          child.stdout.emit('close');
        });
      }
      return child;
    });
    const log = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false, terminalBell: false }, { log });
    await notifier.handle({ kind: 'session-idle', sessionID: 's1' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(log).toHaveBeenCalledWith('error', 'gdbus Notify returned unexpected output', { bytes: 'secret-looking garbage'.length });
  });
});

describe('core.js — mergeOptions', () => {
  // spec: openspec/specs/notification-dispatch/spec.md
  it('Plugin option overrides the config file', () => {
    expect(mergeOptions({ desktop: true, skipIfFocused: false }, { desktop: false })).toEqual({ desktop: false, skipIfFocused: false });
  });

  it('Notification categories merge individually', () => {
    const merged = mergeOptions(
      { notifications: { taskFinished: false, sessionError: true } },
      { notifications: { sessionError: false, questionAsked: false } },
    );
    expect(merged.notifications).toEqual({ taskFinished: false, sessionError: false, questionAsked: false });
  });

  it('tolerates missing options', () => {
    expect(mergeOptions({ desktop: false }, undefined)).toEqual({ desktop: false });
  });
});
