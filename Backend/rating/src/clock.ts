/**
 * Where "now" comes from. Ported from Clock.cs.
 *
 * Injected rather than read from the wall clock because the matchmaker's rating
 * band widens with a challenge's age, and the proof has to run 50000 matches
 * over a virtual timeline in seconds. A matchmaker that reads the wall clock
 * cannot be simulated, and a simulation that cannot run the production
 * matchmaker proves nothing.
 *
 * Time is epoch milliseconds throughout the backend -- Firestore Timestamps
 * convert cleanly to and from it.
 */
export interface IClock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
}

/** The real clock. What the Cloud Functions run on. */
export class SystemClock implements IClock {
  nowMs(): number {
    return Date.now();
  }
}

/**
 * A clock the caller moves by hand. What the proof and the tests run on, so a
 * challenge can be aged an hour without waiting one.
 */
export class VirtualClock implements IClock {
  private current: number;

  constructor(startMs: number) {
    this.current = startMs;
  }

  nowMs(): number {
    return this.current;
  }

  advance(byMs: number): void {
    if (byMs < 0) throw new RangeError('the clock cannot move backwards');
    this.current += byMs;
  }

  moveTo(instantMs: number): void {
    // Time only moves forward. A test that rewinds it would be exercising a
    // situation the product cannot be in.
    if (instantMs < this.current) throw new RangeError('the clock cannot move backwards');
    this.current = instantMs;
  }
}
