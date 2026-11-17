# plugin Specification

## Purpose
Defines the module-export-surface contract each plugin entrypoint module must satisfy so
opencode's plugin loaders can load it successfully, independent of the notification logic
those entrypoints dispatch to.

## Requirements

### Requirement: V2 Entrypoint Export Surface
The V2 plugin entrypoint module (`src/plugin.v2.js`) SHALL export exactly one top-level binding, `default`, which is the plugin definition.

#### Scenario: plugin.v2.js exports only default
- **WHEN** `src/plugin.v2.js` is imported as an ES module
- **THEN** its export namespace contains exactly one key, `default`

#### Scenario: The package main entry resolves to the V2 plugin
- **WHEN** the package is resolved through its `main` field or its `.` export
- **THEN** it resolves to `src/plugin.v2.js`
