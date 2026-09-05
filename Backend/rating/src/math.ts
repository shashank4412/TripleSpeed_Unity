/**
 * Rounding helpers that match the C# money and rating code exactly.
 *
 * JavaScript's `Math.round` rounds a half toward +Infinity, so `Math.round(-12.5)`
 * is -12 where C# `MidpointRounding.AwayFromZero` gives -13, and neither matches
 * `MidpointRounding.ToEven`. The Elo delta is rounded once (away from zero) before
 * it is negated for the opponent; the rake is rounded to even. Both live here,
 * beside the code they protect, ported from src/Redline.Rating/EloRounding and
 * src/Redline.Data/SettlementCalculator.
 */

/** C# `Math.Round(x, MidpointRounding.AwayFromZero)` for an already-integral scale. */
export function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * `round(num / den, MidpointRounding.ToEven)` in pure integer arithmetic, for
 * non-negative num and positive den. Used for the rake, where a consistent
 * half-cent bias toward the house over many matches is a real edge nobody agreed
 * to (ADR 0002).
 */
export function divRoundHalfEven(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('denominator must be positive');
  if (num < 0n) throw new RangeError('divRoundHalfEven expects a non-negative numerator');

  const q = num / den;
  const r = num - q * den;
  const twice = r * 2n;

  if (twice < den) return q;
  if (twice > den) return q + 1n;
  return q % 2n === 0n ? q : q + 1n;
}
