# Hypixel 1.21.11 connection — FINDINGS

## Environment (all LATEST as of 2026-07)
- mineflayer 4.37.1 (latest), minecraft-protocol 1.66.2 (latest), minecraft-data 3.111.0 (latest), prismarine-chunk 1.40.0
- `minecraft-data('1.21.11')` → present. protocol **774**, dataVersion 4671. supportedVersions includes 1.21.11.
- Node 24 on the dev box (bot runs on user's Windows machine).
- Account: `itz_Beluga` (email audaus12435u12@outlook.com), Microsoft auth. Reaches Hypixel Limbo (seen in-game), so account is valid/known to Hypixel.

## Observed failure modes
### A) DIRECT to mc.hypixel.net, version 1.21.11
- Trace: set_protocol → login_start → encryption_begin ↔ → compress → **login success** → login_acknowledged (we send) → we manually send `brand` + `settings` → `state login→configuration` → **socketClosed (hadError=false)**, no `<< configuration` packets from server.
- mineflayer `login`/`spawn` never fire. Account lingers online briefly (server waiting).
- = dies IN the configuration phase, server closes. Matches mineflayer#3775 family.

### B) Via ViaProxy (bot speaks 1.8.9 or 1.20.1 → ViaProxy → Hypixel 1.21.11)
- Bot: set_protocol → login_start → compress → login success → `state login→play` → **socketClosed at ~15.5s** (consistent 15.5s for 1.8.9 AND 1.20.1).
- mineflayer `login`/`spawn` NEVER fire. No chat/kick message. hadError=false.
- ViaProxy log: `[SESSION] Connected successfully! Switching to PLAY state` → 15s later `[DISCONNECT] Connection closed` (no reason).
- ViaProxy toggles tried: `ignore-protocol-translation-errors: true`, `fake-accept-resource-packs: true` → NO CHANGE.
- **15.5s + never spawns = classic KeepAlive-timeout signature: read loop likely died on an early PLAY packet.** ← NOT YET CONFIRMED (need packet trace + error capture).

## Hypotheses
| # | Hypothesis | Status |
|---|---|---|
| 1 | Config-phase settings/brand not sent (dropped in ~short timeout) | DIRECT: we DO send them manually, still dies. PROXY (pre-1.20.2): no config phase, N/A. |
| 2 | **Deserialize error kills read loop → KeepAlive stops → 15s timeout** | **LEADING. Not yet captured. Need last-packet-before-death + thrown error.** |
| 3 | Stale/partial 1.21.11 prismarine data | Ruled out at version level (all latest, data present). Could still be buggy 1.21.11 translation. |
| 4 | Anti-bot / Limbo | Reaches Limbo; account joined normally? (assume yes — it's the user's alt). |
| 5 | Secure chat / session | Not observed. |

## GROUND TRUTH (diag.js proxy 1.20.1) — 2026-07-18
```
>> handshaking/set_protocol → STATE login → >> login_start
<< login/compress, << login/success → STATE login→play
[then 15s of SILENCE — packets=2, keepAlives=0, lastPkt stays login/success]
END: socketClosed (15.0s after last packet). No error, no uncaught, read loop NOT stalled.
```
**Conclusion:** ViaProxy sends the bot NOTHING after `login/success`. Not a deserialize
error (H2 ✗), not KeepAlive (none arrive), not my bot code. **ViaProxy stalls the relay
bridging Hypixel's 1.21.11 CONFIGURATION phase → a pre-1.20.2 client (no config phase).**
ViaProxy↔Hypixel reaches PLAY (earlier logs) but never forwards play packets to the bot.

Updated hypotheses:
- H2 deserialize → **RULED OUT** (0 packets to parse, no error).
- **H-new: ViaProxy config-state bridge stall for pre-1.20.2 clients.** ViaProxy setting
  `skip-config-state-packet-queue` targets exactly this. → TESTING.

## Test results log
- `skip-config-state-packet-queue: true` (ViaProxy restart) → NO CHANGE. Still 2 packets, dead 15s. Reverted assumption.
- **New hypothesis (H-bridge):** bot is pre-1.20.2 (no config phase); ViaProxy must bridge
  Hypixel's 1.21.11 config phase → a config-less client, and that bridge deadlocks (0 packets
  forwarded). FIX: use a bot version that HAS the config phase (1.20.2+) so ViaProxy relays it
  transparently AND the config phase is handled by ViaProxy (normal server), not Hypixel (whose
  config phase tripped mineflayer directly). → TESTING `diag.js proxy 1.20.2` (and 1.21.1).
