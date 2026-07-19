// MINIMAL connection test — no workarounds, no warp, no reconnect, no bot logic.
// Just connect through ViaProxy and report what happens. If this SPAWNS and STAYS
// (no flapping), the connection is fine and the real index.js is doing something
// harmful. If this also drops, it's the Hypixel/ViaProxy/mineflayer layer.
//
// Run:  node test-connect.js       (ViaProxy must be running)

import { readFileSync } from 'node:fs';
import mineflayer from 'mineflayer';

// Direct connection test using config.json (host/auth/username/version).
//   node test-connect.js            uses config.json
//   node test-connect.js 1.21.11    overrides the version
const cfg = JSON.parse(readFileSync('./config.json', 'utf8'));
const version = process.argv[2] || cfg.version || '1.21.11';
console.log(`Testing connection to ${cfg.host}:${cfg.port} as version ${version} (auth ${cfg.auth}) …`);

const bot = mineflayer.createBot({
  host: cfg.host, port: cfg.port, username: cfg.username, auth: cfg.auth, version,
  hideErrors: true, // Hypixel particle packets mis-parse harmlessly (length-framed)
  onMsaCode: (d) => console.log(`\n🔑 SIGN IN: open ${d.verification_uri} code ${d.user_code}\n`),
});

// mineflayer#3623 workaround — send client settings during the configuration
// phase or Hypixel silently socketClosed us. Verified against 1.21.11 schema.
bot._client.on('state', (s) => {
  if (s === 'configuration') {
    bot._client.write('settings', {
      locale: 'en_US', viewDistance: 8, chatFlags: 0, chatColors: true,
      skinParts: 0x7f, mainHand: 1, enableTextFiltering: false,
      enableServerListing: true, particleStatus: 'all',
    });
    console.log('>> [configuration] settings sent');
  }
});

const t0 = Date.now();
const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

bot.on('login', () => console.log(`${at()}  LOGIN ok`));
bot.on('spawn', () => console.log(`${at()}  ✅ SPAWN — in world. Doing NOTHING now; watching if it stays…`));
bot.on('kicked', (reason) => console.log(`${at()}  ⛔ KICKED: ${JSON.stringify(reason)}`));
bot.on('error', (e) => console.log(`${at()}  ERROR: ${e.code || ''} ${e.message}`));
bot.on('end', (reason) => { console.log(`${at()}  END: ${reason}`); process.exit(0); });

// Print any chat/system message the server sends — a kick or limbo notice shows here.
bot.on('message', (msg) => {
  const s = msg.toString().replace(/\n/g, ' ').trim();
  if (s) console.log(`${at()}  MSG: ${s.slice(0, 140)}`);
});

// Heartbeat so we can see how long it survives.
let n = 0;
const iv = setInterval(() => {
  if (!bot.entity) return;
  console.log(`${at()}  alive — pos ${bot.entity.position.floored()}  health ${bot.health}`);
  if (++n > 20) clearInterval(iv);
}, 5000);
