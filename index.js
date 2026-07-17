#!/usr/bin/env node
// bzflipper-bot — headless Hypixel SkyBlock Bazaar flipper (Mineflayer).
//
// ⚠️  Automating the Bazaar breaks Hypixel's rules (Rule #4) and a HEADLESS bot is
//     the most detectable form. Use a THROWAWAY alt. OBSERVE mode (dryRun:true,
//     the default) only reads + ranks and places nothing — start there.

import { readFileSync } from 'node:fs';
import mineflayer from 'mineflayer';
import { BazaarApi } from './src/bazaarApi.js';
import { makeConfig } from './src/config.js';
import { rank } from './src/ranking.js';
import { StateMachine } from './src/stateMachine.js';
import { MineflayerDriver } from './src/mineflayerDriver.js';
import { scoreboardLines, tablistFooter, readWindow } from './src/gui.js';
import { startAntiAfk } from './src/antiAfk.js';

// ---- config ----
const cfgPath = process.argv[2] || './config.json';
let raw;
try {
  raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
} catch (e) {
  console.error(`Could not read ${cfgPath} — copy config.example.json to config.json and edit it.\n`, e.message);
  process.exit(1);
}
const cfg = makeConfig(raw.strategy ?? {});
const bot = {
  host: raw.host ?? 'mc.hypixel.net',
  port: raw.port ?? 25565,
  username: raw.username, // your Microsoft email
  auth: raw.auth ?? 'microsoft',
  // "auto" (or false) → let Mineflayer negotiate the version from the server ping.
  // DEFAULT 1.20.1: mineflayer breaks in the 1.20.2+ configuration phase on
  // Hypixel (mineflayer#3775); Hypixel accepts 1.20.1 clients via ViaVersion.
  version: (raw.version === 'auto' || raw.version === false) ? false : (raw.version ?? '1.20.1'),
  warpCommand: raw.warpCommand ?? 'skyblock',
  webhookUrl: raw.webhookUrl ?? '',
  webhookStatusMin: raw.webhookStatusMin ?? 30,
  logPackets: raw.logPackets === true,
  antiAfk: raw.antiAfk !== false, // default ON — long sessions get idle-kicked otherwise
  dryRun: raw.dryRun !== false, // default TRUE (observe only)
  observeIntervalSec: raw.observeIntervalSec ?? 15,
  startDelaySec: raw.startDelaySec ?? 8,
  viewer: raw.viewer === true,
  viewerPort: raw.viewerPort ?? 3007,
  debugDump: raw.debugDump === true,
};

const fmt = (v) => {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v.toFixed(0);
};

// Discord-compatible webhook notifier (MBF-style alerts). No-op if no URL set.
async function notify(content) {
  if (!bot.webhookUrl) return;
  try {
    await fetch(bot.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: String(content).slice(0, 1900) }),
    });
  } catch { /* alerts are best-effort */ }
}

console.log(`bzflipper-bot — ${bot.dryRun ? 'OBSERVE (dry run — no orders)' : '\x1b[31mLIVE TRADING\x1b[0m'} — ${bot.host} as ${bot.username}`);

