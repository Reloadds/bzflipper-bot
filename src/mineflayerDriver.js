// The MineflayerDriver: implements the semantic driver seam (see driver.js in
// bzflipper-headless) against a live `bot`.
//
// The Hypixel strings/slots below are VERIFIED against the live 1.21.11 SkyBlock
// v0.26 GUIs via the `--probe` diagnostic (see docs/BAZAAR_GUI.md). Two things are
// still marked UNVERIFIED because they can only be reached by committing an order:
//   1. the final Confirm screen (after picking a price), and
//   2. the sign text input for custom amount / custom price.
// Both are exercised (with logging) by a deliberate throwaway-alt micro-order.

import {
  readWindow, findSlot, itemLore, scoreboardLines, tablistFooter,
  onceWindow, waitTicks, componentText,
} from './gui.js';
import { norm } from './bazaarApi.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Hypixel on-screen text (VERIFIED unless marked) ----
export const S = {
  // main Bazaar
  SEARCH: 'search',
  MANAGE_ORDERS: 'manage orders',
  CLOSE: 'close',
  // search-result product tile
  VIEW_DETAILS: 'view details',   // tradeable tile lore: "click to view details!"
  LOCKED: 'you must have',         // locked tile lore: "you must have <skill> <n>!"
  // product details page
  BUY_INSTANTLY: 'buy instantly',
  SELL_INSTANTLY: 'sell instantly',
  CREATE_BUY_ORDER: 'create buy order',
  CREATE_SELL_OFFER: 'create sell offer',
  GO_BACK: 'go back',
  // amount screen — title "how many do you want?"
  AMOUNT_TITLE: 'how many do you want',
  CUSTOM_AMOUNT: 'custom amount',
  // price screen — title "how much do you want to pay?"
  PRICE_TITLE: 'how much do you want to pay',
  SAME_AS_TOP: 'same as top order',
  TOP_ORDER_PLUS: 'top order +0.1',
  CUSTOM_PRICE: 'custom price',
  // confirm screen (title "confirm buy order"/"confirm sell offer") — VERIFIED:
  // the confirm button is named "buy order"/"sell offer", NOT "confirm".
  CONFIRM_BUY: 'buy order',
  CONFIRM_SELL: 'sell offer',
  // Your Bazaar Orders grid — title "your bazaar orders"
  ORDERS_TITLE: 'your bazaar orders',
  CLAIM_ALL: 'claim all coins',
  CANCEL_ORDER: 'cancel order',
  // lore anchors
  TOP_ORDERS: 'top orders',
  TOP_OFFERS: 'top offers',
  LORE_PRICE: 'price per unit',
  LORE_FILLED: 'filled',
  PURSE: 'purse',
  FOOTER_COOKIE: 'cookie buff',
  COOKIE_EXPIRED: 'not active',
};

export class MineflayerDriver {
  constructor(bot, cfg, { log = console.log } = {}) {
    this.bot = bot;
    this.cfg = cfg;
    this.log = log;
    // Human menu cadence — Hypixel flags automated menu clicks that land faster
    // than a person could read+click. Randomized ~0.55–1.2s between clicks.
    const base = cfg.clickDelayMs ?? 550;
    const jit = cfg.clickJitterMs ?? 650;
    this.pace = () => sleep(base + Math.floor(Math.random() * jit));

    // Capture the sign-editor location the server hands us when we click a
    // "custom …" option, so _setSign can address the right block (mineflayer's
    // acceptResourcePack-style guess of the position is wrong).
    this._signLoc = null;
    const onSign = (p) => { this._signLoc = p.location; };
    try { bot._client.on('open_sign_entity', onSign); } catch { /* name varies */ }
    try { bot._client.on('open_sign_editor', onSign); } catch { /* older */ }

    // Safety gate for the final Confirm click. Off by default so the buy/sell
    // flow can be walked end-to-end (verifying nav + sign) WITHOUT placing a real
    // order — _confirm dumps the confirm screen and stops. armConfirm(true) is
    // required for an order to actually be committed.
    this._armed = false;

    // Runtime-learned set of item keys this account CANNOT trade — populated when
    // _navigateTo sees a "you must have <skill> <n>!" tile. The brain reads this
    // (via brainState) and never picks a learned-locked item again.
    this.locked = new Set();
  }

  armConfirm(v) { this._armed = !!v; }

  _win() { return this.bot.currentWindow; }
  _title() { return componentText(this._win()?.title ?? ''); }

