# opencode-notify — Architecture

> Single-file ES-module plugin (`src/index.js`). This document records internal design decisions; there is no public API.

---

## 1. Notification Abstraction Design

### 1.1 Problem Statement

The `permission.asked` event must display a desktop notification. When `permission.replied` subsequently fires, that in-flight notification should be programmatically closed. The current `sendDesktopNotification` is fire-and-forget with no return value, so no dismiss mechanism exists. This design adds one without breaking the existing call contract for all other callers.

---

## 2. Function Signatures

### 2.1 `sendDesktopNotification(opts)` — revised

```js
/**
 * Send a desktop notification.
 *
 * Returns a Promise that resolves to an opaque NotificationHandle, or null
 * if the platform cannot provide a dismissible ID.
 *
 * For permission notifications, callers MUST await the returned Promise
 * to obtain the handle before storing it.  All other callers may fire-and-
 * forget (call without await; the Promise is self-contained).
 *
 * @param {object}  opts
 * @param {string}  opts.title
 * @param {string}  opts.message
 * @param {'low'|'normal'|'critical'} opts.urgency
 * @param {string}  [opts.onClickCommand]   — Linux action-button command
 * @param {string}  [opts.groupId]          — macOS group identifier (caller-supplied
 *                                            string; used as -group <groupId>)
 * @returns {Promise<NotificationHandle|null>}
 */
async function sendDesktopNotification(opts) { … }
```

**Why Promise, not synchronous?**  
On Linux, the numeric notification ID is only available *after* `notify-send` starts and prints to stdout. A synchronous return cannot provide it. Wrapping the whole function in a Promise unifies the return type across platforms. Fire-and-forget callers are unaffected — they simply don't `await`.

### 2.2 `closeDesktopNotification(handle)` — new

```js
/**
 * Dismiss a previously-sent notification.
 *
 * No-op when handle is null, undefined, or the platform does not support
 * programmatic dismissal.
 *
 * @param {NotificationHandle|null|undefined} handle
 * @returns {void}
 */
function closeDesktopNotification(handle) { … }
```

---

## 3. Opaque Handle Shape (per platform)

The handle is an internal plain object. **Callers never inspect its fields.**

```js
// Linux
{ platform: 'linux',  numericId: number }

// macOS
{ platform: 'darwin', groupId: string }

// Windows / other — no reliable dismiss mechanism
null   // sendDesktopNotification resolves to null
```

| Platform | How the handle is obtained | How dismiss works |
|---|---|---|
| **Linux** | `notify-send --print-id` prints the numeric ID as the first line of stdout; resolve the Promise once that line is received | `gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method org.freedesktop.Notifications.CloseNotification <numericId>` (fire-and-forget child_process spawn) |
| **macOS** | The caller supplies `opts.groupId` (a string, e.g. the `requestID`); the handle is constructed immediately and the Promise resolves synchronously-like | `spawn('terminal-notifier', ['-remove', handle.groupId])` (fire-and-forget child_process spawn) |
| **Windows / other** | No handle; resolves to `null` | `closeDesktopNotification(null)` → no-op |

### 3.1 Linux `--print-id` interaction model

```
notify-send --print-id --wait -A 'default=Focus opencode' … 
  ↓ stdout, first line:   "42\n"   ← numeric ID, arrives early
  ↓ stdout, later:        "default\n"  ← action key when user clicks
```

The Promise resolves as soon as the first stdout line (the numeric ID) is received. The `--wait` / action-button listener continues running in the background on the same spawned process — the resolve does not kill the child. The `onClickCommand` callback path is unchanged.

### 3.2 `opts.groupId` for macOS

`groupId` is caller-supplied so the `permission.asked` handler can pass the `requestID` directly:

```js
sendDesktopNotification({ …, groupId: requestID })
```

This makes the group a semantic identifier rather than an opaque UUID, which simplifies dismissal and avoids any ID-generation utility. For all other notifications the field is omitted (no groupId means macOS does not attach a group, which matches current behaviour).

---

## 4. `permissionNotifHandleCache`

### 4.1 Declaration

Module-level `Map`, declared alongside other module-level state:

```js
/** @type {Map<string, NotificationHandle>} */
const permissionNotifHandleCache = new Map();
// key:   requestID (string from the permission.asked event)
// value: NotificationHandle (opaque; platform-specific)
```

### 4.2 Lifecycle

| Event | Action |
|---|---|
| `permission.asked` fires | `await sendDesktopNotification(…)` → store resolved handle under `requestID` |
| `permission.replied` fires | look up handle → `closeDesktopNotification(handle)` → `delete` from Map |

Entries are never left to accumulate: every `permission.replied` (matched or not) results in a `delete` call. An unmatched entry (no `permission.replied` ever arrives) is the only leak risk — see §6 edge cases.

---

## 5. Event-Handler Pseudocode

### 5.1 `permission.asked`

```
on permission.asked(event):
  if permissionNotifHandleCache.has(event.requestID):
    // Duplicate: a prior handle exists; close it before replacing
    closeDesktopNotification(permissionNotifHandleCache.get(event.requestID))
    permissionNotifHandleCache.delete(event.requestID)

  handle = await sendDesktopNotification({
    title:          'Permission requested',
    message:        event.metadata.description,
    urgency:        'critical',
    onClickCommand: FOCUS_COMMAND,
    groupId:        event.requestID,   // macOS: used as -group identifier
  })

  if handle !== null:
    permissionNotifHandleCache.set(event.requestID, handle)
  // if null (Windows): nothing to store; permission.replied becomes a no-op dismiss
```

### 5.2 `permission.replied`

```
on permission.replied(event):
  handle = permissionNotifHandleCache.get(event.requestID)  // may be undefined
  closeDesktopNotification(handle)      // no-op if undefined or null
  permissionNotifHandleCache.delete(event.requestID)
  // (webhook call, if configured, is unchanged)
```

