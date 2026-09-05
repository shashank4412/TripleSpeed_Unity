/**
 * Tools/Simulate — runs the fairness proof and prints the report. A thin
 * re-export of @redline/proof so `Tools/Simulate` and `npm run proof` produce
 * the same numbers.
 *
 *   npm --workspace @redline/tools run simulate -- --players 2000 --matches 50000
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseGameConfig } from '@redline/sim-core';
import { parseEconomyConfig } from '@redline/rating';
import { runArm } from '@redline/proof/harness';
import { renderReport } from '@redline/proof/report';
import { writeCsvs } from '@redline/proof/csv';
function num(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
function str(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const players = num('--players', 2000);
const matches = num('--matches', 50000);
const seed = num('--seed', 20260101);
const repoRoot = new URL('../../../', import.meta.url).pathname;
const gameText = readFileSync(join(repoRoot, 'Backend/config/redline.game.json'), 'utf8');
const economyText = readFileSync(join(repoRoot, 'Backend/config/redline.economy.json'), 'utf8');
const simText = readFileSync(join(repoRoot, 'Backend/config/sim.json'), 'utf8');
const { config: game, configHash: gameHash } = parseGameConfig(gameText);
const economy = parseEconomyConfig(economyText);
const simConfig = JSON.parse(simText);
const opts = { players, matches, startingBalanceCents: 10000, collusionPairs: Math.round(players * 0.02), seed };
const outArg = str('--out');
const outDir = outArg
    ? isAbsolute(outArg)
        ? outArg
        : resolve(process.cwd(), outArg)
    : join(repoRoot, simConfig.output?.directory ?? 'artifacts/sim-output');
const control = await runArm('control', game, economy, opts);
const treatment = await runArm('treatment', game, economy, opts);
// Same options object as Backend/proof/src/main.ts, so `Tools/Simulate` and
// `npm run proof` cannot drift into printing different numbers from one run.
const report = renderReport(control, treatment, { provisionalMatches: economy.rating.provisionalMatches });
console.log(report);
const files = writeCsvs(outDir, control, treatment, {
    provisionalMatches: economy.rating.provisionalMatches,
    players,
    matches,
    seed,
    gameConfigHash: gameHash,
});
writeFileSync(join(outDir, 'report.txt'), report + '\n', 'utf8');
console.error(`wrote ${files.length + 1} files to ${outDir}`);
//# sourceMappingURL=simulate.js.map