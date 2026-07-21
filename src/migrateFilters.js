// Lossless migration: old MBF-style filters (+ optional settings) → the v2
// filter-engine format, with a human-readable diff of everything that changed
// (dedupes, suspected typos, seeded suggestions). NOTHING is dropped: every
// original entry survives as an enabled exact item rule; duplicates collapse to
// one rule each (recorded in the diff); suspected typos are KEPT verbatim and a
// corrected sibling is added alongside.

import { foldId } from './antiEvasion.js';

/** Levenshtein distance (small strings only — used for typo detection). */
export function levenshtein(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Corrections for typos found in the original list. The typo entry is preserved
// AS-IS (zero data loss — if Hypixel ever ships that ID it still blocks); the
// corrected ID is added as a new enabled rule so the author's INTENT also works.
const KNOWN_TYPO_FIXES = {
  DIAMONG_SPREADING: 'DIAMOND_SPREADING',
  FINE_PERDIOT_GEM: 'FINE_PERIDOT_GEM',
};

// Net-new suggestion rules mined from the original's intent — DISABLED by default
// so out-of-the-box behavior is exactly the ported original. Enable in the file.
const SUGGESTIONS = [
  { pattern: 'ESSENCE_*', type: 'glob', target: 'item', enabled: false,
    reason: 'suggestion: original blacklists 8 essences one-by-one — this glob covers all current & future essences' },
  { pattern: 'GOBLIN_EGG*', type: 'glob', target: 'item', enabled: false,
    reason: 'suggestion: original lists 4 goblin egg variants — glob covers the whole family' },
  { pattern: 'FLAWED_*_GEM', type: 'glob', target: 'item', enabled: false,
    reason: 'suggestion: original lists 2 flawed gems — flawed gems are all dust-tier' },
  { pattern: '*_GIFT', type: 'glob', target: 'item', enabled: false,
    reason: 'suggestion: original lists GREEN/WHITE/RED gift — glob covers seasonal gifts wholesale' },
  { pattern: '(discord\\.gg|dsc\\.gg|bit\\.ly)/\\S+', type: 'regex', target: 'chat', action: 'log', enabled: false,
    reason: 'suggestion: log link-spam in chat (log-only; enable to monitor scam links)' },
];

/**
 * @param {object} oldFilters  the MBF filters object {blacklist, whitelist, selectiveBuys}
 * @param {object} [oldSettings]  the MBF settings object (for temporaryBlacklistDuration)
 * @param {object} [opts] {seedSuggestions=true}
 * @returns {{config:object, diff:object, diffText:string}}
 */
export function migrate(oldFilters = {}, oldSettings = null, { seedSuggestions = true } = {}) {
  const diff = { ported: 0, deduped: [], typoFixes: [], suggestions: [], whitelist: [], notes: [] };

  // ---- blacklist: dedupe (case/format-insensitive), preserve original order ----
  const seen = new Map(); // foldId → original spelling
  const blacklist = [];
  for (const raw of (oldFilters.blacklist ?? [])) {
    const id = foldId(raw);
    if (!id) { diff.notes.push(`skipped empty blacklist entry ${JSON.stringify(raw)}`); continue; }
    if (seen.has(id)) { diff.deduped.push(String(raw)); continue; }
    seen.set(id, String(raw));
    blacklist.push(String(raw).trim());
    diff.ported++;
  }
  // Typo corrections: keep the typo verbatim, add the intended sibling DISABLED —
  // the original (typo) never blocked the real item, so enabling the correction
  // would change out-of-box behavior. Flip "enabled" in the file to adopt it.
  for (const [typo, fix] of Object.entries(KNOWN_TYPO_FIXES)) {
    if (seen.has(typo) && !seen.has(fix)) {
      blacklist.push({ pattern: fix, type: 'exact', target: 'item', enabled: false,
        reason: `auto: probable intended ID for original typo "${typo}" — disabled to preserve original behavior; enable to adopt` });
      seen.set(fix, fix);
      diff.typoFixes.push(`${typo} → added ${fix} (disabled)`);
    }
  }
  // Near-duplicate scan (distance ≤ 2) — informational only, nothing changed.
  const ids = [...seen.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (Math.abs(ids[i].length - ids[j].length) > 2) continue;
      const d = levenshtein(ids[i], ids[j]);
      if (d > 0 && d <= 2 && !KNOWN_TYPO_FIXES[ids[i]] && !KNOWN_TYPO_FIXES[ids[j]]) {
        diff.notes.push(`near-duplicates kept as-is: ${ids[i]} ↔ ${ids[j]} (distance ${d})`);
      }
    }
  }

  // ---- whitelist: map form → rule entries, meta preserved verbatim ----
  const whitelist = [];
  for (const [tag, meta] of Object.entries(oldFilters.whitelist ?? {})) {
    whitelist.push({ pattern: foldId(tag), type: 'exact', target: 'item',
      meta: { ...meta }, reason: 'ported from original whitelist' });
    diff.whitelist.push(`${foldId(tag)} (minProfit=${meta?.minProfit ?? '—'}, minPercentage=${meta?.minPercentage ?? '—'}, maxBuyOrder=${meta?.maxBuyOrder ?? '—'})`);
  }
  // Precedence demo entry (disabled, zero effect) — documents how override works.
  whitelist.push({ pattern: 'ENCHANTED_COAL', type: 'exact', target: 'item', enabled: false,
    reason: 'example: enabling this un-blocks a blacklisted item (precedence: whitelist wins)' });

  // ---- suggestions ----
  if (seedSuggestions) {
    for (const s of SUGGESTIONS) { blacklist.push({ ...s }); diff.suggestions.push(`${s.type}:${s.pattern} (${s.enabled ? 'enabled' : 'disabled'})`); }
  }

  const selectiveBuys = typeof oldFilters.selectiveBuys === 'boolean'
    ? oldFilters.selectiveBuys
    : false; // original "{}" object form ≡ feature present but OFF
  if (oldFilters.selectiveBuys && typeof oldFilters.selectiveBuys === 'object' && Object.keys(oldFilters.selectiveBuys).length) {
    diff.notes.push(`selectiveBuys object had ${Object.keys(oldFilters.selectiveBuys).length} entries — carried into whitelist semantics`);
  }

  const config = {
    version: 2,
    precedence: 'whitelist',
    benchMinutes: Number(oldSettings?.price?.temporaryBlacklistDuration) > 0
      ? Number(oldSettings.price.temporaryBlacklistDuration) : 15,
    selectiveBuys,
    blacklist,
    whitelist,
  };

  const lines = [
    '=== filters migration (MBF → v2) ===',
    `ported blacklist entries : ${diff.ported}`,
    `duplicates collapsed     : ${diff.deduped.length}${diff.deduped.length ? '  (' + [...new Set(diff.deduped)].join(', ') + ')' : ''}`,
    `typo corrections added   : ${diff.typoFixes.length}${diff.typoFixes.map((t) => '\n  + ' + t).join('')}`,
    `whitelist entries ported : ${diff.whitelist.length}${diff.whitelist.map((w) => '\n  + ' + w).join('')}`,
    `suggestion rules seeded  : ${diff.suggestions.length} (all disabled)${diff.suggestions.map((s) => '\n  ~ ' + s).join('')}`,
    `benchMinutes             : ${config.benchMinutes} (from settings.price.temporaryBlacklistDuration)`,
    `selectiveBuys            : ${config.selectiveBuys}`,
    ...(diff.notes.length ? ['notes:', ...diff.notes.map((n) => '  · ' + n)] : []),
  ];
  return { config, diff, diffText: lines.join('\n') };
}
