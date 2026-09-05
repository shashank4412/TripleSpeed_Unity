/**
 * The unit system, ported verbatim from Backend/sim-core-cs/Runtime/Sim/Units.cs.
 *
 * THE PROBLEM
 * Speed is configured in milli-units per second (20000 = 20.0 u/s) and the
 * simulation runs at 60 ticks per second. The naive per-tick distance is
 *
 *     delta = speedMilli / ticksPerSecond          // 20000 / 60 = 333.333...
 *
 * which is not a whole number. Any implementation that evaluates that division
 * once per tick either uses floating point -- which is allowed to differ
 * between a phone's Mono/IL2CPP runtime and a Node CoreCLR-equivalent -- or
 * truncates, throwing away a third of a milli-unit sixty times a second.
 *
 * THE FIX
 * Never perform that division. Choose the position unit so the per-tick delta
 * is already a whole number:
 *
 *     PositionScale = MilliScale * ticksPerSecond          (1000 * 60 = 60000)
 *
 * So the hot loop is `position += speedMilli`. Exactly. No division, no
 * rounding, no accumulated error. Score works the same way:
 *
 *     score += speedMilli * laneMultiplier
 *
 * and is divided by PositionScale exactly once, at the end, for display.
 *
 * OVERFLOW
 * Worst case per tick is 55000 * 5 = 275,000. An hour is 216,000 ticks, so
 * under 6e10 -- comfortably inside 2^53, but the score accumulator is kept in
 * BigInt anyway (see simulation.ts) because it is the score of record and a
 * silent precision loss there decides who takes the pot.
 */

/** Config decimals are fixed-point thousandths. 20.5 u/s is stored as 20500. */
export const MILLI_SCALE = 1000;

/**
 * Probabilities and weights are integers over this denominator. A lane hazard
 * weight of 0.55 is stored as 550.
 */
export const WEIGHT_SCALE = 1000;

/**
 * Position units per game unit, derived from the tick rate so that the per-tick
 * delta is integral. This is the whole reason the determinism claim holds.
 */
export function positionScale(ticksPerSecond: number): number {
  return MILLI_SCALE * ticksPerSecond;
}

/** Converts an internal position/score to the whole number shown to a player. */
export function toDisplay(positionUnits: bigint, ticksPerSecond: number): bigint {
  return positionUnits / BigInt(positionScale(ticksPerSecond));
}

/** Converts whole game units to internal position units. */
export function fromGameUnits(gameUnits: number, ticksPerSecond: number): number {
  return gameUnits * positionScale(ticksPerSecond);
}
