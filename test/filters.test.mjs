// Filter engine test suite — run with `npm test` (node --test, zero deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilterEngine, parseJsonc, createEngine } from '../src/filterEngine.js';
import { foldStrict, foldAggressive, foldId } from '../src/antiEvasion.js';
import { migrate } from '../src/migrateFilters.js';

const mk = (obj) => { const e = new FilterEngine(); e.loadObject(obj); return e; };

// ---------- anti-evasion normalization ----------

test('foldStrict: math alphanumerics, zero-width, soft hyphen, formatting codes, cyrillic', () => {
  assert.equal(foldStrict('𝖿𝗋𝖾𝖾'), 'free');                    // NFKC math sans
  assert.equal(foldStrict('fre­e.gg'), 'free.gg');        // soft hyphen
  assert.equal(foldStrict('fr​ee'), 'free');              // zero-width space
  assert.equal(foldStrict('§c§lFREE'), 'free');                // MC color codes
  assert.equal(foldStrict('&aFrEe'), 'free');
  assert.equal(foldStrict('frее'), 'free');          // Cyrillic е
  assert.equal(foldStrict('  a   b  '), 'a b');                // whitespace collapse
  assert.equal(foldStrict(null), '');                          // never throws
});

test('foldAggressive: spacing, leet, repeats all meet', () => {
  const target = foldAggressive('free');
  assert.equal(foldAggressive('f r e e'), target);
  assert.equal(foldAggressive('f.r.e.e'), target);
  assert.equal(foldAggressive('fr33'), target);
  assert.equal(foldAggressive('freeeeee'), target);
  assert.equal(foldAggressive('F R 3 E'), target);
});

test('foldId: exactness preserved (GABAGOOL keeps OO), separators normalized', () => {
  assert.equal(foldId('very crude gabagool'), 'VERY_CRUDE_GABAGOOL');
  assert.equal(foldId('  enchanted-coal '), 'ENCHANTED_COAL');
  assert.equal(foldId('VERY_CRUDE_GABAGOOL'), 'VERY_CRUDE_GABAGOOL');
});

// ---------- match types ----------

test('every match type works', () => {
  const e = mk({ blacklist: [
    { pattern: 'ENCHANTED_COAL', type: 'exact', target: 'item' },
    { pattern: 'ESSENCE_', type: 'prefix', target: 'item' },
    { pattern: '_GEM', type: 'suffix', target: 'item' },
    { pattern: 'scam', type: 'substring', target: 'chat' },
    { pattern: 'SHARD_*', type: 'glob', target: 'item' },
    { pattern: '^gift(ed)?$', type: 'regex', target: 'username' },
  ] });
  assert.equal(e.check('item', 'ENCHANTED_COAL').matched, true);
  assert.equal(e.check('item', 'enchanted coal').matched, true);   // id fold
  assert.equal(e.check('item', 'ENCHANTED_COALS').matched, false); // exact is exact
  assert.equal(e.check('item', 'ESSENCE_GOLD').matched, true);     // prefix
  assert.equal(e.check('item', 'FINE_RUBY_GEM').matched, true);    // suffix
  assert.equal(e.check('chat', 'this is a SCAM link').matched, true); // substring ci
  assert.equal(e.check('item', 'SHARD_KRAKEN').matched, true);     // glob
  assert.equal(e.check('item', 'KRAKEN_SHARD').matched, false);    // glob anchored
  assert.equal(e.check('username', 'Gifted').matched, true);       // regex ci
  assert.equal(e.check('username', 'regifted').matched, false);    // regex anchors hold
});

test('caseSensitive rules match raw only', () => {
  const e = mk({ blacklist: [{ pattern: 'AbC', type: 'exact', target: 'chat', caseSensitive: true }] });
  assert.equal(e.check('chat', 'AbC').matched, true);
  assert.equal(e.check('chat', 'abc').matched, false);
});

// ---------- precedence ----------

test('whitelist overrides blacklist by default; configurable to blacklist-wins', () => {
  const both = { blacklist: ['ENCHANTED_COAL'], whitelist: [{ pattern: 'ENCHANTED_COAL', target: 'item', type: 'exact' }] };
  const w = mk({ ...both });
  assert.equal(w.blocksItem('ENCHANTED_COAL'), false, 'whitelist wins');
  const b = mk({ ...both, precedence: 'blacklist' });
  assert.equal(b.blocksItem('ENCHANTED_COAL'), true, 'blacklist wins when configured');
});

