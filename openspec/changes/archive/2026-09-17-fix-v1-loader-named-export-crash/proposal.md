## Why

`src/plugin.v1.js` currently exports three named bindings (`resolveNotificationConfig`,
`PRODUCIBLE_KINDS`, `normalizeV1Event`) alongside its `default` export. opencode's V1
legacy-plugin loader (`getLegacyPlugins`) speculatively invokes **every top-level named
export that is a function** as if it were an independent plugin factory, using the same
`PluginInput`-shaped argument it passes to the real default export. `normalizeV1Event` takes
a positional `rawEvent` parameter (not a destructured `PluginInput`), so this speculative
call throws, and the loader aborts loading the *entire file* with `error="Plugin export is
not a function"`. This has been confirmed by direct, isolated reproduction this session: a
minimal module with a named export plus `export default async function` fails to load with
this exact error; the identical module with only the default export loads successfully.

Consequently `opencode-notify` currently provides **zero functionality on any V1 host** —
the plugin fails to load at all via both global (`~/.config/opencode/plugins/`) and
project-local (`.opencode/plugins/`) auto-discovery. This is a production-severity
regression with no user-visible error surfaced beyond a logged load failure.

## What Changes

- `PRODUCIBLE_KINDS` and `normalizeV1Event` move out of `src/plugin.v1.js` into a new
  module, `src/normalize-v1.js`. `plugin.v1.js` imports and uses them internally but no
  longer re-exports them.
- The `export { resolveNotificationConfig }` re-export is removed from `src/plugin.v1.js`.
  `resolveNotificationConfig` already lives in and is exported by `src/core.js` — this was
  an unnecessary pass-through, not a relocation.
- `src/plugin.v1.js` ends up exporting exactly one top-level binding: `default`.
- `src/plugin-conformance.test.js` and `src/plugin.v1.test.js` are updated to import from
  the new locations (`./normalize-v1.js`, `./core.js` respectively). No existing test
  assertion changes in behavior.
- A regression test is added asserting the module-export-surface invariant for
  `plugin.v1.js` (`Object.keys(await import('./plugin.v1.js'))` equals `['default']`),
  matching the pattern already established in this porting effort's sibling repos
  (`opencode-openspec`, `opencode-use`).
- `src/plugin.v2.js` is **not** modified. Verified via this repo's own
  `docs/v2-compat-audit.md` (recorded during the original V2 port): `plugin.v2.js` already
  loaded successfully on a real `@opencode/cli` V2 host via `.opencode/plugins/`
  auto-discovery with its current named exports (`PRODUCIBLE_KINDS`, `normalizeV2Event`)
  present — confirming this is a V1-loader-specific hazard (`getLegacyPlugins`'s
  speculative-invocation behavior), not a general "plugin entrypoint" constraint that also
  applies to V2's loading mechanism.

## Capabilities

### New Capabilities
- `plugin`: the module-export-surface contract each plugin entrypoint module
  (`plugin.v1.js`, `plugin.v2.js`) must satisfy for opencode's V1 legacy-plugin loader to
  load it successfully.

### Modified Capabilities
(none — `notification-dispatch` behavior is unchanged; this is a loading/packaging fix,
not a behavioral change to notification dispatch)

## Impact

- `src/plugin.v1.js` (modified: export surface reduced to `default` only)
- `src/normalize-v1.js` (new file: houses `PRODUCIBLE_KINDS`, `normalizeV1Event`)
- `src/plugin-conformance.test.js` (import paths updated; new regression test added)
- `src/plugin.v1.test.js` (import path updated)
- No API, schema, or dependency changes. No change to `src/plugin.v2.js` or `src/core.js`
  (beyond consumption, unchanged).
