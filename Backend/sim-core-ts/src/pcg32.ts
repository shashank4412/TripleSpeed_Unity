/**
 * PCG-XSH-RR 64/32 -- O'Neill's permuted congruential generator.
 * Ported verbatim from Backend/sim-core-cs/Runtime/Rng/Pcg32.cs.
 *
 * Every hazard in a run comes from here. Two players given the same seed must
 * drive an identical road, and a replay months later must reproduce it exactly,
 * so this generator has to be bit-identical on a phone, on the .NET reference
 * core, and here in TypeScript, forever.
 *
 * Why it is safe to make that claim across languages:
 *   * The 64-bit state is held in a BigInt and every step is masked back to 64
 *     bits with MASK64, reproducing C#'s `unchecked` ulong wraparound exactly.
 *   * The 32-bit output is a plain number kept in [0, 2^32) via `>>> 0`.
 *   * Every operation is +, *, ^ and shifts on unsigned integers. No branching
 *     on data, no table lookup, no library call, no float.
 *
 * The instance is mutable by design. It is NOT safe to share across concurrent
 * runs: a run is a single sequential simulation.
 */

const MASK64 = 0xffffffffffffffffn;

// Multiplier from the reference implementation. Chosen by O'Neill for full
// period and good spectral properties; not a number we made up.
const MULTIPLIER = 6364136223846793005n;

export class Pcg32 {
  private state: bigint;
  private readonly increment: bigint; // must be odd; that is what selects the stream

  /**
   * Seeds the generator. `sequence` selects one of 2^63 distinct streams,
   * letting one run seed drive several independent generators (hazard lanes,
   * traffic speeds) without correlating them.
   */
  constructor(seed: bigint, sequence: bigint = 0n) {
    this.state = 0n;
    this.increment = ((sequence << 1n) | 1n) & MASK64; // force odd
    this.nextUint(); // advance past the raw seed
    this.state = (this.state + (seed & MASK64)) & MASK64;
    this.nextUint();
  }

  /** Uniform in [0, 2^32). */
  nextUint(): number {
    const old = this.state;
    this.state = (old * MULTIPLIER + this.increment) & MASK64;

    // Output permutation: xorshift then a random rotation. The rotation amount
    // comes from the high bits, which is what gives PCG its quality over a
    // plain LCG.
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n); // top 5 bits => 0..31

    // C# computes `(xorshifted >> rot) | (xorshifted << ((-rot) & 31))` on a
    // uint. JS `<<`/`>>>` already mask the shift count by 31, and a shift by 0
    // (rot === 0) leaves the value unchanged in both languages, so this line is
    // bit-identical to the reference.
    return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
  }

  /**
   * Uniform in [0, bound). Rejection sampling, so the result is exactly uniform
   * rather than modulo-biased -- with hazard weights this close together,
   * modulo bias would be visible as lane favouritism.
   */
  nextUintBounded(bound: number): number {
    if (bound <= 0 || !Number.isInteger(bound)) {
      throw new RangeError(`bound must be a positive integer, got ${bound}`);
    }

    // C#: threshold = (uint)(-(int)bound) % bound == (2^32 - bound) % bound.
    const threshold = (0x100000000 - bound) % bound;
    for (;;) {
      const r = this.nextUint();
      if (r >= threshold) return r % bound;
    }
  }

  /** Uniform integer in [min, max], inclusive both ends. */
  nextInt(min: number, max: number): number {
    if (max < min) throw new RangeError(`max ${max} < min ${min}`);
    const range = max - min + 1;
    return min + this.nextUintBounded(range);
  }

  /**
   * Uniform in [0, 1) expressed in the caller's fixed-point scale -- e.g. scale
   * 1000 yields 0..999 thousandths. The core has no float anywhere; this is the
   * only "fraction" primitive.
   */
  nextFraction(scale: number): number {
    if (scale <= 0) throw new RangeError(`scale must be positive, got ${scale}`);
    return this.nextUintBounded(scale);
  }
}
