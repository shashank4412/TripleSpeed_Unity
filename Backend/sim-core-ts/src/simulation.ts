/**
 * The deterministic simulation. This is the score of record.
 * Ported verbatim from Backend/sim-core-cs/Runtime/Sim/Simulation.cs and
 * RunTypes.cs.
 *
 * The same rules run on the phone (as a renderer's data source) and here on the
 * server (as the authority). The client never submits a score; it submits the
 * seed it was issued and the swipes the player made, and the server runs this
 * and publishes the answer.
 *
 * Determinism rests on three properties, all checkable by reading this file:
 *   1. No floating point in the score path. Position is advanced by integer
 *      addition; the score accumulator is BigInt.
 *   2. No wall clock and no engine time. The loop is a tick counter.
 *   3. No ambient randomness. Every hazard comes from a seeded PCG32.
 */
import type { GameConfig } from './gameConfig.js';
import { RoadGenerator } from './roadGenerator.js';
import { Hazard } from './hazard.js';

/** A swipe. One swipe moves one lane; there is no free steering. */
export type SwipeDirection = -1 | 1; // Left = -1, Right = 1

/** How a run ended. Strings match the C# RunOutcome enum's ToString(). */
export type RunOutcome = 'Banked' | 'Crashed' | 'Abandoned' | 'Expired';

/** One recorded swipe. */
export interface InputEvent {
  readonly tick: number;
  readonly direction: SwipeDirection;
}

/** Everything needed to reproduce a run, and nothing else -- note the absence of a score. */
export interface RunInput {
  readonly seed: bigint;
  /** Swipes in tick order. At most one per tick. */
  readonly events: readonly InputEvent[];
  /** Hard stop for the replay. A run reaching it without banking or crashing is Abandoned. */
  readonly maxTicks: number;
}

/** The authoritative result of simulating a RunInput. */
export interface RunResult {
  readonly outcome: RunOutcome;
  /** Whole-number score shown to the player. Zero unless banked. */
  readonly score: number;
  /** Internal fixed-point score before the final divide. Kept for test vectors. */
  readonly scoreUnits: bigint;
  /** Tick on which the run ended. */
  readonly endTick: number;
  /** Distance travelled, in whole game units. */
  readonly distance: number;
  /** Lane occupied when the run ended. */
  readonly finalLane: number;
  /** Swipes the rules rejected -- out of bounds, or over the queue limit. */
  readonly rejectedInputs: number;
  /** Config the run was scored under. A mismatch invalidates comparison. */
  readonly configHash: string;
}

/** Live state of a run. */
export interface State {
  tick: number;
  /** Lane the car is in, or moving out of while changing. */
  lane: number;
  /** Lane being moved to. Equals `lane` when settled. */
  targetLane: number;
  /** Ticks left in the current lane change. Zero when settled. */
  changeTicksRemaining: number;
  /** Buffered swipe, or null. At most one, per the rules. */
  queued: SwipeDirection | null;
  /** Road position, in position units. */
  position: number;
  /** Score accumulator, in position units. Divided once, at the end. BigInt: this is the score of record. */
  scoreUnits: bigint;
  rejectedInputs: number;
}

export type TickOutcome = 'running' | 'banked' | 'crashed';

export function isChangingLanes(state: State): boolean {
  return state.changeTicksRemaining > 0;
}

/** A run's starting state. The client and `run` must not disagree about it. */
export function newState(config: GameConfig): State {
  return {
    tick: 0,
    lane: config.startLane,
    targetLane: config.startLane,
    changeTicksRemaining: 0,
    queued: null,
    position: 0,
    scoreUnits: 0n,
    rejectedInputs: 0,
  };
}

/**
 * Advances exactly one tick. THIS IS THE ONLY IMPLEMENTATION OF THE RULES.
 * `run` is a loop around this method precisely so there is nothing to drift.
 *
 * @param scratch reused hazard buffer; contents are not preserved between calls
 * @param swipe   the swipe made on this tick, or null; at most one, a swipe is discrete
 */
export function advance(
  config: GameConfig,
  state: State,
  road: RoadGenerator,
  scratch: Hazard[],
  swipe: SwipeDirection | null,
): TickOutcome {
  // ---- 1. input ------------------------------------------------
  // Applied before movement so a swipe takes effect on the tick it was made.
  if (swipe !== null) applySwipe(config, state, swipe);

  // ---- 2. advance the lane change -----------------------------
  let arrived = false;
  if (state.changeTicksRemaining > 0) {
    state.changeTicksRemaining--;
    if (state.changeTicksRemaining === 0) {
      state.lane = state.targetLane;
      arrived = true;
    }
  }

  // A queued swipe starts only once the car has settled.
  if (state.changeTicksRemaining === 0 && state.queued !== null) {
    const queued = state.queued;
    state.queued = null;
    startChange(config, state, queued);
  }

  // ---- 3. banking --------------------------------------------
  // Only on FULL arrival in the cashout lane. Not on the swipe. Returns without
  // advancing the tick, so endTick is the tick the run ended ON.
  if (arrived && state.lane === config.cashoutLane) return 'banked';

  // ---- 4. movement and score --------------------------------
  const speedMilli = config.speedAtTick(state.tick);
  state.position += speedMilli;
  state.scoreUnits += BigInt(speedMilli) * BigInt(effectiveMultiplier(config, state));

  // ---- 5. collision ----------------------------------------
  road.ensureGeneratedThrough(state.tick, state.position);
  road.collectNear(state.tick, state.position, scratch);

  const playerLength = config.carLengthUnits * config.positionScale;
  for (let i = 0; i < scratch.length; i++) {
    const hazard = scratch[i]!;
    if (!occupiesLane(state, hazard.lane)) continue;
    if (!hazard.overlapsAt(state.tick, state.position, playerLength)) continue;
    return 'crashed';
  }

  state.tick++;
  return 'running';
}

