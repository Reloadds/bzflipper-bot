// Maps a Bazaar product tag (ENCHANTED_CACTUS_GREEN, SHARD_SPHINX, …) to its real
// in-game display name. Port of api/ItemNames.java. Primary source is Hypixel's
// resources endpoint; the rest are three rule-based families.

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

let MAP = new Map();
let MATERIAL = new Map();

export function loaded() {
  return MAP.size > 0;
}

/** Load id→name (+material) from the resources/skyblock/items JSON root. */
export function load(root) {
  const items = root?.items;
  if (!Array.isArray(items)) return;
  const m = new Map();
  const mats = new Map();
  for (const o of items) {
    if (!o?.id) continue;
    if (o.name) m.set(o.id, clean(o.name));
    if (o.material) mats.set(o.id, o.material);
  }
  MAP = m;
  MATERIAL = mats;
}

/** Fetch the name table once from Hypixel (best-effort). */
export async function ensureLoaded(fetchImpl = fetch) {
  if (loaded()) return;
  try {
    const res = await fetchImpl('https://api.hypixel.net/v2/resources/skyblock/items', {
      headers: { 'User-Agent': 'bzflipper-headless' },
    });
    if (res.ok) load(await res.json());
  } catch {
    /* fall back to rule-based names */
  }
}

export function name(tag) {
  return MAP.get(tag) ?? fallback(tag);
}

export function fallback(tag) {
  if (tag.startsWith('ESSENCE_')) return title(tag.slice(8)) + ' Essence';
  if (tag.startsWith('SHARD_')) return title(tag.slice(6)) + ' Shard';
  if (tag.startsWith('ENCHANTMENT_')) {
    let rest = tag.slice('ENCHANTMENT_'.length);
    let level = '';
    const u = rest.lastIndexOf('_');
    if (u > 0 && /^\d+$/.test(rest.slice(u + 1))) {
      level = roman(parseInt(rest.slice(u + 1), 10));
      rest = rest.slice(0, u);
    }
    if (rest.startsWith('ULTIMATE_')) rest = rest.slice('ULTIMATE_'.length);
    return (title(rest) + ' ' + level).trim();
  }
  return title(tag);
}

/** FOO_BAR:2 / FOO_BAR → "Foo Bar". */
export function title(s) {
  return s
    .toLowerCase()
    .replace(/:/g, ' ')
    .split(/[_ ]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .trim();
}

function roman(n) {
  return n >= 0 && n < ROMAN.length ? ROMAN[n] : String(n);
}

/** Strip Minecraft color codes and trim. */
export function clean(s) {
  return s.replace(/§[0-9a-fk-or]/gi, '').trim();
}

/** Essence is a currency (essence storage); shards land as real inventory stacks. */
export function bypassesInventory(tag) {
  return !!tag && tag.startsWith('ESSENCE_');
}
