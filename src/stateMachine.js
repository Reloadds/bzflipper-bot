// The driver-agnostic flip engine: one action per tick, highest priority first —
// claim → list held goods → relist beaten orders → exit dead capital → open a new
// buy. Ports the DECISION logic of the Fabric mod's BazaarMacro (the pure parts);
// all Minecraft interaction is delegated to the semantic driver seam.
//
// State (orders, pending sells, measured fill rates, efficiency, blacklists,
// session accounting, learned capture) lives here so the driver stays stateless.

import { TICK, roundToTick, sellOfferPrice, netMarginFraction } from './priceMath.js';
import { norm } from './bazaarApi.js';
import { pickNext, orderSize, scoreCandidate, rank } from './ranking.js';

const EPS = TICK / 2; // ignore sub-half-tick float noise
const FILL_WINDOW_MS = 60_000; // measure fill rate over a real window, not per-tick

const key = (name) => norm(name);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function inc(map, k, by) { map.set(k, (map.get(k) ?? 0) + by); }
function ema(map, k, v, old) { map.set(k, map.has(k) ? old * map.get(k) + (1 - old) * v : v); }

/** Units still unsold/unfilled in an order — what a cancel actually refunds. */
function remainingUnits(o) {
  return Math.max(1, Math.round(o.amount * (1 - Math.min(100, o.filledPct) / 100)));
}

export class StateMachine {
  /**
   * @param {object} config
   * @param {{candidates:any[], quote:(name:string)=>any}} api
   * @param {import('./driver.js').Driver} driver
   * @param {{now?:()=>number}} [opts]
   */
  constructor(config, api, driver, { now = () => Date.now() } = {}) {
    this.cfg = config;
    this.api = api;
    this.driver = driver;
    this.now = now;

    this.orders = new Map(); // key -> OrderInfo
    this.pendingSells = []; // display names queued to list
    this.pendingAmounts = new Map(); // key -> units queued
    this.sellFillRate = new Map();
    this.buyFillRate = new Map();
    this.efficiency = new Map();
    this.blacklistUntil = new Map();
    this.relistCounts = new Map(); // key -> times relisted (relist-war guard)
    this.lastRelistAt = new Map(); // key -> ms of last relist (cooldown)
    this.fillObs = new Map(); // "B|key"/"S|key" -> [t, filledUnits]
    this.learnedCapture = 0;
    this.learnedCaptureN = 0;

    this.orderLimit = config.orderLimit ?? 14;
    this.session = {
      profit: 0, flips: 0, buysFilled: 0, sellsFilled: 0,
      claimedUnits: new Map(), claimedCost: new Map(),
      soldUnits: new Map(), soldRevenue: new Map(),
    };
    this.lastAction = 'init';
  }

  get tax() { return this.cfg.taxFraction; }

  _newOrder(o, t) {
    return {
      name: o.item, tag: o.tag,
      buyPrice: NaN, sellPrice: NaN, amount: o.amount ?? 0,
      claimedSoFar: 0, soldSoFar: 0, placedAt: t, quotedMargin: NaN,
    };
  }

  heldSet() {
    const s = new Set();
    for (const k of this.orders.keys()) s.add(k);
    for (const it of this.pendingSells) s.add(key(it));
    return s;
  }

  captureEstimate() {
    return this.learnedCaptureN >= 5 ? this.learnedCapture : this.cfg.captureFraction;
  }

  brainState() {
    return {
      sellFillRate: this.sellFillRate, buyFillRate: this.buyFillRate,
      efficiency: this.efficiency, blacklistUntil: this.blacklistUntil,
      learnedCapture: this.captureEstimate() === this.cfg.captureFraction ? 0 : this.captureEstimate(),
      held: this.heldSet(),
      locked: this.driver.locked, // runtime-learned untradeable items
    };
  }

  /** Adaptive margin controller (ported from the mod v0.67). Tunes a dynamic
   *  bonus ON TOP of apiMinMargin toward max realized coins/hr, reading slot/
   *  capital binding — NOT noisy coins/hr. Slots scarce + flips plentiful → raise
   *  the gate (each scarce slot lands a fatter flip); idle slots + starving →
   *  lower toward the floor so the bankroll deploys. Never below your floor. */
  adaptMargin() {
    if (!this.cfg.autoMargin) return;
    const now = this.now();
    if (now - (this._lastMarginAdjust ?? 0) < (this.cfg.autoMarginPeriodSeconds ?? 120) * 1000) return;
    this._lastMarginAdjust = now;

    const freeSlots = Math.max(0, (this.cfg.orderLimit ?? 14) - this.orders.size);
    const qualifiers = rank(this.api.candidates, this.cfg, this.brainState()).filter((r) => r.state === 'ok').length;

    const cur = this.api.dynMarginBonus;
    const hi = Math.max(0, this.cfg.autoMarginMaxBonus ?? 0.05);
    const step = 0.005; // 0.5%/period — gentle
    let next = cur;
    if (freeSlots <= 1 && qualifiers > 2 * Math.max(1, freeSlots) + 2) next = Math.min(hi, cur + step);
    else if (freeSlots >= 2 && qualifiers < freeSlots) next = Math.max(0, cur - step);
    else if (cur > 0) next = Math.max(0, cur - step / 2);

    if (Math.abs(next - cur) > 1e-6) {
      this.api.setMarginBonus(next);
      const pct = (x) => ((this.cfg.apiMinMargin + x) * 100).toFixed(1);
      console.log(`⚙️  auto-margin ${pct(cur)}%→${pct(next)}% (${qualifiers} flips ready, ${freeSlots} free slots)`);
    }
  }

