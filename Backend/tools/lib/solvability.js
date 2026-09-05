/**
 * Tools/Solvability — pushes N seeds through the generator-independent
 * RoadSolvability checker and reports how many roads a player who REFUSES to
 * bank cannot survive. Must be zero. Ported from SolvabilityCommand.cs.
 *
 *   npm --workspace @redline/tools run solvability -- --seeds 10000
 *   npm --workspace @redline/tools run solvability -- --seeds 800 --config Backend/config/redline.game.5lane.json
 *
 * `--config` is what review test #16 ("change the lane count from 4 to 5,
 * live") runs against: it proves the generator, the hazard weights and the
 * prover all derive from `len(lanes)` in a config file, without touching the
 * committed one. Relative paths resolve against the repo root (same anchor as
 * the default); absolute paths pass through unchanged.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGameConfig, RoadSolvability } from '@redline/sim-core';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const seeds = num('--seeds', 10000);
const configArg = str('--config');
const configPath = configArg
    ? isAbsolute(configArg)
        ? configArg
        : resolve(REPO_ROOT, configArg)
    : resolve(REPO_ROOT, 'Backend/config/redline.game.json');
const gameText = readFileSync(configPath, 'utf8');
const { config } = parseGameConfig(gameText);
const ticks = config.maxRunTicks;
console.log(`config: ${configPath} (${config.lanes.length} lanes, cashout lane ${config.cashoutLane})`);
let unwinnable = 0;
const failures = [];
const started = process.hrtime.bigint();
for (let i = 0; i < seeds; i++) {
    const seed = BigInt(i) * 0x9e3779b97f4a7c15n + 1n;
    const report = RoadSolvability.check(config, seed, ticks);
    if (!report.isSolvable) {
        unwinnable++;
        if (failures.length < 20)
            failures.push(`seed ${seed} — UNWINNABLE at tick ${report.failedAtTick}`);
    }
}
const secs = Number(process.hrtime.bigint() - started) / 1e9;
console.log(`checked ${seeds} seeds through ${ticks} ticks in ${secs.toFixed(1)}s`);
console.log(`unwinnable: ${unwinnable}`);
for (const f of failures)
    console.log(`  ${f}`);
process.exit(unwinnable === 0 ? 0 : 1);
function num(flag, fallback) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
function str(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
//# sourceMappingURL=solvability.js.map