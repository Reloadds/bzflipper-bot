// Pulls the live Bazaar order book from Hypixel's public API and ranks the best
// flips — a port of api/BazaarApi.java. Stateful only for the rolling per-item
// price history that yields volatility & trend (accumulates across polls).
//
// Hypixel's field naming is FAMOUSLY INVERTED: `buy_summary` holds the SELL
// offers and `sell_summary` holds the BUY orders. The code below swaps them
// accordingly. Do NOT "fix" the swap to match the names or every margin goes
// negative and no flips are found.

import * as PriceMath from './priceMath.js';
import * as ItemNames from './itemNames.js';

const URL = 'https://api.hypixel.net/v2/skyblock/bazaar';
const HISTORY_LEN = 20;

export class FlipCandidate {
  constructor(tag, displayName, topBuyOrder, lowestSellOffer, buyWeekVolume,
              sellWeekVolume, buyDepth, sellDepth, volatility, trend) {
    this.tag = tag;
    this.displayName = displayName;
    this.topBuyOrder = topBuyOrder; // highest existing buy order (we outbid)
    this.lowestSellOffer = lowestSellOffer; // lowest existing sell offer (we undercut)
    this.buyWeekVolume = buyWeekVolume;
    this.sellWeekVolume = sellWeekVolume;
    this.buyDepth = buyDepth;
    this.sellDepth = sellDepth;
    this.volatility = volatility; // σ/μ of mid price
    this.trend = trend; // relative price change over the window
  }

  ourBuyPrice() { return PriceMath.buyOrderPrice(this.topBuyOrder); }
  ourSellPrice() { return PriceMath.sellOfferPrice(this.lowestSellOffer); }
  margin(tax) { return PriceMath.netMarginFraction(this.topBuyOrder, this.lowestSellOffer, tax); }
  minWeeklyVolume() { return Math.min(this.buyWeekVolume, this.sellWeekVolume); }
  hourlyVolume() { return this.minWeeklyVolume() / 168; }

  // Per-leg flows are fed by OPPOSITE market sides (same inversion convention):
  //   our BUY order is consumed by instasellers → sellMovingWeek
  //   our SELL offer is consumed by instabuyers → buyMovingWeek
  buyLegHourly() { return this.sellWeekVolume / 168; }
  sellLegHourly() { return this.buyWeekVolume / 168; }

  requiredMargin(cfg) { return cfg.apiMinMargin + cfg.volatilityLambda * this.volatility; }

  /** Pre-sort score: profit throughput with a tunable volume exponent. */
  score(cfg) {
    const ppu = Math.max(0, PriceMath.profitPerUnit(this.topBuyOrder, this.lowestSellOffer, cfg.taxFraction));
    const base = ppu * Math.pow(Math.max(1, this.minWeeklyVolume()), cfg.rankVolumeBeta);
    const trendFactor = clamp(1 + cfg.trendWeight * this.trend, 0.5, 1.5);
    return base * trendFactor;
  }
}

