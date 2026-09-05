/**
 * The rules of the game, ported verbatim from
 * Backend/sim-core-cs/Runtime/Config/GameConfig.cs.
 *
 * Nothing in the simulation hardcodes a lane count: it is `laneCount`, taken
 * from the length of the lanes array. Review requirement #16 is to change four
 * lanes to five live, so any new lane-dependent logic must be written against
 * this object.
 *
 * `configHash` is computed over the raw file bytes with FNV-1a. The server
 * stamps it on every run; a client whose config hashes differently is rejected
 * rather than being quietly scored against different rules. This value MUST
 * match the C# core's `GameConfig.ComputeHash` output exactly -- the parity
 * test asserts Backend/config/redline.game.json hashes to 5088b8b1eac58908 (see
 * test/configHash.test.ts for the history of why this value has moved).
 */
import { JsonValue, JsonError } from './json.js';
import { MILLI_SCALE, WEIGHT_SCALE, positionScale } from './units.js';

export type LaneRole = 'scoring' | 'cashout';

export interface LaneConfig {
  readonly index: number;
  /** Score multiplier. The cashout lane is 0 -- it scores nothing. */
  readonly multiplier: number;
  readonly role: LaneRole;
  /** Relative hazard density, in thousandths (0.55 -> 550). */
  readonly hazardWeight: number;
}

export class GameConfig {
  readonly configVersion: number;
  readonly lanes: readonly LaneConfig[];
  readonly startLane: number;
  /** Index of the lane that banks the run on full arrival. */
  readonly cashoutLane: number;

  readonly ticksPerSecond: number;
  /**
   * Hard stop for a run, in ticks. A run reaching it without banking or
   * crashing is Abandoned. Shared and hashed because it decides an outcome.
   */
  readonly maxRunTicks: number;

  readonly speedStartMilli: number;
  readonly speedRampMilli: number;
  readonly speedRampIntervalTicks: number;
  readonly speedMaxMilli: number;

  readonly laneChangeDurationTicks: number;
  readonly maxQueuedInputs: number;

  readonly carLengthUnits: number;

  readonly trafficSpeedFactorMinMilli: number;
  readonly trafficSpeedFactorMaxMilli: number;
  readonly minLongitudinalGapUnits: number;
  readonly startRunwayUnits: number;
  readonly spawnLeadUnits: number;
  readonly encounterIntervalTicks: number;
  readonly maxEncounterWindowTicks: number;
  readonly obstacleLengthUnits: number;
  readonly trafficLengthUnits: number;
  readonly spawnChancePerSliceMilli: number;
  readonly trafficShareMilli: number;

  /** Derived: position units per game unit. */
  readonly positionScale: number;

  readonly configHash: string;

