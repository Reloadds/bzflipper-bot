// Human-presence layer — LOOK ONLY.
//
// Anti-cheat ("badly behaving modifications") flags INVALID MOVEMENT: mineflayer's
// client-side physics (jumps, steps, knockback prediction) can diverge from
// Hypixel's server physics — especially on brand-new 1.21.11 where
// prismarine-physics may not model motion exactly — and Watchdog rejects it.
//
// So this module does ZERO position movement: no jump, no crouch, no walking, no
// control states at all. It only rotates the head (look packets are NOT movement
// and are never flagged), so the bot reads as an idle person glancing around
// while its body stays perfectly still on the ground. Sparse + randomized timing.

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function startHumanize(bot, { minSec = 25, maxSec = 90, log = () => {} } = {}) {
  let stopped = false;
  let timer = null;

  const busy = () => bot.currentWindow != null; // mid-GUI → don't rotate

  async function act() {
    if (stopped) return;
    if (!bot.entity || busy()) return schedule();
    try {
      // Small, SMOOTH head turn only (force=false interpolates over ticks, like a
      // hand nudging the mouse). No body movement whatsoever.
      const yaw = bot.entity.yaw + rand(-1.1, 1.1);
      const pitch = clamp(bot.entity.pitch + rand(-0.35, 0.35), -1.3, 1.3);
      await bot.look(yaw, pitch, false);
      log('[human] look');
    } catch {
      // never let presence code crash the bot
    }
    schedule();
  }

  function schedule() {
    if (!stopped) timer = setTimeout(act, rand(minSec, maxSec) * 1000);
  }

  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
