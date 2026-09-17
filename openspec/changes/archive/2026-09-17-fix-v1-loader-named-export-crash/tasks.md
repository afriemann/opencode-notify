## 1. Extract V1 event-normalization helpers

- [x] 1.1 Create `src/normalize-v1.js` containing `PRODUCIBLE_KINDS` and `normalizeV1Event`,
  moved verbatim from `src/plugin.v1.js` (including the `SUPPORTED_KINDS` cross-check
  guard, importing `SUPPORTED_KINDS` from `./core.js`). Verify: file exists, exports both
  symbols.
- [x] 1.2 Update `src/plugin.v1.js` to import `PRODUCIBLE_KINDS` and `normalizeV1Event` from
  `./normalize-v1.js` (used internally, not re-exported) instead of defining them locally.
  Verify: `grep -n "^export" src/plugin.v1.js` shows only `export default`.
- [x] 1.3 Remove the `export { resolveNotificationConfig }` re-export from
  `src/plugin.v1.js` and drop `resolveNotificationConfig` from its `core.js` import list
  (it is not used anywhere else in the file). Verify: `resolveNotificationConfig` is no
  longer imported or exported by `plugin.v1.js`.

## 2. Update tests to the new module boundaries (red step)

- [x] 2.1 In `src/plugin-conformance.test.js`, change the import of `PRODUCIBLE_KINDS as
  V1_KINDS, normalizeV1Event` to come from `./normalize-v1.js` instead of `./plugin.v1.js`.
  Verify: no assertion text changes, only the import source.
- [x] 2.2 In `src/plugin.v1.test.js`, change the dynamic import of
  `resolveNotificationConfig` to come from `./core.js` instead of `./plugin.v1.js`. Verify:
  no assertion text changes, only the import source.
- [x] 2.3 Add a regression test in `src/plugin-conformance.test.js`'s "module export
  surface" describe block: `expect(Object.keys(await import('./plugin.v1.js'))).toEqual(['default'])`.
  Verify: this test fails against the pre-fix `plugin.v1.js` (confirms red), then passes
  once section 1 is applied (confirms green).

## 3. Verify against a real V1 host (live check)

- [x] 3.1 Symlink the fixed `src/plugin.v1.js` (and its now-required sibling `core.js`,
  `normalize-v1.js`) into a scratch git-initialized test project's `.opencode/plugins/`
  directory. Run `opencode run "say hi" --print-logs --dir <scratch-dir>` and confirm no
  `"failed to load plugin"` / `"Plugin export is not a function"` error appears for this
  plugin. Verify: clean load, plugin's event hook fires (or at minimum no load error).
  Clean up the scratch directory afterward.

## 4. Full suite and review

- [x] 4.1 Run the full existing test suite (`npm test`) and confirm the passing count
  matches or exceeds the pre-change baseline (5 suites / 57 tests), with zero regressions.
- [x] 4.2 Self-review the diff for simplification (duplication, code smells, dead code,
  redundant comments) before requesting `code-reviewer`.
