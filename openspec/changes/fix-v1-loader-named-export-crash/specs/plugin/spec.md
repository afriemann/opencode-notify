## Purpose

Defines the module-export-surface contract each plugin entrypoint module must satisfy so
opencode's plugin loaders can load it successfully, independent of the notification logic
those entrypoints dispatch to.

## ADDED Requirements

### Requirement: V1 Entrypoint Export Surface
The V1 plugin entrypoint module (`src/plugin.v1.js`) SHALL export exactly one top-level
binding, `default`, so that opencode's V1 legacy-plugin loader — which speculatively
invokes every top-level named export that is a function as an independent plugin factory —
cannot throw on a mismatched-argument call to a helper function and abort the module's load.

#### Scenario: plugin.v1.js exports only default
- **WHEN** `src/plugin.v1.js` is imported as an ES module
- **THEN** its export namespace contains exactly one key, `default`, and no other named
  export is reachable

#### Scenario: The module loads successfully on a real V1 host
- **WHEN** `src/plugin.v1.js` is placed in a real opencode V1 host's plugin auto-discovery
  directory (global `~/.config/opencode/plugins/` or project-local `.opencode/plugins/`)
- **THEN** the host loads the plugin without a "Plugin export is not a function" load error

### Requirement: V2 Entrypoint Export Surface Is Unaffected By The V1 Loader Hazard
The V2 plugin entrypoint module (`src/plugin.v2.js`) is loaded through a distinct mechanism
(`@opencode/cli`'s V2 loader) that does not speculatively invoke named exports the way the
V1 legacy-plugin loader does, so `plugin.v2.js` retaining named exports alongside its
`default` export SHALL NOT be treated as a defect of this same class.

#### Scenario: plugin.v2.js continues to load successfully with its existing named exports present
- **WHEN** `src/plugin.v2.js` (unmodified, retaining `PRODUCIBLE_KINDS` and
  `normalizeV2Event` as named exports alongside `default`) is loaded via a real V2 host's
  `.opencode/plugins/` auto-discovery
- **THEN** the host loads the plugin without any `PluginModule.LoadError` or equivalent
  load failure