test('whitelistOnly (selectiveBuys) blocks everything not whitelisted', () => {
  const e = mk({ selectiveBuys: true, blacklist: [], whitelist: [{ pattern: 'PRECURSOR_GEAR', target: 'item', type: 'exact' }] });
  assert.equal(e.blocksItem('PRECURSOR_GEAR'), false);
  assert.equal(e.blocksItem('ENCHANTED_MITHRIL'), true);
});

// ---------- actions / expiry / dynamic ----------

test('non-blocking actions (warn/log) match but do not block items', () => {
  const e = mk({ blacklist: [{ pattern: 'SORROW', target: 'item', type: 'exact', action: 'warn' }] });
  const v = e.check('item', 'SORROW');
  assert.equal(v.matched, true);
  assert.equal(v.blocking, false);
  assert.equal(e.blocksItem('SORROW'), false);
});

test('expiry: ttlMinutes rules stop matching after expiry; bench() is temporary', () => {
  let clock = 1_000_000;
  const e = new FilterEngine({ now: () => clock });
  e.loadObject({ blacklist: [{ pattern: 'DUNG', target: 'item', type: 'exact', ttlMinutes: 10 }] });
  assert.equal(e.blocksItem('DUNG'), true);
  clock += 11 * 60_000;
  assert.equal(e.blocksItem('DUNG'), false, 'expired rule no longer blocks');

  e.bench('RUSTY_COIN', 5, 'test bench');
  assert.equal(e.blocksItem('RUSTY_COIN'), true);
  assert.equal(e.benched().length, 1);
  clock += 6 * 60_000;
  assert.equal(e.blocksItem('RUSTY_COIN'), false, 'bench expired');
});

test('replace action censors text', () => {
  const e = mk({ blacklist: [{ pattern: 'badword', type: 'substring', target: 'chat', action: 'replace' }] });
  const v = e.checkText('chat', 'you badword you');
  assert.equal(v.replaced, 'you *** you');
});

// ---------- anti-evasion end-to-end ----------

test('one "free" chat rule catches all evasion variants', () => {
  const e = mk({ blacklist: [{ pattern: 'free', type: 'substring', target: 'chat' }] });
  for (const s of ['get free coins', 'get 𝖿𝗋𝖾𝖾 coins', 'get f r e e coins', 'get frее coins', '§cget free coins', 'get fr33 coins', 'fre­e stuff', '🅵🆁🅴🅴 coins', '🇫🇷🇪🇪 coins']) {
    assert.equal(e.check('chat', s).matched, true, `should match: ${JSON.stringify(s)}`);
  }
  assert.equal(e.check('chat', 'hello world').matched, false);
});

// ---------- malformed input ----------

test('malformed rules are quarantined with clear errors; engine keeps working', () => {
  const e = new FilterEngine();
  const r = e.loadObject({ blacklist: [
    'GOOD_ID',
    { pattern: '(unclosed', type: 'regex', target: 'chat' },   // bad regex
    { type: 'exact' },                                          // no pattern
    { pattern: 'X', type: 'nonsense' },                         // bad type
    42,                                                         // not a rule
  ] });
  assert.equal(r.ok, true);
  assert.equal(e.errors.length, 4);
  assert.match(e.errors[0].message, /bad regex/);
  assert.equal(e.check('item', 'GOOD_ID').matched, true, 'good rule survived');
});

test('check() never throws on garbage input', () => {
  const e = mk({ blacklist: ['X'] });
  for (const v of [null, undefined, 42, {}, [], '\uD800', 'a'.repeat(100000)]) {
    assert.doesNotThrow(() => e.check('chat', v));
    assert.doesNotThrow(() => e.check('nonsense-target', v));
  }
});

test('parseJsonc: comments + trailing commas, string-safe', () => {
  const obj = parseJsonc(`{
    // line comment
    "a": "keep // this, and this, ]",  /* block */
    "b": [1, 2, 3,],
  }`);
  assert.equal(obj.a, 'keep // this, and this, ]');
  assert.deepEqual(obj.b, [1, 2, 3]);
});

// ---------- hot reload ----------

test('loadFile + reload: broken edit keeps last good ruleset; good edit applies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'filters-'));
  const p = join(dir, 'rules.json');
  writeFileSync(p, JSON.stringify({ blacklist: ['AAA'] }));
  const e = new FilterEngine();
  assert.equal(e.loadFile(p).ok, true);
  assert.equal(e.blocksItem('AAA'), true);

  writeFileSync(p, '{ this is not json');
  assert.equal(e.reload().ok, false);
  assert.equal(e.blocksItem('AAA'), true, 'previous rules kept after broken edit');
  assert.ok(e.lastError, 'load error recorded');

  writeFileSync(p, JSON.stringify({ blacklist: ['BBB'] }));
  assert.equal(e.reload().ok, true);
  assert.equal(e.blocksItem('AAA'), false);
  assert.equal(e.blocksItem('BBB'), true);
});

