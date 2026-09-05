/**
 * The statistics the brief's §6.3 asks for, computed once and consumed twice —
 * by `report.ts` for the prose and by `csv.ts` for the files behind it.
 *
 * They live in their own module for exactly that reason: a number in the report
 * that was computed by a second copy of the formula is a number nobody can
 * check against the CSV, and "every figure in the prose is traceable to a cell"
 * is the acceptance bar for this work. One implementation, two renderers.
 */
import type { ArmResult, MatchRow, PlayerRow } from './harness.js';

export interface Rate {
  rate: number;
  lo: number;
  hi: number;
  n: number;
}

/** Wilson score interval — sane near 0 and 1, unlike normal approximation. */
export function wilson(successes: number, n: number, z = 1.96): Rate {
  if (n === 0) return { rate: 0, lo: 0, hi: 0, n };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { rate: p, lo: (centre - margin) / denom, hi: (centre + margin) / denom, n };
}

/**
 * Fractional ranks with ties averaged. Spearman on integer ratings without tie
 * correction is wrong here rather than merely imprecise: ratings are whole
 * numbers over a few hundred distinct values across 2,000 players, so ties are
 * common, and ranking them by array order would encode the population's
 * construction order into the correlation.
 */
export function rank(xs: readonly number[]): number[] {
  const order = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const mean = (i + j) / 2 + 1; // 1-based, averaged across the tied block
    for (let k = i; k <= j; k++) ranks[order[k]![1]] = mean;
    i = j + 1;
  }
  return ranks;
}

/** Spearman's rho: Pearson correlation of the tie-corrected ranks. */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length) throw new Error('spearman: length mismatch');
  if (xs.length < 3) return NaN;
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx;
    const b = ry[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? NaN : num / Math.sqrt(dx * dy);
}

/**
 * Fisher z 95% interval on a correlation. Approximate — it assumes bivariate
 * normality, which ranks do not have — so it is reported as an indication of
 * how much of a bucket's movement is sampling noise, not as an exact interval.
 */
export function spearmanCi(rho: number, n: number): { lo: number; hi: number } {
  if (!Number.isFinite(rho) || n < 5) return { lo: NaN, hi: NaN };
  const z = 0.5 * Math.log((1 + rho) / (1 - rho));
  const se = 1 / Math.sqrt(n - 3);
  const tanh = (x: number): number => (Math.exp(2 * x) - 1) / (Math.exp(2 * x) + 1);
  return { lo: tanh(z - 1.96 * se), hi: tanh(z + 1.96 * se) };
}

/**
 * The brief asks for convergence "as a function of match count". These are the
 * buckets. The last one is labelled 51+ rather than 50+ because a player with
 * exactly 50 matches has to belong to exactly one bucket, and an overlapping
 * boundary in a table nobody can reproduce is worse than a pedantic label.
 */
export const MATCH_BUCKETS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: '1-5', lo: 1, hi: 5 },
  { label: '6-10', lo: 6, hi: 10 },
  { label: '11-20', lo: 11, hi: 20 },
  { label: '21-50', lo: 21, hi: 50 },
  { label: '51+', lo: 51, hi: Number.POSITIVE_INFINITY },
];

export interface SpearmanBucket {
  label: string;
  players: number;
  rho: number;
  lo: number;
  hi: number;
}

export function spearmanOverall(players: readonly PlayerRow[]): SpearmanBucket {
  const played = players.filter((p) => p.matchesPlayed >= 1);
  const rho = spearman(
    played.map((p) => p.finalRating),
    played.map((p) => p.latentSkill),
  );
  const ci = spearmanCi(rho, played.length);
  return { label: 'all (>=1 match)', players: played.length, rho, lo: ci.lo, hi: ci.hi };
}

export function spearmanByMatchCount(players: readonly PlayerRow[]): SpearmanBucket[] {
  return MATCH_BUCKETS.map((b) => {
    const inBucket = players.filter((p) => p.matchesPlayed >= b.lo && p.matchesPlayed <= b.hi);
    const rho = spearman(
      inBucket.map((p) => p.finalRating),
      inBucket.map((p) => p.latentSkill),
    );
    const ci = spearmanCi(rho, inBucket.length);
    return { label: b.label, players: inBucket.length, rho, lo: ci.lo, hi: ci.hi };
  });
}

/**
 * The seeding control. Spearman(initial rating, latent skill) is what the
 * correlation would be if the rating system had done nothing at all, because
 * population.ts derives skill FROM the initial rating (F-1). Reporting the
 * final number without this one beside it would credit the rating system with
 * a correlation it inherited.
 */
