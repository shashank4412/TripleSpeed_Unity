/**
 * Builds the road from a seed, and cannot build an unwinnable one.
 * Ported verbatim from Backend/sim-core-cs/Runtime/Hazards/RoadGenerator.cs.
 *
 * THE REQUIREMENT
 * "The road must never be unwinnable. The generator must not produce a
 * longitudinal position where every lane is blocked such that no legal sequence
 * of lane changes survives."
 *
 * This generator works forward in ticks. For each hazard it computes the exact
 * tick window during which that hazard would overlap the player's hitbox --
 * using the same interval test the scoring loop uses -- and keeps a per-lane
 * record of when each lane is next free. The invariant it enforces: at every
 * encounter, at least one SCORING lane the player can reach in time is clear for
 * the whole window.
 *
 * The safe corridor wanders by at most one lane per encounter, and BOTH the
 * departed and the entered lane are protected across a move, because the hitbox
 * occupies both. Do NOT weaken this to "leave any one lane open" -- that was
 * tried and 88% of roads became unwinnable. See DevDocs/decisions/0005.
 *
 * DETERMINISM
 * The road is a pure function of (seed, config). It never consults player state.
 */
import type { GameConfig } from './gameConfig.js';
import { Pcg32 } from './pcg32.js';
import { PositionTable } from './positionTable.js';
import { Hazard } from './hazard.js';
import { WEIGHT_SCALE, MILLI_SCALE } from './units.js';

// Separate PRNG streams, so that changing the traffic-speed logic does not
// shift which lanes receive hazards.
const STREAM_PLACEMENT = 1n;
const STREAM_KIND = 2n;
const STREAM_SPEED = 3n;
const STREAM_CORRIDOR = 4n;

export class RoadGenerator {
  private readonly config: GameConfig;
  private readonly positions: PositionTable;
  private readonly hazardList: Hazard[] = [];
  private readonly carLength: number;
  private readonly runwayTicks: number;

  private placement: Pcg32;
  private kind: Pcg32;
  private speed: Pcg32;
  private corridor: Pcg32;

  /** First tick at which each lane is clear again. */
  private readonly laneFreeFrom: number[];

  /** The lane guaranteed clear this encounter. Wanders by at most one lane. */
  private safeLane: number;

  private nextEncounterTick: number;

  /**
   * Hazards the generator declined to place because doing so would have closed
   * the last reachable scoring lane. A high number means the configured density
   * is fighting the safety invariant.
   */
  refusedPlacements = 0;

  /** Retained for the solvability report. */
  get rescuedEncounters(): number {
    return this.refusedPlacements;
  }

  /** Encounters where the roll produced no hazard at all. */
  emptyEncounters = 0;

  get hazards(): readonly Hazard[] {
    return this.hazardList;
  }

  constructor(config: GameConfig, seed: bigint) {
    this.config = config;
    this.positions = new PositionTable(config);
    this.carLength = config.carLengthUnits * config.positionScale;

    this.placement = new Pcg32(seed, STREAM_PLACEMENT);
    this.kind = new Pcg32(seed, STREAM_KIND);
    this.speed = new Pcg32(seed, STREAM_SPEED);
    this.corridor = new Pcg32(seed, STREAM_CORRIDOR);

    this.laneFreeFrom = new Array<number>(config.lanes.length).fill(0);
    this.safeLane = config.startLane;

    // The opening runway carries no hazards. Without it the generator can put a
    // car on top of the player before they have touched the screen.
    this.runwayTicks = this.tickAtOrAfter(config.startRunwayUnits * config.positionScale);
    this.nextEncounterTick = this.runwayTicks;
  }

  /** Builds the road far enough ahead to cover `tick`. */
  ensureGeneratedThrough(tick: number, _playerPosition: number): void {
    const horizon = tick + this.config.encounterIntervalTicks * 3;
    while (this.nextEncounterTick <= horizon) this.generateEncounter();
  }

