// The MineflayerDriver: implements the semantic driver seam (see driver.js in
// bzflipper-headless) against a live `bot`. READ methods (purse, cookie timer,
// order grid) are complete and are what OBSERVE mode exercises. WRITE methods
// (placeBuy/placeSell/claim/cancel/refreshCookie) are the multi-step GUI
// sequences — implemented, but every Hypixel string/slot marked `TUNE:` needs a
// live confirmation pass, since they can't be verified without the real GUIs.

import {
  readWindow, findSlot, itemLore, scoreboardLines, tablistFooter,
  onceWindow, waitTicks,
} from './gui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Hypixel on-screen text (the tuning surface — verify each in-game) ----
export const S = {
  MANAGE_ORDERS: 'manage orders',
  GO_BACK: 'go back',
  BUY_ORDER: 'buy order',
  SELL_OFFER: 'sell offer',
  CUSTOM_AMOUNT: 'custom amount',
  CUSTOM_PRICE: 'custom price',
  BEST_BUY: '+0.1',
  BEST_SELL: '-0.1',
  CONFIRM: 'confirm',
  CLAIM: 'claim',
  CANCEL_ORDER: 'cancel order',
  INSTASELL: 'sell instantly',
  SIDE_BUY_PREFIX: 'buy ', // grid entries "BUY <item>" / "SELL <item>"
  SIDE_SELL_PREFIX: 'sell ',
  LORE_PRICE: 'price per unit',
  LORE_AMOUNT_ORDER: 'order amount',
  LORE_AMOUNT_OFFER: 'offer amount',
  LORE_FILLED: 'filled',
  LORE_CLAIM: 'claim',
  FOOTER_COOKIE: 'cookie buff',
  COOKIE_EXPIRED: 'not active',
  PURSE: 'purse',
};

export class MineflayerDriver {
  constructor(bot, cfg, { log = console.log } = {}) {
    this.bot = bot;
    this.cfg = cfg;
    this.log = log;
    // HUMAN menu cadence. Hypixel's anti-cheat flags automated menu clicks that
    // land faster than a person could read+click ("badly behaving modifications"
    // kick). Tick-pacing (~150-250ms) is far too fast, so we wait a randomized
    // human beat between every click. Tunable via clickDelayMs/clickJitterMs.
    const base = cfg.clickDelayMs ?? 550;
    const jit = cfg.clickJitterMs ?? 650;
    this.pace = () => sleep(base + Math.floor(Math.random() * jit)); // ~0.55–1.2s
  }

  _win() { return this.bot.currentWindow; }
  async _cmd(cmd) { this.bot.chat('/' + cmd); await onceWindow(this.bot, 3000); }
  async _clickName(needle) {
    const win = this._win();
    const slot = findSlot(win, needle);
    if (slot < 0) return false;
    // Always left-click, normal mode (0,0). Middle-click / shift-click patterns
    // are exactly what Hypixel flags — never use them for menu navigation.
    await this.bot.clickWindow(slot, 0, 0);
    await this.pace();
    return true;
  }

  /** Close whatever menu is open, the way a real player backs out. Leaving a
   *  server GUI open indefinitely (and re-clicking into it every cycle) is part
   *  of the automated-usage signature; close it as soon as we're done reading. */
  async closeBook() {
    try { const w = this._win(); if (w) await this.bot.closeWindow(w); } catch { /* already closed */ }
    await this.pace();
  }

  // ---------- READ (used by OBSERVE mode; safe) ----------

  /** Coins in the SkyBlock sidebar ("Purse: 1,234"). NaN if unreadable. */
  readPurse() {
    for (const line of scoreboardLines(this.bot)) {
      if (!line.includes(S.PURSE)) continue;
      const m = line.replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
      if (m) return parseFloat(m[1]);
    }
    return NaN;
  }

  /** Cookie buff remaining from the tab-list footer: >0 ms, 0 expired, -1 unknown. */
  readCookieRemainMs() {
    const footer = tablistFooter(this.bot);
    if (!footer.includes(S.FOOTER_COOKIE)) return -1;
    const line = footer.split('\n').find((l) => l.includes(S.FOOTER_COOKIE)) ?? footer;
    if (line.includes(S.COOKIE_EXPIRED)) return 0;
    let ms = 0;
    for (const [, v, u] of line.matchAll(/(\d+)\s*([dhms])/g)) {
      const n = parseInt(v, 10);
      ms += u === 'd' ? n * 864e5 : u === 'h' ? n * 36e5 : u === 'm' ? n * 6e4 : n * 1e3;
    }
    return ms > 0 ? ms : -1;
  }

  freeInventorySlots() {
    // Player inventory main slots (9..44) that are empty.
    let free = 0;
    for (let i = 9; i <= 44; i++) if (!this.bot.inventory.slots[i]) free++;
    return free;
  }