  async _clickSlot(slot) {
    if (slot < 0) return false;
    await this.bot.clickWindow(slot, 0, 0); // left-click, normal mode ONLY
    await this.pace();
    return true;
  }
  async _clickName(needle) { return this._clickSlot(findSlot(this._win(), needle)); }

  async _cmd(cmd) {
    this.bot.chat('/' + cmd);
    await onceWindow(this.bot, 4000);
    await this.pace();
  }

  async closeBook() {
    try { const w = this._win(); if (w) await this.bot.closeWindow(w); } catch { /* already closed */ }
    await this.pace();
  }

  // ---------- READ (OBSERVE mode; safe) ----------

  /** Coins in the SkyBlock sidebar ("Purse: 1,234"). NaN if unreadable. */
  readPurse() {
    for (const line of scoreboardLines(this.bot)) {
      if (!line.includes(S.PURSE)) continue;
      const m = line.replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
      if (m) return parseFloat(m[1]);
    }
    return NaN;
  }

  /** Cookie buff remaining from the tab-list footer (time is on the line AFTER
   *  "cookie buff"): >0 ms, 0 expired, -1 unknown. */
  readCookieRemainMs() {
    const footer = tablistFooter(this.bot);
    if (!footer.includes(S.FOOTER_COOKIE)) return -1;
    const lines = footer.split('\n').map((l) => l.trim());
    const idx = lines.findIndex((l) => l.includes(S.FOOTER_COOKIE));
    if (idx < 0) return -1;
    let block = '';
    for (let i = idx; i < lines.length && lines[i] !== ''; i++) block += ' ' + lines[i];
    if (block.includes(S.COOKIE_EXPIRED)) return 0;
    let ms = 0;
    for (const [, v, u] of block.matchAll(/(\d+)\s*([dhms])/g)) {
      const n = parseInt(v, 10);
      ms += u === 'd' ? n * 864e5 : u === 'h' ? n * 36e5 : u === 'm' ? n * 6e4 : n * 1e3;
    }
    return ms > 0 ? ms : -1;
  }

  freeInventorySlots() {
    let free = 0;
    for (let i = 9; i <= 44; i++) if (!this.bot.inventory.slots[i]) free++;
    return free;
  }

  /** Open the "Your Bazaar Orders" grid fresh (verified: /bz → Manage Orders @ name). */
  async openBook() {
    if (!this._title().includes(S.ORDERS_TITLE)) {
      if (!this._win() || !this._title().startsWith('bazaar')) await this._cmd('bz');
      if (!(await this._clickName(S.MANAGE_ORDERS))) return false;
      await onceWindow(this.bot, 4000);
    }
    if (!this._title().includes(S.ORDERS_TITLE)) return false;
    await this._settleWindow(); // Hypixel streams the tiles in — wait for the full set
    return true;
  }

