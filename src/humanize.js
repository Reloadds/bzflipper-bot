// Human-presence layer: makes the bot read like an idle player instead of a
// frozen entity — the #1 behavioural tell for anti-cheat. Deliberately SAFE:
//
//  • Smooth, small head movements (like idle mouse drift) — the strongest and
//    safest "a person is here" signal. Not constant spinning (that's ALSO a
//    pattern) — sparse and randomized.
//  • Occasional brief crouch / rare jump.
//  • NO walking / directional movement — a stray step can drop the bot off an
//    island edge, and standing bots on a private island are normal anyway.
//  • Never acts while a GUI/window is open, so it can't disturb Bazaar clicks.
//  • Fully randomized timing — no fixed cadence to fingerprint.
//
// (Velocity/knockback realism is handled separately by mineflayer PHYSICS being
//  enabled — see index.js; this module is the idle-movement half.)

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function startHumanize(bot, { minSec = 20, maxSec = 75, log = () => {} } = {}) {
  let stopped = false;
  let timer = null;

  const busy = () => bot.currentWindow != null; // mid-GUI → don't fidget

  async function act() {
    if (stopped) return;
    if (!bot.entity || busy()) return schedule();
    try {
      const roll = Math.random();
      if (roll < 0.72) {
        // Idle look-around: small, SMOOTH head turn (bot.look with force=false
        // interpolates over ticks, like a hand nudging the mouse).
        const yaw = bot.entity.yaw + rand(-1.0, 1.0);
        const pitch = clamp(bot.entity.pitch + rand(-0.35, 0.35), -1.3, 1.3);
        await bot.look(yaw, pitch, false);
      } else if (roll < 0.9) {
        // Brief crouch — a very human idle twitch.
        bot.setControlState('sneak', true);
        await sleep(rand(200, 550));
        bot.setControlState('sneak', false);
      } else {
        // Rare jump.
        bot.setControlState('jump', true);
        await sleep(250);
        bot.setControlState('jump', false);
      }
      log('[human] idle');
    } catch {
      // never let presence code crash the bot
    }
    schedule();
  }

  function schedule() {
    if (!stopped) timer = setTimeout(act, rand(minSec, maxSec) * 1000);
  }

  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); try { bot.clearControlStates(); } catch {} };
}