  private constructor(root: JsonValue, rawText: string) {
    this.configVersion = root.get('configVersion').asInt();

    const lanes: LaneConfig[] = [];
    let cashout = -1;
    for (const laneJson of root.get('lanes').items()) {
      const index = laneJson.get('index').asInt();
      if (index !== lanes.length) {
        throw new JsonError(
          `lane at position ${lanes.length} declares index ${index}; lanes must be listed in order from 0`,
        );
      }

      const roleText = laneJson.get('role').asString();
      let role: LaneRole;
      if (roleText === 'scoring') role = 'scoring';
      else if (roleText === 'cashout') role = 'cashout';
      else throw new JsonError(`unknown lane role '${roleText}'`);

      if (role === 'cashout') {
        if (cashout >= 0) throw new JsonError('more than one cashout lane; exactly one is required');
        cashout = index;
      }

      lanes.push({
        index,
        multiplier: laneJson.get('multiplier').asInt(),
        role,
        hazardWeight: laneJson.get('hazardWeight').asScaled(WEIGHT_SCALE),
      });
    }

    if (lanes.length < 2) throw new JsonError('at least two lanes are required (one scoring, one cashout)');
    if (cashout < 0) throw new JsonError("no cashout lane declared; exactly one lane must have role 'cashout'");

    this.lanes = lanes;
    this.cashoutLane = cashout;

    this.startLane = root.get('startLane').asInt();
    if (this.startLane < 0 || this.startLane >= lanes.length) {
      throw new JsonError(`startLane ${this.startLane} is outside the ${lanes.length} configured lanes`);
    }
    if (lanes[this.startLane]!.role === 'cashout') {
      throw new JsonError('startLane cannot be the cashout lane; the run would bank instantly');
    }

    const time = root.get('time');
    this.ticksPerSecond = time.get('ticksPerSecond').asInt();
    if (this.ticksPerSecond <= 0) throw new JsonError('ticksPerSecond must be positive');

    this.maxRunTicks = time.get('maxRunTicks').asInt();
    if (this.maxRunTicks <= 0) throw new JsonError('maxRunTicks must be positive');

    const speed = root.get('speed');
    this.speedStartMilli = speed.get('startMilliUnitsPerSec').asInt();
    this.speedRampMilli = speed.get('rampMilliUnitsPerSec').asInt();
    this.speedRampIntervalTicks = speed.get('rampIntervalTicks').asInt();
    this.speedMaxMilli = speed.get('maxMilliUnitsPerSec').asInt();
    if (this.speedStartMilli <= 0) throw new JsonError('startMilliUnitsPerSec must be positive');
    if (this.speedRampIntervalTicks <= 0) throw new JsonError('rampIntervalTicks must be positive');
    if (this.speedMaxMilli < this.speedStartMilli) throw new JsonError('maxMilliUnitsPerSec is below the start speed');

    const laneChange = root.get('laneChange');
    this.laneChangeDurationTicks = laneChange.get('durationTicks').asInt();
    this.maxQueuedInputs = laneChange.get('maxQueuedInputs').asInt();
    if (this.laneChangeDurationTicks <= 0) throw new JsonError('laneChange.durationTicks must be positive');
    if (this.maxQueuedInputs < 0) throw new JsonError('laneChange.maxQueuedInputs cannot be negative');

    this.carLengthUnits = Number(root.get('player').get('carLengthUnits').asLong());
    if (this.carLengthUnits <= 0) throw new JsonError('player.carLengthUnits must be positive');

    const hazards = root.get('hazards');
    this.trafficSpeedFactorMinMilli = hazards.get('trafficSpeedFactorMin').asScaled(MILLI_SCALE);
    this.trafficSpeedFactorMaxMilli = hazards.get('trafficSpeedFactorMax').asScaled(MILLI_SCALE);
    if (this.trafficSpeedFactorMinMilli <= 0 || this.trafficSpeedFactorMaxMilli >= MILLI_SCALE) {
      throw new JsonError(
        'traffic speed factors must sit strictly between 0 and 1; traffic must be slower than the player',
      );
    }
    if (this.trafficSpeedFactorMaxMilli < this.trafficSpeedFactorMinMilli) {
      throw new JsonError('trafficSpeedFactorMax is below trafficSpeedFactorMin');
    }

    this.minLongitudinalGapUnits = Number(hazards.get('minLongitudinalGapUnits').asLong());
    if (this.minLongitudinalGapUnits <= 0) throw new JsonError('minLongitudinalGapUnits must be positive');

    this.spawnLeadUnits = Number(hazards.get('spawnLeadUnits').asLong());
    if (this.spawnLeadUnits <= 0) {
      throw new JsonError(
        'spawnLeadUnits must be positive; a hazard on top of the player is unavoidable by construction',
      );
    }

    this.encounterIntervalTicks = hazards.get('encounterIntervalTicks').asInt();
    this.maxEncounterWindowTicks = hazards.get('maxEncounterWindowTicks').asInt();
    if (this.encounterIntervalTicks <= 0) throw new JsonError('encounterIntervalTicks must be positive');
    if (this.maxEncounterWindowTicks <= this.encounterIntervalTicks) {
      throw new JsonError('maxEncounterWindowTicks must exceed encounterIntervalTicks');
    }

    this.startRunwayUnits = Number(hazards.get('startRunwayUnits').asLong());
    if (this.startRunwayUnits < 0) throw new JsonError('startRunwayUnits cannot be negative');

    this.obstacleLengthUnits = Number(hazards.get('obstacleLengthUnits').asLong());
    this.trafficLengthUnits = Number(hazards.get('trafficLengthUnits').asLong());
    if (this.obstacleLengthUnits <= 0 || this.trafficLengthUnits <= 0) {
      throw new JsonError('hazard lengths must be positive');
    }
    if (
      this.obstacleLengthUnits >= this.minLongitudinalGapUnits ||
      this.trafficLengthUnits >= this.minLongitudinalGapUnits
    ) {
      throw new JsonError('a hazard must be shorter than the slice gap, or slices would overlap');
    }

    this.spawnChancePerSliceMilli = hazards.get('spawnChancePerSlice').asScaled(WEIGHT_SCALE);
    this.trafficShareMilli = hazards.get('trafficShare').asScaled(WEIGHT_SCALE);
    if (this.spawnChancePerSliceMilli < 0 || this.spawnChancePerSliceMilli > WEIGHT_SCALE) {
      throw new JsonError('spawnChancePerSlice must be between 0 and 1');
    }
    if (this.trafficShareMilli < 0 || this.trafficShareMilli > WEIGHT_SCALE) {
      throw new JsonError('trafficShare must be between 0 and 1');
    }

    this.positionScale = positionScale(this.ticksPerSecond);
    this.configHash = GameConfig.computeHash(rawText);
  }