export function spearmanSeeding(players: readonly PlayerRow[]): SpearmanBucket {
  const played = players.filter((p) => p.matchesPlayed >= 1);
  const rho = spearman(
    played.map((p) => p.initialRating),
    played.map((p) => p.latentSkill),
  );
  const ci = spearmanCi(rho, played.length);
  return { label: 'seeding baseline', players: played.length, rho, lo: ci.lo, hi: ci.hi };
}

export interface CalibrationBucket {
  /** Lower edge of the predicted-probability decile. */
  lower: number;
  matches: number;
  meanPredicted: number;
  /** Observed poster Elo score: win 1, tie 0.5, loss 0. */
  observed: number;
  error: number;
  /** The same, with ties dropped — Elo's expectation is a two-outcome model. */
  decidedOnly: number;
  decided: number;
}

function eloScoreOf(outcome: MatchRow['outcome']): number {
  return outcome === 'posterWins' ? 1 : outcome === 'tie' ? 0.5 : 0;
}

export function calibration(rows: readonly MatchRow[]): CalibrationBucket[] {
  const out: CalibrationBucket[] = [];
  for (let d = 0; d < 10; d++) {
    const lower = d / 10;
    const inBucket = rows.filter((r) => r.predictedPoster >= lower && r.predictedPoster < lower + 0.1 + (d === 9 ? 1e-9 : 0));
    if (inBucket.length === 0) {
      out.push({ lower, matches: 0, meanPredicted: NaN, observed: NaN, error: NaN, decidedOnly: NaN, decided: 0 });
      continue;
    }
    const meanPredicted = inBucket.reduce((a, r) => a + r.predictedPoster, 0) / inBucket.length;
    const observed = inBucket.reduce((a, r) => a + eloScoreOf(r.outcome), 0) / inBucket.length;
    const decidedRows = inBucket.filter((r) => r.outcome !== 'tie');
    const decidedOnly =
      decidedRows.length === 0
        ? NaN
        : decidedRows.filter((r) => r.outcome === 'posterWins').length / decidedRows.length;
    out.push({
      lower,
      matches: inBucket.length,
      meanPredicted,
      observed,
      error: observed - meanPredicted,
      decidedOnly,
      decided: decidedRows.length,
    });
  }
  return out;
}

export interface RoleNeutrality {
  /** Matches with a winner — ties excluded, because the test is a win RATE. */
  decided: number;
  posterWins: number;
  challengerWins: number;
  ties: number;
  posterRate: Rate;
  /** poster − challenger, in percentage points, with the 95% CI. */
  gapPP: number;
  gapLoPP: number;
  gapHiPP: number;
}

/**
 * The pre-registered test of ADR 0009 §5 is a difference between two WIN RATES,
 * so ties leave the denominator. Among decided matches the challenger rate is
 * `1 - posterRate`, so the difference is `2p - 1` and its interval is the
 * Wilson interval mapped through the same transform.
 */
export function roleNeutrality(rows: readonly MatchRow[]): RoleNeutrality {
  const posterWins = rows.filter((r) => r.outcome === 'posterWins').length;
  const challengerWins = rows.filter((r) => r.outcome === 'challengerWins').length;
  const ties = rows.length - posterWins - challengerWins;
  const decided = posterWins + challengerWins;
  const p = wilson(posterWins, decided);
  return {
    decided,
    posterWins,
    challengerWins,
    ties,
    posterRate: p,
    gapPP: (2 * p.rate - 1) * 100,
    gapLoPP: (2 * p.lo - 1) * 100,
    gapHiPP: (2 * p.hi - 1) * 100,
  };
}

export interface RatingBandRow {
  band: string;
  lower: number;
  matches: number;
  posterWins: number;
  challengerWins: number;
  ties: number;
  posterRate: Rate;
}

/**
 * "At equal rating" has to mean something operational. It means the two ratings
 * were within `within` points of each other when the match was made; the band
 * is then where on the ladder that equal-rating pair sat.
 */
