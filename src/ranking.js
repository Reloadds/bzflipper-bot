// The decision brain: scores each candidate by expected realized coins/hour and
// picks the best one to deploy into. Port of BazaarMacro.scoreCandidate /
// pickNextItem / pBuyAmount (the pure parts). State (measured fill rates,
// efficiency, learned capture) is passed in so the driver owns persistence.

import * as PriceMath from './priceMath.js';
import { norm } from './bazaarApi.js';

/**
 * @typedef {Object} BrainState
 * @property {Map<string,number>} [sellFillRate]  measured sell units/hr per item key
 * @property {Map<string,number>} [buyFillRate]   measured buy  units/hr per item key
 * @property {Map<string,number>} [efficiency]    realized÷quoted EMA per item key (default 1)
 * @property {number} [learnedCapture]            account-wide share (0 = use config guess)
 * @property {Set<string>} [held]                 item keys we already hold / have pending
 */

function key(name) { return norm(name); }

function captureEstimate(cfg, state) {
  return state?.learnedCapture > 0 ? state.learnedCapture : cfg.captureFraction;
}

/**
 * THE objective function: expected realized coins/hour for one order slot of this
 * candidate. Two legs run IN SERIES, so cph uses the series velocity of both —
 * an item whose sells fly but whose buy order sits for hours parks capital and is
 * penalized accordingly.
 * @returns {{ppu:number, buyRate:number, buyMeasured:boolean, sellRate:number,
 *   sellMeasured:boolean, velocity:number, eff:number, trendF:number, cph:number}}
 */
export function scoreCandidate(c, cfg, state = {}) {
  const k = key(c.displayName);
  const capture = captureEstimate(cfg, state);
  const ppu = Math.max(0, PriceMath.profitPerUnit(c.topBuyOrder, c.lowestSellOffer, cfg.taxFraction));

  const sf = state.sellFillRate?.get(k);
  const sellMeasured = sf > 0;
  const sellRate = sellMeasured ? sf : c.sellLegHourly() * capture;

  const bf = state.buyFillRate?.get(k);
  const buyMeasured = bf > 0;
  const buyRate = buyMeasured ? bf : c.buyLegHourly() * capture;

  const velocity = PriceMath.seriesVelocity(buyRate, sellRate);
  const eff = Math.max(0.1, state.efficiency?.get(k) ?? 1);
  const trendF = clamp(1 + cfg.trendWeight * c.trend, 0.5, 1.5);
  const cph = ppu * velocity * eff * trendF;

  return { ppu, buyRate, buyMeasured, sellRate, sellMeasured, velocity, eff, trendF, cph };
}

/**
 * Rank candidates by cph (desc), annotating each with its score and a `state`
 * tag (held / benched / low-eff / ok). Mirrors refreshRankingSnapshot.
 */
export function rank(candidates, cfg, state = {}) {
  const now = Date.now();
  const held = state.held ?? new Set();
  const avoid = avoidSet(cfg, state);
  const rows = candidates.map((c) => {
    const s = scoreCandidate(c, cfg, state);
    const k = key(c.displayName);
    let tag = 'ok';
    if (avoid.has(k)) tag = 'locked';           // can't trade (config seed or learned)
    else if (held.has(k)) tag = 'held';
    else if ((state.blacklistUntil?.get(k) ?? 0) > now) tag = 'benched';
    else if ((state.efficiency?.get(k) ?? 1) < cfg.minEfficiency) tag = 'low-eff';
    return { candidate: c, ...s, state: tag };
  });
  rows.sort((a, b) => b.cph - a.cph);
  return rows;
}

/** Item keys we must never trade: the config seed (cfg.avoidItems) ∪ the runtime
 *  learned locks the driver discovered (state.locked), both normalised. */
function avoidSet(cfg, state) {
  const s = new Set((cfg.avoidItems ?? []).map((n) => key(n)));
  if (state.locked) for (const k of state.locked) s.add(k);
  return s;
}

/** Best candidate we don't already hold (highest cph). Null if none. */
export function pickNext(candidates, cfg, state = {}) {
  const held = state.held ?? new Set();
  const avoid = avoidSet(cfg, state);
  let best = null, bestCph = -1;
  for (const c of candidates) {
    const k = key(c.displayName);
    if (avoid.has(k)) continue;                 // untradeable — never pick
    if (held.has(k)) continue;
    if ((state.efficiency?.get(k) ?? 1) < cfg.minEfficiency) continue;
    const { cph } = scoreCandidate(c, cfg, state);
    if (cph > bestCph) { bestCph = cph; best = c; }
  }
  return best;
}

/**
 * Preview the order size the driver would place: min of the purse, volume,
 * inventory and Kelly caps. Capital-aware — when a big share of liquid coins is
 * idle, the volume cap relaxes toward maxOrderVolumeFraction. Port of pBuyAmount.
 * @returns {{units:number, binding:string, byPurse:number, byVolume:number, byKelly:number}}
 */
export function orderSize(c, cfg, { purse, deployedBuyCapital = 0, stackSize = 64, freeInvSlots = 30, budget } = {}) {
  const ourBuy = c.ourBuyPrice();
  const spendable = Math.max(0, (purse ?? 0) - cfg.coinReserve);
  // Per-order budget. Use the caller's EVEN-SPLIT budget (spendable ÷ free slots,
  // capped by orderBudgetFraction) when given, so capital spreads across the whole
  // book — without it, one order would eat orderBudgetFraction (e.g. 50%) of the
  // entire purse and starve the other slots. Fall back to the fraction cap.
  const perOrder = (budget != null && budget > 0)
    ? budget
    : Math.min(spendable, spendable * clamp(cfg.orderBudgetFraction, 0.05, 1));

  const byPurse = PriceMath.affordableUnits(perOrder, ourBuy, cfg.maxUnitsPerOrder);

  const liquid = deployedBuyCapital + spendable;
  const utilization = liquid <= 0 ? 0 : deployedBuyCapital / liquid;
  const idle = utilization < 1 - cfg.idleDeployThreshold;
  const volFrac = idle ? Math.max(cfg.orderVolumeFraction, cfg.maxOrderVolumeFraction) : cfg.orderVolumeFraction;
  const byVolume = Math.max(1, Math.floor(c.hourlyVolume() * volFrac));

  let byKelly = Infinity;
  if (cfg.kellyFraction > 0 && c.volatility > 1e-6) {
    const margin = c.margin(cfg.taxFraction);
    if (margin > 0) {
      const f = Math.min(1, margin / (c.volatility * c.volatility)) * cfg.kellyFraction;
      byKelly = Math.max(1, Math.floor((liquid * f) / ourBuy));
    }
  }

  const byInv = Math.max(1, freeInvSlots) * Math.max(1, stackSize);
  const caps = { byPurse, byVolume, byKelly, byInv };
  const units = Math.max(1, Math.min(byPurse, byVolume, byKelly, byInv));
  const binding = Object.entries(caps).sort((a, b) => a[1] - b[1])[0][0];
  return { units, binding, byPurse, byVolume, byKelly: byKelly === Infinity ? -1 : byKelly, byInv };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