test('watch(): file change hot-reloads within the poll interval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'filters-w-'));
  const p = join(dir, 'rules.json');
  writeFileSync(p, JSON.stringify({ blacklist: ['OLD'] }));
  const e = new FilterEngine();
  e.loadFile(p);
  e.watch({ intervalMs: 100 });
  const v0 = e.version;
  await new Promise((r) => setTimeout(r, 150));
  writeFileSync(p, JSON.stringify({ blacklist: ['NEW'] }));
  const deadline = Date.now() + 4000;
  while (e.version === v0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  e.unwatch();
  assert.ok(e.version > v0, 'reload fired on file change');
  assert.equal(e.blocksItem('NEW'), true);
  assert.equal(e.blocksItem('OLD'), false);
});

// ---------- migration losslessness ----------

test('migration: every original entry blocks; whitelist meta intact; dupes collapsed', () => {
  const original = JSON.parse(readFileSync(new URL('../import/filters.mbf.json', import.meta.url), 'utf8'));
  const { config, diff } = migrate(original, { price: { temporaryBlacklistDuration: 15 } });
  const e = new FilterEngine();
  e.loadObject(config);
  for (const t of original.blacklist) assert.equal(e.blocksItem(t), true, `original entry must block: ${t}`);
  assert.equal(diff.ported + diff.deduped.length, original.blacklist.length, 'every entry accounted for');
  const meta = e.itemMeta('PRECURSOR_GEAR');
  assert.deepEqual(meta, { minProfit: 50000, minPercentage: 5, maxBuyOrder: 10 });
  assert.equal(config.benchMinutes, 15);
  // suggestions must be seeded DISABLED — out-of-the-box behavior is the original
  assert.equal(e.blocksItem('ESSENCE_MIDNIGHT'), false, 'disabled glob suggestion inert');
});

