# Filter engine — blacklist / whitelist

A first-class, headless rules engine that decides what the bot will and won't
trade (and can watch chat too). Fully config-file + CLI driven — no GUI anywhere.
Ported 1:1 from the original MBF-style `blacklist`/`whitelist` config, then
extended. **Out of the box it behaves exactly like the original config** — every
extension ships disabled.

- Engine: [src/filterEngine.js](src/filterEngine.js) · normalization: [src/antiEvasion.js](src/antiEvasion.js)
- Rules file: [filters.rules.json](filters.rules.json) (hot-reloaded — edit while the bot runs)
- CLI: `npm run filter -- <cmd>` or `node tools/filter-cli.mjs <cmd>`
- Original config preserved verbatim: [import/filters.mbf.json](import/filters.mbf.json)
- Migration receipt: [filters.migration.txt](filters.migration.txt)

## Quick start

```bash
node tools/filter-cli.mjs check "ENCHANTED_COAL" --target item   # → MATCH black/block
node tools/filter-cli.mjs check "some chat line" --target chat
node tools/filter-cli.mjs list --list black --enabled
node tools/filter-cli.mjs validate --live    # checks item IDs against the live Bazaar API, suggests fixes for typos
node tools/filter-cli.mjs migrate my-old-filters.json --settings my-old-settings.json -o filters.rules.json
npm test                                     # full engine test suite
```

Exit codes: `0` ok / no match · `1` blocking match (or validate found problems) · `2` usage/load error — scriptable.

## Config schema (`filters.rules.json`)

The file is **JSONC** — `//` comments, `/* */` comments, and trailing commas are
all fine. Edits hot-reload while the bot runs; a broken edit keeps the last good
ruleset and logs the error (the bot never crashes on a bad config).

```jsonc
{
  "version": 2,
  "precedence": "whitelist",   // which list wins when BOTH match: "whitelist" (default) | "blacklist"
  "benchMinutes": 15,          // default TTL for runtime "temporary blacklist" benches
  "selectiveBuys": false,      // true = ONLY trade whitelisted items (whitelist-only mode)

  "blacklist": [
    "ENCHANTED_COAL",          // compact form: exact item ID, action block
    {                          // full form: every field optional except pattern
      "pattern": "SHARD_*",
      "type": "glob",          // exact | prefix | suffix | substring | glob | regex
      "target": "item",        // item | name | chat | username | command | server
      "action": "block",       // block | allow | warn | log | bench | replace | kick
      "reason": "why this rule exists (shown in logs / CLI)",
      "enabled": true,
      "caseSensitive": false,
      "ttlMinutes": 0,         // >0 = rule expires this many minutes after load
      "expiresAt": null,       // or an ISO timestamp / epoch ms
      "id": "optional-stable-id"
    }
  ],

  "whitelist": [
    { "pattern": "PRECURSOR_GEAR", "target": "item", "type": "exact",
      "meta": { "minProfit": 50000, "minPercentage": 5, "maxBuyOrder": 10 } }
  ]
}
```

The old MBF shape (`blacklist` as a plain ID array + `whitelist` as a
`{TAG: {…}}` map) is **also accepted directly** — you can paste an original file
in unchanged.

### Targets & normalization profiles

| target | matched against | normalization |
|---|---|---|
| `item` | Bazaar product ID (`ENCHANTED_COAL`) | uppercase, trim, spaces/dashes→`_` — IDs stay exact |
| `name` | item display name | full anti-evasion (below) |
| `chat` | chat lines the bot sees | full anti-evasion |
| `username` | player names | full anti-evasion |
| `command` | commands | strict fold only (no leet) |
| `server` | hostnames | lowercase + confusables |

### Anti-evasion (on by default for text targets)

One `"free"` rule matches **all** of: `𝖿𝗋𝖾𝖾` (Unicode math), `🅵🆁🅴🅴`
(enclosed letters), `f r e e` (spacing), `fr33` (leet), `frее` (Cyrillic
homoglyphs), `§cfree` (Minecraft formatting codes), `fre­e` (soft hyphen /
zero-width). Two fold strengths are computed — a match on either counts, so
aggressive folding widens the net but never weakens exact matching. Item IDs
are deliberately exempt (exactness matters: `VERY_CRUDE_GABAGOOL`'s `OO`
survives). Verified against a 23-vector adversarial evasion suite with zero
bypasses and zero over-matches.

### Actions

| action | on items (trading) | on text (chat etc.) |
|---|---|---|
| `block` | never trade | logged as blocked |
| `allow` | whitelist entry | whitelisted |
| `warn` | trades, but logged | logged |
| `log` | trades, logged | logged |
| `bench` | temporarily blocked (respects TTL) | logged |
| `replace` | — | logged + censored preview (`***`) |

