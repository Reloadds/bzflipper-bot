// MINIMAL connection test — no workarounds, no warp, no reconnect, no bot logic.
// Just connect through ViaProxy and report what happens. If this SPAWNS and STAYS
// (no flapping), the connection is fine and the real index.js is doing something
// harmful. If this also drops, it's the Hypixel/ViaProxy/mineflayer layer.
//
// Run:  node test-connect.js       (ViaProxy must be running)

import mineflayer from 'mineflayer';

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25568,
  username: 'bzbot',
  auth: 'offline',
  version: '1.20.1',
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