  static parse(jsonText: string): GameConfig {
    if (jsonText === null || jsonText === undefined) throw new Error('jsonText is required');
    return new GameConfig(JsonValue.parse(jsonText), jsonText);
  }

  /** Multiplier for a lane index. */
  multiplierOf(lane: number): number {
    return this.lanes[lane]!.multiplier;
  }

  /**
   * The effective multiplier while occupying `from` and moving toward `to`: the
   * LOWER of the two. Mandatory -- without it a player parks on a lane boundary
   * claiming 5x while keeping the car in the safer lane. Review test #5.
   */
  effectiveMultiplier(from: number, to: number): number {
    const a = this.lanes[from]!.multiplier;
    const b = this.lanes[to]!.multiplier;
    return a < b ? a : b;
  }

  /**
   * Forward speed in milli-units/second at a tick. A pure function of the tick
   * index -- it does not depend on lane, score, or anything the player did.
   */
  speedAtTick(tick: number): number {
    if (tick < 0) throw new RangeError(`tick must be non-negative, got ${tick}`);
    const steps = Math.floor(tick / this.speedRampIntervalTicks);
    const speed = this.speedStartMilli + steps * this.speedRampMilli;
    return speed >= this.speedMaxMilli ? this.speedMaxMilli : speed;
  }

  /**
   * FNV-1a over the raw config text, line endings normalised so a Windows and a
   * macOS checkout of the same file agree. Not a security control: an attacker
   * who can edit the config can also edit the hash. The defence against a
   * forged config is that the SERVER's config scores the run.
   */
  static computeHash(text: string): string {
    let normalised = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (c === '\r') {
        if (i + 1 < text.length && text[i + 1] === '\n') continue;
        normalised += '\n';
      } else {
        normalised += c;
      }
    }

    const offsetBasis = 14695981039346656037n;
    const prime = 1099511628211n;
    const mask = 0xffffffffffffffffn;

    let hash = offsetBasis;
    const bytes = new TextEncoder().encode(normalised);
    for (const b of bytes) {
      hash ^= BigInt(b);
      hash = (hash * prime) & mask;
    }
    return hash.toString(16).padStart(16, '0');
  }
}
