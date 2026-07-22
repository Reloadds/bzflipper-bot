// State-machine regression tests — focused on the duplicate-sell consolidation
// and cookie backoff fixes. Uses lightweight fakes for the driver + api.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine } from '../src/stateMachine.js';
import { makeConfig } from '../src/config.js';

function fakeDriver(overrides = {}) {
  const calls = { placeSell: [], cancel: [], placeBuy: [], claim: [], refreshCookie: 0 };
  return {
    calls,
    grid: [],
    purse: 100_000_000,
    cookieMs: -1,
    readPurse() { return this.purse; },
    readCookieRemainMs() { return this.cookieMs; },
    freeInventorySlots() { return 30; },
    async openBook() {},
    readOrders() { return this.grid; },
    async placeSell(item, units, price) { calls.placeSell.push({ item, units, price }); return true; },
    async placeBuy(item, units, price) { calls.placeBuy.push({ item, units, price }); return true; },
    async cancel(o) { calls.cancel.push(o); this.grid = this.grid.filter((g) => g !== o); return true; },
    async claim(o) { calls.claim.push(o); return { kind: o.side, units: o.amount }; },
    async refreshCookie() { calls.refreshCookie++; return overrides.cookieOk ?? false; },
    locked: new Set(),
    ...overrides,
  };
}
const fakeApi = { candidates: [], quote: () => null, filters: null, ageSeconds: () => 0 };

test('duplicate sells consolidate: existing resting offer is cancelled, then one combined offer placed', async () => {
  const sm = new StateMachine(makeConfig({ cookieRefreshEnabled: false }), fakeApi, fakeDriver());
  // We already hold an open sell of 100 Fossil Essence (unfilled), and a fresh
  // partial buy just added 50 more units queued to sell.
  const existing = { side: 'sell', item: 'Fossil Essence', amount: 100, filledPct: 0, price: 3000, claimable: false };
  sm.driver.grid = [existing];
  sm.pendingSells = ['Fossil Essence'];
  sm.pendingAmounts.set('fossil essence', 50);

  await sm.tick(); // should CONSOLIDATE (cancel existing), not place a 2nd offer
  assert.equal(sm.driver.calls.cancel.length, 1, 'cancelled the existing resting sell');
  assert.equal(sm.driver.calls.placeSell.length, 0, 'did NOT stack a second offer this tick');
  assert.equal(sm.pendingAmounts.get('fossil essence'), 150, 'folded 100 unsold into the pending amount');

  await sm.tick(); // now the grid is empty of that sell → place ONE combined offer
  assert.equal(sm.driver.calls.placeSell.length, 1, 'placed exactly one combined offer');
  assert.equal(sm.driver.calls.placeSell[0].units, 150, 'combined amount = 100 + 50');
});

test('no consolidation when there is no existing offer — normal single listing', async () => {
  const sm = new StateMachine(makeConfig({ cookieRefreshEnabled: false }), fakeApi, fakeDriver());
  sm.pendingSells = ['Pest Shard'];
  sm.pendingAmounts.set('pest shard', 3);
  await sm.tick();
  assert.equal(sm.driver.calls.cancel.length, 0);
  assert.equal(sm.driver.calls.placeSell.length, 1);
  assert.equal(sm.driver.calls.placeSell[0].units, 3);
});

test('claimable sells are NOT treated as duplicates (step 1 claims them first)', async () => {
  const sm = new StateMachine(makeConfig({ cookieRefreshEnabled: false }), fakeApi, fakeDriver());
  const claimable = { side: 'sell', item: 'Red Gift', amount: 9, filledPct: 100, price: 19000, claimable: true };
  sm.driver.grid = [claimable];
  sm.pendingSells = ['Red Gift'];
  sm.pendingAmounts.set('red gift', 2);
  await sm.tick(); // claims, does not cancel-as-duplicate
  assert.equal(sm.driver.calls.claim.length, 1);
  assert.equal(sm.driver.calls.cancel.length, 0);
});