  /** Open the Manage Orders grid fresh. */
  async openBook() {
    if (!this._win()) await this._cmd('bz');
    // If we're not already on Manage Orders, click into it.
    const win = this._win();
    if (win && findSlot(win, S.MANAGE_ORDERS) >= 0) {
      await this._clickName(S.MANAGE_ORDERS);
      await onceWindow(this.bot, 3000);
    }
  }

  /** Parse the Manage Orders grid into semantic Order rows. */
  readOrders() {
    const win = this._win();
    const rows = [];
    for (const { slot, name, lore } of readWindow(win)) {
      const parsed = parseOrder(slot, name, lore);
      if (parsed) rows.push(parsed);
    }
    return rows;
  }

  // ---------- WRITE (LIVE mode only — TUNE against real GUIs) ----------

  async placeBuy(item, units, price) {
    if (!(await this._navigateTo(item))) return false;
    if (!(await this._clickName(S.BUY_ORDER))) return false;
    if (!(await this._setSign(S.CUSTOM_AMOUNT, String(units)))) return false;
    if (!(await this._setSign(S.CUSTOM_PRICE, price.toFixed(1)))) return false;
    return this._clickName(S.CONFIRM);
  }

  async placeSell(item, units, price) {
    if (!(await this._navigateTo(item))) return false;
    if (!(await this._clickName(S.SELL_OFFER))) return false;
    // Create Sell Offer sells all held units → straight to the price step.
    if (!(await this._setSign(S.CUSTOM_PRICE, price.toFixed(1)))) return false;
    return this._clickName(S.CONFIRM);
  }

  async claim(order) {
    // Click the claimable grid slot; it claims goods (buy) or coins (sell).
    if (!(await this.bot.clickWindow(order._slot, 0, 0).then(() => true).catch(() => false))) return null;
    await this.pace();
    // The grid re-reads next tick; report the currently-claimable units.
    const units = Math.max(1, Math.round(order.amount * Math.min(100, order.filledPct) / 100));
    return { kind: order.side, units };
  }

  async cancel(order) {
    await this.bot.clickWindow(order._slot, 0, 0); // opens Order Options
    await onceWindow(this.bot, 3000);
    const ok = await this._clickName(S.CANCEL_ORDER);
    return ok ? { refundUnits: Math.round(order.amount * (1 - Math.min(100, order.filledPct) / 100)) } : false;
  }

  async instasell(item /* , units */) {
    if (!(await this._navigateTo(item))) return false;
    return this._clickName(S.INSTASELL);
  }

  /** TODO: cookie consume is a two-GUI flow (use item → confirm popup). Port the
   *  hardened mod flow here once the live GUIs are confirmed. For now: no-op. */
  async refreshCookie() {
    this.log('[cookie] refresh requested — not yet wired for headless; renew manually.');
    return false;
  }

  // ---------- navigation + sign input (the fiddliest live bits) ----------

  async _navigateTo(item) {
    // Reach a product page via the Bazaar search. TUNE: exact search click/flow.
    await this._cmd('bz ' + item);
    return !!this._win();
  }

  /** Click a "Custom …" option, then type into the server-opened sign GUI.
   *  TUNE: Mineflayer sign input is a raw update_sign packet; field names vary by
   *  protocol version. Verify with your minecraft-protocol version. */
  async _setSign(optionName, text) {
    if (!(await this._clickName(optionName))) return false;
    // Wait for the sign editor to open, then submit the text.
    await waitTicks(this.bot, 5);
    try {
      this.bot._client.write('update_sign', {
        location: this.bot.entity.position.offset(0, -1, 0), // placeholder; real sign pos comes from open_sign_entity
        isFrontText: true,
        text1: text, text2: '', text3: '', text4: '',
      });
    } catch (e) {
      this.log('[sign] update_sign failed (needs protocol tuning): ' + e.message);
      return false;
    }
    await onceWindow(this.bot, 3000);
    return true;
  }
}

/** Parse one grid slot into an Order, or null if it isn't an order row. */
export function parseOrder(slot, name, lore) {
  let side = null;
  if (name.startsWith(S.SIDE_BUY_PREFIX)) side = 'buy';
  else if (name.startsWith(S.SIDE_SELL_PREFIX)) side = 'sell';
  if (!side) return null;
  const item = name.slice(side === 'buy' ? S.SIDE_BUY_PREFIX.length : S.SIDE_SELL_PREFIX.length).trim();

  let price = NaN, amount = 0, filledPct = 0, claimable = false;
  for (const line of lore) {
    if (line.includes(S.LORE_CLAIM)) claimable = true;
    if (line.includes(S.LORE_PRICE)) price = num(line);
    if (line.includes(S.LORE_AMOUNT_ORDER) || line.includes(S.LORE_AMOUNT_OFFER)) amount = Math.round(num(line));
    if (line.includes(S.LORE_FILLED)) {
      if (line.includes('100%')) filledPct = 100;
      else { const m = line.match(/([0-9.]+)\s*%/); if (m) filledPct = parseFloat(m[1]); }
    }
  }
  return { side, item, tag: undefined, price, amount, filledPct, claimable, _slot: slot };
}

function num(line) {
  const m = line.replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}