  deployedBuyCapital(grid) {
    let sum = 0;
    for (const o of grid) {
      if (o.side !== 'buy' || o.price == null) continue;
      sum += o.amount * (1 - Math.min(100, o.filledPct) / 100) * o.price;
    }
    return sum;
  }

  // ---- the tick: pick ONE highest-priority action ----
  async tick() {
    const t = this.now();
    const purse = this.driver.readPurse();

    // 0) Cookie refresh guard.
    if (this.cfg.cookieRefreshEnabled !== false) {
      const remain = this.driver.readCookieRemainMs();
      const thr = (this.cfg.cookieRefreshThresholdHours ?? 24) * 3_600_000;
      if (remain >= 0 && remain <= thr) {
        await this.driver.refreshCookie();
        return this._done('cookie-refresh');
      }
    }

    await this.driver.openBook();
    const grid = this.driver.readOrders();
    this.lastGrid = grid; // exposed for the dashboard
    this.observeFills(grid, t);
    this.adopt(grid, t);
    this.adaptMargin(); // self-tune the margin gate toward max coins/hr

    // 1) Claim anything claimable.
    const claimable = grid.find((o) => o.claimable);
    if (claimable) {
      const res = await this.driver.claim(claimable);
      if (res && res.units > 0) {
        if (res.kind === 'buy') this.onBuyClaimed(claimable, res.units, t);
        else this.onSellClaimed(claimable, res.units, t);
      }
      return this._done(`claim-${claimable.side} ${claimable.item}`);
    }

    // 2) List held goods (pending sells) into a free slot.
    if (this.pendingSells.length && grid.length < this.orderLimit) {
      const item = this.pendingSells[0];
      const units = this.pendingAmounts.get(key(item)) ?? 0;
      if (units > 0) {
        const price = this.sellPriceFor(item);
        if (await this.driver.placeSell(item, units, price)) {
          const oi = this.orders.get(key(item)) ?? this._newOrder({ item }, t);
          oi.sellPrice = price; oi.amount = units;
          this.orders.set(key(item), oi);
          this.pendingSells.shift();
          this.pendingAmounts.delete(key(item));
          return this._done(`list-sell ${item}`);
        }
      } else {
        this.pendingSells.shift();
      }
    }

    // 3) Relist orders beaten on price — WITH relist-war protection (ported from
    //    the mod). Without it, a liquid market undercuts us by a tick every pass and
    //    we chase the price forever, so nothing ever rests long enough to fill.
    //    Guards: (a) a per-item COOLDOWN so a fresh (re)list gets time to fill;
    //    (b) don't war with our OWN twin order or when the book's best IS us;
    //    (c) don't chase a buy UP into a loss; (d) a hard relist CAP after which we
    //    bench the item instead of chasing.
    const cooldownMs = (this.cfg.relistCooldownSeconds ?? 45) * 1000;
    const maxRelists = this.cfg.maxRelistsPerOrder ?? 6;
    for (const o of grid) {
      if (o.claimable || o.filledPct >= 100) continue;
      const q = this.api.quote(o.item);
      if (!q) continue;
      const k = key(o.item);
      const bookBest = o.side === 'buy' ? q.topBuyOrder : q.lowestSellOffer;
      const beaten = o.side === 'buy' ? bookBest > o.price + EPS : bookBest < o.price - EPS;
      const bookIsUs = Math.abs(bookBest - o.price) <= EPS; // the best IS our own order
      const myTwin = grid.some((g) => g !== o && g.side === o.side && key(g.item) === k &&
        (o.side === 'buy' ? g.price >= o.price - EPS : g.price <= o.price + EPS));
      if (!beaten || bookIsUs || myTwin) continue;
      // Cooldown: leave a just-(re)listed order alone so it can actually FILL.
      if (t - (this.lastRelistAt.get(k) ?? 0) < cooldownMs) continue;
      // Sell side: never chase below our cost.
      if (o.side === 'sell' && this.cfg.neverSellAtLoss !== false) {
        const floor = this.profitFloor(o.item);
        if (floor != null && q.lowestSellOffer - TICK < floor) continue;
      }
      // Buy side: don't outbid UP into an unprofitable buy vs the sell side.
      if (o.side === 'buy' && this.cfg.neverSellAtLoss !== false) {
        const sellNet = q.lowestSellOffer * (1 - this.cfg.taxFraction);
        if (sellNet <= (q.topBuyOrder + TICK) * (1 + this.cfg.apiMinMargin)) continue;
      }
      const relists = (this.relistCounts.get(k) ?? 0) + 1;
      if (relists > maxRelists) {
        // Lost the war — stop churning. Bench the item so we don't re-pick it; a
        // buy cancel is a lossless refund (frees the slot), a sell we leave resting
        // to avoid a forced loss.
        this.blacklistUntil.set(k, t + (this.cfg.badItemBlacklistMinutes ?? 45) * 60_000);
        if (o.side === 'buy' && await this.driver.cancel(o)) {
          this.orders.delete(k); this.relistCounts.delete(k);
          return this._done(`give-up-buy ${o.item}`);
        }
        continue;
      }
      if (await this.driver.cancel(o)) {
        this.relistCounts.set(k, relists);
        this.lastRelistAt.set(k, t);
        if (o.side === 'buy') {
          this.orders.delete(k); // next tick re-buys the best pick
        } else {
          if (!this.pendingSells.includes(o.item)) this.pendingSells.push(o.item);
          inc(this.pendingAmounts, k, remainingUnits(o));
        }
        return this._done(`relist-${o.side} ${o.item} #${relists}`);
      }
    }

    // 4) Exit dead buy capital (0% filled past the stall timer, or outclassed when
    //    the book is full — buy cancels refund escrow in full, so it's lossless).
    let bestCph = -1;
    for (const o of grid) {
      if (o.side !== 'buy' || o.filledPct > 0 || o.claimable) continue;
      const oi = this.orders.get(key(o.item));
      if (!oi) continue;
      const age = t - oi.placedAt;
      const stall = age >= (this.cfg.buyStallMinutes ?? 10) * 60_000;
      let opp = false;
      const bookFull = grid.length >= this.orderLimit;
      if (!stall && this.cfg.opportunityExitFactor > 0 && bookFull &&
          age >= (this.cfg.opportunityExitMinAgeMinutes ?? 5) * 60_000) {
        if (bestCph < 0) {
          bestCph = Math.max(0, ...this.api.candidates
            .filter((c) => !this.heldSet().has(key(c.displayName)))
            .map((c) => scoreCandidate(c, this.cfg, this.brainState()).cph), 0);
        }
        const q = this.api.quote(o.item);
        const mine = q ? scoreCandidate(q, this.cfg, this.brainState()).cph : 0;
        opp = bestCph > this.cfg.opportunityExitFactor * Math.max(1, mine);
      }
      if ((stall || opp) && await this.driver.cancel(o)) {
        this.orders.delete(key(o.item));
        return this._done(`exit-${stall ? 'stalled' : 'outclassed'} ${o.item}`);
      }
    }

    // 5) Open a new buy with the best-ranked flip we don't hold.
    if (grid.length < this.orderLimit && purse > 0 && !Number.isNaN(purse)) {
      const pick = pickNext(this.api.candidates, this.cfg, this.brainState());
      if (pick && pick.ourBuyPrice() <= this.perOrderBudget(purse, grid)) {
        const size = orderSize(pick, this.cfg, {
          purse,
          deployedBuyCapital: this.deployedBuyCapital(grid),
          freeInvSlots: this.driver.freeInventorySlots(),
          stackSize: 64,
        });
        if (size.units >= 1 && await this.driver.placeBuy(pick.displayName, size.units, pick.ourBuyPrice())) {
          const oi = this._newOrder({ item: pick.displayName, tag: pick.tag, amount: size.units }, t);
          oi.buyPrice = pick.ourBuyPrice();
          oi.quotedMargin = pick.margin(this.tax);
          this.orders.set(key(pick.displayName), oi);
          return this._done(`buy ${size.units}x ${pick.displayName}`);
        }
      }
    }

    return this._done('idle');
  }

