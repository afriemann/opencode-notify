## 1. Confirm current V1 extension points

- [x] 1.1 Confirm this plugin's single `event` hook and its handled event
  types (`session.created`/`session.updated`, `permission.asked`/`replied`,
  `todo.updated`, `session.idle`, `session.error`, question-asked) from
  `src/index.js` — verify by grepping the source.

## 2. Empirically test against opencode2 (opencode-ai@dev)

- [x] 2.1 In a scratch project, add an `opencode.json` pointing `plugin` at
  this repo's `src/index.js`, run `opencode2 run "..." --print-logs
  --log-level DEBUG` (with `--auto` if needed to trigger a permission
  event), and capture the log — verify by confirming `event` handling and
  `client.app.log` output appear without errors.
- [x] 2.2 Record the tested `opencode2`/`opencode-ai` dev build version.

## 3. Write the audit document

- [x] 3.1 Write `docs/v2-compat-audit.md` with the same structure as prior
  audits (overview, hook table, empirical results with evidence, V2-doc
  cross-reference, risk rating, reproduction steps).
