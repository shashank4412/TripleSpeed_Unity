/**
 * One hazard, expressed entirely in integers.
 * Ported verbatim from Backend/sim-core-cs/Runtime/Hazards/Hazard.cs.
 *
 * Position is in the same units as the player's, which is what lets collision be
 * an exact interval overlap with no floating point and no tolerance value.
 *
 * Moving traffic reuses the player's trick: because one tick is 1/60 s and a
 * position unit is 1/60000 of a game unit, a speed of V milli-units per second
 * advances a hazard by exactly V position units per tick. Traffic motion is
 * integer addition, not a velocity integration that could drift.
 */

export type HazardKind = 'obstacle' | 'traffic';

export class Hazard {
  constructor(
    readonly kind: HazardKind,
    readonly lane: number,
    /** Road position of the hazard's trailing edge at `spawnTick`. */
    readonly startPosition: number,
    /** Length along the road, in position units. */
    readonly length: number,
    /** Milli-units per second, which is also position units per tick. Zero for obstacles. */
    readonly speedMilli: number,
    readonly spawnTick: number,
  ) {}

  /**
   * Trailing edge at a given tick. Exact integer arithmetic. Only meaningful
   * from `spawnTick` onward -- see `overlapsAt`, which enforces that.
   */
  positionAt(tick: number): number {
    return this.startPosition + this.speedMilli * (tick - this.spawnTick);
  }

  /**
   * Whether this hazard overlaps [playerStart, playerStart + playerLength) at
   * `tick`. Half-open on both sides, so two intervals that merely touch do not
   * collide -- that makes the boundary case a decision rather than an accident.
   */
  overlapsAt(tick: number, playerStart: number, playerLength: number): boolean {
    if (tick < this.spawnTick) return false; // a hazard cannot hit anyone before it exists

    const hazardStart = this.positionAt(tick);
    const hazardEnd = hazardStart + this.length;
    const playerEnd = playerStart + playerLength;
    return playerStart < hazardEnd && hazardStart < playerEnd;
  }

  toString(): string {
    return `${this.kind} lane=${this.lane} pos=${this.startPosition} len=${this.length} v=${this.speedMilli}`;
  }
}