test('shipped filters.rules.json loads clean and matches the original', () => {
  const e = new FilterEngine();
  const r = e.loadFile(new URL('../filters.rules.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.equal(r.ok, true);
  assert.equal(e.errors.length, 0, 'no quarantined rules in the shipped config');
  const original = JSON.parse(readFileSync(new URL('../import/filters.mbf.json', import.meta.url), 'utf8'));
  for (const t of original.blacklist) assert.equal(e.blocksItem(t), true, `shipped config must block ${t}`);
  assert.equal(e.blocksItem('ENCHANTED_MITHRIL'), false, 'non-blacklisted items still tradeable');
});

// ---------- cfg attach / mirror (bot integration) ----------

test('attachCfg ingests legacy fields; mirrorToCfg exports coherent union', () => {
  const e = mk({ blacklist: ['FILE_TAG'] });
  const cfg = { blacklistTags: ['CFG_TAG'], whitelist: { WL_TAG: { minProfit: 1 } }, avoidItems: ['Undead Essence'], whitelistOnly: false };
  e.attachCfg(cfg);
  assert.equal(e.blocksItem('FILE_TAG'), true);
  assert.equal(e.blocksItem('CFG_TAG'), true);
  assert.equal(e.blocksItem('SOMETHING', 'Undead Essence'), true, 'display-name avoid works');
  assert.deepEqual(e.itemMeta('WL_TAG'), { minProfit: 1 });
  e.mirrorToCfg(cfg);
  assert.ok(cfg.blacklistTags.includes('FILE_TAG') && cfg.blacklistTags.includes('CFG_TAG'));
  assert.ok(cfg.whitelist.WL_TAG);
});

// ---------- regressions from the adversarial verification pass ----------

test('never-throw contract: hostile toString on bench/unbench/itemMeta/loadObject', () => {
  const evil = { toString() { throw new Error('evil'); } };
  const e = mk({ blacklist: ['X'] });
  assert.doesNotThrow(() => e.bench(evil));
  assert.doesNotThrow(() => e.unbench(evil));
  assert.doesNotThrow(() => e.itemMeta(evil));
  const r = new FilterEngine().loadObject({ get blacklist() { throw new Error('getter bomb'); } });
  assert.equal(r.ok, false, 'getter bomb returns ok:false, never throws');
});

test('parseJsonc: trailing comma followed by a comment (commented-out last entry)', () => {
  assert.deepEqual(parseJsonc('[1, /* c */ ]'), [1]);
  assert.deepEqual(parseJsonc('[\n"A", // "B"\n]'), ['A']);
  assert.deepEqual(parseJsonc('﻿{"a":1}'), { a: 1 }, 'UTF-8 BOM tolerated');
});

test('ReDoS guard: nested-quantifier regex quarantined unless unsafeRegex', () => {
  const e = new FilterEngine();
  e.loadObject({ blacklist: [{ pattern: '(a+)+$', type: 'regex', target: 'chat' }] });
  assert.equal(e.errors.length, 1);
  assert.match(e.errors[0].message, /catastrophic/);
  assert.equal(e.check('chat', 'aaaa').matched, false, 'quarantined rule inert');
  const f = new FilterEngine();
  f.loadObject({ blacklist: [{ pattern: '(a+)+$', type: 'regex', target: 'chat', unsafeRegex: true }] });
  assert.equal(f.errors.length, 0, 'explicit unsafeRegex opt-out honored');
});

test('bench: garbage minutes fall back to benchMinutes (never permanent)', () => {
  let clock = 0;
  const e = new FilterEngine({ now: () => clock });
  e.loadObject({ benchMinutes: 5, blacklist: [] });
  e.bench('FOO', NaN);
  assert.equal(e.blocksItem('FOO'), true);
  clock = 6 * 60_000;
  assert.equal(e.blocksItem('FOO'), false, 'NaN TTL fell back to 5min, expired');
});

test('attachCfg/mirrorToCfg tolerate malformed cfg shapes', () => {
  const e = mk({ blacklist: ['X'] });
  assert.doesNotThrow(() => e.attachCfg({ blacklistTags: 'abc', whitelist: 42, avoidItems: {} }));
  assert.doesNotThrow(() => e.mirrorToCfg(Object.freeze({})));
  assert.doesNotThrow(() => e.mirrorToCfg('nope'));
  assert.equal(e.blocksItem('X'), true, 'file rules unharmed');
});

test('no mirror→attach echo: file deletions apply after re-attach; whitelistOnly never latches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'filters-echo-'));
  const p = join(dir, 'rules.json');
  writeFileSync(p, JSON.stringify({ selectiveBuys: false, blacklist: ['FILE_TAG'] }));
  const e = new FilterEngine();
  e.loadFile(p);
  const src = { blacklistTags: ['CFG_TAG'], whitelist: {}, avoidItems: [], whitelistOnly: false };
  e.attachCfg(src);
  const mirrored = {};
  e.mirrorToCfg(mirrored);
  assert.ok(mirrored.blacklistTags.includes('FILE_TAG'));
  // Re-attach the SOURCE (correct usage) after deleting the file rule.
  writeFileSync(p, JSON.stringify({ selectiveBuys: false, blacklist: [] }));
  e.reload();
  e.attachCfg(src);
  assert.equal(e.blocksItem('FILE_TAG'), false, 'file deletion applies — no echo resurrection');
  assert.equal(e.blocksItem('CFG_TAG'), true, 'cfg source survives');
  assert.equal(e.whitelistOnly, false, 'whitelistOnly does not latch');
  // Repeated attach is idempotent (rule count stable).
  const n = e.stats().black;
  e.attachCfg(src); e.attachCfg(src);
  assert.equal(e.stats().black, n);
});

test('parity: DIAMOND_SPREADING typo-correction ships DISABLED (out-of-box = original)', () => {
  const e = new FilterEngine();
  e.loadFile(new URL('../filters.rules.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.equal(e.blocksItem('DIAMONG_SPREADING'), true, 'original typo entry still blocks');
  assert.equal(e.blocksItem('DIAMOND_SPREADING'), false, 'corrected sibling is disabled by default');
});

test('createEngine: late-created rules file is reloadable (path set before existsSync)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'filters-late-'));
  const p = join(dir, 'rules.json');
  const e = createEngine({ path: p, log: () => {} }); // file does not exist yet
  assert.equal(e.blocksItem('LATE_TAG'), false);
  writeFileSync(p, JSON.stringify({ blacklist: ['LATE_TAG'] }));
  assert.equal(e.reload().ok, true, 'reload() works once the file appears');
  assert.equal(e.blocksItem('LATE_TAG'), true);
});

// ---------- performance ----------

test('perf: 10k exact rules, 20k lookups stay fast (hash-map path)', () => {
  const rules = Array.from({ length: 10_000 }, (_, i) => `ITEM_${i}`);
  const e = mk({ blacklist: rules });
  const t0 = performance.now();
  for (let i = 0; i < 10_000; i++) {
    assert.equal(e.check('item', `ITEM_${i}`).matched, true);
    assert.equal(e.check('item', `MISS_${i}`).matched, false);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `20k lookups took ${ms.toFixed(0)}ms — expected well under 2s`);
});
