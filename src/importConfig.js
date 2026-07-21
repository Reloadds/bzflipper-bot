// Importable config: accept two MBF-style JSON shapes (a "settings" object and a
// "filters" object with blacklist/whitelist) and map them onto the bot's own
// config. Used both at boot (import/settings.json + import/filters.json if present)
// and live from the dashboard's Import panel (POST /api/import).
//
// The mapping is intentionally the ONE place that knows the foreign schema, so the
// rest of the bot only ever sees native cfg fields.

const pct = (v) => (v == null ? null : Number(v) / 100);
const numOr = (v, d = null) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

/** Detect which shape a pasted/loaded object is. */
export function detectKind(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj.blacklist) || obj.whitelist || obj.selectiveBuys && typeof obj.selectiveBuys === 'object') return 'filters';
  if (obj.profit || obj.price || obj.orders || obj.volume || obj.purse) return 'settings';
  return null;
}

/**
 * Map the MBF-style settings object → a partial of the bot's strategy cfg plus a
 * few bot-level fields (webhook/port/password). Only fields the bot actually
 * honors are returned; unknown ones are ignored (and reported as warnings).
 * @returns {{strategy:Object, bot:Object, warnings:string[]}}
 */
export function mapSettings(s = {}) {
  const strategy = {};
  const bot = {};
  const warn = [];
  const set = (k, v) => { if (v != null && Number.isFinite(v)) strategy[k] = v; };

  if (s.profit) {
    set('apiMinMargin', pct(s.profit.minPercentage));
    set('minProfitCoins', numOr(s.profit.min));
    set('maxProfitCoins', numOr(s.profit.max));
  }
  if (s.price) {
    set('apiMaxUnitPrice', numOr(s.price.maxPricePerUnitBuy));
    set('maxSellUnitPrice', numOr(s.price.maxPricePerUnitSell));
    set('minUnitPrice', numOr(s.price.minPricePerUnitBuy));
    set('apiMaxTopGap', pct(s.price.manipulationTriggerPercentage));
    set('blacklistMinutes', numOr(s.price.temporaryBlacklistDuration));
  }
  if (s.orders) {
    set('orderLimit', numOr(s.orders.maxBuyOrders));
    if (s.orders.sortBy && s.orders.sortBy !== 'coinsPerHour')
      warn.push(`orders.sortBy="${s.orders.sortBy}" ignored — the bot always ranks by coins/hour.`);
  }
  if (s.volume) {
    set('minBuyVolumeHourly', numOr(s.volume.minBuy));
    set('minSellVolumeHourly', numOr(s.volume.minSell));
  }
  if (s.purse) {
    set('coinReserve', numOr(s.purse.minPurse));
    set('maxSpentPerOrder', numOr(s.purse.maxSpentPerOrder));
  }
  if (typeof s.selectiveBuys === 'boolean') strategy.whitelistOnly = s.selectiveBuys;

  if (s.webhook != null) bot.webhookUrl = String(s.webhook);
  if (typeof s.detailedWebhooks === 'boolean') bot.detailedWebhooks = s.detailedWebhooks;
  if (s.webpage?.settings) {
    if (s.webpage.settings.port != null) bot.dashboardPort = numOr(s.webpage.settings.port);
    if (s.webpage.settings.password != null) bot.dashboardPassword = String(s.webpage.settings.password);
  }
  if (s.proxy?.enabled) warn.push('proxy.* ignored — set the bot connection in config.json instead.');
  if (s.key || s.username || s.friendlyKeys) warn.push('key/username/friendlyKeys ignored — this bot authenticates via config.json.');

  return { strategy, bot, warnings: warn };
}

/**
 * Map the MBF-style filters object → native cfg. Blacklist/whitelist use Bazaar
 * product IDs (e.g. "ENCHANTED_COAL"), which match FlipCandidate.tag exactly.
 * @returns {{strategy:Object, warnings:string[]}}
 */
export function mapFilters(f = {}) {
  const strategy = {};
  const warn = [];
  if (Array.isArray(f.blacklist)) {
    strategy.blacklistTags = [...new Set(f.blacklist.map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
  }
  if (f.whitelist && typeof f.whitelist === 'object') {
    const wl = {};
    for (const [tag, o] of Object.entries(f.whitelist)) {
      const T = String(tag).trim().toUpperCase();
      wl[T] = {
        minProfit: numOr(o?.minProfit, 0),
        minPercentage: numOr(o?.minPercentage, null), // percent, mapped to a fraction at use-time
        maxBuyOrder: numOr(o?.maxBuyOrder, 0), // 0 = no cap — a defaulted 1 would shrink every order to a single unit
      };
    }
    strategy.whitelist = wl;
  }
  if (f.selectiveBuys && typeof f.selectiveBuys === 'object') strategy.selectiveBuys = f.selectiveBuys;
  return { strategy, warnings: warn };
}

/**
 * Apply an imported object (auto-detected) onto a live cfg (mutated in place) and
 * an optional bot object. Returns what changed so the caller can persist + log.
 * Accepts either a single settings/filters object, or a combined {settings,filters}.
 * @returns {{kind:string, strategy:Object, bot:Object, warnings:string[]}}
 */
export function applyImport(cfg, obj, botObj = null) {
  let strategy = {}, botPatch = {}, warnings = [], kind = 'combined';

  const takeSettings = (s) => { const r = mapSettings(s); Object.assign(strategy, r.strategy); Object.assign(botPatch, r.bot); warnings.push(...r.warnings); };
  const takeFilters = (f) => { const r = mapFilters(f); Object.assign(strategy, r.strategy); warnings.push(...r.warnings); };

  if (obj && (obj.settings || obj.filters)) {
    if (obj.settings) takeSettings(obj.settings);
    if (obj.filters) takeFilters(obj.filters);
  } else {
    kind = detectKind(obj);
    if (kind === 'settings') takeSettings(obj);
    else if (kind === 'filters') takeFilters(obj);
    else throw new Error('unrecognised config shape — expected an MBF settings object or a blacklist/whitelist object');
  }

  for (const [k, v] of Object.entries(strategy)) cfg[k] = v;
  if (botObj) for (const [k, v] of Object.entries(botPatch)) botObj[k] = v;
  return { kind, strategy, bot: botPatch, warnings };
}

// ---- Example templates (also written to import/*.example.json) ----------------

export const SETTINGS_TEMPLATE = {
  webhook: '',
  detailedWebhooks: true,
  webpage: { settings: { port: 3000, password: '' } },
  profit: { min: 12000, max: 200000000, minPercentage: 9 },
  price: {
    maxPricePerUnitBuy: 20000000,
    maxPricePerUnitSell: 50000000,
    minPricePerUnitBuy: 500,
    manipulationTriggerPercentage: 20,
    temporaryBlacklistDuration: 15,
  },
  orders: { maxBuyOrders: 6, sortBy: 'coinsPerHour' },
  volume: { minBuy: 60, minSell: 30 },
  purse: { minPurse: 1000000, maxSpentPerOrder: 9000000 },
  selectiveBuys: false,
};

export const FILTERS_TEMPLATE = {
  blacklist: ['SUSPICIOUS_SCRAP', 'RED_GIFT', 'ENCHANTED_COAL'],
  whitelist: { PRECURSOR_GEAR: { minProfit: 50000, minPercentage: 5, maxBuyOrder: 10 } },
  selectiveBuys: {},
};
