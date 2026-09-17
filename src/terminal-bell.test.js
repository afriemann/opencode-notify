import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

/**
 * Fake `spawn`-returned child process, matching the shape the plugin consumes
 * elsewhere (`child.on('error'|'close', …)`, `child.stdout.on('data'|'close', …)`).
 * Used both to keep incidental `spawn` calls (e.g. the desktop-notification
 * backend) harmless, and — for `hyprctl activewindow -j` — to drive the
 * focus-detection path exercised by the "suppressed when focused" tests
 * below: emits `{ pid: hyprctlFocusedPid }` so `isOpencodeWindowFocused()`
 * resolves deterministically without touching a real compositor.
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

/** PID reported by the faked `hyprctl activewindow -j`; set per test. */
let hyprctlFocusedPid;

const spawnMock = jest.fn((command, args) => {
  const child = createFakeChild();
  if (command === 'hyprctl' && args[0] === 'activewindow') {
    process.nextTick(() => {
      child.stdout.emit('data', JSON.stringify({ pid: hyprctlFocusedPid }));
      child.emit('close', 0);
    });
  } else {
    // Any other spawn (e.g. `xprop`) — treat as "no result" so focus
    // detection falls through to the Hyprland IPC path above.
    process.nextTick(() => child.emit('close', 1));
  }
  return child;
});

/** Fake file handle returned by `fs/promises.open`, tracking write/close calls. */
function createFakeHandle() {
  return {
    write: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

const openMock = jest.fn();
const readFileMock = jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

jest.unstable_mockModule('node:child_process', () => ({
  spawn: spawnMock,
  exec: jest.fn(),
}));

jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: readFileMock,
  open: openMock,
}));

let opencodeNotify;

beforeAll(async () => {
  ({ default: opencodeNotify } = await import('./plugin.v1.js'));
});

