// First-class blacklist/whitelist engine — headless, config-file driven, zero-dep.
//
// Design goals (ported from the MBF-style filters + made general):
//   • black + white lists with configurable precedence (whitelist wins by default)
//   • per-rule match type: exact | prefix | suffix | substring | glob | regex
//   • per-rule action (block/allow/warn/log/bench/replace), reason, enabled, expiry
//   • anti-evasion normalization (src/antiEvasion.js) — a rule matches if EITHER
//     the strict or the aggressive fold of the value matches the same fold of the
//     pattern, so "𝖿𝗋𝖾𝖾", "f r e e" and "§cfree" all hit a "free" rule
//   • targets: item (Bazaar product ID), name (display name), chat, username,
//     command, server — each with its own normalization profile
//   • O(1) exact lookups via per-(list,target) hash maps; compiled+cached regex;
//     scans bucketed by target so unrelated rules cost nothing
//   • JSONC config (comments + trailing commas tolerated), line-aware validation
//     that QUARANTINES bad rules (engine keeps running) instead of crashing
//   • hot-reload: watch the file; a broken edit keeps the last good ruleset
//   • dynamic rules with TTL (bench) — the runtime "temporary blacklist"
//
// Never throws on malformed input: check() on garbage returns {matched:false}.

import { readFileSync, watchFile, unwatchFile, existsSync } from 'node:fs';
import { foldsFor, foldId, PROFILES } from './antiEvasion.js';

const MATCH_TYPES = new Set(['exact', 'prefix', 'suffix', 'substring', 'glob', 'regex']);
const ACTIONS = new Set(['block', 'allow', 'warn', 'log', 'bench', 'replace', 'kick', 'censor']);
const BLOCKING = new Set(['block', 'bench', 'kick']);
const TARGETS = Object.keys(PROFILES);

/** Strip BOM, // and /* *​/ comments, then trailing commas — string-safe, in TWO
 *  passes so "[1, /* c *​/ ]" (comma, then a comment, then the bracket) parses:
 *  a one-pass lookahead sees the comment and keeps the comma, breaking the very
 *  common edit of commenting out the last list entry. */
