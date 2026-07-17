// Anti-AFK: gentle, randomized presence signals so Hypixel's idle detector
// doesn't kick the bot during long observe/trading sessions.
//
// Research notes (Hypixel forums + mineflayer discussions):
// - Hypixel kicks idle players (and on SkyBlock sends them to limbo) after ~20
//   minutes of NO input. Any real input resets the timer.
// - SLOWER IS SAFER: a bot that twirls/jumps constantly on a fixed timer is a
//   pattern; sparse, randomized, small actions look like a human nudging the
//   mouse. We act every 2–4 minutes, well inside the ~20-minute window.
// - A Booster Cookie also prevents AFK-out on your private island — keep one
//   active regardless; this module is the belt to that suspender.
// - We deliberately DON'T walk (could step off an island edge) and DON'T swing
//   at entities. Head rotation + a rare jump + a rare sneak-tap is plenty.

export function startAntiAfk(bot, { minSec = 120, maxSec = 240, log = () => {} } = {}) {
  let timer = null;
  let stopped = false;

  const rand = (lo, hi) => lo + Math.random() * (hi - lo);

  async function act() {
    if (stopped || !bot.entity) return schedule();
    try {
      const roll = Math.random();
      if (roll < 0.70) {
        // Small head turn (most common — the "human nudged the mouse" signal).
        const yaw = bot.entity.yaw + rand(-0.6, 0.6);
        const pitch = Math.max(-1.2, Math.min(1.2, bot.entity.pitch + rand(-0.25, 0.25)));
        await bot.look(yaw, pitch, false);
      } else if (roll < 0.85) {
        // Brief sneak tap.
        bot.setControlState('sneak', true);
        setTimeout(() => { try { bot.setControlState('sneak', false); } catch {} }, 300 + Math.random() * 400);
      } else {
        // Rare jump.
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch {} }, 250);
      }
      log('[anti-afk] nudge');
    } catch { /* never let anti-afk crash the bot */ }
    schedule();
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(act, rand(minSec, maxSec) * 1000);
  }

  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