  perOrderBudget(purse, grid) {
    const spendable = Math.max(0, purse - (this.cfg.coinReserve ?? 0));
    const freeSlots = Math.max(1, this.orderLimit - 1 - grid.length);
    const even = spendable / freeSlots;
    const cap = spendable * clamp(this.cfg.orderBudgetFraction ?? 0.5, 0.05, 1);
    return Math.min(even, cap);
  }

  /** Lowest price we can sell at without losing money vs what we paid. */
  profitFloor(item) {
    const oi = this.orders.get(key(item));
    if (!oi || !(oi.buyPrice > 0)) return null;
    return roundToTick((oi.buyPrice * (1 + (this.cfg.minSellMargin ?? 0))) / (1 - this.tax));
  }

  sellPriceFor(item) {
    const q = this.api.quote(item);
    const oi = this.orders.get(key(item));
    let price = q ? sellOfferPrice(q.lowestSellOffer) : (oi?.buyPrice ?? 0) * 1.05;
    if (this.cfg.neverSellAtLoss !== false) {
      const floor = this.profitFloor(item);
      if (floor != null && price < floor) price = floor; // hold the line, don't sell at a loss
    }
    return roundToTick(price);
  }

  // ---- bookkeeping ----
  adopt(grid, t) {
    for (const o of grid) {
      const k = key(o.item);
      if (!this.orders.has(k)) {
        const oi = this._newOrder(o, t);
        if (o.side === 'buy') oi.buyPrice = o.price; else oi.sellPrice = o.price;
        this.orders.set(k, oi);
      }
    }
  }