### Precedence

When one value matches **both** lists, `precedence` decides ("whitelist" by
default — an enabled whitelist entry un-blocks a blacklisted item). The shipped
config contains a disabled `ENCHANTED_COAL` whitelist entry demonstrating
exactly this.

### Whitelist `meta` (per-item overrides — ported semantics)

| field | effect |
|---|---|
| `minProfit` | overrides the global per-order profit floor for this item |
| `minPercentage` | overrides the global min-margin % for this item |
| `maxBuyOrder` | hard cap on **units** per buy order of this item |

### Rule sources, merged into one engine

1. **File rules** — `filters.rules.json` (hot-reloaded)
2. **cfg rules** — legacy `blacklistTags` / `whitelist` / `avoidItems` from
   `config.json` and dashboard imports (kept working, ingested automatically)
3. **Dynamic rules** — runtime benches with TTL (the original's
   `temporaryBlacklistDuration`)

The merged *item* view is mirrored back onto `cfg` so every legacy code path
sees one coherent picture. Engine stats (rule counts, hits, quarantined rules,
whitelist-only flag) are exposed on the dashboard's `/api/state` as `filters`.

## Performance

Exact rules live in per-(list,target) hash maps → **O(1)** lookups (measured:
20,000 lookups against 10,000 rules in ~45 ms). Glob/regex compile once at load;
a bad regex is quarantined at load time with a clear error instead of failing at
match time. Scans are bucketed per target, so chat rules cost items nothing.

Safety rails (from the adversarial verification pass): regexes with nested
quantifiers — the catastrophic-backtracking `(a+)+` class — are quarantined at
load (add `"unsafeRegex": true` to a rule to force them), regex/glob inputs are
length-capped at 2048 chars, UTF-8 BOMs are tolerated (PowerShell writes them),
a comment after the last list entry parses correctly, and every public engine
method keeps its never-throw contract even against hostile inputs.

## Feature-parity checklist (original → this port)

| original feature | where it lives now | status |
|---|---|---|
| `blacklist` — 194 product IDs | `filters.rules.json` (192 unique rules; 2 exact dupes collapsed, recorded in [filters.migration.txt](filters.migration.txt)) | ✅ verified: every original entry blocks (round-trip test in `npm test`) |
| `whitelist` `{PRECURSOR_GEAR: {minProfit, minPercentage, maxBuyOrder}}` | whitelist rule with `meta`, enforced in the API gate + order sizing | ✅ 1:1, `maxBuyOrder` now actually caps units |
| `selectiveBuys` | `selectiveBuys: false` → whitelist-only mode | ✅ (original `{}`/`false` ≡ off) |
| `price.temporaryBlacklistDuration: 15` | `benchMinutes: 15` + `engine.bench(tag, min, reason)` dynamic rules | ✅ |
| `profit.min/max`, `price.*`, `orders.*`, `volume.*`, `purse.*` | already mapped by [src/importConfig.js](src/importConfig.js) (previous feature) | ✅ unchanged |
| typo entries (`DIAMONG_SPREADING`, `FINE_PERDIOT_GEM`) | **kept verbatim**; corrected sibling (`DIAMOND_SPREADING`) added **disabled** — the original never blocked the real item, so enabling it would change behavior | ✅ zero loss, exact parity |
| — (new) match types beyond exact | prefix/suffix/substring/glob/regex per rule | ➕ new |
| — (new) anti-evasion normalization | Unicode NFKC, homoglyphs, zero-width, `§/&` codes, leet, spacing | ➕ new |
| — (new) per-rule action/reason/enabled/expiry | rule schema | ➕ new |
| — (new) precedence control | `precedence` | ➕ new |
| — (new) chat/username/command/server targets | engine targets (+ chat hook in the bot, observability-only) | ➕ new |
| — (new) hot-reload, JSONC, validation quarantine | engine core | ➕ new |
| — (new) CLI (`check`/`list`/`validate --live`/`migrate`/`selftest`) | [tools/filter-cli.mjs](tools/filter-cli.mjs) | ➕ new |
| — (new) live-API ID validation with typo suggestions | `validate --live` (Levenshtein against real Bazaar product list) | ➕ new |

## Migrating your own config

```bash
node tools/filter-cli.mjs migrate old-filters.json --settings old-settings.json -o filters.rules.json --diff migration.txt
```

Prints the full diff (ported/deduped/typo-fixes/suggestions) and **verifies the
round trip**: every original blacklist entry must block through the new engine
and all whitelist meta must survive, or it exits non-zero and tells you what's
missing.
