import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBreakdown, discordSummary, fmt } from '../src/report.js';

const m = (o) => new Map(Object.entries(o));
const session = () => ({
  flips: 2, buysFilled: 3, sellsFilled: 2, startedAt: 1_000_000,
  buyOrders: m({ MITHRIL: 1000, GIFT: 200 }), buyOrderCoins: m({ MITHRIL: 1.4e6, GIFT: 3e6 }),
  sellOffers: m({ MITHRIL: 5000 }), sellOfferCoins: m({ MITHRIL: 7e6 }),
  claimedUnits: m({ MITHRIL: 1000, FOSSIL: 500 }), claimedCost: m({ MITHRIL: 1.4e6, FOSSIL: 1.5e6 }),
  soldUnits: m({ MITHRIL: 1000 }), soldRevenue: m({ MITHRIL: 1.6e6 }),
});

test('fmt: B/M/K/raw with sign', () => {
  assert.equal(fmt(2.5e9), '2.50B');
  assert.equal(fmt(-4.4e6), '-4.40M');
  assert.equal(fmt(950), '950');
  assert.equal(fmt(NaN), '0');
});

test('buildBreakdown: totals, sections, realized vs held split', () => {
  const out = buildBreakdown(session(), { now: 1_000_000 + 3.7e6 });
  assert.match(out, /BUY ORDERS TOTAL {2}: 4\.40M/);
  assert.match(out, /SELL OFFERS TOTAL : 7\.00M/);
  assert.match(out, /OVERALL TOTAL {5}: 11\.40M/);
  assert.match(out, /🟢 GIFT — 200× \(3\.00M\)/);          // buy section, sorted by coins
  assert.match(out, /🔴 MITHRIL — 5000× \(7\.00M\)/);
  assert.match(out, /MITHRIL — CLAIMED: 1000× .* PROFIT: 200\.00K/); // 1.6M-1.4M realized
  assert.match(out, /FOSSIL .*PROFIT: -1\.50M.*HELD/);      // claimed, not sold → held, not a loss
  assert.match(out, /SESSION DURATION : 1 hour 1 minute/);
});

test('discordSummary: no double sign, fits under limit, held excluded from top/worst', () => {
  const s = discordSummary(session(), { now: 1_000_000 + 6e5 });
  assert.ok(s.length <= 1900);
  assert.match(s, /realized \*\*200\.00K\*\*/);
  assert.match(s, /\+200\.00K MITHRIL/);        // positive prefixed with + once
  assert.doesNotMatch(s, /\+-/);                // never "+-"
  assert.doesNotMatch(s, /FOSSIL/);             // held item not in top/worst
});

test('empty session renders without throwing', () => {
  assert.doesNotThrow(() => buildBreakdown({}));
  assert.doesNotThrow(() => discordSummary({}));
  assert.match(buildBreakdown({}), /\(none\)/);
});
