#!/usr/bin/env node
// Headless CLI for the filter engine. Zero deps.
//
//   node tools/filter-cli.mjs check "some string" [--target item|name|chat|username|command|server] [--file filters.rules.json]
//   node tools/filter-cli.mjs list [--list black|white] [--enabled] [--file f]
//   node tools/filter-cli.mjs validate [--live] [--file f]        # --live checks item IDs against the Hypixel Bazaar API
//   node tools/filter-cli.mjs migrate <old-filters.json> [--settings old-settings.json] [-o filters.rules.json] [--diff filters.migration.txt]
//   node tools/filter-cli.mjs selftest [--file f]
//
// Exit codes: 0 ok / no match · 1 matched-blocking (check) or problems found · 2 usage/load error

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { FilterEngine, parseJsonc } from '../src/filterEngine.js';
import { migrate, levenshtein } from '../src/migrateFilters.js';
import { foldId } from '../src/antiEvasion.js';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, def = null) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? true) : def; };
const has = (name) => args.includes(name);
const file = flag('--file', './filters.rules.json');

function loadEngine() {
  const e = new FilterEngine({ log: (m) => console.error(m) });
  if (!existsSync(file)) { console.error(`no filters file at ${file} (use --file)`); process.exit(2); }
  const r = e.loadFile(file);
  if (!r.ok) process.exit(2);
  return e;
}

if (cmd === 'check') {
  const value = args[1];
  if (value == null || value.startsWith('--')) { console.error('usage: check "some string" [--target chat]'); process.exit(2); }
  const target = flag('--target', 'chat');
  const e = loadEngine();
  const v = e.checkText(target, value);
  if (!v.matched) { console.log(`no match  (target=${target})`); process.exit(0); }
  console.log(`MATCH  list=${v.list}  action=${v.action}${v.blocking ? ' (blocking)' : ''}`);
  console.log(`  rule    : [${v.rule.type}] ${v.rule.pattern}  (id ${v.rule.id}, target ${v.rule.target})`);
  if (v.reason) console.log(`  reason  : ${v.reason}`);
  if (v.replaced) console.log(`  censored: ${v.replaced}`);
  process.exit(v.blocking ? 1 : 0);
}

else if (cmd === 'list') {
  const e = loadEngine();
  const rules = e.listRules({ list: flag('--list') }).filter((r) => !has('--enabled') || r.enabled);
  for (const r of rules) {
    const exp = r.expiresAt ? `  expires ${new Date(r.expiresAt).toISOString()}` : '';
    const meta = r.meta ? `  meta ${JSON.stringify(r.meta)}` : '';
    console.log(`${r.enabled ? ' ' : 'x'} ${r.list === 'black' ? 'B' : 'W'} [${r.target}/${r.type}] ${r.pattern}  → ${r.action}${meta}${exp}${r.reason ? `   # ${r.reason}` : ''}`);
  }
  const s = e.stats();
  console.log(`\n${s.black} black · ${s.white} white · ${s.quarantined} quarantined · precedence=${s.precedence} · whitelistOnly=${s.whitelistOnly}`);
}

else if (cmd === 'validate') {
  const e = loadEngine();
  let problems = e.errors.length;
  for (const err of e.errors) console.log(`✗ quarantined ${err.list}[${err.index}]${err.id ? ' ' + err.id : ''}: ${err.message}`);
  if (has('--live')) {
    console.log('fetching live Bazaar product list…');
    const res = await fetch('https://api.hypixel.net/v2/skyblock/bazaar', { headers: { 'User-Agent': 'bzflipper-filter-cli' } });
    const root = await res.json();
    const known = new Set(Object.keys(root.products ?? {}));
    const itemRules = e.listRules().filter((r) => r.target === 'item' && r.type === 'exact');
    for (const r of itemRules) {
      const id = foldId(r.pattern);
      if (known.has(id)) continue;
      let best = null, bestD = 4;
      for (const k of known) {
        if (Math.abs(k.length - id.length) > 3) continue;
        const d = levenshtein(k, id);
        if (d < bestD) { bestD = d; best = k; }
      }
      console.log(`? unknown product ID "${id}"${best ? `  — did you mean "${best}"? (distance ${bestD})` : ''}`);
      problems++;
    }
    console.log(`checked ${itemRules.length} exact item rules against ${known.size} live products`);
  }
  console.log(problems ? `${problems} problem(s)` : '✓ config valid — no problems');
  process.exit(problems ? 1 : 0);
}

else if (cmd === 'migrate') {
  const src = args[1];
  if (!src || src.startsWith('--')) { console.error('usage: migrate <old-filters.json> [--settings s.json] [-o out.json] [--diff diff.txt]'); process.exit(2); }
  const oldFilters = parseJsonc(readFileSync(src, 'utf8'));
  const settingsPath = flag('--settings');
  const oldSettings = settingsPath ? parseJsonc(readFileSync(settingsPath, 'utf8')) : null;
  const { config, diffText } = migrate(oldFilters, oldSettings);
  const out = flag('-o', './filters.rules.json');
  writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
  console.log(diffText);
  console.log(`\nwrote ${out}`);
  const diffOut = flag('--diff');
  if (diffOut) { writeFileSync(diffOut, diffText + '\n'); console.log(`wrote ${diffOut}`); }
  // Round-trip guarantee: every original entry must match in the new engine.
  const e = new FilterEngine();
  e.loadObject(config);
  const missing = (oldFilters.blacklist ?? []).filter((t) => !e.blocksItem(t));
  const wlMissing = Object.keys(oldFilters.whitelist ?? {}).filter((t) => !e.itemMeta(t));
  if (missing.length || wlMissing.length) {
    console.error(`✗ LOSSY MIGRATION — missing black: ${missing.join(', ') || '—'}  missing white meta: ${wlMissing.join(', ') || '—'}`);
    process.exit(1);
  }
  console.log(`✓ verified lossless: all ${(oldFilters.blacklist ?? []).length} original blacklist entries block; whitelist meta intact`);
}

else if (cmd === 'selftest') {
  const e = loadEngine();
  const cases = [
    ['item', 'ENCHANTED_COAL'], ['item', 'enchanted coal'], ['item', 'SHARD_KRAKEN'],
    ['item', 'PRECURSOR_GEAR'], ['chat', 'visit free­.gg now'], ['chat', 'f r e e coins'],
  ];
  for (const [t, v] of cases) {
    const r = e.check(t, v);
    console.log(`${t.padEnd(8)} ${JSON.stringify(v).padEnd(28)} → ${r.matched ? `${r.list}/${r.action}${r.blocking ? ' BLOCK' : ''} (${r.rule.pattern})` : 'no match'}`);
  }
  console.log(JSON.stringify(e.stats(), null, 2));
}

else {
  console.error('commands: check | list | validate [--live] | migrate | selftest   (see file header for usage)');
  process.exit(2);
}
