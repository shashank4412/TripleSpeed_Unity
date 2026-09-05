/**
 * Proves a road is survivable, independently of the generator that built it.
 * Ported verbatim from Backend/sim-core-cs/Runtime/Hazards/RoadSolvability.cs.
 *
 * This deliberately does NOT reuse RoadGenerator's reachable set. A checker that
 * asks the generator whether the generator was careful proves nothing. So this
 * walks the real state machine from the simulation against the real hazards,
 * using the same collision test the scoring loop uses.
 *
 * Method: forward breadth-first search over every state the player could legally
 * occupy at each tick. If that set is ever empty, some earlier hazard placement
 * killed every possible line and the road is unwinnable.
 *
 * The search does not use the input queue. Ignoring it makes the solver strictly
 * more restrictive than a real player, so a road this proves survivable is
 * survivable -- the error is in the safe direction.
 *
 * The player under test is GREEDY: full arrival in the cashout lane is dropped
 * rather than counted as success, because the requirement is that the road never
 * FORCES a crash on a player who chooses to keep going.
 */
import type { GameConfig } from './gameConfig.js';
import { RoadGenerator } from './roadGenerator.js';
import { Hazard } from './hazard.js';

interface Node {
  lane: number;
  target: number;
  remaining: number;
}

// Pack a node into a single integer key. lane/target < ~16, remaining < ~64
// with the shipped config, so 10 bits each is ample and matches the intent of
// the C# GetHashCode-based HashSet<Node>.
function pack(lane: number, target: number, remaining: number): number {
  return (lane << 20) | (target << 10) | remaining;
}
function unpack(packed: number): Node {
  return { lane: (packed >> 20) & 0x3ff, target: (packed >> 10) & 0x3ff, remaining: packed & 0x3ff };
}

export class SolvabilityReport {
  constructor(
    readonly isSolvable: boolean,
    readonly ticksProven: number,
    readonly failedAtTick: number,
    readonly rescuedEncounters: number,
  ) {}

  toString(): string {
    return this.isSolvable
      ? `solvable through ${this.ticksProven} ticks`
      : `UNWINNABLE at tick ${this.failedAtTick}`;
  }
}

export class RoadSolvability {
  /**
   * Searches for any survivable line through `ticks` ticks of the road
   * generated from `seed`.
   */
  static check(config: GameConfig, seed: bigint, ticks: number): SolvabilityReport {
    const road = new RoadGenerator(config, seed);
    const near: Hazard[] = [];
    const carLength = config.carLengthUnits * config.positionScale;

    let current = new Set<number>([pack(config.startLane, config.startLane, 0)]);
    const next = new Set<number>();

    let position = 0;

    for (let tick = 0; tick < ticks; tick++) {
      next.clear();

      for (const packed of current) {
        const node = unpack(packed);
        if (node.remaining === 0) {
          RoadSolvability.advance(node, next); // hold
          if (node.lane - 1 >= 0) {
            RoadSolvability.advance(
              { lane: node.lane, target: node.lane - 1, remaining: config.laneChangeDurationTicks },
              next,
            );
          }
          if (node.lane + 1 < config.lanes.length) {
            RoadSolvability.advance(
              { lane: node.lane, target: node.lane + 1, remaining: config.laneChangeDurationTicks },
              next,
            );
          }
        } else {
          RoadSolvability.advance(node, next); // hold the change

          // Reversal: swap ends, mirror the timer.
          const mirrored = config.laneChangeDurationTicks - node.remaining;
          const reversed: Node =
            mirrored === 0
              ? { lane: node.lane, target: node.lane, remaining: 0 }
              : { lane: node.target, target: node.lane, remaining: mirrored };
          RoadSolvability.advance(reversed, next);
        }
      }

      const speed = config.speedAtTick(tick);
      position += speed;

      road.ensureGeneratedThrough(tick, position);
      road.collectNear(tick, position, near);

      current = new Set<number>();
      for (const packed of next) {
        const node = unpack(packed);

        // The greedy player declines to bank: drop full arrival in the cashout
        // lane. Transit toward it is still explored (a player may move that way
        // and reverse to dodge); only full arrival is excluded.
        if (node.remaining === 0 && node.lane === config.cashoutLane) continue;

        let hit = false;
        for (let i = 0; i < near.length && !hit; i++) {
          const hazard = near[i]!;
          const occupies = hazard.lane === node.lane || (node.remaining > 0 && hazard.lane === node.target);
          if (occupies && hazard.overlapsAt(tick, position, carLength)) hit = true;
        }

        if (!hit) current.add(pack(node.lane, node.target, node.remaining));
      }

      if (current.size === 0) {
        return new SolvabilityReport(false, tick, tick, road.rescuedEncounters);
      }
    }

    return new SolvabilityReport(true, ticks, -1, road.rescuedEncounters);
  }

  /** Applies one tick of lane-change progress, mirroring the simulation. */
  private static advance(node: Node, into: Set<number>): void {
    if (node.remaining === 0) {
      into.add(pack(node.lane, node.lane, 0));
      return;
    }

    const remaining = node.remaining - 1;
    into.add(remaining === 0 ? pack(node.target, node.target, 0) : pack(node.lane, node.target, remaining));
  }
}
