/**
 * A small deterministic RNG for the harness itself — NOT the game core (which
 * has its own PCG32). Mulberry32: one 32-bit state, good enough to pick
 * populations and strategies reproducibly. Never touches a score.
 */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  /** Box–Muller normal. */
  normal(mean: number, sd: number): number {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  /** A 64-bit seed as a bigint, for the game core. */
  seed64(): bigint {
    const hi = BigInt(Math.floor(this.next() * 0x100000000));
    const lo = BigInt(Math.floor(this.next() * 0x100000000));
    return (hi << 32n) | lo;
  }
}