test('sell-fail guard: an unreachable sell page is benched after 3 tries, not retried forever', async () => {
  const drv = fakeDriver();
  drv.placeSell = async () => false; // its sell screen is a category — always aborts
  const sm = new StateMachine(makeConfig({ cookieRefreshEnabled: false }), fakeApi, drv);
  sm.pendingSells = ['Condensed Lily Pad'];
  sm.pendingAmounts.set('condensed lily pad', 5);
  const a1 = await sm.tick(); assert.match(a1, /sell-retry .*#1/);
  const a2 = await sm.tick(); assert.match(a2, /sell-retry .*#2/);
  const a3 = await sm.tick(); assert.match(a3, /give-up-sell/);
  assert.equal(sm.pendingSells.length, 0, 'dropped from the queue — no infinite loop');
  assert.ok(sm.blacklistUntil.has('condensed lily pad'), 'item benched');
});

test('stuck-claim guard: a buy that stays claimable (bag full) benches after 3, stops hammering', async () => {
  const drv = fakeDriver();
  drv.freeInventorySlots = () => 5;            // reports space, but the claim never clears
  drv.claim = async (o) => ({ kind: o.side, units: o.amount }); // "succeeds" yet tile persists
  const stuck = { side: 'buy', item: 'Birries Shard', amount: 900, filledPct: 100, price: 2000, claimable: true };
  const sm = new StateMachine(makeConfig({ cookieRefreshEnabled: false }), fakeApi, drv);
  drv.grid = [stuck];
  for (let i = 0; i < 3; i++) await sm.tick();  // 3 stuck "claims"
  const claimsBefore = drv.calls.claim.length;
  await sm.tick();                              // 4th: guard trips — no more claim clicks
  assert.equal(drv.calls.claim.length, claimsBefore, 'stopped clicking the stuck claim');
  assert.ok(sm.blacklistUntil.has('birries shard'), 'stuck item benched so it is not re-bought');
});

test('full inventory does not freeze the bot in an infinite buy-claim loop', async () => {
  // Reproduces the birries-shard freeze: a filled BUY order is "to claim" but the
  // bag is full, so the claim can never land. The old code re-hit the same tile
  // every tick forever. Now: the driver reports noSpace, step 1 stops hammering,
  // and control falls through to free space instead of looping.
  const drv = fakeDriver();
  drv.freeInventorySlots = () => 0; // bag full
  // Driver honours the guard: a buy claim with no space reports failure.
  drv.claim = async function (o) {
    this.calls.claim.push(o);
    if (o.side === 'buy' && this.freeInventorySlots() <= 0) return { kind: 'buy', units: 0, noSpace: true };
    return { kind: o.side, units: o.amount };
  };
  const stuck = { side: 'buy', item: 'Birries Shard', amount: 922, filledPct: 100, price: 2090, claimable: true };
  drv.grid = [stuck];
  const sm = new StateMachine(makeConfig({ cookieRefreshEnabled: false }), fakeApi, drv);

  const a1 = await sm.tick();
  const a2 = await sm.tick();
  // It must NOT report a phantom claim success, and must not be wedged on claim.
  assert.equal(sm.session.buysFilled, 0, 'no phantom buy claim was counted');
  assert.notEqual(a1, 'claim-buy Birries Shard', 'did not lock onto the unclaimable tile');
  assert.notEqual(a2, 'claim-buy Birries Shard', 'still not looping on the next tick');
  assert.ok(sm.inventoryFullSince != null, 'flagged the full-inventory condition');
});

test('a claimable SELL is still claimed even when the bag is full (coins need no slot)', async () => {
  const drv = fakeDriver();
  drv.freeInventorySlots = () => 0;
  const sell = { side: 'sell', item: 'Pest Shard', amount: 5, filledPct: 100, price: 68000, claimable: true };
  drv.grid = [sell];
  const sm = new StateMachine(makeConfig({ cookieRefreshEnabled: false }), fakeApi, drv);
  const action = await sm.tick();
  assert.equal(action, 'claim-sell Pest Shard', 'sell coins claimed despite the full bag');
  assert.equal(sm.session.sellsFilled, 1);
});

test('cookie refresh failure backs off instead of firing every tick', async () => {
  const drv = fakeDriver({ cookieOk: false });
  drv.cookieMs = 2 * 3_600_000; // 2h left — below the 24h threshold
  let clock = 1_000_000;
  const sm = new StateMachine(makeConfig({ cookieRefreshEnabled: true, cookieRetryMinutes: 30 }), fakeApi, drv, { now: () => clock });

  await sm.tick(); // attempt 1 → fails → back off
  assert.equal(drv.calls.refreshCookie, 1);
  await sm.tick(); // still in backoff → must NOT attempt again, trading proceeds
  assert.equal(drv.calls.refreshCookie, 1, 'no retry during backoff');

  clock += 31 * 60_000; // past the backoff window
  await sm.tick();
  assert.equal(drv.calls.refreshCookie, 2, 'retries after backoff elapses');
});

test('cookie backoff does not block trading (a failed refresh yields the tick, next tick trades)', async () => {
  const drv = fakeDriver({ cookieOk: false });
  drv.cookieMs = 1 * 3_600_000;
  let clock = 0;
  // one ranked candidate so step 5 would place a buy if reached
  const c = { tag: 'PEST_SHARD', displayName: 'Pest Shard', topBuyOrder: 100, lowestSellOffer: 130,
    buyWeekVolume: 5e6, sellWeekVolume: 5e6, volatility: 0.01, trend: 0,
    ourBuyPrice() { return 100.1; }, ourSellPrice() { return 129.9; },
    margin() { return 0.2; }, minWeeklyVolume() { return 5e6; }, hourlyVolume() { return 3e4; },
    buyLegHourly() { return 3e4; }, sellLegHourly() { return 3e4; } };
  const api = { candidates: [c], quote: () => null, filters: null, ageSeconds: () => 0 };
  const sm = new StateMachine(makeConfig({ cookieRefreshEnabled: true, cookieRetryMinutes: 30, apiMinMargin: 0.01, minOrderValue: 0, minProfitCoins: 0 }), api, drv, { now: () => clock });

  await sm.tick(); // cookie attempt fails, backs off
  assert.equal(drv.calls.refreshCookie, 1);
  await sm.tick(); // NOT blocked by cookie → reaches step 5 and buys
  assert.ok(drv.calls.placeBuy.length >= 1, 'trading proceeds while cookie is in backoff');
});