describe('terminal bell (ring on notification-worthy events)', () => {
  const originalPlatform = process.platform;
  const originalDisplay = process.env.DISPLAY;
  const originalWaylandDisplay = process.env.WAYLAND_DISPLAY;
  const originalHyprlandSig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const client = { app: { log: jest.fn().mockResolvedValue(undefined) } };

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    spawnMock.mockClear();
    openMock.mockReset();
    client.app.log.mockClear();
    hyprctlFocusedPid = undefined;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.DISPLAY = originalDisplay;
    process.env.WAYLAND_DISPLAY = originalWaylandDisplay;
    process.env.HYPRLAND_INSTANCE_SIGNATURE = originalHyprlandSig;
  });

  it('rings the terminal bell on a permission request', async () => {
    const handle = createFakeHandle();
    openMock.mockResolvedValue(handle);

    const hooks = await opencodeNotify({ client }, { desktop: false });
    await hooks.event({
      event: { type: 'permission.asked', properties: { id: 'req-1', sessionID: 'sess-1', permission: 'bash' } },
    });

    expect(openMock).toHaveBeenCalledWith('/dev/tty', 'w');
    expect(handle.write).toHaveBeenCalledWith('\x07');
    expect(handle.close).toHaveBeenCalled();
  });

  it('rings the terminal bell on a question being asked', async () => {
    const handle = createFakeHandle();
    openMock.mockResolvedValue(handle);

    const hooks = await opencodeNotify({ client }, { desktop: false });
    await hooks.event({
      event: {
        type: 'question.asked',
        properties: { id: 'q-1', sessionID: 'sess-1', questions: [{ header: 'Pick one', question: 'A or B?' }] },
      },
    });

    expect(handle.write).toHaveBeenCalledWith('\x07');
  });

  it('rings the terminal bell when a session goes idle (skipIfFocused disabled)', async () => {
    const handle = createFakeHandle();
    openMock.mockResolvedValue(handle);

    const hooks = await opencodeNotify({ client }, { desktop: false, skipIfFocused: false });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'sess-1' } } });

    expect(handle.write).toHaveBeenCalledWith('\x07');
  });

  it('rings the terminal bell on a session error (skipIfFocused disabled)', async () => {
    const handle = createFakeHandle();
    openMock.mockResolvedValue(handle);

    const hooks = await opencodeNotify({ client }, { desktop: false, skipIfFocused: false });
    await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'sess-1' } } });

    expect(handle.write).toHaveBeenCalledWith('\x07');
  });

  it('rings the terminal bell when a todo completes (skipIfFocused disabled)', async () => {
    const handle = createFakeHandle();
    openMock.mockResolvedValue(handle);

    const hooks = await opencodeNotify({ client }, { desktop: false, skipIfFocused: false });
    const sessionID = 'sess-1';

    // First sighting establishes the baseline (no notification for pre-existing state).
    await hooks.event({
      event: { type: 'todo.updated', properties: { sessionID, todos: [{ content: 'Task A', status: 'pending' }] } },
    });
    expect(handle.write).not.toHaveBeenCalled();

    // Transition to completed fires the bell.
    await hooks.event({
      event: { type: 'todo.updated', properties: { sessionID, todos: [{ content: 'Task A', status: 'completed' }] } },
    });

    expect(handle.write).toHaveBeenCalledWith('\x07');
  });

  it('does not ring the bell when terminalBell is disabled', async () => {
    const handle = createFakeHandle();
    openMock.mockResolvedValue(handle);

    const hooks = await opencodeNotify({ client }, { desktop: false, terminalBell: false });
    await hooks.event({
      event: { type: 'permission.asked', properties: { id: 'req-1', sessionID: 'sess-1', permission: 'bash' } },
    });

    expect(openMock).not.toHaveBeenCalled();
  });

  it('does not ring the bell on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const handle = createFakeHandle();
    openMock.mockResolvedValue(handle);

    const hooks = await opencodeNotify({ client }, { desktop: false });
    await hooks.event({
      event: { type: 'permission.asked', properties: { id: 'req-1', sessionID: 'sess-1', permission: 'bash' } },
    });

    expect(openMock).not.toHaveBeenCalled();
  });

  it('logs once and stops retrying when /dev/tty cannot be opened', async () => {
    openMock.mockRejectedValue(Object.assign(new Error('no such device or address'), { code: 'ENXIO' }));

    const hooks = await opencodeNotify({ client }, { desktop: false });

    await hooks.event({
      event: { type: 'permission.asked', properties: { id: 'req-1', sessionID: 'sess-1', permission: 'bash' } },
    });
    await hooks.event({
      event: { type: 'permission.asked', properties: { id: 'req-2', sessionID: 'sess-1', permission: 'bash' } },
    });

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(client.app.log).toHaveBeenCalledTimes(1);
  });

  describe('focus suppression (skipIfFocused default true)', () => {
    beforeEach(() => {
      // Native-Wayland guard: skip xprop and go straight to the Hyprland IPC
      // path (see `isOpencodeWindowFocused`), which our `spawnMock` fakes.
      delete process.env.DISPLAY;
      process.env.WAYLAND_DISPLAY = 'wayland-0';
      process.env.HYPRLAND_INSTANCE_SIGNATURE = 'fake-sig';
    });

    it('does not ring the bell when the opencode window is already focused', async () => {
      hyprctlFocusedPid = process.pid; // matches the plugin's own ancestor chain
      const handle = createFakeHandle();
      openMock.mockResolvedValue(handle);

      const hooks = await opencodeNotify({ client }, { desktop: false });
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'sess-1' } } });

      expect(openMock).not.toHaveBeenCalled();
    });

    it('rings the bell when a different window is focused', async () => {
      hyprctlFocusedPid = process.pid + 99999; // does not match the plugin's ancestor chain
      const handle = createFakeHandle();
      openMock.mockResolvedValue(handle);

      const hooks = await opencodeNotify({ client }, { desktop: false });
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'sess-1' } } });

      expect(handle.write).toHaveBeenCalledWith('\x07');
    });

    it('also suppresses the bell on session.error when focused (shared fireFocusGatedNotification helper)', async () => {
      hyprctlFocusedPid = process.pid;
      const handle = createFakeHandle();
      openMock.mockResolvedValue(handle);

      const hooks = await opencodeNotify({ client }, { desktop: false });
      await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'sess-1' } } });

      expect(openMock).not.toHaveBeenCalled();
    });
  });
});