  /** Wait until the order grid stops populating, so a fresh open isn't read while
   *  Hypixel is still streaming tiles in (the cause of the dashboard "missing a few
   *  orders" flicker). Polls the buy/sell tile count and returns once it's been
   *  stable for a beat (or maxMs elapses). */
  async _settleWindow(maxMs = 1800, minMs = 400) {
    const count = () => readWindow(this._win()).filter((r) => /^(buy|sell)\s/.test(r.name)).length;
    const t0 = Date.now();
    let prev = -1, stableSince = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(110);
      const n = count();
      if (n !== prev) { prev = n; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 280 && Date.now() - t0 >= minMs) break;
    }
  }

  /** Parse the "Your Bazaar Orders" grid into semantic Order rows. */
  readOrders() {
    const win = this._win();
    if (!componentText(win?.title ?? '').includes(S.ORDERS_TITLE)) return [];
    const rows = [];
    for (const { slot, name, lore } of readWindow(win)) {
      const parsed = parseOrder(slot, name, lore);
      if (parsed) rows.push(parsed);
    }
    return rows;
  }

  /** Navigate to a product's DETAILS page and read the live order book from the
   *  "create buy order" / "create sell offer" lore. Returns {buyOrders, sellOffers}
   *  (arrays of {price, qty, orders}) or null if unreachable/locked. */
  async readOrderBook(item) {
    if (!(await this._navigateTo(item))) return null;
    const win = this._win();
    const buy = itemLore(win.slots[findSlot(win, S.CREATE_BUY_ORDER)]);
    const sell = itemLore(win.slots[findSlot(win, S.CREATE_SELL_OFFER)]);
    return { buyOrders: parseBook(buy), sellOffers: parseBook(sell) };
  }

  // ---------- WRITE (LIVE mode) ----------

  async placeBuy(item, units, price) {
    if (!(await this._navigateTo(item))) return false;
    if (!(await this._clickName(S.CREATE_BUY_ORDER))) return false;      // → amount screen
    await onceWindow(this.bot, 4000); await this.pace();
    if (!(await this._enterAmount(units))) return false;                 // → price screen
    if (!(await this._enterPrice(price))) return false;                  // → confirm screen
    return this._confirm('buy');
  }

  async placeSell(item, units, price) {
    if (!(await this._navigateTo(item))) return false;
    if (!(await this._clickName(S.CREATE_SELL_OFFER))) return false;
    await onceWindow(this.bot, 4000); await this.pace();
    // VERIFIED: the sell flow is PRICE-FIRST — "create sell offer" goes straight to
    // "at what price are you selling?" (no amount step; it offers what you hold).
    if (!(await this._enterPrice(price))) return false;
    // If a quantity step does appear after the price (some products), handle it.
    if (findSlot(this._win(), S.CUSTOM_AMOUNT) >= 0 && !(await this._enterAmount(units))) return false;
    return this._confirm('sell');
  }

  async instasell(item) {
    if (!(await this._navigateTo(item))) return false;
    return this._clickName(S.SELL_INSTANTLY);
  }

  async claim(order) {
    if (!(await this._clickSlot(order._slot))) return null;
    const units = Math.max(1, Math.round(order.amount * Math.min(100, order.filledPct) / 100));
    return { kind: order.side, units };
  }

  async cancel(order) {
    if (!(await this._clickSlot(order._slot))) return false; // opens Order Options
    await onceWindow(this.bot, 4000); await this.pace();
    const ok = await this._clickName(S.CANCEL_ORDER);
    return ok ? { refundUnits: Math.round(order.amount * (1 - Math.min(100, order.filledPct) / 100)) } : false;
  }

  async refreshCookie() {
    this.log('[cookie] refresh not yet wired for headless; renew manually.');
    return false;
  }

  // ---------- navigation + amount/price/confirm/sign ----------

  /** /bz <item> opens a SEARCH; the product tile lives inside it and must be
   *  clicked to reach the details page. Returns true only when we're on details. */
  async _navigateTo(item) {
    await this._cmd('bz ' + item);
    const search = this._win();
    if (!search) return false;
    const slot = findSlot(search, item.toLowerCase());
    if (slot < 0) { this.log(`[nav] "${item}" not in search result`); return false; }
    const lore = itemLore(search.slots[slot]).join(' ');
    if (lore.includes(S.LOCKED)) {
      this.locked.add(norm(item)); // learn it — the brain will stop picking it
      this.log(`[nav] "${item}" is skill-locked — cannot trade (added to avoid-list)`);
      return false;
    }
    if (!(await this._clickSlot(slot))) return false;
    await onceWindow(this.bot, 4000); await this.pace();
    // On the details page the product's own buy/sell buttons exist.
    return findSlot(this._win(), S.CREATE_BUY_ORDER) >= 0 || findSlot(this._win(), S.CREATE_SELL_OFFER) >= 0;
  }

  /** Amount screen (buy: "how many do you want?"; sell may differ): type an exact
   *  quantity via the sign. Adapts by BUTTON name, not title, so the sell flow
   *  (unverified screen titles) still works — the title is only logged. */
  async _enterAmount(units) {
    const t = this._title();
    if (!t.includes(S.AMOUNT_TITLE)) this.log(`[amount] screen "${t}" — proceeding by "custom amount" button`);
    if (!(await this._clickName(S.CUSTOM_AMOUNT))) { this.log(`[amount] no "custom amount" on "${t}"`); return false; }
    if (!(await this._sign(String(Math.max(1, Math.round(units)))))) return false;
    await onceWindow(this.bot, 4000); await this.pace();
    return true; // next screen is the price screen
  }

  /** Price screen (buy: "how much do you want to pay?"; sell differs): type an
   *  exact price via the sign. Adapts by "custom price" button, title logged. */
  async _enterPrice(price) {
    const t = this._title();
    if (!t.includes(S.PRICE_TITLE)) this.log(`[price] screen "${t}" — proceeding by "custom price" button`);
    if (!(await this._clickName(S.CUSTOM_PRICE))) { this.log(`[price] no "custom price" on "${t}"`); return false; }
    if (!(await this._sign(price.toFixed(1)))) return false;
    await onceWindow(this.bot, 4000); await this.pace();
    return true; // now on the confirm screen
  }

  /** Confirm screen (title "confirm buy order" / "confirm sell offer"). VERIFIED:
   *  the confirm button is named "buy order" / "sell offer" (slot 13), NOT
   *  "confirm" — and a "cancel buy order" tile also contains the term, so exclude
   *  cancel/create/go-back. Gated behind armConfirm(): disarmed → dumps + stops. */
  async _confirm(kind) {
    const win = this._win();
    const term = kind === 'sell' ? S.CONFIRM_SELL : S.CONFIRM_BUY;
    this.log('[confirm] window "' + this._title() + '" slots: ' +
      readWindow(win).map((r) => `${r.slot}:"${r.name}"`).join(', '));
    const hit = readWindow(win).find((r) =>
      r.name.includes(term) && !r.name.includes('cancel') && !r.name.includes('create') && !r.name.includes('go back'));
    if (!hit) { this.log(`[confirm] confirm button ("${term}") not found`); return false; }
    if (!this._armed) {
      this.log(`[confirm] DISARMED — would click slot ${hit.slot} ("${hit.name}"); NO order placed.`);
      return 'stopped';
    }
    this.log(`[confirm] ARMED — clicking slot ${hit.slot} ("${hit.name}") to place the ${kind} order.`);
    return this._clickSlot(hit.slot);
  }

  /** Type text into the sign editor Hypixel opens for custom amount/price. Uses
   *  the location captured from open_sign_entity. Fields per 1.21.11 update_sign. */
  async _sign(text) {
    await waitTicks(this.bot, 6); // let the sign editor open + location arrive
    const loc = this._signLoc ?? this.bot.entity?.position?.offset(0, 1, 0);
    if (!loc) { this.log('[sign] no sign location captured'); return false; }
    try {
      this.bot._client.write('update_sign', {
        location: loc, isFrontText: true,
        text1: text, text2: '', text3: '', text4: '',
      });
      this.log(`[sign] wrote "${text}" @ ${loc.x},${loc.y},${loc.z}`);
    } catch (e) {
      this.log('[sign] update_sign failed: ' + e.message);
      return false;
    }
    await this.pace();
    return true;
  }
}