export function parseJsonc(src) {
  let s = String(src ?? '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // UTF-8 BOM (PowerShell loves these)
  // Pass 1: strip comments (string-aware).
  let a = '', i = 0, inStr = false;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (inStr) {
      a += c;
      if (c === '\\') { a += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; a += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    a += c; i++;
  }
  // Pass 2: drop trailing commas (string-aware; comments are already gone).
  let out = ''; i = 0; inStr = false;
  while (i < a.length) {
    const c = a[i], n = a[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < a.length && /\s/.test(a[j])) j++;
      if (a[j] === '}' || a[j] === ']') { i++; continue; }
    }
    out += c; i++;
  }
  return JSON.parse(out);
}

// Catastrophic-backtracking heuristic: a quantifier applied to a group that
// itself contains a quantifier — the classic (a+)+ / (a*)* / (a{2,})+ ReDoS
// class. Such rules are quarantined at load unless they set unsafeRegex:true.
const NESTED_QUANTIFIER_RE = /\([^()]*[+*{][^()]*\)\s*[+*{]/;
// Defense-in-depth: regex/glob rules never test more than this many chars.
const MAX_REGEX_INPUT = 2048;

function globToRegex(glob, caseSensitive) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, caseSensitive ? '' : 'i');
}

let seq = 0;

export class FilterEngine {
  constructor({ log = () => {}, now = Date.now } = {}) {
    this.log = log;
    this.now = now;
    this.precedence = 'whitelist'; // which list wins when both match
    this.whitelistOnly = false;    // selectiveBuys: trade nothing but whitelisted
    this.benchMinutes = 15;        // default TTL for dynamic bench rules
    this.errors = [];              // quarantined rules: {index, id, list, message}
    this.hits = { black: 0, white: 0 };
    this.version = 0;              // bumps on every successful (re)build
    this.lastError = null;         // last load failure (old ruleset kept)
    this._fileRules = [];          // normalized rules from the config file
    this._cfgRules = [];           // rules synthesized from the bot cfg snapshot
    this._dynamic = [];            // bench() rules with expiry
    this._path = null;
    this._watching = false;
    this._buckets = null;
    this._itemMeta = new Map();    // TAG → whitelist meta {minProfit,minPercentage,maxBuyOrder}
    this._rebuild();
  }

  // ---- loading -----------------------------------------------------------------

  /** Load a parsed config object. Accepts BOTH shapes:
   *  v1 (MBF): { blacklist:[ids], whitelist:{TAG:{...}}, selectiveBuys:{}|bool }
   *  v2:       { version:2, precedence, benchMinutes, blacklist:[str|rule],
   *             whitelist:[str|rule]|{TAG:meta}, selectiveBuys:bool } */
  loadObject(obj, { source = 'file' } = {}) {
    try {
      return this._loadObject(obj, source);
    } catch (e) { // e.g. throwing property getters — contract: return, never throw
      this.lastError = `config rejected: ${e.message}`;
      return { ok: false, errors: [{ message: this.lastError }], counts: this.stats() };
    }
  }

  _loadObject(obj, source) {
    const errors = [];
    const rules = [];
    if (!obj || typeof obj !== 'object') {
      this.lastError = 'config is not an object';
      return { ok: false, errors: [{ message: this.lastError }], counts: this.stats() };
    }
    this.precedence = obj.precedence === 'blacklist' ? 'blacklist' : 'whitelist';
    if (Number.isFinite(obj.benchMinutes)) this.benchMinutes = obj.benchMinutes;
    const wlOnly = typeof obj.selectiveBuys === 'boolean' ? obj.selectiveBuys
      : (obj.whitelistOnly === true);

    const push = (raw, list, index) => {
      const r = this._normalizeRule(raw, list, index, errors);
      if (r) rules.push(r);
    };
    if (Array.isArray(obj.blacklist)) obj.blacklist.forEach((e, i) => push(e, 'black', i));
    if (Array.isArray(obj.whitelist)) obj.whitelist.forEach((e, i) => push(e, 'white', i));
    else if (obj.whitelist && typeof obj.whitelist === 'object') { // v1 map form
      Object.entries(obj.whitelist).forEach(([tag, meta], i) =>
        push({ pattern: tag, target: 'item', type: 'exact', meta }, 'white', i));
    }
    if (Array.isArray(obj.rules)) obj.rules.forEach((e, i) => push(e, e?.list === 'white' ? 'white' : 'black', i));

    this._fileRules = rules;
    this._fileWhitelistOnly = wlOnly;
    this.errors = errors;
    this.lastError = null;
    this._rebuild();
    for (const e of errors) this.log(`[filters] rule quarantined (${e.list}[${e.index}]${e.id ? ' ' + e.id : ''}): ${e.message}`);
    return { ok: true, errors, counts: this.stats() };
  }

  /** Load (or reload) from a JSONC file. On failure the previous ruleset stays. */
  loadFile(path) {
    this._path = path;
    let obj;
    try { obj = parseJsonc(readFileSync(path, 'utf8')); }
    catch (e) {
      this.lastError = `${path}: ${e.message}`;
      this.log(`[filters] load failed — keeping previous rules: ${this.lastError}`);
      return { ok: false, errors: [{ message: this.lastError }], counts: this.stats() };
    }
    const r = this.loadObject(obj, { source: 'file' });
    if (r.ok) this.log(`[filters] loaded ${path}: ${this._fileRules.length} rules (${r.errors.length} quarantined)`);
    return r;
  }

  reload() { return this._path ? this.loadFile(this._path) : { ok: false, errors: [{ message: 'no file loaded' }] }; }

  /** Hot-reload: poll the file (watchFile is reliable cross-platform). */
  watch({ intervalMs = 2000 } = {}) {
    if (!this._path || this._watching) return;
    this._watching = true;
    watchFile(this._path, { interval: intervalMs }, (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs) { this.log('[filters] file changed — reloading'); this.reload(); }
    });
  }

  unwatch() { if (this._path && this._watching) { unwatchFile(this._path); this._watching = false; } }

  /** Ingest a SOURCE snapshot of legacy fields (blacklistTags / whitelist map /
   *  avoidItems / whitelistOnly) as an extra rule source. IMPORTANT: pass the
   *  ORIGINAL source (config.json values / a dashboard-import payload), never an
   *  object mirrorToCfg has written to — mirroring exports the merged view, and
   *  re-attaching it would echo file rules back in as cfg rules (deletions from
   *  the file would then stick around, and whitelistOnly would latch on).
   *  Replaces the previous cfg-source set (idempotent). Never throws. */
  attachCfg(src) {
    try {
      const rules = [];
      const errors = [];
      const tags = Array.isArray(src?.blacklistTags) ? src.blacklistTags : [];
      tags.forEach((t, i) => {
        const r = this._normalizeRule({ pattern: t, target: 'item', type: 'exact', reason: 'cfg.blacklistTags' }, 'black', i, errors);
        if (r) { r.src = 'cfg'; rules.push(r); }
      });
      const wl = (src?.whitelist && typeof src.whitelist === 'object' && !Array.isArray(src.whitelist)) ? src.whitelist : {};
      Object.entries(wl).forEach(([tag, meta], i) => {
        const r = this._normalizeRule({ pattern: tag, target: 'item', type: 'exact', meta, reason: 'cfg.whitelist' }, 'white', i, errors);
        if (r) { r.src = 'cfg'; rules.push(r); }
      });
      const avoid = Array.isArray(src?.avoidItems) ? src.avoidItems : [];
      avoid.forEach((n, i) => {
        const r = this._normalizeRule({ pattern: n, target: 'name', type: 'exact', reason: 'cfg.avoidItems' }, 'black', i, errors);
        if (r) { r.src = 'cfg'; rules.push(r); }
      });
      this._cfgRules = rules;
      this._cfgWhitelistOnly = src?.whitelistOnly === true;
      this._rebuild();
    } catch (e) { this.log(`[filters] attachCfg rejected malformed source: ${e.message}`); }
  }

  /** Mirror the engine's merged ITEM view onto cfg so legacy code paths
   *  (stateMachine fallback / dashboard state) see one coherent picture.
   *  Write-only: the mirrored object must NOT be fed back into attachCfg.
   *  Never throws (frozen/odd cfg objects are tolerated). */
  mirrorToCfg(cfg) {
    try {
      if (!cfg || typeof cfg !== 'object') return;
      const tags = new Set();
      for (const r of this._allRules()) {
        if (r.list === 'black' && r.target === 'item' && r.type === 'exact' && r.enabled && !this._expired(r)) tags.add(foldId(r.pattern));
      }
      cfg.blacklistTags = [...tags];
      cfg.whitelist = Object.fromEntries(this._itemMeta);
      cfg.whitelistOnly = this.whitelistOnly;
    } catch (e) { this.log(`[filters] mirrorToCfg skipped: ${e.message}`); }
  }

  // ---- rule normalization / compilation ------------------------------------------

  _normalizeRule(raw, list, index, errors) {
    try {
      const r = typeof raw === 'string' ? { pattern: raw } : (raw && typeof raw === 'object' ? { ...raw } : null);
      if (!r || typeof r.pattern !== 'string' || !r.pattern.trim()) {
        errors.push({ index, list, id: r?.id, message: 'missing/empty "pattern"' });
        return null;
      }
      r.list = list;
      r.type = (r.type ?? 'exact').toLowerCase();
      if (!MATCH_TYPES.has(r.type)) { errors.push({ index, list, id: r.id, message: `unknown type "${r.type}" (use ${[...MATCH_TYPES].join('/')})` }); return null; }
      r.target = (r.target ?? 'item').toLowerCase();
      if (!TARGETS.includes(r.target)) { errors.push({ index, list, id: r.id, message: `unknown target "${r.target}" — treating as chat` }); r.target = 'chat'; }
      r.action = (r.action ?? (list === 'white' ? 'allow' : 'block')).toLowerCase();
      if (!ACTIONS.has(r.action)) { errors.push({ index, list, id: r.id, message: `unknown action "${r.action}" — using ${list === 'white' ? 'allow' : 'block'}` }); r.action = list === 'white' ? 'allow' : 'block'; }
      r.enabled = r.enabled !== false;
      r.caseSensitive = r.caseSensitive === true;
      r.reason = r.reason ?? r.comment ?? '';
      r.id = r.id ?? `${list}-${r.target}-${++seq}`;
      r.src = 'file';
      if (r.ttlMinutes > 0) r.expiresAt = this.now() + r.ttlMinutes * 60_000;
      else if (r.expiresAt != null) {
        const t = typeof r.expiresAt === 'number' ? r.expiresAt : Date.parse(r.expiresAt);
        if (Number.isNaN(t)) { errors.push({ index, list, id: r.id, message: `bad expiresAt "${r.expiresAt}"` }); r.expiresAt = null; }
        else r.expiresAt = t;
      }
      // Compile the matcher now so a bad regex is caught at LOAD time, not match time.
      if (r.type === 'glob') r._re = globToRegex(r.pattern, r.caseSensitive);
      else if (r.type === 'regex') {
        if (NESTED_QUANTIFIER_RE.test(r.pattern) && r.unsafeRegex !== true) {
          errors.push({ index, list, id: r.id, message: `potentially catastrophic regex (nested quantifiers, e.g. (a+)+) — set "unsafeRegex": true to force` });
          return null;
        }
        try { r._re = new RegExp(r.pattern, r.caseSensitive ? '' : 'i'); }
        catch (e) { errors.push({ index, list, id: r.id, message: `bad regex: ${e.message}` }); return null; }
      } else {
        // Pre-fold the pattern once per profile fold strength.
        r._folds = foldsFor(r.target, r.pattern);
      }
      return r;
    } catch (e) {
      errors.push({ index, list, message: `rule rejected: ${e.message}` });
      return null;
    }
  }

  _allRules() { return [...this._fileRules, ...this._cfgRules, ...this._dynamic]; }

  _rebuild() {
    // buckets[target] = { exact: {black:Map, white:Map}, scan: {black:[], white:[]} }
    const b = {};
    for (const t of TARGETS) b[t] = { exact: { black: new Map(), white: new Map() }, scan: { black: [], white: [] } };
    this._itemMeta = new Map();
    for (const r of this._allRules()) {
      if (!r.enabled) continue;
      const bucket = b[r.target] ?? b.chat;
      if (r.type === 'exact' && !r.caseSensitive) {
        for (const f of (r._folds ?? [])) if (!bucket.exact[r.list].has(f)) bucket.exact[r.list].set(f, r);
      } else {
        bucket.scan[r.list].push(r);
      }
      if (r.list === 'white' && r.target === 'item' && r.type === 'exact' && r.meta && !this._expired(r)) {
        this._itemMeta.set(foldId(r.pattern), { ...r.meta });
      }
    }
    this._buckets = b;
    this.whitelistOnly = this._fileWhitelistOnly === true || this._cfgWhitelistOnly === true;
    this.version++;
    // Duplicate-pattern authority note: exact-match buckets are FIRST-wins (file
    // rule beats a cfg rule for the same folded pattern) while _itemMeta above is
    // LAST-wins (cfg meta overrides file meta) — deliberate: list membership
    // should follow the file, but dashboard-imported per-item meta should apply.
    try { this.onReload?.(this); } catch { /* observer must never break the engine */ }
  }

  _expired(r) { return r.expiresAt != null && this.now() > r.expiresAt; }

  // ---- matching ------------------------------------------------------------------

  _matchList(list, target, value, folds) {
    const bucket = this._buckets[target] ?? this._buckets.chat;
    // O(1): exact map, strictest fold first.
    for (const f of folds) {
      const r = bucket.exact[list].get(f);
      if (r && !this._expired(r)) return r;
    }
    // Scans: same-strength fold pairing (strict needle vs strict value, etc.).
    const raw = String(value ?? '');
    for (const r of bucket.scan[list]) {
      if (this._expired(r)) continue;
      try {
        if (r._re) { // glob / regex — test raw and every fold (length-capped: ReDoS defense)
          if (r._re.test(raw.slice(0, MAX_REGEX_INPUT))) return r;
          for (const f of folds) if (r._re.test(f.slice(0, MAX_REGEX_INPUT))) return r;
          continue;
        }
        if (r.caseSensitive) {
          if (this._plainTest(r.type, r.pattern, raw)) return r;
          continue;
        }
        const n = Math.min(r._folds.length, folds.length);
        for (let i = 0; i < n; i++) if (this._plainTest(r.type, r._folds[i], folds[i])) return r;
        // strength counts differ (e.g. id vs text profile) — cross-check strictest.
        if (n === 0 || r._folds.length !== folds.length) {
          if (this._plainTest(r.type, r._folds[0], folds[0])) return r;
        }
      } catch { /* one bad rule must never break matching */ }
    }
    return null;
  }

  _plainTest(type, needle, hay) {
    if (!needle || hay == null) return false;
    switch (type) {
      case 'exact': return hay === needle;
      case 'prefix': return hay.startsWith(needle);
      case 'suffix': return hay.endsWith(needle);
      case 'substring': return hay.includes(needle);
      default: return false;
    }
  }

  /** Check one value against one target. Returns a verdict — never throws.
   *  {matched, list, rule, action, reason, blocking} */
  check(target, value) {
    try {
      const t = TARGETS.includes(target) ? target : 'chat';
      const folds = foldsFor(t, value);
      const white = this._matchList('white', t, value, folds);
      const black = this._matchList('black', t, value, folds);
      let winner = null, list = null;
      if (white && black) { winner = this.precedence === 'blacklist' ? black : white; list = this.precedence === 'blacklist' ? 'black' : 'white'; }
      else if (white) { winner = white; list = 'white'; }
      else if (black) { winner = black; list = 'black'; }
      if (!winner) return { matched: false, action: 'none', blocking: false };
      this.hits[list]++;
      return {
        matched: true, list, rule: winner, action: winner.action,
        reason: winner.reason || '', blocking: list === 'black' && BLOCKING.has(winner.action),
      };
    } catch { return { matched: false, action: 'none', blocking: false }; }
  }

  /** Text helper: verdict + best-effort censored string for replace/censor rules. */
  checkText(target, value) {
    const v = this.check(target, value);
    if (v.matched && (v.action === 'replace' || v.action === 'censor')) {
      try {
        const re = new RegExp(String(v.rule.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        v.replaced = String(value).replace(re, '***');
      } catch { v.replaced = '***'; }
    }
    return v;
  }

  /** Should the flipper skip this item entirely? Checks the product ID (item
   *  target) AND the display name (name target); whitelist wins per precedence.
   *  whitelistOnly: anything not whitelisted is blocked. */
  blocksItem(tag, displayName = null) {
    try {
      const byTag = this.check('item', tag);
      const byName = displayName ? this.check('name', displayName) : { matched: false };
      const white = (byTag.matched && byTag.list === 'white') || (byName.matched && byName.list === 'white');
      const blackV = byTag.matched && byTag.list === 'black' ? byTag : (byName.matched && byName.list === 'black' ? byName : null);
      if (this.whitelistOnly && !white) return true;
      if (white && blackV) return this.precedence === 'blacklist' && blackV.blocking;
      if (blackV) return blackV.blocking;
      return false;
    } catch { return false; }
  }

  /** Whitelist meta overrides for an item ({minProfit,minPercentage,maxBuyOrder}). */
  itemMeta(tag) { return this._itemMeta.get(foldId(tag)) ?? null; }

  // ---- dynamic rules (the runtime "temporary blacklist") --------------------------

  bench(tag, minutes = this.benchMinutes, reason = 'benched at runtime') {
    if (!Number.isFinite(minutes) || minutes <= 0) minutes = this.benchMinutes; // garbage TTL must not create a permanent rule
    const t = foldId(tag);
    this._dynamic = this._dynamic.filter((r) => !(r.target === 'item' && foldId(r.pattern) === t) && !this._expired(r));
    const r = this._normalizeRule({ pattern: t, target: 'item', type: 'exact', action: 'bench', reason, ttlMinutes: minutes }, 'black', this._dynamic.length, []);
    if (r) { r.src = 'dynamic'; this._dynamic.push(r); this._rebuild(); }
    return r;
  }

  unbench(tag) {
    const t = foldId(tag);
    const before = this._dynamic.length;
    this._dynamic = this._dynamic.filter((r) => foldId(r.pattern) !== t);
    if (this._dynamic.length !== before) this._rebuild();
  }

  benched() {
    return this._dynamic.filter((r) => !this._expired(r))
      .map((r) => ({ tag: r.pattern, until: r.expiresAt, reason: r.reason }));
  }

  // ---- observability -------------------------------------------------------------

  stats() {
    const count = (list) => this._allRules().filter((r) => r.list === list && r.enabled && !this._expired(r)).length;
    return {
      black: count('black'), white: count('white'),
      dynamic: this._dynamic.filter((r) => !this._expired(r)).length,
      quarantined: this.errors.length, precedence: this.precedence,
      whitelistOnly: this.whitelistOnly, hits: { ...this.hits },
      version: this.version, lastError: this.lastError,
    };
  }

  /** List rules for the CLI (enabled state, expiry resolved). */
  listRules({ list = null } = {}) {
    return this._allRules()
      .filter((r) => !list || r.list === list)
      .map((r) => ({
        id: r.id, list: r.list, target: r.target, type: r.type, pattern: r.pattern,
        action: r.action, enabled: r.enabled && !this._expired(r), reason: r.reason,
        src: r.src, expiresAt: r.expiresAt ?? null, meta: r.meta ?? null,
      }));
  }
}

/** Build an engine from a file if it exists, plus an optional cfg SOURCE
 *  snapshot, mirroring the merged view onto mirrorTo (usually the live bot cfg).
 *  _path is set even when the file is absent, so watch() picks the file up the
 *  moment it is created. (cfg is accepted as a legacy alias for cfgSource —
 *  do NOT pass the same object as both source and mirror target.) */
export function createEngine({ path = './filters.rules.json', cfgSource = null, cfg = null, mirrorTo = null, log = () => {}, watch = false } = {}) {
  const e = new FilterEngine({ log });
  if (path) {
    e._path = path; // before existsSync: reload()/watch() work for late-created files
    if (existsSync(path)) e.loadFile(path);
    if (watch) e.watch();
  }
  const src = cfgSource ?? cfg;
  if (src) e.attachCfg(src);
  if (mirrorTo) e.mirrorToCfg(mirrorTo);
  else if (src && !mirrorTo && cfg && !cfgSource) e.mirrorToCfg(cfg); // legacy call shape
  return e;
}