// ---- connect ----
let attempts = 0;
function start() {
  attempts++;
  console.log(`connecting (attempt ${attempts}) — version ${bot.version || 'auto'} …`);
  let mc;
  try {
    mc = mineflayer.createBot({
      host: bot.host, port: bot.port, username: bot.username, auth: bot.auth, version: bot.version,
      // WORKAROUND (mineflayer#3623/#3775): physics packets sent during the
      // configuration phase make some servers (Hypixel) drop the connection
      // right after [login] success. Keep physics off until spawn.
      physicsEnabled: false,
      // Surface the Microsoft device-code sign-in clearly (first run / expired token).
      onMsaCode: (data) => {
        console.log('\n\x1b[33m🔑 SIGN IN:\x1b[0m open \x1b[36m' + (data.verification_uri || 'https://microsoft.com/link') +
          '\x1b[0m and enter code \x1b[36m' + data.user_code + '\x1b[0m  (as ' + bot.username + ')\n');
        notify(`🔑 Sign-in needed: open ${data.verification_uri} code \`${data.user_code}\``);
      },
    });
  } catch (e) {
    console.log('\x1b[31mcreateBot failed:\x1b[0m', e.message);
    console.log('  → your installed mineflayer may not know this version. Try: npm i mineflayer@latest minecraft-data@latest');
    setTimeout(start, 15_000);
    return;
  }

  // WORKAROUND (mineflayer#3623): mineflayer may not send client_information
  // ("settings") + brand during the CONFIGURATION phase; Hypixel disconnects
  // clients that stay silent there. Send both ourselves the moment we enter
  // the configuration state. Extra/unknown fields are tolerated per-protocol;
  // failures are logged but non-fatal (the upstream fix supersedes this).
  mc._client?.on('state', (newState) => {
    if (newState !== 'configuration') return;
    try {
      mc._client.write('brand', { channel: 'minecraft:brand', data: Buffer.from('\x07vanilla', 'latin1') });
    } catch { /* some protocol builds name it custom_payload */
      try { mc._client.write('custom_payload', { channel: 'minecraft:brand', data: Buffer.from('\x07vanilla', 'latin1') }); } catch {}
    }
    try {
      mc._client.write('settings', {
        locale: 'en_US',
        viewDistance: 8,
        chatFlags: 0,
        chatColors: true,
        skinParts: 127,
        mainHand: 1,
        enableTextFiltering: false,
        enableServerListing: true,
        particleStatus: 0,
        particles: 0,
      });
      console.log('  >> [configuration] settings + brand sent (hypixel workaround)');
    } catch (e) {
      console.log('  >> [configuration] settings write failed:', e.message);
    }
  });

  // Deep diagnostics: see exactly how far the handshake gets and the raw errors.
  let loginSucceeded = false, reachedConfig = false, packetCount = 0;
  mc._client?.on('error', (e) => console.log('  client error:', e.code || '', e.message));
  mc._client?.on('packet', (data, meta) => {
    if (meta.state === 'login' && meta.name === 'success') loginSucceeded = true;
    if (meta.state === 'configuration') reachedConfig = true;
    if (bot.logPackets && packetCount < 40) {
      packetCount++;
      console.log(`  << [${meta.state}] ${meta.name}` + (meta.name === 'disconnect' ? ' :: ' + JSON.stringify(data).slice(0, 300) : ''));
    }
  });
  const api = new BazaarApi(cfg);
  const driver = new MineflayerDriver(mc, cfg, { log: (m) => console.log(m) });
  const sm = new StateMachine(cfg, api, driver);
  let running = false;

  mc.on('login', () => { attempts = 0; console.log('✅ logged in — loading SkyBlock…'); });
  mc.on('kicked', (reason) => {
    const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
    console.log('kicked:', r);
    notify('⛔ kicked: ' + r.slice(0, 300));
  });
  mc.on('error', (err) => console.log('error:', err.message));
  mc.on('end', (why) => {
    running = false;
    const delay = Math.min(60, 15 * Math.min(attempts, 4));
    console.log(`disconnected: ${why} — reconnecting in ${delay}s`);
    // Diagnose by HOW FAR we got.
    if (why === 'socketClosed' && loginSucceeded && !reachedConfig) {
      // KNOWN MINEFLAYER BUG (#3775): on protocols >1.20.1 the client dies
      // silently in the login→configuration handoff. Telltale: the account
      // lingers ONLINE on Hypixel after we "disconnect" — the server is still
      // waiting for our acknowledgement; nobody kicked us, our side died.
      console.log('  ⚠ mineflayer bug #3775: versions >1.20.1 break in the configuration handoff on Hypixel.');
      console.log('    FIX: set "version": "1.20.1" in config.json — Hypixel translates old client');
      console.log('    versions server-side (ViaVersion); the Bazaar works identically.');
    } else if (why === 'socketClosed' && attempts >= 2) {
      console.log('  ⚠ socketClosed before login success — refused at handshake (version/IP/anti-bot).');
    }
    if (attempts === 1) notify('⚠️ disconnected: ' + why);
    setTimeout(start, delay * 1000);
  });

  mc.once('spawn', async () => {
    mc.physicsEnabled = true;   // physics stayed off through configuration (see workaround)
    if (bot.viewer) await startViewer(mc);
    if (bot.antiAfk) {
      startAntiAfk(mc, { log: bot.logPackets ? console.log : () => {} });
      console.log('anti-afk: on (gentle randomized nudges every 2–4 min)');
    }
    console.log(`spawned. warping to SkyBlock via /${bot.warpCommand} in ${bot.startDelaySec}s…`);
    await mc.waitForTicks(bot.startDelaySec * 20);
    mc.chat('/' + bot.warpCommand);
    await mc.waitForTicks(bot.startDelaySec * 20);
    if (!scoreboardLines(mc).join(' ').includes('skyblock')) {
      console.log('⚠ SkyBlock sidebar not detected yet — continuing anyway (check /warp).');
    }
    running = true;
    notify(`✅ ${bot.username} on SkyBlock — ${bot.dryRun ? 'OBSERVE' : 'LIVE'} mode`);
    bot.dryRun ? observeLoop(mc, api, driver, cfg, () => running) : liveLoop(sm, api, cfg, () => running);
  });
}

