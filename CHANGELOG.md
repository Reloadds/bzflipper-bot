# Changelog

## 0.2.0 — filter engine (2026-07-21)

### Ported 1:1 (zero data loss)
- All **194** original blacklist entries (192 unique; the 2 exact duplicates of
  `FINE_AQUAMARINE_GEM` collapse to one rule each — recorded in
  `filters.migration.txt`). Round-trip verified by test: every original entry
  blocks through the new engine.
- Whitelist `PRECURSOR_GEAR` with `minProfit`/`minPercentage`/`maxBuyOrder`
  meta, byte-for-byte.
- `selectiveBuys` → whitelist-only mode; `temporaryBlacklistDuration` →
  `benchMinutes` + dynamic TTL bench rules.
- Typos preserved verbatim (`DIAMONG_SPREADING`, `FINE_PERDIOT_GEM`); the
  intended `DIAMOND_SPREADING` is added alongside but **disabled** (the original
  typo never blocked the real item — verified by the migration audit).
- Original file preserved untouched at `import/filters.mbf.json`.

### Improved
- O(1) exact matching via per-(list,target) hash maps (was an O(n) array scan
  per product per refresh); compiled+cached glob/regex; target-bucketed scans.
- Validation quarantines malformed rules with index-level errors instead of
  crashing; a bad regex is caught at load, not at match time.
- Hot-reload: edit `filters.rules.json` while the bot runs; broken edits keep
  the last good ruleset.
- `maxBuyOrder` whitelist meta now actually caps buy-order units (previously
  stored but unenforced); imported whitelist entries that omit it default to
  **no cap** (a defaulted `1` would have shrunk every order to a single unit).
- `minOrderValue` was a dashboard-tunable knob that no code enforced — now a
  real per-order value floor in the state machine.
- Hardened by an adversarial verification pass (5 parallel agents + a manual
  evasion suite): never-throw contracts hold against hostile inputs, JSONC
  handles a comment after the last entry + UTF-8 BOMs, nested-quantifier
  (ReDoS-class) regexes are quarantined at load, enclosed-alphanumeric letters
  (🅵🆁🅴🅴) fold correctly, and the dashboard-import path can no longer echo
  file rules into the cfg source (sticky deletions / latched whitelist-only).

### New capabilities
- Per-rule match types: `exact`, `prefix`, `suffix`, `substring`, `glob`, `regex`.
- Per-rule `action` (block/allow/warn/log/bench/replace), `reason`, `enabled`,
  `caseSensitive`, expiry (`ttlMinutes`/`expiresAt`).
- Anti-evasion normalization: Unicode NFKC, homoglyph folding, zero-width/soft-
  hyphen stripping, `§`/`&` formatting codes, leetspeak + spacing folds.
- Targets beyond items: display `name`, `chat`, `username`, `command`, `server`
  (chat hook wired in the bot, observability-only).
- Configurable precedence (whitelist-wins by default), whitelist-only mode.
- JSONC config (comments + trailing commas), documented schema (`FILTERS.md`).
- Headless CLI: `check` / `list` / `validate [--live]` / `migrate` / `selftest`
  with scriptable exit codes; `--live` validates item IDs against the real
  Bazaar API and suggests fixes for unknown IDs (Levenshtein).
- Lossless auto-migration with a printed diff + round-trip verification.
- 20-test suite (`npm test`): match types, precedence, anti-evasion, malformed
  input, expiry, hot-reload, migration losslessness, perf.
- Engine stats on the dashboard `/api/state` (`filters` field).

### Seeded defaults (all extensions disabled — out-of-box behavior = the original)
- 5 suggestion rules mined from the original's intent (`ESSENCE_*`,
  `GOBLIN_EGG*`, `FLAWED_*_GEM`, `*_GIFT` globs; a chat link-log regex).
- A disabled `ENCHANTED_COAL` whitelist entry demonstrating precedence.

## 0.1.x — earlier
- Headless Mineflayer flipper: server-authoritative position fix, verified
  write path (buy/sell/claim/cancel), dashboard + live tuning, adaptive margin,
  relist-war protection, per-slot order sizing, MBF-style config import,
  Booster Cookie auto-consume.
