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
import { scoreboardLines, tablistFooter, readWindow, onSkyblock, onIsland, scoreboardTitle, componentText, onceWindow, findSlot } from './src/gui.js';
import { startHumanize } from './src/humanize.js';

// ---- config ----
// First non-flag arg is the config path; flags like --probe are handled separately
// so `node index.js --probe` still reads ./config.json.
const cliArgs = process.argv.slice(2);
const cfgPath = cliArgs.find((a) => !a.startsWith('--')) || './config.json';
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
  // OBSERVE mode: open + read your live open-orders grid (needs GUI clicks). Off
  // by default; the desync (not clicking) was the ban risk, but keep reads minimal.
  readOrdersGui: raw.readOrdersGui === true,
  // Never volunteer our own position — defer to the server (fixes the 1.21.11
  // chunk-desync Watchdog kick). Default ON; set false only to debug movement.
  serverAuthoritativePosition: raw.serverAuthoritativePosition !== false,
  // One-shot: on reaching the island, open the Bazaar and dump the real GUI
  // structure (titles/slots/lore) so the S-table string anchors can be verified.
  // Enable via config ("guiProbe": true) OR the `--probe` CLI flag (no JSON edit).
  guiProbe: raw.guiProbe === true || cliArgs.includes('--probe'),
  // Item the probe clicks into for the buy/sell interface. MUST be a
  // guaranteed-tradeable item (no skill lock) — the top-ranked flip can be
  // locked/seasonal (e.g. essences need Catacombs 20), which blocks the details
  // page. Enchanted Cobblestone has no requirement. Override with "probeItem".
  probeItem: raw.probeItem ?? 'Enchanted Cobblestone',
  // `--place-test`: walk the full buy flow once on probeItem to verify the sign
  // input + capture the Confirm screen. DISARMED by default (stops at Confirm,
  // places nothing). `--confirm` ARMS it → places ONE tiny resting order you must
  // cancel. Throwaway-alt only.
  placeTest: cliArgs.includes('--place-test'),
  placeConfirm: cliArgs.includes('--confirm'),
  // `--cancel-test`: read your open orders (verifies readOrders against a real
  // order) and dump the Order Options menu. DISARMED stops there; `--confirm`
  // arms it to actually cancel the first order (cleans up the place-test order).
  cancelTest: cliArgs.includes('--cancel-test'),
  // True when any one-shot diagnostic is requested: run only it, then exit, and
  // mute routine chat/position spam so the diagnostic block is clean to paste.
  get oneShot() { return this.guiProbe || this.placeTest || this.cancelTest; },
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
  // Rolling black-box tape. Collapses consecutive identical lines to a count so
  // the ~1/sec `position` stream doesn't drown out the interesting packets, and
  // keeps ~200 entries so a full minute of idle traffic before a Watchdog flag
  // is visible.
  const tape = [];
  const record = (line) => {
    const last = tape[tape.length - 1];
    if (last && last.line === line) { last.n++; return; }
    tape.push({ line, n: 1 });
    if (tape.length > 200) tape.shift();
  };
  const dumpTape = (title) => {
    console.log(`  ---- ${title} ----`);
    for (const e of tape) console.log('  ' + e.line + (e.n > 1 ? `  ×${e.n}` : ''));
    console.log('  -----------------------------------');
  };
  {
    const CONFIG_PACKETS = new Set([
      'settings', 'cookie_response', 'custom_payload', 'finish_configuration',
      'keep_alive', 'pong', 'resource_pack_receive', 'select_known_packs',
      'custom_click_action', 'accept_code_of_conduct',
    ]);
    const MOVE = new Set(['position', 'look', 'position_look', 'flying']);
    // Server-authoritative position (fix for the position-desync Watchdog flag).
    // The tape showed the server sending us a `position` setback while we keep
    // asserting a phantom {7.5,100,7.5} onGround:true — mineflayer's physics isn't
    // tracking the real world, so our self-reported position diverges from the
    // server and the movement anti-cheat rejects it. This bot never moves (it
    // stands and drives GUIs), so we simply STOP asserting our own position: drop
    // the periodic idle movement packets and let the server own our location.
    // We KEEP `teleport_confirm` (acks server teleports) and `position_look` (the
    // forced echo mineflayer sends right after a teleport) so the teleport
    // handshake still completes — we just never volunteer a drifting position.
    const SUPPRESS = new Set(['position', 'look', 'flying']);
    const origWrite = mc._client.write.bind(mc._client);
    mc._client.write = (name, params) => {
      if (mc._client.state === 'configuration' && !CONFIG_PACKETS.has(name)) {
        record(`xx blocked [configuration] ${name} (play packet during transfer)`);
        return;
      }
      if (bot.serverAuthoritativePosition !== false && mc._client.state === 'play' && SUPPRESS.has(name)) {
        record(`xx suppressed ${name} ${JSON.stringify(params)} (server-authoritative)`);
        return;
      }
      // For movement packets, record the actual payload so we can inspect it for
      // malformation (bad flags, wrong onGround, NaN coords) — this is exactly the
      // idle traffic Hypixel may be flagging. Identical idle packets collapse.
      record(MOVE.has(name)
        ? `>> [${mc._client.state}] ${name} ${JSON.stringify(params)}`
        : `>> [${mc._client.state}] ${name}`);
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
  //
  // TIMING MATTERS. Packet instrumentation proved every runtime packet we send is
  // vanilla-normal (valid position at vanilla idle-rate, correct pong/keep_alive,
  // "vanilla" brand) — so the "badly behaving modifications" kick is NOT movement.
  // The one non-vanilla thing left was firing 3→4→0 in the SAME millisecond: a
  // client that "downloads + loads" a pack in 0ms is a textbook cheat-client tell.
  // Stage the responses over a realistic download interval so it looks like a real
  // client fetching + applying the pack, not an instant bypass.
  const acceptPack = async (data) => {
    console.log(`  >> resource pack ${data.uuid} pushed by server — accepting (staged, realistic timing)`);
    const send = (result) => {
      try { mc._client.write('resource_pack_receive', { uuid: data.uuid, result }); }
      catch (e) { console.log('  resource_pack_receive failed:', e.message); }
    };
    send(3);                                            // accepted — immediately (clicked "yes")
    await sleep(1500 + Math.floor(Math.random() * 1500)); // ~1.5–3s "downloading…"
    send(4);                                            // downloaded
    await sleep(400 + Math.floor(Math.random() * 500));   // ~0.4–0.9s "applying…"
    send(0);                                            // successfully loaded
    console.log(`  >> resource pack ${data.uuid} accept sequence complete (loaded)`);
  };
  mc._client.on('add_resource_pack', acceptPack);
  mc._client.on('resource_pack_send', acceptPack);

  // DIAG: position-desync detector. Log every server-sent position (a teleport or
  // anti-cheat SETBACK) with coordinates + relative-flags, so we can see how far
  // the server thinks we are from the {7.5,100,7.5} we keep claiming. A big
  // absolute jump = real setback = confirmed desync driving the Watchdog flag.
  mc._client.on('position', (p) => {
    if (!bot.debugDump || bot.oneShot) return;
    const flags = typeof p.flags === 'object' ? p.flags : { bitmask: p.flags };
    console.log(`  [SRV-POS] server placed us at x=${p.x} y=${p.y} z=${p.z} yaw=${p.yaw} pitch=${p.pitch} flags=${JSON.stringify(flags)}`);
  });

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
    // In one-shot diagnostic mode, mute routine chat (lobby joins, announcements,
    // welcome spam) so the diagnostic block is clean — keep only kicks/warnings.
    const important = /detected badly behaving|a kick occurred|you must have|too fast|cannot join/i.test(m);
    if (m && (!bot.oneShot || important)) console.log(`  [chat] ${m.slice(0, 200)}`);
    // The "badly behaving modifications" kick is a chat message + server transfer,
    // NOT a socket close — so the normal end-of-connection tape dump never fires
    // for it. Dump the tape the instant Hypixel flags US. Match the exact kick
    // phrasing only — NOT the server-wide "[WATCHDOG ANNOUNCEMENT] … Blacklisted
    // modifications are a bannable offense!" broadcast, which is not a kick.
    if (/detected badly behaving modifications|a kick occurred in your connection/i.test(m)) {
      dumpTape('PACKETS BEFORE WATCHDOG FLAG (paste this)');
    }
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
    dumpTape('last packets before close');
    if (attempts <= 1) notify('⚠️ disconnected: ' + why);
    setTimeout(start, delay * 1000);
  });

  mc.once('spawn', async () => {
    everSpawned = true;         // we made it into the world — real drops now reconnect
    mc.physicsEnabled = true;   // physics stays on, but serverAuthoritativePosition
                                // drops our outgoing position packets — the 1.21.11
                                // chunk-desync (loadedColumns=0) made our self-reported
                                // onGround invalid and got us Watchdog-kicked.
    console.log('✅ spawned in-world. Heading to SkyBlock…');
    if (bot.viewer) await startViewer(mc);

    await joinSkyblockIsland(mc);

    // DIAG: is the world actually loaded under us? If blockAt is NULL the island
    // chunk never parsed on 1.21.11 → mineflayer physics is frozen → we hover at a
    // phantom position the server rejects. If there's air (not solid) below us,
    // we're floating and the server sees a fly hack. This one line tells us which.
    if (bot.debugDump && !bot.oneShot) setTimeout(() => {
      const e = mc.entity; if (!e) return;
      const at = mc.blockAt(e.position);
      const below = mc.blockAt(e.position.offset(0, -1, 0));
      const cols = Object.keys(mc.world?.columns || mc._chunkColumns || {}).length;
      console.log(`  [WORLD] pos=${e.position.x.toFixed(2)},${e.position.y.toFixed(2)},${e.position.z.toFixed(2)} onGround=${e.onGround} blockAt=${at ? at.name : 'NULL (chunk not loaded)'} below=${below ? below.name : 'NULL'} loadedColumns=${cols}`);
    }, 6000);

    // One-shot GUI probe: dump the real Bazaar menu structure so the S-table
    // string anchors (mineflayerDriver.js) can be verified before live trading.
    if (bot.guiProbe) {
      try { await probeBazaarGui(mc, api, cfg); }
      catch (e) { console.log('  [PROBE] error:', e.message); }
    }
    // One-shot live write-path test (verifies sign input + Confirm screen).
    if (bot.placeTest) {
      try { await placeTest(mc, api, cfg, driver, bot.placeConfirm); }
      catch (e) { console.log('  [PLACE-TEST] error:', e.message); }
    }
    // One-shot read+cancel test (verifies readOrders + the Order Options / cancel).
    if (bot.cancelTest) {
      try { await cancelTest(mc, cfg, driver, bot.placeConfirm); }
      catch (e) { console.log('  [CANCEL-TEST] error:', e.message); }
    }
    // One-shot flags run their diagnostic and quit — no observe-loop spam after,
    // so the block above is the clean tail of the output, easy to copy.
    if (bot.oneShot) {
      console.log('\n(one-shot diagnostic done — exiting. Remove the flag to run OBSERVE/LIVE.)');
      await sleep(300);
      process.exit(0);
    }

    // Idle head-look presence only makes sense when we actually send rotation
    // packets. With serverAuthoritativePosition on, `look` is suppressed, so
    // humanize would be a no-op — skip it.
    if (bot.humanize && !bot.serverAuthoritativePosition) {
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

// ---- GUI PROBE: dump the real Bazaar menu structure (verify S-table anchors) ----
// One-shot diagnostic. Opens the main Bazaar, a product page for the current top
// flip, and the Manage Orders grid, printing each window's title + every slot
// (name + lore). This is the ground truth for tuning the Hypixel strings in
// mineflayerDriver.js before the write path can work. Read-only: it only opens
// menus and closes them, places nothing.
async function probeBazaarGui(mc, api, cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dumpWin = (label) => {
    const w = mc.currentWindow;
    if (!w) { console.log(`  [PROBE] ${label}: (no window open)`); return null; }
    const title = componentText(w.title) || '(untitled)';
    const rows = readWindow(w);
    console.log(`\n  [PROBE] ===== ${label} =====`);
    console.log(`  [PROBE] title="${title}"  totalSlots=${w.slots.length}  chestSlots=${w.inventoryStart ?? '?'}`);
    for (const r of rows) {
      console.log(`    [${String(r.slot).padStart(2)}] "${r.name}"`);
      for (const l of r.lore.slice(0, 6)) if (l) console.log(`         · ${l}`);
    }
    return w;
  };
  const closeWin = async () => {
    try { if (mc.currentWindow) await mc.closeWindow(mc.currentWindow); } catch { /* ignore */ }
    await sleep(700);
  };
  const openCmd = async (cmd, label) => {
    await closeWin();
    mc.chat('/' + cmd);
    await onceWindow(mc, 4500);
    await sleep(800); // let Hypixel populate the slots
    return dumpWin(label);
  };

  console.log('\n========== BAZAAR GUI PROBE ==========');

  // 1) Main Bazaar browser.
  await openCmd('bz', '/bz  (main Bazaar)');

  // 2) Product for the current top-ranked flip. `/bz <item>` opens a SEARCH view;
  // the product itself is a slot inside it ("click to view details!"), so we click
  // into it to reach the details page (Buy Order / Sell Offer), then peek the Buy
  // Order setup (amount/price). We NEVER click Confirm — this places nothing.
  const itemName = bot.probeItem; // guaranteed-tradeable (see config parsing)
  if (itemName) {
    const search = await openCmd('bz ' + itemName, `/bz ${itemName}  (search result)`);
    const pslot = search ? findSlot(search, itemName.toLowerCase()) : -1;
    if (pslot >= 0) {
      console.log(`  [PROBE] product "${itemName}" at slot ${pslot} — clicking "view details"`);
      await mc.clickWindow(pslot, 0, 0);
      await onceWindow(mc, 4500); await sleep(900);
      const details = dumpWin(`${itemName} — PRODUCT DETAILS (buy order / sell offer)`);

      const bslot = details ? findSlot(details, 'create buy order') : -1;
      if (bslot >= 0) {
        console.log(`  [PROBE] "create buy order" at slot ${bslot} — opening amount setup (will NOT confirm)`);
        await mc.clickWindow(bslot, 0, 0);
        await onceWindow(mc, 4500); await sleep(900);
        const setup = dumpWin('BUY ORDER amount setup ("how many do you want?")');
        // One level deeper to the PRICE screen. Picking a preset amount places
        // NOTHING — a buy order exists only after a final Confirm we never click.
        const aslot = setup ? findSlot(setup, 'buy a stack') : -1;
        if (aslot >= 0) {
          console.log(`  [PROBE] "buy a stack!" at slot ${aslot} — proceeding to PRICE screen (will NOT confirm)`);
          await mc.clickWindow(aslot, 0, 0);
          await onceWindow(mc, 4500); await sleep(900);
          dumpWin('BUY ORDER price screen (will NOT confirm — safe)');
        }
      } else if (details) {
        console.log('  [PROBE] "create buy order" not found on details page.');
      }
    } else if (search) {
      console.log(`  [PROBE] product "${itemName}" not found in search result — check the item name.`);
    }
  } else {
    console.log('  [PROBE] (no ranked item for product probe)');
  }

  // 3) Manage Orders grid (find the button in a fresh main Bazaar, click it).
  const main = await openCmd('bz', '/bz  (for Manage Orders)');
  const slot = main ? findSlot(main, 'manage orders') : -1;
  if (slot >= 0) {
    console.log(`  [PROBE] "manage orders" at slot ${slot} — clicking`);
    await mc.clickWindow(slot, 0, 0);
    await onceWindow(mc, 4500);
    await sleep(800);
    dumpWin('Manage Orders grid');
  } else if (main) {
    console.log('  [PROBE] "manage orders" NOT found — real button label must be one of the names above.');
  }

  await closeWin();
  console.log('========== END PROBE ==========\n');
}

// ---- LIVE WRITE-PATH TEST: one guarded micro-order ----
// Walks the full buy flow on a cheap, guaranteed-tradeable item to verify the
// sign text input and capture the Confirm screen. The order is priced at 60% of
// the top buy so it can NOT fill (rests until cancelled), and it's 1 unit. With
// `--confirm` it is actually placed; without it, the driver stops at the Confirm
// screen and places nothing. Either way the sign/confirm details are logged.
async function placeTest(mc, api, cfg, driver, armed) {
  const item = bot.probeItem;
  console.log('\n========== LIVE PLACE-TEST ==========');
  driver.armConfirm(armed);
  const book = await driver.readOrderBook(item);
  const topBuy = book?.buyOrders?.[0]?.price;
  if (!topBuy) { console.log(`  [PLACE-TEST] could not read order book for ${item} — aborting`); await driver.closeBook(); return; }
  const price = Math.max(0.1, Math.floor(topBuy * 0.6 * 10) / 10); // 60% of top → cannot fill
  console.log(`  [PLACE-TEST] item=${item}  units=1  price=${price} (60% of top buy ${topBuy} — cannot fill, rests until cancelled)`);
  console.log(`  [PLACE-TEST] confirm=${armed ? 'ARMED — will place a REAL resting order you must cancel' : 'DISARMED — stops at Confirm, places nothing'}`);
  const r = await driver.placeBuy(item, 1, price);
  console.log('  [PLACE-TEST] placeBuy →', r);
  if (armed && r === true) console.log('  [PLACE-TEST] order placed — check Manage Orders, then CANCEL it in-game or via the bot.');
  await driver.closeBook();
  console.log('========== END PLACE-TEST ==========\n');
}

// ---- LIVE READ+CANCEL TEST: verify readOrders + the Order Options / cancel ----
async function cancelTest(mc, cfg, driver, armed) {
  console.log('\n========== CANCEL-TEST ==========');
  driver.armConfirm(armed);
  if (!(await driver.openBook())) { console.log('  [CANCEL-TEST] could not open Your Bazaar Orders'); return; }
  const orders = driver.readOrders();
  console.log(`  [CANCEL-TEST] readOrders() → ${orders.length} order(s):`);
  orders.forEach((o) => console.log(`    ${o.side} "${o.item}" ${o.amount}x @ ${o.price} filled ${o.filledPct}%${o.claimable ? ' [claim]' : ''} (slot ${o._slot})`));
  if (!orders.length) { console.log('  [CANCEL-TEST] no open orders — place one first with --place-test --confirm'); await driver.closeBook(); return; }

  // Open the first order's options menu and dump it (verify the cancel button).
  const target = orders[0];
  await mc.clickWindow(target._slot, 0, 0);
  await onceWindow(mc, 4000); await sleep(900);
  const opts = mc.currentWindow;
  console.log('  [CANCEL-TEST] Order Options "' + componentText(opts?.title ?? '') + '": ' +
    readWindow(opts).map((r) => `${r.slot}:"${r.name}"`).join(', '));
  const cancelHit = readWindow(opts).find((r) => r.name.includes('cancel') && r.name.includes('order'));
  if (!cancelHit) { console.log('  [CANCEL-TEST] no cancel button found in options — see names above'); await driver.closeBook(); return; }
  if (!armed) {
    console.log(`  [CANCEL-TEST] DISARMED — would click slot ${cancelHit.slot} ("${cancelHit.name}"); order NOT cancelled.`);
    await driver.closeBook(); console.log('========== END CANCEL-TEST ==========\n'); return;
  }
  console.log(`  [CANCEL-TEST] ARMED — clicking slot ${cancelHit.slot} ("${cancelHit.name}") to cancel.`);
  await mc.clickWindow(cancelHit.slot, 0, 0);
  await sleep(1200);
  // Some flows pop a confirm; dump whatever window we land on for visibility.
  if (mc.currentWindow) console.log('  [CANCEL-TEST] post-cancel window "' + componentText(mc.currentWindow.title ?? '') + '": ' +
    readWindow(mc.currentWindow).map((r) => `${r.slot}:"${r.name}"`).join(', '));
  console.log('  [CANCEL-TEST] done — verify the order is gone + coins refunded in-game.');
  await driver.closeBook();
  console.log('========== END CANCEL-TEST ==========\n');
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
      // Exclude untradeable items (config avoidItems + learned skill-locks) so the
      // displayed flips are all actionable, not padded with things we can't trade.
      const rows = rank(api.candidates, cfg, { locked: driver.locked })
        .filter((r) => r.state !== 'locked')
        .slice(0, 12);

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