export class BazaarApi {
  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.candidates = [];
    this.quotes = new Map(); // norm(displayName) → FlipCandidate (every item)
    this.lastUpdatedMs = 0;
    this.lastError = null;
    this._history = new Map(); // tag → number[] of recent mids
  }

  ageSeconds() {
    return this.lastUpdatedMs === 0 ? -1 : Math.floor((Date.now() - this.lastUpdatedMs) / 1000);
  }

  quote(name) {
    return this.quotes.get(norm(name)) ?? null;
  }

  async refresh() {
    await ItemNames.ensureLoaded(this.fetch);
    const res = await this.fetch(URL, { headers: { 'User-Agent': 'bzflipper-headless' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const root = await res.json();
    if (!root.success) throw new Error('API success=false');

    const cfg = this.config;
    const list = [];
    const quoteMap = new Map();

    for (const [tag, p] of Object.entries(root.products)) {
      try {
        const sellOffers = p.buy_summary; // inverted: these are SELL offers
        const buyOrders = p.sell_summary; // inverted: these are BUY orders
        if (!sellOffers?.length || !buyOrders?.length) continue;

        const topBuyOrder = buyOrders[0].pricePerUnit; // we outbid
        const lowestSellOffer = sellOffers[0].pricePerUnit; // we undercut
        if (topBuyOrder <= 0 || lowestSellOffer <= 0) continue;

        const q = p.quick_status;
        if (!q || q.buyMovingWeek == null || q.sellMovingWeek == null) continue;
        const buyMW = q.buyMovingWeek;
        const sellMW = q.sellMovingWeek;

        const buyDepth = buyOrders[0].amount ?? 0;
        const sellDepth = sellOffers[0].amount ?? 0;
        const [volatility, trend] = this._updateStats(tag, (topBuyOrder + lowestSellOffer) / 2);

        const c = new FlipCandidate(tag, ItemNames.name(tag), topBuyOrder, lowestSellOffer,
          buyMW, sellMW, buyDepth, sellDepth, volatility, trend);
        // Every item is quotable (used for exact undercut checks), pre-filter.
        quoteMap.set(norm(c.displayName), c);

        const margin = PriceMath.netMarginFraction(topBuyOrder, lowestSellOffer, cfg.taxFraction);
        if (margin < c.requiredMargin(cfg) || margin > cfg.apiMaxMargin) continue;
        if (Math.min(buyMW, sellMW) < cfg.apiMinWeeklyVolume) continue;
        if (trend < -cfg.crashFilter) continue;
        if (cfg.apiMaxUnitPrice > 0 && topBuyOrder > cfg.apiMaxUnitPrice) continue;

        // Anti-manipulation 1: lone-outlier top order (spoof).
        if (buyOrders.length > 1) {
          const second = buyOrders[1].pricePerUnit;
          if (second > 0 && (topBuyOrder - second) / second > cfg.apiMaxTopGap) continue;
        }
        if (sellOffers.length > 1) {
          const second = sellOffers[1].pricePerUnit;
          if (second > 0 && (second - lowestSellOffer) / lowestSellOffer > cfg.apiMaxTopGap) continue;
        }
        // Anti-manipulation 2: weighted-average cross-check (quick_status is the
        // volume-weighted book; naming inverted like the summaries).
        const avgSellOffer = q.buyPrice ?? 0;
        const avgBuyOrder = q.sellPrice ?? 0;
        if (avgSellOffer > 0 && avgBuyOrder > 0) {
          const weightedMargin = PriceMath.netMarginFraction(avgBuyOrder, avgSellOffer, cfg.taxFraction);
          if (weightedMargin < cfg.apiMinMargin * 0.4) continue;
        }

        list.push(c);
      } catch {
        // One malformed product must not abort the whole refresh.
        continue;
      }
    }

    list.sort((a, b) => b.score(cfg) - a.score(cfg));
    this.candidates = list.slice(0, 30);
    this.quotes = quoteMap;
    this.lastUpdatedMs = Date.now();
    this.lastError = null;
    return this.candidates;
  }

  /** Append the item's mid; return [volatility σ/μ, trend %-change over window]. */
  _updateStats(tag, mid) {
    let hist = this._history.get(tag);
    if (!hist) { hist = []; this._history.set(tag, hist); }
    hist.push(mid);
    while (hist.length > HISTORY_LEN) hist.shift();
    const n = hist.length;
    if (n < 4) return [0, 0];
    const mean = hist.reduce((s, v) => s + v, 0) / n;
    if (mean <= 0) return [0, 0];
    const varc = hist.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
    const vol = Math.sqrt(varc) / mean;
    const k = Math.max(1, Math.floor(n / 3));
    let first = 0, last = 0;
    for (let j = 0; j < k; j++) { first += hist[j]; last += hist[n - 1 - j]; }
    first /= k; last /= k;
    const trend = first > 0 ? (last - first) / first : 0;
    return [vol, trend];
  }
}

/** Normalize a name to a lookup key (lowercase, strip symbols/punctuation). */
export function norm(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