/**
 * The multiplier in force this tick: while changing lanes it is the LOWER of
 * origin and destination. Mandatory -- closes the boundary-parking exploit.
 * Review test #5 probes this directly.
 */
export function effectiveMultiplier(config: GameConfig, state: State): number {
  return isChangingLanes(state)
    ? config.effectiveMultiplier(state.lane, state.targetLane)
    : config.multiplierOf(state.lane);
}

/**
 * Whether the car's hitbox covers a lane this tick. While changing, it covers
 * BOTH origin and destination -- crossing traffic is the risk, and that risk
 * has to be real.
 */
function occupiesLane(state: State, lane: number): boolean {
  return lane === state.lane || (isChangingLanes(state) && lane === state.targetLane);
}

function applySwipe(config: GameConfig, state: State, direction: SwipeDirection): void {
  if (!isChangingLanes(state)) {
    startChange(config, state, direction);
    return;
  }

  // Reversal is always legal and is never queued behind the move in flight.
  const inFlight = Math.sign(state.targetLane - state.lane);
  if (inFlight === -direction) {
    // Swap ends and mirror the timer.
    const tmp = state.lane;
    state.lane = state.targetLane;
    state.targetLane = tmp;
    state.changeTicksRemaining = config.laneChangeDurationTicks - state.changeTicksRemaining;

    state.queued = null; // the reversal supersedes anything buffered

    if (state.changeTicksRemaining === 0) state.lane = state.targetLane;
    return;
  }

  // Same direction as the move in flight: buffer it, up to the limit.
  if (state.queued !== null || config.maxQueuedInputs === 0) {
    // A third swipe while one is in flight and one is queued is discarded.
    state.rejectedInputs++;
    return;
  }

  state.queued = direction;
}

function startChange(config: GameConfig, state: State, direction: SwipeDirection): void {
  const target = state.lane + direction;

  // Swiping left in lane 0 or right in the last lane is a no-op, but it still
  // HAPPENED. Counted here and recorded in the submission.
  if (target < 0 || target >= config.lanes.length) {
    state.rejectedInputs++;
    return;
  }

  state.targetLane = target;
  state.changeTicksRemaining = config.laneChangeDurationTicks;
}

/**
 * The result a run in progress would produce if it ended now. The client uses
 * it to show a live score; the server's answer is still the one that counts.
 */
export function result(config: GameConfig, state: State, outcome: RunOutcome): RunResult {
  return finish(config, state, outcome);
}

function finish(config: GameConfig, state: State, outcome: RunOutcome): RunResult {
  // A crash zeroes the score. No revives, no continues. The zero is the product.
  const scoreUnits = outcome === 'Banked' ? state.scoreUnits : 0n;
  const scale = BigInt(config.positionScale);

  return {
    outcome,
    score: Number(scoreUnits / scale),
    scoreUnits,
    endTick: state.tick,
    distance: Math.floor(state.position / config.positionScale),
    finalLane: state.lane,
    rejectedInputs: state.rejectedInputs,
    configHash: config.configHash,
  };
}

/** Runs a submission to completion and returns the authoritative result. */
export function run(config: GameConfig, input: RunInput): RunResult {
  if (input.maxTicks <= 0) throw new RangeError('maxTicks must be positive');
  for (let i = 1; i < input.events.length; i++) {
    if (input.events[i]!.tick < input.events[i - 1]!.tick) {
      throw new Error(`input events must be in tick order; event ${i} goes backwards`);
    }
    if (input.events[i]!.tick === input.events[i - 1]!.tick) {
      throw new Error(`two input events share tick ${input.events[i]!.tick}; a swipe is discrete`);
    }
  }
  if (input.events.length > 0 && input.events[0]!.tick < 0) {
    throw new Error('input event tick cannot be negative');
  }

  const state = newState(config);
  const road = new RoadGenerator(config, input.seed);
  const near: Hazard[] = [];
  let nextEvent = 0;

  while (state.tick < input.maxTicks) {
    // RunInput guarantees at most one event per tick.
    let swipe: SwipeDirection | null = null;
    if (nextEvent < input.events.length && input.events[nextEvent]!.tick === state.tick) {
      swipe = input.events[nextEvent]!.direction;
      nextEvent++;
    }

    const outcome = advance(config, state, road, near, swipe);
    if (outcome === 'banked') return finish(config, state, 'Banked');
    if (outcome === 'crashed') return finish(config, state, 'Crashed');
  }

  // Ran out of ticks without banking or crashing: incomplete, scores nothing,
  // settles as a loss.
  return finish(config, state, 'Abandoned');
}
