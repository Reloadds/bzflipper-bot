# bzflipper-bot — headless Bazaar flipper (Mineflayer)

A **fully headless** Hypixel SkyBlock Bazaar flipper. It logs a Mineflayer bot
into Hypixel, and drives the same decision brain as the
[Fabric mod](https://github.com/Reloadds/bzflipper) — ranking, two-sided capital
velocity, sizing, undercut/relist — but with no game client rendering.

The pure brain (price math, API + ranking, the state machine) is the tested core
from [bzflipper-headless](https://github.com/Reloadds/bzflipper-headless), vendored
into `src/`. This repo adds the **Mineflayer driver** that implements the game
actions against a live `bot`.

> ⚠️ **Read this.** Automating the Bazaar breaks Hypixel's rules (Rule #4,
> exploiting) and **a headless bot is the most detectable form** — no legit-client
> fingerprint, no rendering, pure behavioral signature. Watchdog hunts exactly
> this. **Use a throwaway alt you don't care about.** This is a learning project.

## Two modes

| Mode | `dryRun` | What it does | Risk |
|---|---|---|---|
| **OBSERVE** *(default)* | `true` | Logs in, gets on SkyBlock, reads your purse (scoreboard) + cookie (tab list) and fetches the live Bazaar from the public API, then prints the ranked flips. **No GUI is opened, nothing is clicked, nothing is placed.** | Read-only, zero-click. Safe study. Start here. |
| **LIVE** | `false` | Runs the state machine — places, claims, relists, and cancels **real orders with real coins**. | Real automation. Ban risk. |

## Setup

```bash
git clone https://github.com/Reloadds/bzflipper-bot
cd bzflipper-bot
npm install                 # pulls mineflayer
cp config.example.json config.json
# edit config.json — set "username" to your Microsoft email, leave dryRun: true
npm start
```

**First run auth:** with `"auth": "microsoft"`, Mineflayer prints a
**device-code link + code** to the console. Open the link, sign in with the alt's
Microsoft account, enter the code. The token is cached, so you only do this once.

## What you'll see in OBSERVE mode

Every ~15s:

```
── 14:32:07 · purse 104.10M · cookie 38h · api 3s · orders 7
  TOP FLIPS (coins/hr):
    1. Enchanted Redstone          2.14M/hr  m13.7%  vel 687u/hr
    2. Sphinx Shard                1.98M/hr  m8.2%   vel 41k/hr
    ...
  OPEN ORDERS:
    SELL Enchanted Redstone   3.1  × 8202   64% [claim]
    BUY  Whale Bait           1.2  × 26880  0%
```

That proves the whole chain works headless: login → SkyBlock → Bazaar read →
ranking. **This is what to verify first.**

## Watching + debugging

Two switches in `config.json` make bring-up and remote debugging easy:

- **`"viewer": true`** — starts [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer)
  at `http://localhost:<viewerPort>` (default 3007) so you can *watch* the bot in a
  browser. On a remote box, tunnel it:
  `ssh -L 3007:localhost:3007 user@your-host` then open `http://localhost:3007`.
- **`"debugDump": true`** — each OBSERVE cycle also prints the **raw** scoreboard,
  tab-list footer, and open-window slots (name + lore). If a read looks wrong
  (empty order grid, purse `—`, etc.), **paste that dump** — it's exactly what's
  needed to correct the Hypixel string anchors (the `S` table in
  `mineflayerDriver.js`) against your real GUIs.

## Going live (only after OBSERVE looks right)

Set `"dryRun": false` in `config.json`. The state machine then trades.

**Heads-up — the write path needs a live tuning pass.** The order-placing
sequences (buy/sell/claim/cancel and especially the **sign inputs** for custom
amount/price) depend on Hypixel's exact GUI text and the sign-edit packet for your
protocol version. Every such string is centralized in `src/mineflayerDriver.js`
(the `S = {…}` table) and marked `TUNE:` where it needs confirming against the real
GUIs. Expect to adjust these once while watching OBSERVE output before live works
cleanly. Cookie auto-refresh is **not yet wired headless** — keep a buff active
manually (or `cookieRefreshEnabled: false`, the default).

## Config (`config.json`)

- `username` — your Microsoft **email** (not the gamertag), `auth: "microsoft"`.
- `version` — protocol to connect with (default `"1.21.11"`). Direct connection
  works: the bot ships three built-in workarounds for the handshake bugs that
  used to kill it (see "How the connection works" below). On any disconnect the
  console dumps the last 40 packets in both directions for diagnosis.
- `warpCommand` — how to reach SkyBlock after login (default `skyblock`).
- `dryRun` — **`true` = observe (safe), `false` = live trading.**
- `strategy` — the brain knobs (order slots, margins, sizing, volume floors …),
  same meaning as the mod's config.

## Discord / webhook alerts

Set `"webhookUrl"` to a Discord (or any compatible) webhook URL to get pushed
alerts — sign-in prompts, connect/disconnect, kicks, and a periodic status line
(purse · orders · top flip) every `webhookStatusMin` minutes. Leave it `""` to
disable. This is the "run it 24/7 on a VPS and watch from your phone" workflow.

## "Badly behaving modifications" kicks — what actually causes them

If Hypixel kicks you to the lobby with *"We have detected badly behaving
modifications…"*, it is **not** your movement/physics and **not** a ban — it's the
anti-cheat flagging **automated menu clicking**. Current Hypixel builds flag rapid
or non-human GUI interaction (fast clicks, middle-click, quick inventory moves);
mineflayer navigating the Bazaar menu tick-fast looks exactly like that. This repo
mitigates it:

- **OBSERVE mode clicks nothing.** Purse, cookie and prices come from the
  scoreboard, tab list and public API — no GUI is opened. Reading your own open
  orders (which *does* need the menu) is opt-in via `"readOrdersGui": true`, and
  even then the bot human-paces the clicks and closes the menu afterward.
- **Every menu click is human-paced** — a randomized ~0.55–1.2s beat
  (`clickDelayMs` / `clickJitterMs`), only left-click, never middle/shift-click.
- **Menus are closed when done**, instead of sitting open and re-clicked each cycle.

Movement/physics is left at mineflayer defaults — standing still is fine; it was
never the trigger.

## How the connection works (no proxy needed)

Direct connection to Hypixel on 1.21.11 works. Three stock-mineflayer bugs used
to kill it — each looked like a bare `socketClosed` — and `index.js` carries a
built-in workaround for each (verified working July 2026):

1. **Client settings during configuration** — Hypixel drops clients that never
   send the `settings` packet in the 1.20.2+ configuration phase
   ([mineflayer#3623](https://github.com/PrismarineJS/mineflayer/issues/3623),
   upstream fix unmerged). We send it on every configuration entry.
2. **SkyBlock's required resource pack** (SkyBlock 0.26, July 2026) — pushed
   during the transfer into SkyBlock. Mineflayer's `acceptResourcePack()` is
   broken (serializes the pack UUID as 16 zero bytes), so we answer the raw
   packet ourselves with the accepted/downloaded/loaded sequence.
3. **Play packets during the transfer** — mineflayer's physics keeps sending
   `position` while the connection is back in the configuration phase; the
   serializer silently emits it as a malformed 0x00 (settings) packet and
   Hypixel closes the socket. A write-guard drops non-configuration packets
   while the transfer is in progress.

ViaProxy/1.20.1 downgrading (the old workaround) is no longer needed. On any
disconnect the console prints the last 40 packets in both directions — if a new
handshake problem ever appears, that tape is how you find it.

## Troubleshooting login

`disconnected: socketClosed` **before** an `✅ logged in` line means Hypixel
refused the connection during handshake (not an in-game kick). In order:

1. **Join Hypixel once from a real Minecraft client** on this account and accept
   the network rules — a brand-new account that has never joined gets closed.
2. **VPS IPs are frequently blocked/greylisted** by Hypixel's anti-bot. A
   datacenter IP (Vultr, etc.) is a common cause of instant `socketClosed`; try a
   residential IP or a proxy.
3. Try `"version": "auto"` (negotiate from the server) or a nearby release like
   `"1.21.8"`.

The console now prints these hints after repeated failures, and the Microsoft
**sign-in code is shown clearly** (`🔑 SIGN IN: …`) — if you never see that code,
the failure is at Hypixel's gate, not auth.

## Known caveats (be realistic)

- **Version support.** Mineflayer needs `minecraft-data` to support the protocol
  you connect with. `1.21` is safe today; the very latest MC may not be. Hypixel
  accepts a wide range via ViaVersion, so pin `version` to a supported one.
- **Hypixel login hurdles.** Hypixel sometimes gates non-vanilla clients; if the
  bot connects but can't reach SkyBlock, join once manually on that account first.
- **The GUI write path is unverified** (see "Going live"). OBSERVE is the tested
  surface; live trading is a scaffold you finish by tuning the `S` strings.
- This can get the account **banned**. Throwaway alt only.

## Roadmap

- [x] Brain + state machine (vendored, tested — 14/14).
- [x] Mineflayer driver: reads (purse/cookie/orders) + OBSERVE mode.
- [x] `prismarine-viewer` hook + raw GUI debug dump to watch/debug bring-up.
- [ ] Tune the write sequences (sign input, confirm slots) against live GUIs.
- [ ] Port the hardened cookie-consume flow to headless.

## License

MIT.
