/**
 * The CSVs behind the report. `Backend/config/sim.json` has named an output directory
 * since the C# harness, and until now nothing wrote to it — the TypeScript
 * proof printed prose and no cells, which makes "walk me through the
 * calibration curve" (review test #15) an unanswerable request.
 *
 * Every file here is rendered from `stats.ts`, the same module the prose reads,
 * so a cell and the sentence quoting it cannot drift.
 *
 * No CSV library: these are numbers and fixed ASCII labels with no commas, no
 * quotes and no newlines in them, so a dependency would buy nothing and add a
 * thing to audit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArmResult } from './harness.js';
import { armStats, type ArmStats } from './stats.js';

function write(dir: string, name: string, header: string, rows: string[]): void {
  writeFileSync(join(dir, name), [header, ...rows].join('\n') + '\n', 'utf8');
}

function n(x: number, dp = 6): string {
  return Number.isFinite(x) ? x.toFixed(dp) : '';
}

export interface CsvOptions {
  provisionalMatches: number;
  players: number;
  matches: number;
  seed: number;
  runtimeSeconds?: number;
  /** Written into run.csv so a CSV set can be traced to the rules it ran under. */
  gameConfigHash?: string;
}

/**
 * Writes the whole set and returns the file names, so the caller can print them
 * and a reviewer knows what to open.
 */
