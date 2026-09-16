## 1. Dependency and packaging setup

- [x] 1.1 Add `@opencode/plugin` as a devDependency and optional peerDependency; verify `npm install` resolves cleanly
- [x] 1.2 Update `package.json`: `main`/`"."` resolve to `plugin.v1.js` (unchanged from users' perspective), `"./v2"` to `plugin.v2.js`

## 2. Extract the runtime-agnostic core (design.md, `NormalizedEvent`)

- [x] 2.1 Create `src/core.js`: `createNotifier(options, {log})` returning `{handle(normalizedEvent), notificationState}`; holds all caches (session title, todo state, permission/prompt notification handles, `permissionRepliedEarlyCache`), the OS notification back-ends (Linux D-Bus, macOS `terminal-notifier`, Windows PowerShell toast), focus detection (`xprop`/Hyprland/Sway), webhook dispatch, and config resolution — all moved from `src/index.js` unchanged; core imports no opencode-runtime package
- [x] 2.2 Define the `NormalizedEvent` union per design.md's table (`session-titled`, `permission-asked`, `permission-replied`, `todos-updated`, `session-idle`, `session-failed`, `prompt-asked`, `prompt-resolved`); exported as `SUPPORTED_KINDS`
- [x] 2.3 Port the todo-completion transition logic (first-seen suppression, per-session state map) and the permission race fix (`permissionRepliedEarlyCache`) into core unchanged; verified `node --check src/core.js`

## 3. V1 adapter (`src/plugin.v1.js`)

- [x] 3.1 `git mv src/index.js src/plugin.v1.js`; reduced to a stateless translator (`normalizeV1Event` + `core.handle`); all test imports updated; existing V1 test suite passes unchanged (12/12 pre-existing tests, byte-for-byte behavior preserved)

## 4. V2 adapter (`src/plugin.v2.js`)

- [x] 4.1 Exports a plain `{id, setup}` object literal — no runtime import of `@opencode/plugin`; empirically confirmed to load on the real host (no `PluginModule.LoadError`, unlike five other still-V1-shaped comparison plugins present in the same test environment)
- [x] 4.2 `setup(ctx)`: `AbortController` created, subscribe loop started detached, cleanup aborts; per-event `try/catch`, unmapped types return before any `await`, `AbortError` not logged as an error
- [x] 4.3 V2 event normalization implemented per design.md's mapping notes for all 7 V2-producible kinds (session.created/renamed, permission.asked/replied, session.idle, session.execution.failed, form.created/replied/cancelled)
- [x] 4.4 Opt-in-only todo warning implemented and confirmed live: fired when `notifications.todoCompleted` was explicitly configured, did not fire when unconfigured, in two separate real-host runs
- [x] 4.5 Stderr-only logging implemented
- [x] 4.6 `node --check src/plugin.v2.js` verified; no default-export-adjacent named exports (only `PRODUCIBLE_KINDS` and `normalizeV2Event`, both intentional named exports for the cross-check/normalization tests — this plugin never registers as a V1-loadable module under a name a V1 legacy-loader would scan, since it's reached only via the `./v2` export or direct `.opencode/plugins/` discovery)

## 5. Spec compliance

- [x] 5.1 `openspec/changes/v2-plugin-migration/specs/notification-dispatch/spec.md` matches the implementation; `openspec validate v2-plugin-migration --strict` passes

## 6. Test suite

- [x] 6.1 Tier 1 — core handler unit tests: todo transition detection (first-seen suppression, no duplicate notification, disabled-category), session-failed error-message inclusion, prompt dismiss-on-reply; the pre-existing `permission-notifications.test.js` suite (race fix, urgency/timeout config, early-reply leak guards) ported unchanged via the V1 path
- [x] 6.2 Tier 2 — per-adapter normalization tests: all 8 V1 kinds and all 7 V2-producible kinds table-tested, including V2's `session.created` with/without `title`, permission text composition (with and without a `message`), `form.created` (nested `data.form`) vs `form.replied`/`form.cancelled` (flat `data.id`, `data.answer` never surfaced), V1 `todo.updated` array pass-through, and unrecognized/high-frequency event types producing nothing
- [x] 6.3 Tier 3 — V2 lifecycle tests: `setup()` returns without awaiting the loop; cleanup resolves without an unhandled rejection; the todo warning fires exactly once when explicitly configured and never when unconfigured
- [x] 6.4 Cross-check test: both adapters' producible kinds are asserted to be subsets of `SUPPORTED_KINDS`; a dedicated test asserts V2 deliberately excludes `todos-updated`

**Total: 44 tests passing** (12 pre-existing + 32 new).

## 7. Real V2 host verification (release gate)

- [x] 7.1 Confirmed live against `@opencode/cli` 2.0.3: `plugin.v2.js` loads via `.opencode/plugins/` auto-discovery with no `PluginModule.LoadError`, across two separate runs
- [ ] 7.2 **Not completed live** — the sandbox environment auto-approved the simple shell commands used to attempt triggering a permission prompt, so no real `permission.asked`/`permission.replied` round-trip was observed on the real host in this session. Covered instead by an exact-shape Tier 2 unit test built from the confirmed schema (not guessed), and by the unchanged, still-passing `permission-notifications.test.js` suite via the V1 path. Recorded as an open follow-up, not silently assumed passing.
- [ ] 7.3 **Not completed live** — no session failure was induced in this session (would require e.g. an invalid API key). Covered by a Tier 2 unit test built from the exact confirmed `session.execution.failed` schema shape.
- [x] 7.4 Recorded in docs/v2-compat-audit.md: Open Questions 1-3 were not resolved live in this session (explicitly listed as open follow-ups, not assumed); the opt-in todo-warning behavior (a design-critical detail) WAS confirmed live.

## 8. Documentation

- [x] 8.1 Rewrote `docs/v2-compat-audit.md`: retracts the prior `opencode-ai@dev`-audit's conclusion, documents the real hook/event mapping, the permanent todo gap, the form-mapping scope reduction, and verification status honestly including the two incomplete live-fire items above
- [x] 8.2 Updated `README.md`'s installation section and the Hyprland example to describe both V1 and V2 entry points and the V2-specific limitations

## 9. Final verification and review

- [x] 9.1 Full test suite green: 44/44 passing
- [x] 9.2 `openspec validate v2-plugin-migration --strict` passes
- [x] 9.3 Commission `code-reviewer` for the full diff — 0 blockers, 3 warnings + 2 suggestions. All 3 warnings accepted and fixed: (1) a genuine bug found via review — `normalizeV2Event`'s call itself sat OUTSIDE the inner per-event try/catch, so a malformed event would escape to the outer catch and kill the **entire** subscription loop, not just skip one event; moved inside, with a new regression test asserting two consecutive malformed events both produce an "event handling failed" log line rather than the loop dying after the first; (2) `plugin.v1.js`'s `event()` hook gained the same per-event try/catch as V2, so the new cross-runtime "malformed events never halt processing" spec requirement holds for both adapters, not just V2; (3) `core.js`'s empty-title fallback behavior (a deliberate, spec-driven change from the pre-port monolith) is now locked in by a regression test. One of two suggestions accepted (a docs sentence clarified re: V2 config-file-only support); the other (moving the test-only `setup()` parameter to a separate helper) rejected as it matches the already-established, already-reviewed precedent in three sibling repos. Final count: 46/46 tests passing.
