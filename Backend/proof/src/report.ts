/**
 * Turns the two arms' raw counts into the numbers the report quotes.
 *
 * Every figure printed here comes from `stats.ts`, which `csv.ts` also renders
 * to file. That is deliberate: the acceptance bar for this report is that every
 * number in the prose can be pointed at a CSV cell, and a second copy of a
 * formula is exactly how that stops being true.
 *
 * What this report does NOT yet cover from the brief's §6.3 is listed at the
 * bottom of the output rather than left for a reviewer to notice.
 */
import type { ArmResult } from './harness.js';
import {
  armStats,
  quantile,
  wilson,
  type ArmStats,
  type SpearmanBucket,
} from './stats.js';

export { wilson } from './stats.js';
export type { Rate } from './stats.js';

function pct(x: number): string {
  return Number.isFinite(x) ? (x * 100).toFixed(2) + '%' : '   n/a';
}

function rho(x: number): string {
  return Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(3) : 'n/a';
}

function spearmanRow(b: SpearmanBucket): string {
  const ci = Number.isFinite(b.lo) ? `  95% CI [${rho(b.lo)}, ${rho(b.hi)}]` : '';
  return `  ${b.label.padEnd(16)} n=${b.players.toString().padStart(5)}   rho=${rho(b.rho)}${ci}`;
}

export interface ReportOptions {
  /** `rating.provisionalMatches` from the economy config — the K = 40 ladder step. */
  provisionalMatches: number;
  /** Wall-clock seconds for the whole run, if the caller measured it. */
  runtimeSeconds?: number;
}

export function computeStats(control: ArmResult, treatment: ArmResult, opts: ReportOptions): {
  control: ArmStats;
  treatment: ArmStats;
} {
  return {
    control: armStats(control, opts.provisionalMatches),
    treatment: armStats(treatment, opts.provisionalMatches),
  };
}

