/**
 * Entry point. Reads the committed config (the same JSON Remote Config serves),
 * runs the control and treatment arms, prints the report and writes the CSVs
 * behind it.
 *
 *   node lib/main.js [--players N] [--matches N] [--seed N] [--out DIR]
 *
 * Defaults are the brief's: 2,000 players, 50,000 matches.
 *
 * The default output directory comes from `Backend/config/sim.json`. That file was
 * written for the retired C# harness and this is the ONLY key of it anything
 * still reads — see DevDocs/simulation-report.md §0. Honouring it here rather than
 * hardcoding a path keeps the one live promise the file makes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseGameConfig } from '@redline/sim-core';
import { parseEconomyConfig } from '@redline/rating';
import { runArm } from './harness.js';
import { renderReport } from './report.js';
import { writeCsvs } from './csv.js';
import type { AnomalyConfig } from './population.js';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

function strArg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

const players = arg('players', 2000);
const matches = arg('matches', 50000);
const seed = arg('seed', 20260101);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const gameText = readFileSync(join(repoRoot, 'Backend/config/redline.game.json'), 'utf8');
const economyText = readFileSync(join(repoRoot, 'Backend/config/redline.economy.json'), 'utf8');
const simText = readFileSync(join(repoRoot, 'Backend/config/sim.json'), 'utf8');
const seedText = readFileSync(join(repoRoot, 'Backend/config/seed.json'), 'utf8');

const { config: game, configHash: gameHash } = parseGameConfig(gameText);
const economy = parseEconomyConfig(economyText);
const simConfig = JSON.parse(simText) as { output?: { directory?: string } };
// Task 3: Backend/config/seed.json's planted sandbagger + smurf — the two
// BEHAVIOURAL anomalies (no shared identity signal) nothing in production
// detects. Only these two blocks are wired; collusionPair/stealthPair are
// out of scope here — that identity-based collusion shape is already
// exercised by the harness's own `collusionPairs` mechanism and reported in
// the "Collusion exclusion" section.
const seedConfig = JSON.parse(seedText) as { anomalies: { sandbagger: AnomalyConfig['sandbagger']; smurf: AnomalyConfig['smurf'] } };
const anomalies: AnomalyConfig = {
  sandbagger: seedConfig.anomalies.sandbagger,
  smurf: seedConfig.anomalies.smurf,
};

const outArg = strArg('out');
const outDir = outArg
  ? isAbsolute(outArg)
    ? outArg
    : resolve(process.cwd(), outArg)
  : join(repoRoot, simConfig.output?.directory ?? 'artifacts/sim-output');

const opts = {
  players,
  matches,
  startingBalanceCents: 100_00,
  collusionPairs: Math.round(players * 0.02),
  seed,
  anomalies,
};

const startedAt = Date.now();
console.error(`running control arm (${players} players, ${matches} matches)…`);
const control = await runArm('control', game, economy, opts);
console.error('running treatment arm…');
const treatment = await runArm('treatment', game, economy, opts);
const runtimeSeconds = (Date.now() - startedAt) / 1000;

// The report itself carries no runtime: a wall clock in the committed text
// would change on every machine and make `diff` between two runs non-empty,
// which is the reproducibility check. It goes to stderr and to run.csv only if
// the caller asked for a directory that is not the committed one.
const report = renderReport(control, treatment, { provisionalMatches: economy.rating.provisionalMatches });
console.log(report);
console.error(`runtime: ${runtimeSeconds.toFixed(2)}s wall clock, both arms`);

const files = writeCsvs(outDir, control, treatment, {
  provisionalMatches: economy.rating.provisionalMatches,
  players,
  matches,
  seed,
  gameConfigHash: gameHash,
});
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.txt'), report + '\n', 'utf8');
console.error(`wrote ${files.length + 1} files to ${outDir}`);
