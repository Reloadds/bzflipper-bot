// Anti-evasion text normalization for the filter engine. One rule like "free"
// must catch "free­gg" (soft hyphen), "f r e e" (spacing), "𝖿𝗋𝖾𝖾" (math
// alphanumerics), "§cfree" (formatting codes) and "frее" (Cyrillic е). Two fold
// strengths are produced so aggressive folding can widen matching without ever
// weakening it: a match on EITHER fold counts.
//
// Zero-dependency; pure functions; never throws on any input (null → '').

// Confusable homoglyphs NFKC does NOT fold (NFKC handles fullwidth + math
// alphanumerics, but Cyrillic/Greek lookalikes normalize to themselves).
const CONFUSABLES = {
  // Cyrillic → Latin
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c',
  'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'ԁ': 'd',
  'һ': 'h', 'к': 'k', 'м': 'm', 'т': 't', 'в': 'b',
  'н': 'h', 'А': 'a', 'Е': 'e', 'О': 'o', 'Р': 'p',
  'С': 'c', 'Х': 'x', 'У': 'y', 'І': 'i', 'Ѕ': 's',
  'К': 'k', 'М': 'm', 'Т': 't', 'В': 'b', 'Н': 'h',
  // Greek → Latin
  'ο': 'o', 'α': 'a', 'ν': 'v', 'ε': 'e', 'ι': 'i',
  'ρ': 'p', 'τ': 't', 'υ': 'u', 'Ο': 'o', 'Α': 'a',
  'Ε': 'e', 'Ι': 'i', 'Ρ': 'p', 'Τ': 't',
  // Misc lookalikes
  'ı': 'i', 'ℓ': 'l', 'ⅼ': 'l', 'ⅰ': 'i', 'ⅴ': 'v',
};
const CONFUSABLES_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

// Zero-width & invisible characters (incl. soft hyphen U+00AD — the classic
// "free­.gg" trick) and bidi controls.
const ZERO_WIDTH_RE = /[­​-‏⁠-⁤﻿᠎؜‪-‮⁦-⁩]/g;

// Minecraft formatting codes: §x or &x (color/format).
const FORMATTING_RE = /[§&][0-9a-fk-orx]/gi;

// Enclosed-alphanumeric letters NFKC does NOT decompose (found by adversarial
// testing: 🅵🆁🅴🅴 bypassed the NFKC pass). Mapped programmatically to a-z.
const ENCLOSED_RANGES = [
  [0x1F130, 0x1F149], // 🄰–🅉 squared latin
  [0x1F150, 0x1F169], // 🅐–🅩 negative circled
  [0x1F170, 0x1F189], // 🅰–🆉 negative squared
  [0x1F1E6, 0x1F1FF], // 🇦–🇿 regional indicators
];
function foldEnclosed(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    let mapped = ch;
    for (const [lo, hi] of ENCLOSED_RANGES) {
      if (cp >= lo && cp <= hi) { mapped = String.fromCharCode(97 + (cp - lo)); break; }
    }
    out += mapped;
  }
  return out;
}

// Leetspeak folds (applied only in the aggressive fold).
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '+': 't' };
const LEET_RE = /[0134578@$!+]/g;

const s0 = (v) => (v == null ? '' : String(v));

/** Strip §/& formatting codes, zero-width chars; NFKC; map confusables; lowercase;
 *  collapse whitespace runs to a single space. The "strict" fold — safe for exact
 *  matching (no information loss beyond casing/invisibles). */
export function foldStrict(value) {
  let s = '';
  try {
    s = s0(value); // inside try: a hostile toString() must not escape (contract: never throws)
    s = s.replace(FORMATTING_RE, '');
    s = s.normalize('NFKC'); // fullwidth, math alphanumerics 𝖿𝗋𝖾𝖾 → free
    if (/[\u{1F130}-\u{1F1FF}]/u.test(s)) s = foldEnclosed(s); // 🅵🆁🅴🅴 → free
    s = s.replace(ZERO_WIDTH_RE, '');
    s = s.replace(CONFUSABLES_RE, (c) => CONFUSABLES[c] ?? c);
    s = s.toLowerCase();
    s = s.replace(/\s+/g, ' ').trim();
  } catch { /* malformed surrogates etc. — best effort */ }
  return s;
}

/** Strict fold → leet fold → strip ALL non-alphanumerics (defeats "f r e e" and
 *  "f.r.e.e") → collapse repeated chars to one ("freee" → "fre", and "free" also
 *  → "fre", so they meet). Wider net, so only ever used ALONGSIDE the strict fold
 *  — a match on either counts, a miss on both is a miss. */
export function foldAggressive(value) {
  let s = foldStrict(value);
  try {
    s = s.replace(LEET_RE, (c) => LEET[c] ?? c);
    s = s.replace(/[^a-z0-9]+/g, '');
    s = s.replace(/(.)\1+/g, '$1');
  } catch { /* best effort */ }
  return s;
}

/** Bazaar product IDs / item tags: uppercase, trim, whitespace+dashes → "_",
 *  strip invisibles. Deliberately NOT aggressive — IDs need exactness
 *  (VERY_CRUDE_GABAGOOL's OO must survive). */
export function foldId(value) {
  let s = '';
  try {
    s = s0(value); // inside try: hostile toString() must not escape
    s = s.replace(ZERO_WIDTH_RE, '').normalize('NFKC').trim().toUpperCase();
    s = s.replace(/[\s\-]+/g, '_');
  } catch { /* best effort */ }
  return s;
}

/** Hostnames / server addresses: lowercase, strip invisibles + confusables,
 *  no leet (punycode lookalike domains still fold via confusables). */
export function foldHost(value) {
  let s = '';
  try {
    s = s0(value); // inside try: hostile toString() must not escape
    s = s.replace(ZERO_WIDTH_RE, '').normalize('NFKC');
    s = s.replace(CONFUSABLES_RE, (c) => CONFUSABLES[c] ?? c);
    s = s.toLowerCase().trim();
  } catch { /* best effort */ }
  return s;
}

/** Normalization profile per match target. Unknown targets get the text profile. */
export const PROFILES = {
  item:     { folds: [foldId] },                    // product IDs — exact by nature
  name:     { folds: [foldStrict, foldAggressive] },// item display names
  chat:     { folds: [foldStrict, foldAggressive] },
  username: { folds: [foldStrict, foldAggressive] },
  command:  { folds: [foldStrict] },                // commands are structured — no leet
  server:   { folds: [foldHost] },
};

/** All fold variants of a value for a target (deduped, in strictest-first order). */
export function foldsFor(target, value) {
  const prof = PROFILES[target] ?? PROFILES.chat;
  const out = [];
  for (const f of prof.folds) {
    const v = f(value);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.length ? out : [''];
}
