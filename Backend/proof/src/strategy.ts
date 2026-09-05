/**
 * A driver bot. It plays a real run through the SHARED core (newState/advance),
 * so the score it produces is scored by exactly the code the server runs — the
 * proof is not simulating the game, it is playing it.
 *
 * Behaviour: drive forward; if a hazard is about to overlap the current lane,
 * try to step to a safe neighbour (success gated by `skill`); once the score
 * passes `targetUnitsScore`, head for the cashout lane whenever the step is
 * safe. `targetUnitsScore` is the greed decision — a poster sets it blind, a
 * challenger who can see the poster's number sets it one above.
 */
import {
  newState,
  advance,
  result as coreResult,
  RoadGenerator,
  Hazard,
  type GameConfig,
  type InputEvent,
  type RunOutcome,
  type SwipeDirection,
  type State,
} from '@redline/sim-core';
import type { Rng } from './rng.js';

export interface PlayedRun {
  events: InputEvent[];
  score: number;
  outcome: RunOutcome;
  endTick: number;
}

export function playRun(
  config: GameConfig,
  seed: bigint,
  targetScore: number,
  skill: number,
  rng: Rng,
): PlayedRun {
  const state = newState(config);
  const road = new RoadGenerator(config, seed);
  const scratch: Hazard[] = [];
  const events: InputEvent[] = [];
  const cashout = config.cashoutLane;

  let outcome: RunOutcome = 'Abandoned';

  while (state.tick < config.maxRunTicks) {
    // Peek at hazards near the player this tick.
    road.ensureGeneratedThrough(state.tick, state.position);
    road.collectNear(state.tick, state.position, scratch);

    const banking = displayScore(config, state) >= targetScore;
    const swipe = decide(config, state, scratch, banking, cashout, skill, rng);
    if (swipe !== null) events.push({ tick: state.tick, direction: swipe });

    const tick = advance(config, state, road, scratch, swipe);
    if (tick === 'banked') {
      outcome = 'Banked';
      break;
    }
    if (tick === 'crashed') {
      outcome = 'Crashed';
      break;
    }
  }

  const r = coreResult(config, state, outcome);
  return { events, score: r.score, outcome: r.outcome, endTick: r.endTick };
}

function displayScore(config: GameConfig, state: State): number {
  // The bot's greed threshold must be compared against the SAME number the
  // player sees and the server settles on, so it uses the core's own divisor.
  // This previously divided by 1000n, which is MILLI_SCALE alone rather than
  // positionScale = MILLI_SCALE * ticksPerSecond (60000 at 60 tps). That made
  // every simulated score read 60x high, so the bot banked at 1/60th of its
  // intended target and every run in the proof was far shorter than a real one.
  return Number(state.scoreUnits / BigInt(config.positionScale));
}

function decide(
  config: GameConfig,
  state: State,
  hazards: readonly Hazard[],
  banking: boolean,
  cashout: number,
  skill: number,
  rng: Rng,
): SwipeDirection | null {
  if (state.changeTicksRemaining > 0) return null; // already moving

  const lane = state.lane;
  const speed = config.speedAtTick(state.tick);
  const danger = (l: number): boolean => {
    for (const h of hazards) {
      if (h.lane !== l) continue;
      for (let k = 1; k <= config.laneChangeDurationTicks + 6; k++) {
        if (h.overlapsAt(state.tick + k, state.position + speed * k, config.carLengthUnits * config.positionScale)) {
          return true;
        }
      }
    }
    return false;
  };

  const canGo = (l: number): boolean => l >= 0 && l < config.lanes.length && !danger(l);

  if (danger(lane)) {
    // Must move. Prefer the direction that is both safe and toward a better spot.
    const left = canGo(lane - 1);
    const right = canGo(lane + 1);
    if (rng.next() > skill) return left ? -1 : right ? 1 : null; // fumbled but still tries
    if (left && right) return banking ? 1 : rng.next() < 0.5 ? -1 : 1;
    if (left) return -1;
    if (right) return 1;
    return null; // trapped — the core will decide the crash
  }

  if (banking && lane < cashout && canGo(lane + 1)) return 1;

  // Not banking: occasionally chase the 5x lane if it is safe.
  if (!banking && lane > 0 && rng.next() < 0.03 && canGo(lane - 1)) return -1;

  return null;
}