export function roleNeutralityByBand(rows: readonly MatchRow[], within = 50, bandWidth = 200): RatingBandRow[] {
  const equal = rows.filter((r) => Math.abs(r.posterRatingBefore - r.challengerRatingBefore) <= within);
  const byBand = new Map<number, MatchRow[]>();
  for (const r of equal) {
    const mid = (r.posterRatingBefore + r.challengerRatingBefore) / 2;
    const lower = Math.floor(mid / bandWidth) * bandWidth;
    const list = byBand.get(lower) ?? [];
    list.push(r);
    byBand.set(lower, list);
  }
  return [...byBand.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lower, list]) => {
      const posterWins = list.filter((r) => r.outcome === 'posterWins').length;
      const challengerWins = list.filter((r) => r.outcome === 'challengerWins').length;
      return {
        band: `${lower}-${lower + bandWidth - 1}`,
        lower,
        matches: list.length,
        posterWins,
        challengerWins,
        ties: list.length - posterWins - challengerWins,
        posterRate: wilson(posterWins, posterWins + challengerWins),
      };
    });
}

/**
 * How much of each player's rating history was accumulated at the provisional
 * K. This is the arithmetic behind the caveat the report has to state: 50,000
 * matches over 2,000 players is 25 per player on average, and ADR 0007 runs the
 * first `provisionalMatches` of each at K = 40.
 */
export interface ProvisionalShare {
  players: number;
  playersWithAnyMatch: number;
  totalPlayerMatches: number;
  meanMatchesPerPlayer: number;
  provisionalPlayerMatches: number;
  provisionalShare: number;
  playersStillProvisional: number;
  provisionalMatches: number;
}

export function provisionalShare(players: readonly PlayerRow[], provisionalMatches: number): ProvisionalShare {
  const total = players.reduce((a, p) => a + p.matchesPlayed, 0);
  const prov = players.reduce((a, p) => a + Math.min(p.matchesPlayed, provisionalMatches), 0);
  return {
    players: players.length,
    playersWithAnyMatch: players.filter((p) => p.matchesPlayed >= 1).length,
    totalPlayerMatches: total,
    meanMatchesPerPlayer: total / players.length,
    provisionalPlayerMatches: prov,
    provisionalShare: total === 0 ? 0 : prov / total,
    playersStillProvisional: players.filter((p) => p.matchesPlayed < provisionalMatches).length,
    provisionalMatches,
  };
}

/**
 * F-8 was a harness defect where settlement read the wrong player's run — see
 * the fix note in `runArm` (harness.ts). Kept as a first-class, CSV-backed
 * number rather than removed once fixed: it is now a standing INVARIANT
 * check (`scoreNotTheTakenChallenges` must be 0) rather than a measurement of
 * the bug, so a future change that reintroduces the split is caught by the
 * report itself instead of requiring someone to notice a chart looks wrong.
 * `tookAnEarlierChallenge` staying well above zero is expected and fine — a
 * live challenge pool taking a backlogged challenge is normal matchmaking,
 * not a defect.
 */
export interface SettlementIntegrity {
  matches: number;
  /** Settled matches where the challenge taken was not the one just posted. */
  tookAnEarlierChallenge: number;
  /** Settled matches where the score settled differs from the taken challenge's banked score. */
  scoreNotTheTakenChallenges: number;
  share: number;
}

export function settlementIntegrity(rows: readonly MatchRow[]): SettlementIntegrity {
  const earlier = rows.filter((r) => r.chosenMatchIndex !== r.index).length;
  const wrongScore = rows.filter((r) => r.creatorBankedScore !== r.posterScore).length;
  return {
    matches: rows.length,
    tookAnEarlierChallenge: earlier,
    scoreNotTheTakenChallenges: wrongScore,
    share: rows.length === 0 ? 0 : wrongScore / rows.length,
  };
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

/** Everything the report quotes for one arm, computed once. */
export interface ArmStats {
  arm: ArmResult['arm'];
  overall: SpearmanBucket;
  seeding: SpearmanBucket;
  byMatchCount: SpearmanBucket[];
  calibration: CalibrationBucket[];
  role: RoleNeutrality;
  roleByBand: RatingBandRow[];
  provisional: ProvisionalShare;
  integrity: SettlementIntegrity;
}

export function armStats(arm: ArmResult, provisionalMatchesSetting: number): ArmStats {
  return {
    arm: arm.arm,
    overall: spearmanOverall(arm.players),
    seeding: spearmanSeeding(arm.players),
    byMatchCount: spearmanByMatchCount(arm.players),
    calibration: calibration(arm.matchRows),
    role: roleNeutrality(arm.matchRows),
    roleByBand: roleNeutralityByBand(arm.matchRows),
    provisional: provisionalShare(arm.players, provisionalMatchesSetting),
    integrity: settlementIntegrity(arm.matchRows),
  };
}
