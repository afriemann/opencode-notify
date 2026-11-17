# Spec Delta

## ADDED Requirements

### Requirement: V2 Entrypoint Export Surface
The V2 plugin entrypoint module (`src/plugin.v2.js`) SHALL export exactly one top-level binding, `default`, which is the plugin definition.

#### Scenario: plugin.v2.js exports only default
- **WHEN** `src/plugin.v2.js` is imported as an ES module
- **THEN** its export namespace contains exactly one key, `default`

#### Scenario: The package main entry resolves to the V2 plugin
- **WHEN** the package is resolved through its `main` field or its `.` export
- **THEN** it resolves to `src/plugin.v2.js`

## REMOVED Requirements

### Requirement: V1 Entrypoint Export Surface
**Reason**: The V1 runtime is no longer supported and `src/plugin.v1.js` is deleted.
**Migration**: Use the V2 entrypoint `src/plugin.v2.js`.

### Requirement: V2 Entrypoint Export Surface Is Unaffected By The V1 Loader Hazard
**Reason**: The V1 loader hazard no longer applies; the V2 entrypoint now exports only `default`.
**Migration**: See the requirement "V2 Entrypoint Export Surface".
