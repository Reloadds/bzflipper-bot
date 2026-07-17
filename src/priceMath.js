// Pure, dependency-free flipping math — a 1:1 port of core/PriceMath.java from the
// Fabric mod. ZERO Minecraft/Mineflayer concerns live here on purpose: this is the
// reusable brain, identical logic on both clients. Keep it pure.

/** Hypixel Bazaar prices tick in increments of 0.1 coins. */
export const TICK = 0.1;

/** Round a price to the nearest valid 0.1 increment. */
export function roundToTick(price) {
  return Math.round(price / TICK) * TICK;
}

/** Competitive BUY order: outbid the current top buy order by one tick. */
export function buyOrderPrice(topBuyOrder) {
  return roundToTick(topBuyOrder + TICK);
}

/** Competitive SELL offer: undercut the current lowest sell offer by one tick. */
export function sellOfferPrice(lowestSellOffer) {
  return roundToTick(lowestSellOffer - TICK);
}

/** Absolute spread per unit between our sell and buy prices. */
export function spread(topBuyOrder, lowestSellOffer) {
  return sellOfferPrice(lowestSellOffer) - buyOrderPrice(topBuyOrder);
}

/**
 * Net profit margin as a fraction of the buy price, AFTER Bazaar tax.
 * @returns e.g. 0.05 for a 5% net margin. Negative = unprofitable.
 */
export function netMarginFraction(topBuyOrder, lowestSellOffer, taxFraction) {
  const buy = buyOrderPrice(topBuyOrder);
  const sell = sellOfferPrice(lowestSellOffer);
  if (buy <= 0) return 0;
  const netSell = sell * (1 - taxFraction);
  return (netSell - buy) / buy;
}

/** Net profit per unit after tax (coins), at competitive prices. */
export function profitPerUnit(topBuyOrder, lowestSellOffer, taxFraction) {
  return sellOfferPrice(lowestSellOffer) * (1 - taxFraction) - buyOrderPrice(topBuyOrder);
}

/** True if someone has outbid our buy order (their price > ours). */
export function buyOrderUndercut(ourBuyPrice, currentTopBuyOrder) {
  return currentTopBuyOrder > ourBuyPrice + 1e-9;
}

/** True if someone has undercut our sell offer (their price < ours). */
export function sellOfferUndercut(ourSellPrice, currentLowestSell) {
  return currentLowestSell < ourSellPrice - 1e-9;
}

/**
 * Liquidity-weighted flip score (log of the smaller weekly volume). An illiquid
 * high-margin trap scores low. Bounded at 0 for unprofitable flips.
 */
export function flipScore(margin, buyWeekVol, sellWeekVol) {
  const liquidity = Math.log1p(Math.max(0, Math.min(buyWeekVol, sellWeekVol)));
  return Math.max(0, margin) * liquidity;
}

/**
 * Capital velocity of a flip whose two legs run IN SERIES (buy fills at buyRate
 * u/hr, then sell fills at sellRate u/hr). Harmonic combination:
 *   v = 1 / (1/buyRate + 1/sellRate)
 * A flip is only as fast as BOTH legs together. 0 if either leg is stalled.
 */
export function seriesVelocity(buyRate, sellRate) {
  if (buyRate <= 0 || sellRate <= 0) return 0;
  return 1 / (1 / buyRate + 1 / sellRate);
}

/** Max whole units affordable for `spendableCoins` at `unitBuyPrice`, capped. */
export function affordableUnits(spendableCoins, unitBuyPrice, cap) {
  if (unitBuyPrice <= 0 || spendableCoins <= 0) return 0;
  const n = Math.floor(spendableCoins / unitBuyPrice);
  return Math.max(0, Math.min(n, cap));
}
