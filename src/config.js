// Selection/sizing config for the brain — the subset of the Fabric mod's
// FlipConfig that governs WHICH items to flip and HOW MUCH, mirrored 1:1 so the
// two clients rank identically. (GUI/pacing/cookie config lives on the driver.)

export const defaultConfig = {
  // Margin / liquidity gates (BazaarApi filters).
  taxFraction: 0.0125, // auto-detected in-game; conservative default here
  apiMinMargin: 0.03,
  apiMaxMargin: 0.30, // above this is almost always an illiquid/manipulation trap
  apiMinWeeklyVolume: 250_000,
  apiMaxUnitPrice: 0, // 0 = no cap
  apiMaxTopGap: 0.15, // lone-outlier top-of-book spoof guard
  crashFilter: 0.08, // skip items mid-crash (protects the sell side)

  // Ranking / risk model.
  rankVolumeBeta: 0.85, // pre-sort: profitPerUnit × volume^beta
  volatilityLambda: 0.6, // requiredMargin = apiMinMargin + λ·σ
  trendWeight: 0.6, // momentum tilt on cph
  captureFraction: 0.30, // assumed share of volume before we've measured it
  minEfficiency: 0.35, // bench items that capture too little of quoted margin

  // Sizing (used by the driver; kept here so the brain can preview order sizes).
  orderVolumeFraction: 0.5,
  maxOrderVolumeFraction: 1.0, // when capital is idle
  idleDeployThreshold: 0.5,
  orderBudgetFraction: 0.5,
  minOrderValue: 250_000, // absolute per-order value floor
  maxUnitsPerOrder: 71_680, // Bazaar's own limit
  kellyFraction: 0.25,
  coinReserve: 0,

  // Items to NEVER trade (display names, matched via norm). Seed this with things
  // your account can't trade — e.g. skill-locked essences ("Undead Essence" needs
  // Catacombs 20). The driver ALSO learns locks at runtime (it refuses any product
  // whose tile says "you must have …") and skips them thereafter, so this is just
  // the proactive seed. Example: ["Undead Essence", "Wither Essence"].
  avoidItems: [],
};

export function makeConfig(overrides = {}) {
  return { ...defaultConfig, ...overrides };
}