  onBuyClaimed(order, units, t) {
    const k = key(order.item);
    const oi = this.orders.get(k) ?? this._newOrder(order, t);
    if (Number.isNaN(oi.buyPrice)) oi.buyPrice = order.price;
    oi.claimedSoFar += units;
    this.orders.set(k, oi);
    this.session.buysFilled += 1;
    if (oi.buyPrice > 0) {
      inc(this.session.claimedUnits, order.item, units);
      inc(this.session.claimedCost, order.item, units * oi.buyPrice);
    }
    if (!this.pendingSells.includes(order.item)) this.pendingSells.push(order.item);
    inc(this.pendingAmounts, k, units);
  }

  onSellClaimed(order, units, t) {
    const k = key(order.item);
    const oi = this.orders.get(k);
    const sellP = order.price ?? oi?.sellPrice;
    const buyP = oi?.buyPrice;
    this.session.sellsFilled += 1;
    if (sellP != null && !Number.isNaN(sellP)) {
      inc(this.session.soldUnits, order.item, units);
      inc(this.session.soldRevenue, order.item, sellP * (1 - this.tax) * units);
    }
    if (buyP != null && !Number.isNaN(buyP) && sellP != null) {
      const profit = (sellP * (1 - this.tax) - buyP) * units;
      this.session.profit += profit;
      this.session.flips += 1;
      if (oi?.quotedMargin > 0 && buyP > 0) {
        const realized = (sellP * (1 - this.tax) - buyP) / buyP;
        ema(this.efficiency, k, clamp(realized / oi.quotedMargin, 0, 2), 0.7);
      }
      if (profit < 0) {
        this.blacklistUntil.set(k, t + (this.cfg.badItemBlacklistMinutes ?? 45) * 60_000);
      }
    }
    // Fully sold order can be dropped once its goods are gone.
    if (oi) { oi.soldSoFar += units; if (order.filledPct >= 100) this.orders.delete(k); }
  }

  /** Measure real fill rates per side and learn our capture share (feedback loops). */
  observeFills(grid, t) {
    for (const o of grid) {
      const target = o.side === 'buy' ? this.buyFillRate : this.sellFillRate;
      const obsKey = (o.side === 'buy' ? 'B|' : 'S|') + key(o.item);
      const filled = o.amount * Math.min(100, o.filledPct) / 100;
      const prev = this.fillObs.get(obsKey);
      if (!prev) { this.fillObs.set(obsKey, [t, filled]); continue; }
      const dF = filled - prev[1];
      if (dF < 0) { this.fillObs.set(obsKey, [t, filled]); continue; } // relisted → new baseline
      if (dF > 0) this.relistCounts.delete(key(o.item)); // it IS filling — not a losing war
      if (t - prev[0] < FILL_WINDOW_MS) continue;
      this.fillObs.set(obsKey, [t, filled]);
      const rate = dF / ((t - prev[0]) / 3_600_000);
      ema(target, key(o.item), rate, 0.75);
      const q = this.api.quote(o.item);
      if (q) {
        const legFlow = o.side === 'buy' ? q.buyLegHourly() : q.sellLegHourly();
        if (legFlow > 0) {
          const ratio = clamp(rate / legFlow, 0.01, 2);
          this.learnedCapture = this.learnedCaptureN === 0 ? ratio : 0.9 * this.learnedCapture + 0.1 * ratio;
          this.learnedCaptureN += 1;
        }
      }
    }
  }

  utilization(grid, purse) {
    const deployed = this.deployedBuyCapital(grid);
    const free = Number.isNaN(purse) ? 0 : Math.max(0, purse - (this.cfg.coinReserve ?? 0));
    const liquid = deployed + free;
    return liquid <= 0 ? 0 : deployed / liquid;
  }

  _done(action) { this.lastAction = action; return action; }
}
