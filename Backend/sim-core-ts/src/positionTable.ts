/**
 * Player road position at any tick, cached.
 * Ported verbatim from Backend/sim-core-cs/Runtime/Sim/PositionTable.cs.
 *
 * Position is a pure function of the tick -- speed depends only on the tick
 * index, never on lane, score, or anything the player did -- so this table is
 * shared by the road generator and the solvability checker without either of
 * them consulting player state. That property is exactly what makes "both
 * players drive the same road" true.
 *
 * Cached because the generator and solver both need P(t) repeatedly; recomputing
 * it by summing speeds each time would make road generation quadratic in run
 * length.
 */
import type { GameConfig } from './gameConfig.js';

export class PositionTable {
  private readonly cumulative: number[] = [0];

  constructor(private readonly config: GameConfig) {}

  /** Road position, in position units, after `tick` ticks of travel. */
  at(tick: number): number {
    while (this.cumulative.length <= tick) {
      const t = this.cumulative.length - 1;
      this.cumulative.push(this.cumulative[t]! + this.config.speedAtTick(t));
    }
    return this.cumulative[tick]!;
  }
}
