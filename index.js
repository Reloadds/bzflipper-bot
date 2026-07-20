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
import { scoreboardLines, tablistFooter, readWindow, onSkyblock, onIsland, scoreboardTitle } from './src/gui.js';
import { startHumanize } from './src/humanize.js';

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
  // Direct 1.21.11 works now — the configuration-phase fixes below (settings
  // packet, resource pack, transfer write-guard) handle what used to kill it.
  // "auto" (or false) lets Mineflayer negotiate from the server ping.
  version: (raw.version === 'auto' || raw.version === false) ? false : (raw.version ?? '1.21.11'),
  warpCommand: raw.warpCommand ?? 'skyblock',
  islandCommand: raw.islandCommand ?? 'is',
  humanize: raw.humanize !== false, // default ON — natural idle presence
  webhookUrl: raw.webhookUrl ?? '',
  webhookStatusMin: raw.webhookStatusMin ?? 30,
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
let everSpawned = false; // once true, disconnects are real drops worth reconnecting
function start() {
  attempts++;
  console.log(`connecting (attempt ${attempts}) — version ${bot.version || 'auto'} …`);
  let mc;
  try {
    mc = mineflayer.createBot({
      host: bot.host, port: bot.port, username: bot.username, auth: bot.auth, version: bot.version,
      // Hypixel sends particle packets that don't match the vanilla schema; each
      // MC packet is length-framed, so a failed parse drops only that packet and
      // the connection is fine. hideErrors silences the flood (maps to
      // node-minecraft-protocol's deserializer noErrorLogging). Our error/kicked/
      // end handlers still fire — those are the meaningful signals.
      hideErrors: true,
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

  // Workaround for https://github.com/PrismarineJS/mineflayer/issues/3623:
  // Hypixel silently drops ("socketClosed") clients that never send the
  // client-information packet during the 1.20.2+ configuration phase.
  // Vanilla sends it there; node-minecraft-protocol only sends it in the
  // play phase (upstream fix: PrismarineJS/node-minecraft-protocol#1499,
  // not yet released). Remove this once that PR ships and deps are updated.
  // Fields match minecraft-data's packet_common_settings for 1.21.11 and
  // serialize cleanly (verified offline). 'state' not 'once': the server may
  // re-enter configuration on a lobby/world transfer, and the packet is idempotent.
  mc._client.on('state', (newState) => {
    if (newState === 'configuration') {
      mc._client.write('settings', {
        locale: 'en_US',
        viewDistance: 8,
        chatFlags: 0,
        chatColors: true,
        skinParts: 0x7f,
        mainHand: 1,
        enableTextFiltering: false,
        enableServerListing: true,
        particleStatus: 'all',
      });
      console.log('  >> [configuration] client settings sent (mineflayer#3623 workaround)');
    }
  });

  // GUARD: when Hypixel re-enters configuration mid-session (server transfer into
  // SkyBlock), mineflayer keeps ticking physics and tries to send play-state
  // packets like `position`. The configuration serializer doesn't reject them —
  // it silently emits packet id 0x00 with an EMPTY body, and 0x00 in configuration
  // is the client-settings packet. Hypixel gets a malformed settings packet and
  // closes the socket (this was the real socketClosed during /play skyblock).
  // Only these packets are legal during configuration on 1.21.11 — drop the rest.
  // The same wrapper doubles as a black-box tape: the last 40 packets in both
  // directions (plus state changes) are dumped whenever the connection dies,
  // which is the technique that isolated all three socketClosed causes.
  const tape = [];
  const record = (line) => { tape.push(line); if (tape.length > 40) tape.shift(); };
  {
    const CONFIG_PACKETS = new Set([
      'settings', 'cookie_response', 'custom_payload', 'finish_configuration',
      'keep_alive', 'pong', 'resource_pack_receive', 'select_known_packs',
      'custom_click_action', 'accept_code_of_conduct',
    ]);
    const origWrite = mc._client.write.bind(mc._client);
    mc._client.write = (name, params) => {
      if (mc._client.state === 'configuration' && !CONFIG_PACKETS.has(name)) {
        record(`xx blocked [configuration] ${name} (play packet during transfer)`);
        return;
      }
      record(`>> [${mc._client.state}] ${name}`);
      return origWrite(name, params);
    };
  }
  mc._client.on('packet', (data, meta) => {
    const extra = /disconnect|kick|transfer|resource|start_configuration/.test(meta.name)
      ? ' :: ' + JSON.stringify(data).slice(0, 300) : '';
    record(`<< [${meta.state}] ${meta.name}${extra}`);
  });
  mc._client.on('state', (ns, os) => record(`== state ${os} -> ${ns}`));

  // Hypixel pushes a REQUIRED resource pack when transferring you into SkyBlock
  // (SkyBlock 0.26, July 2026). Never answering = silent socketClosed mid-transfer.
  // Do NOT use mc.acceptResourcePack(): mineflayer's plugin wraps the pack UUID in
  // a uuid-1345 object, which the 1.21.11 serializer silently writes as 16 ZERO
  // bytes — Hypixel sees us accept a pack it never sent and drops us. Answer the
  // raw packet with the UUID string from the push, echoing the vanilla status
  // sequence: 3=accepted, 4=downloaded, 0=successfully loaded.
  const acceptPack = (data) => {
    console.log(`  >> resource pack ${data.uuid} pushed by server — accepting`);
    for (const result of [3, 4, 0]) {
      mc._client.write('resource_pack_receive', { uuid: data.uuid, result });
    }
  };
  mc._client.on('add_resource_pack', acceptPack);
  mc._client.on('resource_pack_send', acceptPack);

  // mineflayer's scoreboard plugin predates 1.20.3: `scoreboard_score` no longer
  // carries an `action` field (removals moved to the separate `reset_score`
  // packet, which the plugin never listens for), so its `action === 0` check
  // silently drops every sidebar line — title populates, items stay empty.
  // Feed both packets into the plugin's own ScoreBoard objects ourselves.
  mc._client.on('scoreboard_score', (p) => {
    if (p.action !== undefined) return; // pre-1.20.3 protocol — plugin handled it
    mc.scoreboards[p.scoreName]?.add(p.itemName, p.value);
  });
  mc._client.on('reset_score', (p) => {
    if (p.objective_name != null) { mc.scoreboards[p.objective_name]?.remove(p.entity_name); return; }
    for (const sb of Object.values(mc.scoreboards)) sb.remove(p.entity_name);
  });

  const api = new BazaarApi(cfg);
  const driver = new MineflayerDriver(mc, cfg, { log: (m) => console.log(m) });
  const sm = new StateMachine(cfg, api, driver);
  let running = false;

  mc.on('login', () => { attempts = 0; console.log('✅ logged in — loading SkyBlock…'); });
  // Hypixel explains every lobby-kick / forced transfer in chat ("A kick
  // occurred…", "You are sending commands too fast!", Watchdog warnings).
  // Log all chat so those reasons are visible instead of a silent transfer.
  mc.on('messagestr', (msg, position) => {
    if (position === 'game_info') return; // action-bar spam (health etc.)
    const m = msg.replace(/\s+/g, ' ').trim();
    if (m) console.log(`  [chat] ${m.slice(0, 200)}`);
  });
  mc.on('kicked', (reason) => {
    const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
    console.log('kicked:', r);
    notify('⛔ kicked: ' + r.slice(0, 300));
  });
  mc.on('error', (err) => console.log('error:', err.message));
  mc.on('end', (why) => {
    running = false;

    // Reconnect with a sane floor (attempts resets to 0 on login, so don't let
    // the backoff collapse to 0s and hammer Hypixel).
    const delay = Math.max(8, Math.min(60, 15 * Math.min(attempts, 4)));
    console.log(`disconnected: ${why} — reconnecting in ${delay}s`);
    console.log('  ---- last packets before close ----');
    tape.forEach((l) => console.log('  ' + l));
    console.log('  -----------------------------------');
    if (attempts <= 1) notify('⚠️ disconnected: ' + why);
    setTimeout(start, delay * 1000);
  });

  mc.once('spawn', async () => {
    everSpawned = true;         // we made it into the world — real drops now reconnect
    mc.physicsEnabled = true;   // normal client physics. Standing still is NOT what
                                // triggers the "badly behaving modifications" kick —
                                // automated Bazaar-MENU CLICKING is (see driver).
    console.log('✅ spawned in-world. Heading to SkyBlock…');
    if (bot.viewer) await startViewer(mc);

    await joinSkyblockIsland(mc);

    // Optional idle head-look presence (rotation packets only — never flagged).
    if (bot.humanize) {
      startHumanize(mc, { log: bot.debugDump ? console.log : () => {} });
      console.log('humanize: on (idle head-look only, no body movement)');
    }

    running = true;
    notify(`✅ ${bot.username} on SkyBlock island — ${bot.dryRun ? 'OBSERVE' : 'LIVE'} mode`);
    bot.dryRun ? observeLoop(mc, api, driver, cfg, () => running) : liveLoop(sm, api, cfg, () => running);
  });
}

// ---- Limbo → SkyBlock → private island ----
// Instrumented: logs the scoreboard state at each step so we can SEE where the
// bot is (Limbo / Main Lobby / SkyBlock) and why a warp didn't land. Hypixel
// routes sub-servers internally (fires fresh login/spawn), so we read the LIVE
// scoreboard each pass and adapt instead of blindly spamming.
async function joinSkyblockIsland(mc) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // The 6s waits below outlive a disconnect: without this guard the loop keeps
  // chatting into a dead connection, and after a reconnect TWO loops run
  // interleaved, double-spamming /play skyblock.
  let live = true;
  mc.once('end', () => { live = false; });
  const state = () => {
    const t = scoreboardTitle(mc);
    const lines = scoreboardLines(mc);
    const joined = (t + ' ' + lines.join(' '));
    let where = 'unknown';
    if (onIsland(mc)) where = 'ISLAND';
    else if (onSkyblock(mc)) where = 'SKYBLOCK(hub)';
    else if (joined.includes('limbo')) where = 'LIMBO';
    else if (joined.includes('lobby') || t.includes('hypixel')) where = 'LOBBY';
    return { where, t, lines };
  };
  const dump = (tag) => {
    const s = state();
    console.log(`  [nav ${tag}] where=${s.where} title="${s.t}" lines=[${s.lines.slice(0, 5).join(' | ')}]`);
    return s.where;
  };

  for (let i = 0; i < 10; i++) {
    if (!live) { console.log('  [nav] connection ended — aborting navigation.'); return; }
    const where = dump(`step${i}`);
    if (where === 'ISLAND') { console.log('🏝️  on your island.'); return; }
    if (where === 'SKYBLOCK(hub)') { console.log('  → /is'); mc.chat('/is'); await wait(6000); continue; }
    // Not on SkyBlock yet. From Limbo we must reach a real server first; /play
    // skyblock is the canonical warp and works from Limbo and lobbies.
    console.log('  → /play skyblock');
    mc.chat('/play skyblock');
    await wait(6000);
  }
  console.log('⚠ could not reach the island — the [nav] lines above show where it got stuck.');
}

// ---- OBSERVE: read + rank + print, place nothing ----
async function observeLoop(mc, api, driver, cfg, alive) {
  let lastWebhook = 0;
  while (alive()) {
    try {
      // Hypixel sometimes bounces the bot to a lobby (kick-to-lobby, server
      // restart). Detect it and walk back to the island instead of running
      // /bz where it doesn't exist.
      if (!onSkyblock(mc)) {
        console.log('  ⚠ not on SkyBlock anymore — re-navigating…');
        await joinSkyblockIsland(mc);
        await sleep(2000);
        continue;
      }
      await api.refresh();
      const purse = driver.readPurse();
      const cookie = driver.readCookieRemainMs();
      // Reading your OPEN ORDERS requires opening + CLICKING the Bazaar menu, and
      // Hypixel's anti-cheat flags automated menu clicks as "badly behaving
      // modifications" (kick-to-lobby). Observe mode is read-only by design, so
      // by default it does ZERO clicking: purse comes from the scoreboard, cookie
      // from the tab list, prices from the public API — no GUI touched, nothing
      // to flag. Set "readOrdersGui": true only if you want the live open-orders
      // grid too and accept that click risk; even then we human-pace and close.
      let grid = [];
      if (bot.readOrdersGui) {
        await driver.openBook();
        grid = driver.readOrders();
        await driver.closeBook();
      }
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