---

## 6. Edge Cases

### 6.1 Race: `permission.replied` fires before Linux ID is printed

**Scenario:** The `permission.asked` handler is `await`-ing `sendDesktopNotification`; `permission.replied` arrives from the SDK before that Promise resolves (i.e., before `notify-send` has printed its ID line to stdout).

**Analysis:** Node.js event processing is single-threaded. SDK event callbacks are delivered as microtasks or I/O callbacks. The `await` inside `permission.asked` yields the event loop, allowing `permission.replied` to run while the Promise is still pending.

**Result at `permission.replied` time:** `permissionNotifHandleCache.get(requestID)` returns `undefined` (the `set` has not happened yet). `closeDesktopNotification(undefined)` → no-op. The Map entry is deleted (a no-op delete).

**Consequence:** The notification is not closed programmatically. It remains visible until the user dismisses it or the OS times it out.

**Mitigation option (not required for MVP):** Replace the Map value with a `{ promise, resolve }` slot so `permission.replied` can `await` the pending handle. This adds complexity for a rare race; defer unless it proves to be a user-visible problem in practice (YAGNI — rejected for now, reason recorded here).

### 6.2 Duplicate `permission.asked` for the same `requestID`

Handled in §5.1: the handler detects an existing entry, closes the old notification, deletes the entry, then proceeds with the new send. This prevents Map growth and dangling visible notifications.

### 6.3 `permission.replied` with no matching entry

`permissionNotifHandleCache.get` returns `undefined`. `closeDesktopNotification(undefined)` is defined as a no-op. `Map.delete` on a non-existent key is a no-op. Safe.

### 6.4 `notify-send` not installed (Linux)

The existing error-handling path (spawn failure) is unchanged. If the spawn fails, the Promise rejects (or resolves to `null` depending on chosen error strategy) — the cache never receives an entry. `permission.replied` degrades gracefully per §6.3.

### 6.5 Handle leak (no `permission.replied` ever arrives)

If the SDK never fires `permission.replied` for a given `requestID`, the entry remains in the Map indefinitely. Given that `permission.asked`/`permission.replied` are paired SDK lifecycle events, this is considered a SDK contract violation outside this plugin's control. No TTL or periodic purge is designed in (YAGNI — no evidence this occurs in practice).

### 6.6 `closeDesktopNotification` on an already-dismissed notification

Linux: `gdbus CloseNotification` on a stale ID is a no-op at the D-Bus level (the notification server ignores unknown IDs). macOS: `terminal-notifier -close <groupId>` on an already-dismissed group is a no-op. Safe.

---

## 7. Options Considered and YAGNI Decisions

### Option A — Callback-based handle (rejected)

Pass an `onHandle(handle)` callback into `sendDesktopNotification`. Avoids the async return but complicates the call site and requires the caller to manage state inside a callback. Adds ceremony without benefit. **Rejected: Promise is simpler at the call site.**

### Option B — Global ID auto-generation (rejected)

Generate a UUID/counter inside `sendDesktopNotification` and use it as the macOS `groupId`. Callers would not need to supply `groupId`. **Rejected:** the `requestID` already uniquely identifies the notification context; introducing a separate generated ID creates a mapping problem and adds code. Use `requestID` directly (YAGNI).

### Option C — Race-safe pending-handle slot (deferred, not rejected)

Store a `Promise<handle>` in the Map so `permission.replied` can `await` the ID even if it races ahead. **Deferred:** adds non-trivial complexity for a race that requires a specific timing window and has not been observed in practice. Revisit if the race becomes reproducible (YAGNI — see §6.1).

### Option D — Dismiss via re-send with `remove` only (macOS, rejected)

Re-use the same notifier call for both send and close on all platforms. **Rejected:** Linux dismiss requires a separate `gdbus` call; mixing send/close inside one function creates a confusing dual-purpose API. Separate `closeDesktopNotification` is cleaner.

---

## 8. Component Breakdown

| Component | Work kind | Done-criterion |
|---|---|---|
| Revised `sendDesktopNotification` — Linux branch | Application code | Returns `Promise<{platform:'linux', numericId}>` by reading first stdout line of `notify-send --print-id`; existing `--wait` / action-button path continues in background |
| Revised `sendDesktopNotification` — macOS branch | Application code | Returns `Promise<{platform:'darwin', groupId}>` resolved immediately after `terminal-notifier` is spawned with `-group groupId`; `opts.groupId` threaded through |
| Revised `sendDesktopNotification` — Windows/other branch | Application code | Returns `Promise<{platform:'other', groupId:null}>`; spawns PowerShell WinRT toast via `-EncodedCommand` |
| `closeDesktopNotification(handle)` — new function | Application code | Linux: spawns `gdbus CloseNotification`; macOS: spawns `terminal-notifier -remove <groupId>`; null/undefined: no-op; no npm dep |
| `permissionNotifHandleCache` — module-level Map | Application code | Declared at module scope; populated in `permission.asked` handler; cleared in `permission.replied` handler |
| `permission.asked` handler update | Application code | `await`s `sendDesktopNotification`, stores non-null handle in cache; handles duplicate `requestID` per §6.2 |
| `permission.replied` handler (new) | Application code | Looks up and closes handle, deletes cache entry; no-op when entry absent |

---

## 9. Research Needs

All platform-specific facts (notify-send `--print-id`, `gdbus CloseNotification`, `terminal-notifier -group`/`-remove`) were supplied in the task prompt and are treated as verified. No additional research required.

---

*Document written: `docs/ARCHITECTURE.md`. Left uncommitted for the caller to stage and commit. No code, config, or IaC was written.*