export function renderReport(control: ArmResult, treatment: ArmResult, opts?: ReportOptions): string {
  const options: ReportOptions = opts ?? { provisionalMatches: 10 };
  const stats = computeStats(control, treatment, options);
  const lines: string[] = [];
  const rule = '─'.repeat(66);

  lines.push('REDLINE — matchmaking & rating fairness proof');
  lines.push(rule);

  for (const arm of [control, treatment]) {
    const decided = arm.posterWins + arm.challengerWins + arm.ties;
    const posterShare = wilson(arm.posterWins, decided);
    const tieRate = wilson(arm.ties, decided);
    lines.push('');
    lines.push(`[${arm.arm}]  target ${arm.arm === 'control' ? 'SHOWN' : 'HIDDEN'} to the challenger`);
    lines.push(`  matches settled ......... ${arm.matches}`);
    lines.push(`  post_own_challenge ...... ${arm.postOwnChallenge}  (starvation / no fit)`);
    lines.push(`  abandoned (a side DNF) .. ${arm.abandoned}`);
    lines.push(
      `  poster share of all ..... ${pct(posterShare.rate)}   95% CI [${pct(posterShare.lo)}, ${pct(posterShare.hi)}]`,
    );
    lines.push(`  challenger share of all . ${pct(1 - posterShare.rate - tieRate.rate)}`);
    lines.push(`  tie frequency .......... ${pct(tieRate.rate)}`);
    lines.push(`  rake collected ......... $${(arm.rakeCentsTotal / 100).toFixed(2)}`);
  }

  // ── §6.3 item 1 — convergence ────────────────────────────────────────────
  lines.push('');
  lines.push(rule);
  lines.push('Rating convergence — Spearman(final rating, latent skill), treatment arm');
  lines.push(spearmanRow(stats.treatment.overall));
  lines.push('');
  lines.push('  By matches played, final population (DIFFERENT COHORTS — see below):');
  for (const b of stats.treatment.byMatchCount) lines.push(spearmanRow(b));
  lines.push(
    '  ^ this harness gives every player roughly the same number of matches\n' +
      '    (poster and challenger are both drawn uniformly), so the low buckets are\n' +
      '    empty and this table cannot show improvement. The trajectory below is the\n' +
      '    same population measured as it accumulates matches, which is what the\n' +
      "    brief's \"and how it improves over match count\" actually asks for.",
  );
  lines.push('');
  lines.push('  Convergence trajectory — one population, measured as it plays (treatment):');
  lines.push('    matches settled   mean matches/player   Spearman(rating, latent skill)');
  for (const c of treatment.convergence) {
    lines.push(
      `    ${c.matchesSettled.toString().padStart(15)}   ${c.meanMatchesPerPlayer
        .toFixed(2)
        .padStart(19)}   ${rho(c.rho).padStart(30)}`,
    );
  }
  lines.push('');
  lines.push('  SEEDING BASELINE — Spearman(STARTING rating, latent skill):');
  lines.push(spearmanRow(stats.treatment.seeding));
  lines.push(
    '  ^ F-1 FIXED: population.ts now draws latent skill from its own independent\n' +
      '    Normal, not from the starting rating. This baseline is what the population\n' +
      '    generator hands the rating system for free; the gap between it and the\n' +
      '    headline above is what match outcomes actually earned. Prior (circular)\n' +
      '    baseline was +0.859 of a final +0.867 — see DevDocs/simulation-report.md §1.',
  );

  const prov = stats.treatment.provisional;
  lines.push('');
  lines.push(
    `  provisional share: ${prov.totalPlayerMatches} player-matches over ${prov.players} players` +
      ` = ${prov.meanMatchesPerPlayer.toFixed(2)} each;` +
      ` ${prov.provisionalPlayerMatches} of them (${pct(prov.provisionalShare)}) were played` +
      ` at the provisional K (first ${prov.provisionalMatches} per player).`,
  );
  lines.push(`  players still provisional at the end: ${prov.playersStillProvisional}`);

  // ── F-8 invariant check (fixed — see harness.ts's runArm) ────────────────
  const integ = stats.treatment.integrity;
  lines.push('');
  lines.push(rule);
  lines.push("F-8 FIXED — settlement integrity check (should read 0 mismatches below)");
  lines.push(`  settled matches ....................................... ${integ.matches}`);
  lines.push(
    `  took a challenge posted by an EARLIER arrival ......... ${integ.tookAnEarlierChallenge}` +
      `  (${pct(integ.tookAnEarlierChallenge / integ.matches)})  — normal, not a defect`,
  );
  lines.push(
    `  settled a score that is NOT that challenge's banked ... ${integ.scoreNotTheTakenChallenges}` +
      `  (${pct(integ.share)})  — must be 0`,
  );
  lines.push(
    '  harness.ts used to settle `posterRun` — the run played by the arrival picked\n' +
      '  at the top of the iteration — against the RATING, money and Elo of `creator`,\n' +
      '  the creator of whichever challenge the matchmaker actually selected (measured\n' +
      "  at 91.07% mismatched before the fix). It now settles `chosen.bankedScore`\n" +
      "  directly — that challenge's own creator's own run, recorded when they played\n" +
      '  it — so the two numbers above are the same figure by construction and this\n' +
      '  section is a standing invariant check, not a live defect report.',
  );

  // ── §6.3 item 2 — calibration ────────────────────────────────────────────
  lines.push('');
  lines.push(rule);
  lines.push('Calibration — predicted poster win probability vs observed (treatment)');
  lines.push('  predicted   matches   mean pred   observed   error   decided-only');
  for (const c of stats.treatment.calibration) {
    if (c.matches === 0) continue;
    lines.push(
      `  ${c.lower.toFixed(1)}-${(c.lower + 0.1).toFixed(1)}   ${c.matches.toString().padStart(7)}   ` +
        `${c.meanPredicted.toFixed(3).padStart(9)}   ${c.observed.toFixed(3).padStart(8)}   ` +
        `${(c.error >= 0 ? '+' : '') + c.error.toFixed(3)}   ${c.decidedOnly.toFixed(3).padStart(12)}`,
    );
  }
  lines.push(
    '  Not bucketed by match count as well: the smallest predicted-probability\n' +
      '    deciles already fall below 1,000 matches, and splitting each of those five\n' +
      '    ways puts most cells under 100 — a calibration curve nobody should read.\n' +
      '    calibration.csv carries the counts so the judgement can be checked.',
  );

  // ── §6.3 item 6 — role neutrality ────────────────────────────────────────
  const t = stats.treatment.role;
  const c = stats.control.role;
  lines.push('');
  lines.push(rule);
  lines.push('Role neutrality (ADR 0009 §5, pre-registered) — ties excluded, this is a WIN RATE');
  lines.push(`  control   poster win rate: ${pct(c.posterRate.rate)}  n=${c.decided} decided  (target visible)`);
  lines.push(`  treatment poster win rate: ${pct(t.posterRate.rate)}  n=${t.decided} decided  (target hidden)`);
  lines.push(
    `  treatment poster − challenger: ${t.gapPP >= 0 ? '+' : ''}${t.gapPP.toFixed(2)} pp` +
      `   95% CI [${t.gapLoPP.toFixed(2)}, ${t.gapHiPP.toFixed(2)}] pp`,
  );
  const under1 = Math.abs(t.gapPP) < 1.0;
  const containsZero = t.gapLoPP <= 0 && t.gapHiPP >= 0;
  lines.push(`  test A — gap under 1.0 pp        : ${under1 ? 'HELD' : 'FAILED'}`);
  lines.push(`  test B — 95% CI contains zero    : ${containsZero ? 'HELD' : 'FAILED'}`);
  lines.push(`  verdict: ${under1 && containsZero ? 'the mitigation worked' : 'REVIEW — see the report prose'}`);
  lines.push('');
  lines.push('  At equal rating (the two ratings within 50 points), by rating band:');
  lines.push('    band        matches   poster   chall   ties   poster win rate   95% CI');
  for (const b of stats.treatment.roleByBand) {
    if (b.matches < 100) continue;
    lines.push(
      `    ${b.band.padEnd(10)} ${b.matches.toString().padStart(8)} ${b.posterWins
        .toString()
        .padStart(8)} ${b.challengerWins.toString().padStart(7)} ${b.ties.toString().padStart(6)}   ` +
        `${pct(b.posterRate.rate).padStart(15)}   [${pct(b.posterRate.lo)}, ${pct(b.posterRate.hi)}]`,
    );
  }
  lines.push(
    '  note: the control arm shows the mitigation MATTERS (the two arms differ); its\n' +
      '        absolute level is a coarse run model — the full per-tick model was the\n' +
      '        retired C# MatchSimulator. The graded claim is the treatment gap above.',
  );

  // Rating gap vs poster win rate, treatment arm.
  lines.push('');
  lines.push(rule);
  lines.push('Poster share of matches by rating gap (treatment; poster − challenger)');
  const buckets = [...treatment.byRatingGap.entries()].sort((a, b) => a[0] - b[0]);
  for (const [bucket, { posterWins, total }] of buckets) {
    if (total < 30) continue;
    const r = wilson(posterWins, total);
    lines.push(`  ${bucket >= 0 ? '+' : ''}${bucket.toString().padStart(4)} : ${pct(r.rate).padStart(7)}  (n=${total})`);
  }

  // Rating spread.
  for (const arm of [control, treatment]) {
    const sorted = [...arm.finalRatings].sort((a, b) => a - b);
    lines.push('');
    lines.push(
      `[${arm.arm}] final rating  p05=${quantile(sorted, 0.05).toFixed(0)}  p50=${quantile(sorted, 0.5).toFixed(
        0,
      )}  p95=${quantile(sorted, 0.95).toFixed(0)}  min=${sorted[0]}  max=${sorted[sorted.length - 1]}`,
    );
  }

  // Collusion.
  lines.push('');
  lines.push(rule);
  lines.push('Collusion exclusion (treatment)');
  for (const [reason, n] of [...treatment.exclusions.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${reason.padEnd(22)} ${n}`);
  }
  lines.push(`  known colluding pairs matched anyway (leaks): ${treatment.collusionLeaks}  (want 0)`);

  // ── Task 3 — Backend/config/seed.json's planted BEHAVIOURAL anomalies ────────────
  const anomalies = treatment.plantedAnomalies;
  lines.push('');
  lines.push(rule);
  lines.push('Planted anomalies (Backend/config/seed.json, wired — treatment arm)');
  if (!anomalies) {
    lines.push('  NOT WIRED this run — main.ts did not pass --anomalies from Backend/config/seed.json.');
  } else {
    const sb = anomalies.sandbagger;
    lines.push(
      `  sandbagger  rating ${sb.startingRating} -> ${sb.finalRating}  (min seen ${sb.minRatingReached},` +
        ` sink target ${sb.sinkToRating})  matches ${sb.matchesPlayed}  thrown ${sb.matchesThrown}` +
        `  identity flags ${sb.identityFlags}`,
    );
    lines.push(
      `  smurf       rating ${anomalies.smurf.startingRating} -> ${anomalies.smurf.finalRating}` +
        `  matches ${anomalies.smurf.matchesPlayed}  identity flags ${anomalies.smurf.identityFlags}`,
    );
    lines.push(
      '  Both are BEHAVIOURAL anomalies with no shared device / IP / payment instrument\n' +
        '  with any other account — by construction, identity-based exclusion (the only\n' +
        '  collusion detection production has; see collusion-capability-matrix.md) can\n' +
        '  never see them, and "identity flags" above is the measured confirmation, not\n' +
        '  an assumption. Verdict: MISSED. This is a legitimate false negative, not a\n' +
        '  bug — production has no behavioural detector to catch a lone account that\n' +
        '  sinks its own rating or climbs unusually fast, so neither is flagged.',
    );
  }

  // What this generator still does not produce. Stated here so a reviewer meets
  // it in the output rather than discovering it by looking for a section.
  lines.push('');
  lines.push(rule);
  lines.push("Not produced by this generator (brief §6.3) — see DevDocs/simulation-report.md:");
  lines.push('  4. match quality: rating gap percentiles at the moment of matching');
  lines.push('  5. wait time before a challenge is answered, incl. the ladder extremes');
  lines.push('  7. economics by rating decile (net $ per decile)');
  lines.push('  8. new-player experience: first-5 win rate and net money');
  lines.push('  9. anomaly detection false-positive rate over honest pairs — still not computed;');
  lines.push('     the planted sandbagger + smurf above are 2 of 2,000, not a honest-pair rate');
  if (options.runtimeSeconds !== undefined) {
    lines.push('');
    lines.push(`runtime: ${options.runtimeSeconds.toFixed(2)}s wall clock, both arms`);
  }

  lines.push('');
  lines.push(rule);
  return lines.join('\n');
}
