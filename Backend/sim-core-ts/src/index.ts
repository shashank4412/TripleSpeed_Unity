/**
 * REDLINE deterministic simulation core -- public surface.
 *
 * Ported byte-for-byte from Backend/sim-core-cs. The Cloud Functions, the proof
 * harness and the operator tools all import THIS module, so there is exactly one
 * implementation of the rules that decide a score. Zero runtime dependencies.
 */
export { GameConfig } from './gameConfig.js';
export type { LaneConfig, LaneRole } from './gameConfig.js';
export { JsonValue, JsonError } from './json.js';
export { Pcg32 } from './pcg32.js';
export { Hazard } from './hazard.js';
export type { HazardKind } from './hazard.js';
export { PositionTable } from './positionTable.js';
export { RoadGenerator } from './roadGenerator.js';
export { RoadSolvability, SolvabilityReport } from './roadSolvability.js';
export * as Sim from './simulation.js';
export {
  newState,
  advance,
  run,
  result,
  effectiveMultiplier,
  isChangingLanes,
} from './simulation.js';
export type {
  SwipeDirection,
  RunOutcome,
  InputEvent,
  RunInput,
  RunResult,
  State,
  TickOutcome,
} from './simulation.js';

import { GameConfig } from './gameConfig.js';
import { run as runCore } from './simulation.js';
import type { InputEvent, RunOutcome, SwipeDirection } from './simulation.js';

/**
 * Parse the game rules text and return the config plus its hash. The hash is
 * FNV-1a over the raw bytes with line endings normalised; submitRun rejects a
 * submission whose configHash disagrees with the server's, it never rescopes.
 */
export function parseGameConfig(text: string): { config: GameConfig; configHash: string } {
  const config = GameConfig.parse(text);
  return { config, configHash: config.configHash };
}

export interface RunSimulationInput {
  /** The server-issued seed. 64-bit; pass as BigInt or a decimal string. */
  seed: bigint | string;
  /** Swipes in strict tick order, at most one per tick. */
  events: readonly InputEvent[];
  /** Hard replay ceiling. Defaults to config.maxRunTicks. */
  maxRunTicks?: number;
}

export interface RunSimulationResult {
  score: number;
  outcome: RunOutcome;
  endTick: number;
  distance: number;
  finalLane: number;
  rejectedInputs: number;
  configHash: string;
  /** Internal fixed-point score before the display divide. Not part of the wire result. */
  scoreUnits: bigint;
}

/**
 * Re-simulate a submission from the server-issued seed and the server's config.
 * The score and outcome this returns are the score of record.
 */
export function runSimulation(config: GameConfig, input: RunSimulationInput): RunSimulationResult {
  const seed = typeof input.seed === 'bigint' ? input.seed : BigInt(input.seed);
  const maxTicks = input.maxRunTicks ?? config.maxRunTicks;

  const r = runCore(config, { seed, events: input.events, maxTicks });
  return {
    score: r.score,
    outcome: r.outcome,
    endTick: r.endTick,
    distance: r.distance,
    finalLane: r.finalLane,
    rejectedInputs: r.rejectedInputs,
    configHash: r.configHash,
    scoreUnits: r.scoreUnits,
  };
}

/**
 * Parse the compact input-log form used by the test vectors and the wire:
 * "-" or "" -> no events; otherwise a comma list of "<tick><L|R>", e.g.
 * "90R,120L,126R". Throws on anything malformed rather than silently dropping.
 */
export function parseInputLog(field: string): InputEvent[] {
  const events: InputEvent[] = [];
  if (field === '-' || field.length === 0) return events;
  for (const token of field.split(',')) {
    const trimmed = token.trim();
    const suffix = trimmed[trimmed.length - 1];
    const dir: SwipeDirection = suffix === 'L' ? -1 : suffix === 'R' ? 1 : (() => {
      throw new Error(`input token '${trimmed}' must end in L or R`);
    })();
    const tickText = trimmed.slice(0, -1);
    if (!/^\d+$/.test(tickText)) throw new Error(`input token '${trimmed}' has a non-numeric tick`);
    events.push({ tick: Number(tickText), direction: dir });
  }
  return events;
}

/** Serialise events back to the compact input-log form. */
export function formatInputLog(events: readonly InputEvent[]): string {
  if (events.length === 0) return '-';
  return events.map((e) => `${e.tick}${e.direction === -1 ? 'L' : 'R'}`).join(',');
}
