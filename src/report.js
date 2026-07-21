// Session breakdown builder — turns the state machine's session counters into the
// buy/sell/profit report you paste back for config tuning. Two renders:
//   buildBreakdown()  → the full text (for the console + the Discord .txt file)
//   discordSummary()  → a short embed-friendly summary (top lines, fits in a msg)
//
// Naming note: BUY ORDERS / SELL OFFERS totals are GROSS order flow (every order
// placed, relists included) — they show churn, not capital. Realized PROFIT comes
// only from claims (buy claimed vs sell claimed), so an item still held shows as
// "held", not a loss.

const abs = Math.abs;
export function fmt(n) {
  if (n == null || Number.isNaN(n)) return '0';
  const a = abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toFixed(0);
}

function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
}

const sum = (map) => [...map.values()].reduce((a, b) => a + b, 0);
const sortedDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

/** @param {object} session  the sm.session object
 *  @param {object} [opts] {now, title} */
export function buildBreakdown(session = {}, { now = Date.now(), title = 'BZFLIPPER SESSION BREAKDOWN' } = {}) {
  const buyOrders = session.buyOrders ?? new Map();
  const buyCoins = session.buyOrderCoins ?? new Map();
  const sellOffers = session.sellOffers ?? new Map();
  const sellCoins = session.sellOfferCoins ?? new Map();
  const claimedU = session.claimedUnits ?? new Map();
  const claimedC = session.claimedCost ?? new Map();
  const soldU = session.soldUnits ?? new Map();
  const soldR = session.soldRevenue ?? new Map();

  const buyTotal = sum(buyCoins);
  const sellTotal = sum(sellCoins);
  const L = [];
  L.push(`=== ${title} ===`);
  L.push(`BUY ORDERS TOTAL  : ${fmt(buyTotal)} coins`);
  L.push(`SELL OFFERS TOTAL : ${fmt(sellTotal)} coins`);
  L.push(`OVERALL TOTAL     : ${fmt(buyTotal + sellTotal)} coins`);
  L.push('');

  L.push('=== BUY ORDERS ===');
  for (const [item, coins] of sortedDesc(buyCoins)) L.push(`🟢 ${item} — ${buyOrders.get(item) ?? 0}× (${fmt(coins)})`);
  if (!buyCoins.size) L.push('(none)');
  L.push('');

  L.push('=== SELL OFFERS ===');
  for (const [item, coins] of sortedDesc(sellCoins)) L.push(`🔴 ${item} — ${sellOffers.get(item) ?? 0}× (${fmt(coins)})`);
  if (!sellCoins.size) L.push('(none)');
  L.push('');

  // Profit per item: realized = sold revenue − claimed cost. Items claimed but not
  // yet sold are "held" (not a loss). PPI = profit ÷ sold units.
  const items = new Set([...claimedU.keys(), ...soldU.keys()]);
  const rows = [];
  for (const it of items) {
    const cu = claimedU.get(it) ?? 0, cc = claimedC.get(it) ?? 0;
    const su = soldU.get(it) ?? 0, sr = soldR.get(it) ?? 0;
    const profit = sr - cc;
    const ppi = su > 0 ? profit / su : 0;
    rows.push({ it, cu, cc, su, sr, profit, ppi, held: su === 0 });
  }
  rows.sort((a, b) => b.profit - a.profit);
  const totalProfit = rows.reduce((a, r) => a + r.profit, 0);
  const realized = rows.filter((r) => r.su > 0).reduce((a, r) => a + r.profit, 0);
  const heldCost = rows.filter((r) => r.held).reduce((a, r) => a + r.cc, 0);

  L.push('=== PROFIT ===');
  L.push(`TOTAL PROFIT     : ${fmt(totalProfit)} coins   (realized round-trips: ${fmt(realized)}; still-held inventory cost: ${fmt(heldCost)})`);
  L.push(`FLIPS            : ${session.flips ?? 0}   ·   BUYS FILLED: ${session.buysFilled ?? 0}   ·   SELLS FILLED: ${session.sellsFilled ?? 0}`);
  L.push(`SESSION DURATION : ${dur(now - (session.startedAt ?? now))}`);
  L.push('');
  for (const r of rows) {
    const tail = r.held ? '  📦 HELD (bought, not yet sold — not a loss)' : '';
    L.push(`💰 ${r.it} — CLAIMED: ${r.cu}× (${fmt(r.cc)}) | SOLD: ${r.su}× (${fmt(r.sr)}) | PROFIT: ${fmt(r.profit)} | PPI: ${fmt(r.ppi)}${tail}`);
  }
  if (!rows.length) L.push('(no fills yet)');
  return L.join('\n');
}

/** Compact one-embed summary for Discord (safe under the 2000-char limit). */
export function discordSummary(session = {}, { now = Date.now() } = {}) {
  const claimedC = session.claimedCost ?? new Map();
  const soldR = session.soldRevenue ?? new Map();
  const soldU = session.soldUnits ?? new Map();
  const claimedU = session.claimedUnits ?? new Map();
  const items = new Set([...claimedU.keys(), ...soldU.keys()]);
  const rows = [];
  for (const it of items) {
    const profit = (soldR.get(it) ?? 0) - (claimedC.get(it) ?? 0);
    rows.push({ it, profit, held: (soldU.get(it) ?? 0) === 0 });
  }
  rows.sort((a, b) => b.profit - a.profit);
  const realized = rows.filter((r) => !r.held).reduce((a, r) => a + r.profit, 0);
  const sign = (n) => (n >= 0 ? '+' : '') + fmt(n);
  const top = rows.filter((r) => !r.held && r.profit > 0).slice(0, 5).map((r) => `${sign(r.profit)} ${r.it}`);
  const bot = rows.filter((r) => !r.held && r.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, 3).map((r) => `${sign(r.profit)} ${r.it}`);
  const lines = [
    `**Session ended** — realized **${fmt(realized)}** coins over **${session.flips ?? 0}** flips (${dur(now - (session.startedAt ?? now))})`,
    `buys filled ${session.buysFilled ?? 0} · sells filled ${session.sellsFilled ?? 0}`,
    top.length ? `top: ${top.join(', ')}` : '',
    bot.length ? `worst: ${bot.join(', ')}` : '',
    '📄 full breakdown attached — paste it back to tune the config.',
  ].filter(Boolean);
  return lines.join('\n').slice(0, 1900);
}
