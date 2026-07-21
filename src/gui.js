// Low-level Mineflayer read helpers: turn chest windows, the scoreboard sidebar,
// and the tab-list footer into plain strings the driver can match against. This
// is the Mineflayer analogue of the mod's GuiHelper read side. Item name/lore
// parsing is defensive because prismarine-item exposes it a few different ways
// across versions and Hypixel uses custom NBT components.

/** Unwrap prismarine-nbt {type, value} wrappers. Since 1.20.3 text components
 *  (scoreboard title/lines, tab list, item names) arrive as NBT, not JSON —
 *  e.g. {type:'compound', value:{text:{type:'string', value:'HYPIXEL'}}} —
 *  which componentText would otherwise flatten to ''. */
function unwrapNbt(x) {
  if (x && typeof x === 'object' && typeof x.type === 'string' && x.value !== undefined) {
    return unwrapNbt(x.value);
  }
  if (Array.isArray(x)) return x.map(unwrapNbt);
  if (x && typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x)) out[k] = unwrapNbt(x[k]);
    return out;
  }
  return x;
}

/** Recursively flatten a Minecraft text component (object | array | JSON string
 *  | NBT-wrapped component) to plain lowercased text with color codes stripped. */
export function componentText(x) {
  if (x == null) return '';
  x = unwrapNbt(x);
  if (typeof x === 'string') {
    // Might itself be a JSON component string.
    const t = x.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return componentText(JSON.parse(t)); } catch { /* plain string */ }
    }
    return strip(x);
  }
  if (Array.isArray(x)) return x.map(componentText).join('');
  let out = x.text != null && typeof x.text !== 'object' ? String(x.text) : '';
  if (Array.isArray(x.extra)) out += x.extra.map(componentText).join('');
  return strip(out);
}

function strip(s) {
  // §. (any char), not §[0-9a-fk-or]: Hypixel names its invisible sidebar
  // entries with NON-vanilla codes (§q, §s, §t, §u, §v …) which land in the
  // middle of each line's text ("your isla§qnd") and break substring matching.
  return String(s).replace(/§./g, '').toLowerCase();
}

/** Plain lowercased display name of a prismarine item (or '' if empty). */
export function itemName(item) {
  if (!item) return '';
  if (item.customName) return componentText(item.customName);
  const nbtName = item.nbt?.value?.display?.value?.Name?.value;
  if (nbtName) return componentText(nbtName);
  return strip(item.displayName ?? item.name ?? '');
}

/** Plain lowercased lore lines of a prismarine item. */
export function itemLore(item) {
  if (!item) return [];
  if (Array.isArray(item.customLore)) return item.customLore.map(componentText);
  const lore = item.nbt?.value?.display?.value?.Lore?.value?.value;
  if (Array.isArray(lore)) return lore.map(componentText);
  return [];
}

/** Slots that belong to the CHEST (not the player inventory) of a window. */
export function chestSlotCount(window) {
  // A generic chest window's inventoryStart marks where the player inv begins.
  return window?.inventoryStart ?? (window ? window.slots.length - 36 : 0);
}

/** First chest slot whose item name contains `needle` (lowercased), or -1. */
export function findSlot(window, needle) {
  if (!window) return -1;
  const n = needle.toLowerCase();
  const count = chestSlotCount(window);
  for (let i = 0; i < count; i++) {
    if (itemName(window.slots[i]).includes(n)) return i;
  }
  return -1;
}

/** All chest rows parsed to {slot, name, lore}. */
export function readWindow(window) {
  const out = [];
  if (!window) return out;
  const count = chestSlotCount(window);
  for (let i = 0; i < count; i++) {
    const it = window.slots[i];
    if (!it) continue;
    out.push({ slot: i, name: itemName(it), lore: itemLore(it) });
  }
  return out;
}

/** SkyBlock sidebar lines (top→bottom), color-stripped. */
export function scoreboardLines(bot) {
  const board = bot.scoreboard?.sidebar;
  if (!board) return [];
  // prismarine scoreboard: items have .name / .displayName; Hypixel puts text in
  // both the team prefix/suffix and the entry name. Join what we can.
  return (board.items ?? [])
    .slice()
    .sort((a, b) => b.value - a.value)
    .map((it) => strip(componentText(it.displayName) || it.name || ''));
}

/** SkyBlock sidebar TITLE (e.g. "SKYBLOCK"), plain lowercased. */
export function scoreboardTitle(bot) {
  const sb = bot.scoreboard?.sidebar;
  return componentText(sb?.title ?? sb?.displayName ?? sb?.name ?? '');
}

/** True if the SkyBlock scoreboard is up (title or any line mentions skyblock). */
export function onSkyblock(bot) {
  const all = (scoreboardTitle(bot) + ' ' + scoreboardLines(bot).join(' '));
  return all.includes('skyblock');
}

/** True if the sidebar shows we're on the private island ("⏣ Your Island"). */
export function onIsland(bot) {
  return scoreboardLines(bot).some((l) => l.includes('your island') || l.includes('island'));
}

/** Tab-list footer as plain lowercased text (holds "Cookie Buff: 1d 3h"). */
export function tablistFooter(bot) {
  return componentText(bot.tablist?.footer ?? '');
}

/** Wait for the next window to open (server-driven GUI), or null on timeout. */
export function onceWindow(bot, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { bot.removeListener('windowOpen', h); resolve(null); }, timeoutMs);
    const h = (win) => { clearTimeout(t); resolve(win); };
    bot.once('windowOpen', h);
  });
}

/** Small paced wait in ticks (20/s), the Mineflayer analogue of actionDelayTicks. */
export function waitTicks(bot, n) {
  return bot.waitForTicks(Math.max(1, n));
}