/** Parse a "top orders:" / "top offers:" lore block into [{price, qty, orders}].
 *  Lines look like: "- 396.2 coins each | 71,668x in 1 order". */
export function parseBook(lore) {
  const out = [];
  for (const line of lore || []) {
    const m = line.match(/([0-9][0-9,]*\.?[0-9]*)\s*coins each\s*\|\s*([0-9][0-9,]*)x\s*(?:in|from)\s*([0-9]+)/);
    if (m) out.push({ price: parseFloat(m[1].replace(/,/g, '')), qty: parseInt(m[2].replace(/,/g, ''), 10), orders: parseInt(m[3], 10) });
  }
  return out;
}

/** Parse one Your-Bazaar-Orders grid tile into an Order, or null. VERIFIED tile:
 *   name "BUY <item>" / "SELL <item>"
 *   lore "Order amount: 1x" | "Offer amount: 2x", "Price per unit: 516.5 coins",
 *        "Filled: 2/2 100%!" (or "Filled: 1,234/5,000 24.7%"), "…to claim!" */
export function parseOrder(slot, name, lore) {
  const m = /^\s*(buy|sell)\b\s+(.+?)\s*$/.exec(name);
  if (!m) return null;
  const side = m[1];
  const item = m[2].trim();
  const text = (lore || []).join('\n');

  const pm = /price per unit:\s*([0-9][0-9,]*\.?[0-9]*)/.exec(text);
  const price = pm ? parseFloat(pm[1].replace(/,/g, '')) : NaN;

  const am = /(?:order|offer)\s+amount:\s*([0-9][0-9,]*)/.exec(text);
  const amount = am ? parseInt(am[1].replace(/,/g, ''), 10) : 0;

  // Filled: prefer an explicit "…NN%", else derive from the "filled A/B" ratio.
  let filledPct = 0;
  const pct = /filled:[^%\n]*?([0-9]+(?:\.[0-9]+)?)\s*%/.exec(text);
  if (pct) filledPct = parseFloat(pct[1]);
  else {
    const ratio = /filled:\s*([0-9][0-9,]*)\s*\/\s*([0-9][0-9,]*)/.exec(text);
    if (ratio) {
      const a = parseInt(ratio[1].replace(/,/g, ''), 10);
      const b = parseInt(ratio[2].replace(/,/g, ''), 10);
      if (b > 0) filledPct = Math.min(100, (a / b) * 100);
    }
  }

  const claimable = /to claim/.test(text);
  const expired = /expired|cancell?ed/.test(text);
  return { side, item, price, amount, filledPct, claimable, expired, _slot: slot };
}
