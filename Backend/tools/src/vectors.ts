/**
 * Tools/Vectors — regenerates Backend/testvectors/vectors.tsv from
 * @redline/sim-core and a game config.
 *
 * This is the harness `DevDocs/features/0002-submission-readiness/prompts/
 * T-102-vector-generator.md` asked for: the vector file's own header used to
 * name `redline vectors`, a .NET command that lived in `src/Redline.Tools` and
 * was deleted in the Firebase migration. Without a regenerator, the vector
 * file is a fixture nobody can reproduce, extend, or trust after the next
 * config change.
 *
 * WHAT THIS FILE DOES NOT DO
 *
 * It contains no game rules. Every row comes from calling `runSimulation` --
 * the same function the Cloud Functions score a real submission with -- and
 * writing down what came back. If this file ever computes a score itself,
 * that is a second implementation of the rules the whole vectors.tsv design
 * exists to prevent (two copies drift; the drift is exactly what a determinism
 * gate is supposed to catch).
 *
 * DETERMINISM
 *
 * The seeds are either a fixed arithmetic sequence (the legacy 24, kept
 * byte-for-byte reproducible) or individually hardcoded (the vectors added by
 * T-102, each chosen by a one-off search over the real simulation -- see the
 * comment on each one below for what property it was searched for). Nothing
 * here calls Math.random or reads the clock, so running this twice produces
 * byte-identical output.
 *
 *   npm --workspace @redline/tools run vectors -- --out Backend/testvectors/vectors.tsv
 *   npm --workspace @redline/tools run vectors -- --out /tmp/x.tsv --config Backend/config/redline.game.5lane.json
 *
 * `--config` exists for the same reason it exists on Tools/Solvability:
 * requirement #16 is "change the lane count from 4 to 5, live", and this
 * generator must not need editing to keep working when that happens.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGameConfig, runSimulation, parseInputLog, formatInputLog } from '@redline/sim-core';
import type { InputEvent, RunSimulationResult } from '@redline/sim-core';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const outArg = str('--out') ?? 'Backend/testvectors/vectors.tsv';
const outPath = isAbsolute(outArg) ? outArg : resolve(REPO_ROOT, outArg);
const configArg = str('--config');
const configPath = configArg
  ? isAbsolute(configArg)
    ? configArg
    : resolve(REPO_ROOT, configArg)
  : resolve(REPO_ROOT, 'Backend/config/redline.game.json');

const gameText = readFileSync(configPath, 'utf8');
const { config, configHash } = parseGameConfig(gameText);

// ---------------------------------------------------------------------------
// One vector: a recipe (seed, ceiling, swipes) plus the label a reviewer reads
// above it in the file. The generator supplies the recipe; runSimulation
// supplies every other column.
// ---------------------------------------------------------------------------
interface Scenario {
  readonly seed: bigint;
  readonly maxTicks: number;
  readonly events: readonly InputEvent[];
  readonly comment: string;
}

// ---------------------------------------------------------------------------
// The legacy 24 -- the vectors this file has always shipped, kept
// byte-for-byte reproducible by construction: a fixed base seed, a fixed
// step, and six input templates cycled four times. Recorded here exactly as
// they were before T-102 (nothing about the RECIPE changed); only the
// recorded OUTPUT columns can legitimately move, and only because
// Backend/config/redline.game.json's maxEncounterWindowTicks changed from 180 to 600
// this week (a deliberate, human-approved fix -- see CLAUDE.md and
// DevDocs/decisions -- not a generator bug or a sim-core-ts/sim-core-cs drift).
// ---------------------------------------------------------------------------
const LEGACY_BASE_SEED = 1592590336n;
const LEGACY_SEED_STEP = 7919n;
const LEGACY_CYCLES = 4;

const LEGACY_TEMPLATES: ReadonlyArray<{ maxTicks: number; events: readonly InputEvent[]; label: string }> = [
  {
    maxTicks: 1800,
    events: parseInputLog('-'),
    label: 'never swipes; stays in the start lane until it crashes or the run is abandoned',
  },
  {
    maxTicks: 600,
    events: parseInputLog('90R'),
    label: 'a single swipe toward the cashout side, then a bank attempt',
  },
  {
    maxTicks: 2400,
    events: parseInputLog('60L,80L,900R,920R,940R'),
    label: 'out and back early, then a late run at the cashout lane -- exercises the road generator across a wide tick range',
  },
  {
    maxTicks: 1500,
    events: parseInputLog(
      '120L,126R,132L,138R,144L,150R,156L,162R,168L,174R,180L,186R,192L,198R,204L,210R,216L,222R,228L,234R,240L,246R,252L,258R,264L,270R,276L,282R,288L,294R',
    ),
    // Every swipe alternates direction and lands 6 ticks after the previous
    // one (which takes 12 ticks to complete), so each is opposite the move
    // still in flight -- the reversal path, not the same-direction queue.
    label: 'alternating left-right swipes every 6 ticks, each one reversing the lane change already in flight',
  },
  {
    maxTicks: 900,
    events: parseInputLog('50R,80R,110R,140R,170R,200R,230R,260R'),
    // Verified against the actual output, not assumed: from startLane 2 the
    // first swipe (tick 50) already targets the cashout lane, and the run
    // banks as soon as that one move completes -- the seven later swipes in
    // the log are never reached. A comment claiming otherwise would be the
    // "vector nobody can explain" the task brief warns against.
    label: 'a steady cadence of same-direction swipes toward the cashout side; the first one banks the run before any of the later ones are read',
  },
  {
    maxTicks: 3000,
    events: parseInputLog('70L,1200R,1230R'),
    label: 'one early swipe, a long idle stretch, then a late pair toward cashout',
  },
];

function legacyVectors(): Scenario[] {
  const out: Scenario[] = [];
  for (let cycle = 0; cycle < LEGACY_CYCLES; cycle++) {
    for (const t of LEGACY_TEMPLATES) {
      const seed = LEGACY_BASE_SEED + LEGACY_SEED_STEP * BigInt(out.length);
      out.push({
        seed,
        maxTicks: t.maxTicks,
        events: t.events,
        comment: `[legacy ${out.length + 1}/24, cycle ${cycle + 1}/4] ${t.label}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// T-102's additions. Each seed was found by a one-off search over the real
// runSimulation (never a hand-computed score) for the specific property named
// in its comment -- see DevDocs/features/0002-submission-readiness/prompts/
// T-102-vector-generator.md's coverage list. Hardcoded rather than
// re-searched on every run: a search that could silently find a DIFFERENT
// qualifying seed next time would make the file non-reproducible, which is
// the one property this generator must not lose.
// ---------------------------------------------------------------------------
function extraVectors(): Scenario[] {
  return [
    {
      seed: 9030044686n,
      maxTicks: config.maxRunTicks,
      events: parseInputLog('-'),
      comment:
        'maximum-length run: reaches the tick cap (config.maxRunTicks) without banking or crashing -> Abandoned at endTick == maxTicks',
    },
    {
      seed: 7772682166416005758n,
      maxTicks: 500,
      events: parseInputLog('0L'),
      comment:
        'crash on the first possible tick: the earliest crash found over a wide search. startRunwayUnits + spawnLeadUnits guarantee a hazard-free zone at the start of every road, so nothing can crash near tick 0 by construction; this is that floor',
    },
    {
      seed: 7000000000n,
      maxTicks: 662,
      events: parseInputLog('-'),
      comment:
        "crash on the final tick: maxTicks is set to exactly (this seed's natural crash tick + 1), so endTick == maxTicks - 1 -- the boundary the run loop's `while (tick < maxTicks)` has to get exactly right",
    },
    {
      seed: 6000000000n,
      maxTicks: config.maxRunTicks,
      events: parseInputLog('200L,232L,264R,296R,328R'),
      comment:
        'banks having previously visited every lane: left, left, right, right, right walks lane 2 -> 1 -> 0 -> 1 -> 2 -> 3 (cashout) before banking, with 20+ ticks of settle time between swipes so no reversal or queueing is in play',
    },
    {
      seed: 1000000000n,
      maxTicks: 2000,
      events: parseInputLog('100L,132L,164L'),
      comment:
        'final lane 0, with a rejected input: the third left swipe is thrown at the leftmost lane (index 0) and is rejected as off-road (target < 0); rejectedInputs == 1. The run then crashes sitting in lane 0',
    },
    {
      seed: 4000000000n,
      maxTicks: 2000,
      events: parseInputLog('60L'),
      comment: 'final lane 1: one swipe left settles the car in lane 1, then it crashes there',
    },
    {
      seed: 3000000000n,
      maxTicks: 400,
      events: parseInputLog('100L,104R'),
      comment:
        'reversal mid-transit: swipe left at tick 100 starts a 12-tick move toward lane 1, then swipe right at tick 104 (before it completes) reverses it -- lane and targetLane swap, the timer mirrors, and the car settles back in the ORIGINAL lane rather than the one it swiped toward',
    },
    {
      seed: 14518968876424411753n,
      maxTicks: 780,
      events: parseInputLog('380L'),
      comment:
        'collision during a lane change: the crash lands while changeTicksRemaining > 0 (mid-transit), exercising invariant 5 -- the hitbox occupies BOTH lanes and the effective multiplier is the lower of the two while changing',
    },
    {
      seed: 13755318504167525298n,
      maxTicks: 2000,
      events: parseInputLog('320R'),
      comment:
        'score decided by a single tick, A of an A/B pair: swipes to cashout at tick 320 and banks scoring 119. Compare the next vector: same seed, same everything, swipe one tick later',
    },
    {
      seed: 13755318504167525298n,
      maxTicks: 2000,
      events: parseInputLog('321R'),
      comment:
        'score decided by a single tick, B of the pair above: identical run, swipe at tick 321 instead of 320 -- one extra tick of travel before the lane change starts banks a strictly higher score (119 -> 120), which is the whole reason the accumulator has to be exact to the tick rather than "close"',
    },
  ];
}

// ---------------------------------------------------------------------------
// Formatting -- TSV columns, in the order every reader (vectors.test.ts,
// VectorReplayTests.cs) already parses them in. Not renegotiable: two test
// suites depend on this exact order and neither is in this task's scope.
// ---------------------------------------------------------------------------
function formatRow(s: Scenario, r: RunSimulationResult): string {
  return [
    s.seed.toString(),
    String(s.maxTicks),
    formatInputLog(s.events),
    r.outcome,
    String(r.score),
    r.scoreUnits.toString(), // bigint -- exact, never routed through a float
    String(r.endTick),
    String(r.distance),
    String(r.finalLane),
    String(r.rejectedInputs),
  ].join('\t');
}

function render(scenarios: readonly Scenario[]): string {
  const lines: string[] = [
    '# REDLINE test vectors',
    '#',
    '# Generated by: Tools/Vectors (Backend/tools/src/vectors.ts).',
    '# Each line is one recorded run. The Unity EditMode test suite and the',
    '# sim-core-ts test suite both replay these and assert an exact match, which',
    '# is how client/server agreement is proven rather than asserted.',
    '#',
    `# configHash: ${configHash}`,
    `# lanes: ${config.lanes.length}  cashout: ${config.cashoutLane}  tickRate: ${config.ticksPerSecond}`,
    '#',
    '# seed\tmaxTicks\tinputs\toutcome\tscore\tscoreUnits\tendTick\tdistance\tfinalLane\trejected',
  ];

  for (const s of scenarios) {
    const r = runSimulation(config, { seed: s.seed, events: s.events, maxRunTicks: s.maxTicks });
    lines.push(`# ${s.comment}`);
    lines.push(formatRow(s, r));
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
const scenarios = [...legacyVectors(), ...extraVectors()];
const text = render(scenarios);
writeFileSync(outPath, text, 'utf8');
console.log(`wrote ${scenarios.length} vectors to ${outPath} (config ${configPath}, hash ${configHash})`);

// ---------------------------------------------------------------------------
function str(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}
