// Instrumented connection diagnostic — captures GROUND TRUTH, changes nothing.
// Writes a full timestamped trace to diag-<mode>-<ver>-<ts>.log AND the console.
//
//   node diag.js proxy 1.20.1     ← bot→ViaProxy(127.0.0.1:25568), auth offline
//   node diag.js proxy 1.8.9
//   node diag.js direct 1.21.11   ← bot→mc.hypixel.net direct, auth microsoft
//   add  --debug  to also enable minecraft-protocol's internal parse logging
//
// What it answers:
//  • the LAST packet received before the connection stalls/dies
//  • whether a deserialize ERROR is thrown (read loop death → keepalive stops)
//  • whether keep_alive packets arrive and keep arriving near the 15s mark
//  • exact disconnect reason / kick payload

if (process.argv.includes('--debug')) process.env.DEBUG = 'minecraft-protocol';

import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import mineflayer from 'mineflayer';

const mode = process.argv[2] || 'proxy';
const version = process.argv[3] || (mode === 'direct' ? '1.21.11' : '1.20.1');

let username = 'bzbot';
if (mode === 'direct') {
  try { username = JSON.parse(readFileSync('./config.json', 'utf8')).username; } catch {}
  username = process.env.MC_EMAIL || username;
}

const opts = {
  host: mode === 'direct' ? 'mc.hypixel.net' : '127.0.0.1',
  port: mode === 'direct' ? 25565 : 25568,
  auth: mode === 'direct' ? 'microsoft' : 'offline',
  username,
  version,
};

const t0 = Date.now();
const logfile = `diag-${mode}-${version}-${t0}.log`;
const out = fs.createWriteStream(logfile, { flags: 'a' });
const log = (...a) => {
  const line = `[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${a.join(' ')}`;
  console.log(line); out.write(line + '\n');
};

log(`DIAG mode=${mode} host=${opts.host}:${opts.port} version=${version} auth=${opts.auth} user=${username}`);
log(`writing trace → ${logfile}`);

const bot = mineflayer.createBot(opts);

let pkts = 0, keepAlives = 0, lastPacket = 'none', lastPacketAt = t0;
const seen = new Set();

bot._client.on('packet', (data, meta) => {
  pkts++; lastPacket = `${meta.state}/${meta.name}`; lastPacketAt = Date.now();
  // Log every packet the FIRST time (to see the join sequence) + all keep_alives.
  const key = `${meta.state}/${meta.name}`;
  if (!seen.has(key)) { seen.add(key); log(`<< ${key}  (first)`); }
  if (meta.name === 'keep_alive') { keepAlives++; log(`   ↳ KEEP_ALIVE #${keepAlives}`); }
  if (meta.name === 'kick_disconnect' || meta.name === 'disconnect') log(`<< ${key} :: ${JSON.stringify(data).slice(0, 400)}`);
});

const ow = bot._client.write.bind(bot._client);
bot._client.write = (name, params) => { log(`>> ${bot._client.state}/${name}`); return ow(name, params); };

bot._client.on('state', (n, o) => log(`STATE ${o} → ${n}`));
bot._client.on('error', (e) => log('‼ CLIENT ERROR:', e.stack || e.message));
const hookSock = () => { const s = bot._client.socket; if (!s) return setTimeout(hookSock, 100);
  s.on('close', (he) => log(`SOCKET close hadError=${he}`)); s.on('error', (e) => log('SOCKET error', e.code || '', e.message)); };
hookSock();

bot.on('login', () => log('EVENT login (join_game processed — spawn imminent)'));
bot.on('spawn', () => log('EVENT ✅ SPAWN — in world'));
bot.on('kicked', (r) => log('EVENT kicked:', JSON.stringify(r)));
bot.on('error', (e) => log('EVENT error:', e.stack || e.message));
bot.on('end', (r) => {
  log(`EVENT end: ${r}`);
  log(`SUMMARY packets=${pkts} keepAlives=${keepAlives} lastPacket=${lastPacket} (${((Date.now() - lastPacketAt) / 1000).toFixed(1)}s before end)`);
  out.end(() => process.exit(0));
});
process.on('uncaughtException', (e) => log('‼ UNCAUGHT:', e.stack || e.message));
process.on('unhandledRejection', (e) => log('‼ UNHANDLED REJECTION:', (e && e.stack) || e));

// Heartbeat: is the read loop alive right up to the death? If lastPkt "ago" keeps
// growing while we're still connected, the read loop stalled → that packet broke it.
setInterval(() => {
  log(`HEARTBEAT still connected, packets=${pkts} keepAlives=${keepAlives} lastPkt=${lastPacket} (${((Date.now() - lastPacketAt) / 1000).toFixed(1)}s ago)`);
}, 3000);