export function writeCsvs(
  dir: string,
  control: ArmResult,
  treatment: ArmResult,
  opts: CsvOptions,
): string[] {
  mkdirSync(dir, { recursive: true });
  const stats: Array<[ArmResult, ArmStats]> = [
    [control, armStats(control, opts.provisionalMatches)],
    [treatment, armStats(treatment, opts.provisionalMatches)],
  ];

  // players.csv — the input to every convergence number. Latent skill is the
  // ground truth; initial rating is where the system started from. Both are
  // here because F-1 means the two are not independent, and a reader has to be
  // able to see that for themselves rather than take our word for it.
  write(
    dir,
    'players.csv',
    'arm,playerId,latentSkill,initialRating,finalRating,matchesPlayed',
    stats.flatMap(([arm, _]) =>
      arm.players.map(
        (p) =>
          `${arm.arm},${p.id},${n(p.latentSkill)},${p.initialRating},${p.finalRating},${p.matchesPlayed}`,
      ),
    ),
  );

  write(
    dir,
    'spearman-by-matches.csv',
    'arm,bucket,players,spearman,ci95Lo,ci95Hi',
    stats.flatMap(([arm, s]) =>
      [s.overall, ...s.byMatchCount, s.seeding].map(
        (b) => `${arm.arm},${b.label},${b.players},${n(b.rho)},${n(b.lo)},${n(b.hi)}`,
      ),
    ),
  );

  // convergence.csv — the series behind "how it improves over match count".
  write(
    dir,
    'convergence.csv',
    'arm,matchesSettled,meanMatchesPerPlayer,spearman',
    stats.flatMap(([arm, _]) =>
      arm.convergence.map(
        (c) => `${arm.arm},${c.matchesSettled},${n(c.meanMatchesPerPlayer, 4)},${n(c.rho)}`,
      ),
    ),
  );

  write(
    dir,
    'calibration.csv',
    'arm,predictedLower,predictedUpper,matches,meanPredicted,observedEloScore,error,decidedMatches,decidedOnlyPosterRate',
    stats.flatMap(([arm, s]) =>
      s.calibration.map(
        (c) =>
          `${arm.arm},${c.lower.toFixed(1)},${(c.lower + 0.1).toFixed(1)},${c.matches},` +
          `${n(c.meanPredicted)},${n(c.observed)},${n(c.error)},${c.decided},${n(c.decidedOnly)}`,
      ),
    ),
  );

  write(
    dir,
    'role-neutrality.csv',
    'arm,scope,ratingBand,matches,posterWins,challengerWins,ties,decided,posterWinRate,ci95Lo,ci95Hi,gapPP,gapLoPP,gapHiPP',
    stats.flatMap(([arm, s]) => {
      const r = s.role;
      const overall =
        `${arm.arm},overall,all,${r.decided + r.ties},${r.posterWins},${r.challengerWins},${r.ties},${r.decided},` +
        `${n(r.posterRate.rate)},${n(r.posterRate.lo)},${n(r.posterRate.hi)},` +
        `${n(r.gapPP, 4)},${n(r.gapLoPP, 4)},${n(r.gapHiPP, 4)}`;
      const bands = s.roleByBand.map(
        (b) =>
          `${arm.arm},equalRatingWithin50,${b.band},${b.matches},${b.posterWins},${b.challengerWins},${b.ties},` +
          `${b.posterWins + b.challengerWins},${n(b.posterRate.rate)},${n(b.posterRate.lo)},${n(b.posterRate.hi)},` +
          `${n((2 * b.posterRate.rate - 1) * 100, 4)},${n((2 * b.posterRate.lo - 1) * 100, 4)},${n(
            (2 * b.posterRate.hi - 1) * 100,
            4,
          )}`,
      );
      return [overall, ...bands];
    }),
  );

  // matches.csv — one row per settled match. This is the file everything else
  // is derivable from; it exists so the report can be recomputed without
  // re-running the 57-second simulation.
  write(
    dir,
    'matches.csv',
    'arm,index,posterId,challengerId,posterRatingBefore,challengerRatingBefore,posterMatchesBefore,' +
      'challengerMatchesBefore,posterProvisional,challengerProvisional,predictedPoster,outcome,' +
      'posterScore,challengerScore,k,posterDelta,stakeCents,rakeCents,chosenMatchIndex,creatorBankedScore',
    stats.flatMap(([arm, _]) =>
      arm.matchRows.map(
        (m) =>
          `${arm.arm},${m.index},${m.posterId},${m.challengerId},${m.posterRatingBefore},` +
          `${m.challengerRatingBefore},${m.posterMatchesBefore},${m.challengerMatchesBefore},` +
          `${m.posterProvisional ? 1 : 0},${m.challengerProvisional ? 1 : 0},${n(m.predictedPoster)},` +
          `${m.outcome},${m.posterScore},${m.challengerScore},${m.k},${m.posterDelta},${m.stakeCents},` +
          `${m.rakeCents},${m.chosenMatchIndex},${m.creatorBankedScore}`,
      ),
    ),
  );

  write(
    dir,
    'exclusions.csv',
    'arm,reason,count',
    stats.flatMap(([arm, _]) =>
      [...arm.exclusions.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${arm.arm},${r},${c}`),
    ),
  );

  // run.csv — the scalars the prose quotes that are not a row in any other
  // file. Key/value rather than one wide row, so adding a figure never
  // renumbers a column somebody has already cited.
  const scalars: string[] = [
    `config,players,${opts.players}`,
    `config,matches,${opts.matches}`,
    `config,seed,${opts.seed}`,
    `config,provisionalMatches,${opts.provisionalMatches}`,
  ];
  if (opts.gameConfigHash) scalars.push(`config,gameConfigHash,${opts.gameConfigHash}`);
  if (opts.runtimeSeconds !== undefined) scalars.push(`run,runtimeSeconds,${n(opts.runtimeSeconds, 2)}`);
  for (const [arm, s] of stats) {
    scalars.push(`${arm.arm},matchesSettled,${arm.matches}`);
    scalars.push(`${arm.arm},postOwnChallenge,${arm.postOwnChallenge}`);
    scalars.push(`${arm.arm},rakeCentsTotal,${arm.rakeCentsTotal}`);
    scalars.push(`${arm.arm},collusionLeaks,${arm.collusionLeaks}`);
    scalars.push(`${arm.arm},spearmanOverall,${n(s.overall.rho)}`);
    scalars.push(`${arm.arm},spearmanSeedingBaseline,${n(s.seeding.rho)}`);
    scalars.push(`${arm.arm},totalPlayerMatches,${s.provisional.totalPlayerMatches}`);
    scalars.push(`${arm.arm},meanMatchesPerPlayer,${n(s.provisional.meanMatchesPerPlayer, 4)}`);
    scalars.push(`${arm.arm},provisionalPlayerMatches,${s.provisional.provisionalPlayerMatches}`);
    scalars.push(`${arm.arm},provisionalShare,${n(s.provisional.provisionalShare)}`);
    scalars.push(`${arm.arm},playersStillProvisional,${s.provisional.playersStillProvisional}`);
    const sorted = [...arm.finalRatings].sort((a, b) => a - b);
    scalars.push(`${arm.arm},tookAnEarlierChallenge,${s.integrity.tookAnEarlierChallenge}`);
    scalars.push(`${arm.arm},settledScoreNotTakenChallenge,${s.integrity.scoreNotTheTakenChallenges}`);
    scalars.push(`${arm.arm},settledScoreMismatchShare,${n(s.integrity.share)}`);
    scalars.push(`${arm.arm},finalRatingMin,${sorted[0]}`);
    scalars.push(`${arm.arm},finalRatingMax,${sorted[sorted.length - 1]}`);
    // Task 3 — Backend/config/seed.json's planted sandbagger + smurf, when wired.
    if (arm.plantedAnomalies) {
      const { sandbagger: sb, smurf: sm } = arm.plantedAnomalies;
      scalars.push(`${arm.arm},sandbaggerId,${sb.id}`);
      scalars.push(`${arm.arm},sandbaggerStartingRating,${sb.startingRating}`);
      scalars.push(`${arm.arm},sandbaggerFinalRating,${sb.finalRating}`);
      scalars.push(`${arm.arm},sandbaggerMinRatingReached,${sb.minRatingReached}`);
      scalars.push(`${arm.arm},sandbaggerSinkToRating,${sb.sinkToRating}`);
      scalars.push(`${arm.arm},sandbaggerMatchesPlayed,${sb.matchesPlayed}`);
      scalars.push(`${arm.arm},sandbaggerMatchesThrown,${sb.matchesThrown}`);
      scalars.push(`${arm.arm},sandbaggerIdentityFlags,${sb.identityFlags}`);
      scalars.push(`${arm.arm},smurfId,${sm.id}`);
      scalars.push(`${arm.arm},smurfStartingRating,${sm.startingRating}`);
      scalars.push(`${arm.arm},smurfFinalRating,${sm.finalRating}`);
      scalars.push(`${arm.arm},smurfMatchesPlayed,${sm.matchesPlayed}`);
      scalars.push(`${arm.arm},smurfIdentityFlags,${sm.identityFlags}`);
    }
  }
  write(dir, 'run.csv', 'scope,key,value', scalars);

  return [
    'players.csv',
    'spearman-by-matches.csv',
    'convergence.csv',
    'calibration.csv',
    'role-neutrality.csv',
    'matches.csv',
    'exclusions.csv',
    'run.csv',
  ];
}