// ---- OBSERVE: read + rank + print, place nothing ----
async function observeLoop(mc, api, driver, cfg, alive) {
  let lastWebhook = 0;
  while (alive()) {
    try {
      await api.refresh();
      const purse = driver.readPurse();
      const cookie = driver.readCookieRemainMs();
      await driver.openBook();
      const grid = driver.readOrders();
      const rows = rank(api.candidates, cfg).slice(0, 12);

      console.log(`\n── ${new Date().toISOString().slice(11, 19)} · purse ${fmt(purse)} · cookie ${cookie < 0 ? '?' : Math.round(cookie / 36e5) + 'h'} · api ${api.ageSeconds()}s · orders ${grid.length}`);
      console.log('  TOP FLIPS (coins/hr):');
      rows.forEach((r, i) =>
        console.log(`   ${String(i + 1).padStart(2)}. ${r.candidate.displayName.padEnd(26)} ${fmt(r.cph).padStart(9)}/hr  m${(r.candidate.margin(cfg.taxFraction) * 100).toFixed(1)}%  vel ${fmt(r.velocity)}u/hr`));
      if (grid.length) {
        console.log('  OPEN ORDERS:');
        grid.forEach((o) => console.log(`   ${o.side.toUpperCase().padEnd(4)} ${o.item.padEnd(24)} ${fmt(o.price)} × ${o.amount}  ${o.filledPct.toFixed(0)}%${o.claimable ? ' [claim]' : ''}`));
      }
      // Periodic webhook status (MBF-style). Interval in config (webhookStatusMin).
      if (bot.webhookUrl && Date.now() - lastWebhook > bot.webhookStatusMin * 60_000) {
        lastWebhook = Date.now();
        const t = rows[0];
        notify(`📊 purse ${fmt(purse)} · ${grid.length} orders · top: ${t ? t.candidate.displayName + ' ' + fmt(t.cph) + '/hr' : '—'}`);
      }
      // Raw GUI dump for remote debugging: paste this if a read looks wrong, so the
      // Hypixel string anchors (the `S` table) can be corrected against reality.
      if (bot.debugDump) {
        console.log('  --- DEBUG: scoreboard sidebar ---');
        scoreboardLines(mc).forEach((l) => console.log('   | ' + l));
        console.log('  --- DEBUG: tablist footer ---');
        console.log('   | ' + tablistFooter(mc).replace(/\n/g, '\n   | '));
        console.log('  --- DEBUG: open window slots (name — lore[0..2]) ---');
        readWindow(mc.currentWindow).slice(0, 30).forEach((r) =>
          console.log(`   [${r.slot}] "${r.name}"  ::  ${r.lore.slice(0, 3).join(' | ')}`));
      }
    } catch (e) {
      console.log('observe error:', e.message);
    }
    await sleep(bot.observeIntervalSec * 1000);
  }
}

// ---- LIVE: run the state machine (real orders) ----
async function liveLoop(sm, api, cfg, alive) {
  console.log('\x1b[31mLIVE trading — the state machine will place real orders. Ctrl-C to stop.\x1b[0m');
  // Keep the API fresh on its own cadence.
  const refresh = async () => { try { await api.refresh(); } catch (e) { console.log('api:', e.message); } };
  await refresh();
  setInterval(refresh, Math.max(10, cfg.apiRefreshSeconds ?? 20) * 1000);
  while (alive()) {
    try {
      const action = await sm.tick();
      if (action && action !== 'idle') console.log(`[live] ${action}  · session ${fmt(sm.session.profit)} (${sm.session.flips} flips)`);
    } catch (e) {
      console.log('tick error:', e.message);
    }
    await sleep(((cfg.actionDelayTicks ?? 3) / 20) * 1000 + 250);
  }
}

// ---- prismarine-viewer: watch the bot in a browser during bring-up ----
async function startViewer(mc) {
  try {
    const pv = (await import('prismarine-viewer')).default;
    pv.mineflayer(mc, { port: bot.viewerPort, firstPerson: false });
    console.log(`\x1b[36mviewer: http://localhost:${bot.viewerPort}\x1b[0m  (remote box? tunnel: ssh -L ${bot.viewerPort}:localhost:${bot.viewerPort} user@host)`);
  } catch (e) {
    console.log('viewer failed to start (npm i prismarine-viewer?):', e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
start();