  private generateEncounter(): void {
    const tick = this.nextEncounterTick;
    const interval = this.config.encounterIntervalTicks;

    // ---- the safe corridor -------------------------------------------------
    let corridorFrom = this.safeLane;
    let corridorTo = this.safeLane;

    if (tick >= this.runwayTicks) {
      const drift = this.corridor.nextInt(-1, 1);
      const candidate = this.safeLane + drift;
      if (
        drift !== 0 &&
        candidate >= 0 &&
        candidate < this.config.lanes.length &&
        this.config.lanes[candidate]!.role !== 'cashout' &&
        this.laneFreeFrom[candidate]! <= tick
      ) {
        corridorTo = candidate;
      }
    }

    // ---- roll and place --------------------------------------------------
    let emittedAny = false;

    for (let lane = 0; lane < this.config.lanes.length; lane++) {
      const chance = Math.trunc(
        (this.config.spawnChancePerSliceMilli * this.config.lanes[lane]!.hazardWeight) / WEIGHT_SCALE,
      );

      // Draw unconditionally, so that a lane which happens to be protected or
      // occupied does not desynchronise the streams for the other lanes.
      const roll = this.placement.nextFraction(WEIGHT_SCALE) < chance;
      const isTraffic = this.kind.nextFraction(WEIGHT_SCALE) < this.config.trafficShareMilli;
      const factor = this.speed.nextInt(
        this.config.trafficSpeedFactorMinMilli,
        this.config.trafficSpeedFactorMaxMilli,
      );

      if (tick < this.runwayTicks) continue; // opening runway is clear
      if (lane === corridorFrom || lane === corridorTo) {
        // the guaranteed escape
        if (roll) this.refusedPlacements++;
        continue;
      }
      if (!roll) continue;
      if (this.laneFreeFrom[lane]! > tick) continue; // an earlier hazard still occupies it

      const hazard = this.build(lane, tick, isTraffic, factor);
      this.hazardList.push(hazard);
      this.laneFreeFrom[lane] = this.lastBlockedTick(hazard) + 1;
      emittedAny = true;
    }

    if (!emittedAny) this.emptyEncounters++;

    this.safeLane = corridorTo;
    this.nextEncounterTick = tick + interval;
  }

  private build(lane: number, tick: number, isTraffic: boolean, factor: number): Hazard {
    const length =
      (isTraffic ? this.config.trafficLengthUnits : this.config.obstacleLengthUnits) * this.config.positionScale;

    // Place it AHEAD of the player, never on top of them.
    const start = this.positions.at(tick) + this.config.spawnLeadUnits * this.config.positionScale;
    const speed = isTraffic ? Math.trunc((this.config.speedAtTick(tick) * factor) / MILLI_SCALE) : 0;

    return new Hazard(isTraffic ? 'traffic' : 'obstacle', lane, start, length, speed, tick);
  }

  /**
   * Last tick at which a hazard still overlaps the player's hitbox. Stepped
   * rather than solved: the speed ramp makes the closing rate piecewise, and
   * stepping is exact where a closed form would need care. Bounded by the
   * encounter horizon so a pathological config cannot hang.
   */
  private lastBlockedTick(hazard: Hazard): number {
    const limit = hazard.spawnTick + this.config.maxEncounterWindowTicks;
    let last = hazard.spawnTick;
    let seenOverlap = false;

    for (let t = hazard.spawnTick; t <= limit; t++) {
      if (hazard.overlapsAt(t, this.positions.at(t), this.carLength)) {
        seenOverlap = true;
        last = t;
      } else if (seenOverlap) {
        break;
      }
    }
    return seenOverlap ? last : limit;
  }

  private tickAtOrAfter(position: number): number {
    let tick = 0;
    while (this.positions.at(tick) < position) tick++;
    return tick;
  }

  /**
   * Hazards that could touch the player at a tick. Walks backwards from the
   * newest and stops once hazards are far enough behind, so replay cost stays
   * linear in run length rather than quadratic.
   */
  collectNear(tick: number, _playerPosition: number, into: Hazard[]): void {
    into.length = 0;
    for (let i = this.hazardList.length - 1; i >= 0; i--) {
      const h = this.hazardList[i]!;
      if (h.spawnTick > tick + this.config.maxEncounterWindowTicks) continue;
      if (h.spawnTick + this.config.maxEncounterWindowTicks < tick) break;
      into.push(h);
    }
  }
}
