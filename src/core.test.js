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

beforeAll(async () => {
  ({ createNotifier } = await import('./core.js'));
});

describe('core.js — todo transition detection', () => {
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

  it('does not notify for todos already completed on first observation', async () => {
    const log = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false }, { log });
    await notifier.handle({
      kind: 'todos-updated',
      sessionID: 's1',
      todos: [{ content: 'already done', status: 'completed' }],
    });
    expect(notifyCalls).toHaveLength(0);
  });

  it('notifies on the first transition to completed, but not again on a repeat observation', async () => {
    const log = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false }, { log });
    await notifier.handle({ kind: 'todos-updated', sessionID: 's1', todos: [{ content: 'task', status: 'in_progress' }] });
    expect(notifyCalls).toHaveLength(0);

    await notifier.handle({ kind: 'todos-updated', sessionID: 's1', todos: [{ content: 'task', status: 'completed' }] });
    expect(notifyCalls).toHaveLength(1);

    await notifier.handle({ kind: 'todos-updated', sessionID: 's1', todos: [{ content: 'task', status: 'completed' }] });
    expect(notifyCalls).toHaveLength(1); // no duplicate notification
  });

  it('does not notify when the todoCompleted category is disabled', async () => {
    const log = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false, notifications: { todoCompleted: false } }, { log });
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

  it('includes the error message in the notification body when available (V2)', async () => {
    const log = jest.fn();
    const notifier = createNotifier({ skipIfFocused: false }, { log });
    await notifier.handle({ kind: 'session-failed', sessionID: 's1', errorMessage: 'invalid API key' });
    expect(notifyCalls).toHaveLength(1);
    // Notify args: [..., title, message, actions, hints, expireTimeout]
    const message = notifyCalls[0].args.at(-4);
    expect(message).toContain('invalid API key');
  });

  it('omits the error message line when none is available (V1)', async () => {
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

  it('falls back to the truncated-session-ID label instead of caching a blank title', async () => {
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

