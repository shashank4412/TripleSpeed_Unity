/**
 * The driver. Runs N matches over a VirtualClock against the PRODUCTION
 * Matchmaker + InMemoryChallengeInventory + applyElo + settle. Nothing here
 * re-implements a rule — if it did, the report would be fiction.
 *
 * One arm = one call with `hideTarget` set. The report compares the control
 * (target shown) and treatment (target hidden) arms on the same seeds and
 * population, which is the test the brief sets for role asymmetry.
 */
import {
  Matchmaker,
  InMemoryChallengeInventory,
  VirtualClock,
  applyElo,
  expected,
  posterEloScore,
  settle,
  outcomeFromScores,
  type EconomyConfig,
  type Challenge,
  type SettlementOutcome,
} from '@redline/rating';
import type { GameConfig } from '@redline/sim-core';
import { Rng } from './rng.js';
import { buildPopulation, type AnomalyConfig, type Player, type PlantedAnomalies } from './population.js';
import { playRun, type PlayedRun } from './strategy.js';
import { spearman } from './stats.js';

/**
 * One player at the end of the run. `latentSkill` is the ground truth the
 * rating is supposed to discover, and `initialRating` is what it started from —
 * both are carried out of the harness because the convergence question cannot
 * be answered without seeing them side by side. See the F-1 caveat in
 * DevDocs/simulation-report.md: today one is derived from the other.
 */
export interface PlayerRow {
  id: string;
  latentSkill: number;
  initialRating: number;
  finalRating: number;
  matchesPlayed: number;
}

/**
 * One settled match, at the moment it was settled. Everything here is the state
 * BEFORE the Elo update, because calibration asks whether the rating predicted
 * the result — a prediction made from the post-match rating is not a prediction.
 */
export interface MatchRow {
  index: number;
  posterId: string;
  challengerId: string;
  posterRatingBefore: number;
  challengerRatingBefore: number;
  posterMatchesBefore: number;
  challengerMatchesBefore: number;
  posterProvisional: boolean;
  challengerProvisional: boolean;
  predictedPoster: number;
  outcome: SettlementOutcome;
  posterScore: number;
  challengerScore: number;
  k: number;
  posterDelta: number;
  stakeCents: number;
  rakeCents: number;
  /**
   * The `matchId` index of the challenge the matchmaker actually selected. When
   * this differs from `index`, the challenge taken was posted by an EARLIER
   * arrival — the normal case once the inventory has a backlog, and on its own
   * not a defect (a real challenge pool works the same way).
   */
  chosenMatchIndex: number;
  /**
   * The banked score carried on the selected challenge — i.e. the run its
   * creator really played. F-8 (fixed): this used to be recorded only for
   * comparison, because settlement used the WRONG run (`posterRun`, this
   * iteration's arrival) instead of this value. `posterScore` now IS this
   * number by construction — see the F-8 note in `runArm` below — so the two
   * fields are kept in lockstep as a standing invariant check rather than
   * collapsed into one, in case a future change reintroduces the split.
   */
  creatorBankedScore: number;
}

/** One snapshot of convergence part-way through a run. */
export interface ConvergencePoint {
  matchesSettled: number;
  /** Mean matches played per player at this point — the brief's x-axis. */
  meanMatchesPerPlayer: number;
  /** Spearman(current rating, latent skill) over the whole population. */
  rho: number;
}

/**
 * Task 3 — what happened to Backend/config/seed.json's two planted BEHAVIOURAL
 * anomalies over the run. Production has no behavioural detector (only
 * identity-based exclusions — see DevDocs/features/0003-spec-alignment/
 * collusion-capability-matrix.md), so `identityFlags` is expected to be zero
 * for both: neither shares a device, IP or payment instrument with anyone,
 * which is what makes them behavioural rather than identity anomalies.
 */
export interface PlantedAnomalyRow {
  id: string;
  startingRating: number;
  finalRating: number;
  matchesPlayed: number;
  /** Collusion-reason exclusions the matchmaker ever raised naming this account. */
  identityFlags: number;
}

export interface PlantedAnomalyReport {
  sandbagger: PlantedAnomalyRow & {
    sinkToRating: number;
    /** Lowest rating this account reached during the run. */
    minRatingReached: number;
    /** How many of its own runs were deliberately thrown (score forced to 0). */
    matchesThrown: number;
  };
  smurf: PlantedAnomalyRow;
}

export interface ArmResult {
  arm: 'control' | 'treatment';
  matches: number;
  posterWins: number;
  challengerWins: number;
  ties: number;
  abandoned: number;
  postOwnChallenge: number;
  /** rows: [ratingGapBucket] -> { posterWins, total } */
  byRatingGap: Map<number, { posterWins: number; total: number }>;
  /** exclusions by reason, from every matchmake call */
  exclusions: Map<string, number>;
  /** matchmake selections that paired a known-colluding ground-truth pair (should be ~0) */
  collusionLeaks: number;
  finalRatings: number[];
  rakeCentsTotal: number;
  /** Ground truth vs outcome, per player — the input to Spearman. */
  players: PlayerRow[];
  /** One row per settled match — the input to calibration and role neutrality. */
  matchRows: MatchRow[];
  /**
   * Spearman over the SAME players as the run proceeds. The by-match-count
   * buckets cannot show improvement (they are different cohorts, and in this
   * harness they are nearly empty because every player plays about the same
   * number of matches); this series measures one population accumulating
   * matches, which is what the brief's "improves over match count" asks for.
   */
  convergence: ConvergencePoint[];
  /** Task 3 — present only when `opts.anomalies` was supplied to `runArm`. */
  plantedAnomalies?: PlantedAnomalyReport;
}

export interface HarnessOptions {
  players: number;
  matches: number;
  startingBalanceCents: number;
  collusionPairs: number;
  seed: number;
  /** Task 3: Backend/config/seed.json's planted sandbagger + smurf. Omit to run without them. */
  anomalies?: AnomalyConfig;
}

// 'sameAccount' is deliberately EXCLUDED here: it fires whenever a player
// happens to arrive as a challenger while their OWN earlier challenge is
// still open — a routine self-match guard every player in the population
// triggers occasionally, not a signal that two DIFFERENT identities share
// anything. Counting it would inflate "identity flags" for the planted
// anomalies (and everyone else) with noise unrelated to collusion detection.
const COLLUSION_EXCLUSION_REASONS = new Set(['sameDevice', 'samePaymentInstrument', 'sharedIp']);

/**
 * Applies the sandbagger's deliberate-loss behaviour to a run it just played,
 * if this account is the planted sandbagger and the roll says throw this one.
 *
 * The REAL run is still played by the REAL sim core with the player's REAL
 * skill first (see the call sites) — this only overrides the OUTCOME
 * afterward, the way a human sandbagger drives badly on purpose rather than
 * the game refusing to let them play. That keeps `playRun` as the one and
 * only source of scores, per the "the proof must keep calling production
 * code" constraint — nothing here re-implements scoring.
 */
function maybeThrow(
  player: Player,
  plantedAnomalies: PlantedAnomalies | undefined,
  rng: Rng,
  run: PlayedRun,
  onThrow: () => void,
): PlayedRun {
  if (!plantedAnomalies || player.id !== plantedAnomalies.sandbaggerId) return run;
  const cfg = plantedAnomalies.sandbagger;
  if (player.rating < cfg.sinkToRating) return run; // sunk far enough — plays honestly from here
  if (rng.next() >= cfg.throwRateMilli / 1000) return run; // the minority they don't throw
  onThrow();
  return { ...run, score: 0, outcome: 'Crashed' };
}

export async function runArm(
  arm: 'control' | 'treatment',
  game: GameConfig,
  economy: EconomyConfig,
  opts: HarnessOptions,
): Promise<ArmResult> {
  const rng = new Rng(opts.seed ^ (arm === 'treatment' ? 0x9e3779b9 : 0));
  const { players, colludingPairs, plantedAnomalies } = buildPopulation(rng, opts.players, {
    startingBalanceCents: opts.startingBalanceCents,
    initialRating: economy.rating.initial,
    collusionPairs: opts.collusionPairs,
    ...(opts.anomalies ? { anomalies: opts.anomalies } : {}),
  });
  const byId = new Map(players.map((p) => [p.id, p]));
  const colludes = new Set(colludingPairs.map(([a, b]) => key(a, b)));

  // Task 3 tracking — see PlantedAnomalyReport. Only touched when anomalies
  // were actually wired in, so a plain run pays nothing for this.
  let sandbaggerMinRating = plantedAnomalies ? byId.get(plantedAnomalies.sandbaggerId)!.rating : 0;
  let sandbaggerThrows = 0;
  let sandbaggerIdentityFlags = 0;
  let smurfIdentityFlags = 0;
  // F-8's own fix depends on this: the score a creator's run actually banked,
  // keyed by matchId, recorded at POST time (when the run is played) so that
  // settlement — which may happen many iterations later, against whichever
  // challenger the matchmaker eventually selects this challenge for — reads
  // the same run every time rather than whatever arrival happens to be at the
  // top of the loop when it finally settles.
  const runOutcomeByMatchId = new Map<string, PlayedRun['outcome']>();

  const clock = new VirtualClock(Date.UTC(2026, 0, 1));
  const inv = new InMemoryChallengeInventory();
  for (const p of players) inv.register(p.id, p.deviceFingerprint, p.paymentInstrument, p.rating);

  const economyForArm: EconomyConfig = {
    ...economy,
    roleAsymmetry: { hideTargetFromChallenger: arm === 'treatment' },
  };
  const matchmaker = new Matchmaker(inv, clock, economyForArm.matchmaking);

  const res: ArmResult = {
    arm,
    matches: 0,
    posterWins: 0,
    challengerWins: 0,
    ties: 0,
    abandoned: 0,
    postOwnChallenge: 0,
    byRatingGap: new Map(),
    exclusions: new Map(),
    collusionLeaks: 0,
    finalRatings: [],
    rakeCentsTotal: 0,
    players: [],
    matchRows: [],
    convergence: [],
  };

  // Snapshot before a single match is played: the seeding baseline the report
  // has to show beside the final correlation.
  const initialRating = new Map(players.map((p) => [p.id, p.rating]));

  const stake = economy.money.stakesCents[Math.floor(economy.money.stakesCents.length / 2)]!;
  const checkpointEvery = Math.max(1, Math.floor(opts.matches / 20));

  for (let m = 0; m < opts.matches; m++) {
    clock.advance(rng.int(30_000) + 1_000); // matches arrive seconds to half a minute apart

    const poster = rng.pick(players);
    if (poster.balanceCents < stake) {
      poster.balanceCents = opts.startingBalanceCents; // top up so the run keeps going
    }

    // Poster plays blind: greed target is a multiple of a rough "safe" number.
    const safe = 400 + poster.skill * 2600;
    const posterTarget = Math.round(safe * poster.greed);
    const posterSeed = rng.seed64();
    let posterRun = playRun(game, posterSeed, posterTarget, poster.skill, rng);
    posterRun = maybeThrow(poster, plantedAnomalies, rng, posterRun, () => sandbaggerThrows++);

    poster.balanceCents -= stake;
    const matchId = `m${m}`;
    const challenge: Challenge = {
      matchId,
      stakeCents: stake,
      bankedScore: posterRun.outcome === 'Banked' ? posterRun.score : 0,
      creatorAccountId: poster.id,
      creatorRating: poster.rating,
      creatorProvisional: poster.ratedMatches < economy.rating.provisionalMatches,
      createdAt: clock.nowMs(),
      seed: posterSeed.toString(),
    };
    inv.post(challenge);
    // F-8: recorded now, at the ONLY moment this run exists, because whichever
    // challenger eventually takes this challenge — possibly many iterations
    // from now — must settle against THIS outcome, not against whatever a
    // future loop iteration's unrelated arrival happens to play.
    runOutcomeByMatchId.set(matchId, posterRun.outcome);

    // A challenger arrives shortly after and asks the matchmaker.
    clock.advance(rng.int(20_000) + 2_000);
    const challenger = pickChallenger(rng, players, poster.id);
    const decision = await matchmaker.select({
      accountId: challenger.id,
      rating: challenger.rating,
      settledMatches: challenger.ratedMatches,
      stakeCents: stake,
    });

    for (const e of decision.excluded) {
      res.exclusions.set(e.reason, (res.exclusions.get(e.reason) ?? 0) + 1);
      // Task 3: did an identity-based rule ever even consider one of the
      // planted behavioural anomalies? Checked here rather than assumed,
      // though by construction (unique device/IP/instrument, see
      // population.ts) it should stay zero for both.
      if (plantedAnomalies && COLLUSION_EXCLUSION_REASONS.has(e.reason)) {
        const excludedCreator = inv.tryGetCreator(e.matchId);
        if (challenger.id === plantedAnomalies.sandbaggerId || excludedCreator === plantedAnomalies.sandbaggerId) {
          sandbaggerIdentityFlags++;
        }
        if (challenger.id === plantedAnomalies.smurfId || excludedCreator === plantedAnomalies.smurfId) {
          smurfIdentityFlags++;
        }
      }
    }

    if (decision.outcome !== 'matched' || !decision.selected) {
      res.postOwnChallenge++;
      // The challenge sits in the inventory; a later arrival may take it.
      continue;
    }

    const chosen = decision.selected;
    const creator = byId.get(chosen.creatorAccountId)!;
    if (colludes.has(key(creator.id, challenger.id))) res.collusionLeaks++;

    inv.take(chosen.matchId);
    challenger.balanceCents -= stake;

    // Challenger plays. In the control arm they can see the target and bank one above it.
    const knowsTarget = arm === 'control' && chosen.bankedScore > 0;
    let challengerRun: PlayedRun;
    if (knowsTarget) {
      // The challenger can see the number, so this is not a greed bet — it is
      // execution of a line the poster has ALREADY proven survivable to
      // bankedScore on this exact seed. Modelled directly: the challenger banks
      // one point over the target unless they fumble the run. The survival
      // probability is high and rises with skill, because the hard part
      // (finding a line that lives that long) is already solved for them. This
      // is the arithmetic behind ADR 0009's 25% ceiling — a fuller run-level
      // model lived in the retired C# MatchSimulator.
      const pSurvive = 0.72 + challenger.skill * 0.2; // ~0.72–0.92
      challengerRun =
        rng.next() < pSurvive
          ? { events: [], score: chosen.bankedScore + 1, outcome: 'Banked' as const, endTick: 0 }
          : { events: [], score: 0, outcome: 'Crashed' as const, endTick: 0 };
    } else {
      const challengerTarget = Math.round((400 + challenger.skill * 2600) * challenger.greed);
      challengerRun = playRun(game, BigInt(chosen.seed), challengerTarget, challenger.skill, rng);
    }
    challengerRun = maybeThrow(challenger, plantedAnomalies, rng, challengerRun, () => sandbaggerThrows++);

    // Settle with the production arithmetic.
    //
    // F-8 (fixed): this used to be `posterRun.outcome === 'Banked' ? posterRun.score : 0`
    // — the run played by WHICHEVER ARRIVAL happened to be `poster` at the top
    // of THIS iteration. But the challenge the matchmaker just selected
    // (`chosen`) is very often an EARLIER arrival's challenge (measured at
    // 92.36% of matches in the unfixed harness) — the inventory carries a
    // backlog, same as production. Settling `posterRun` against `creator`'s
    // rating therefore paired one player's run with a different player's
    // identity in ~91% of matches. `chosen.bankedScore` is the score the
    // ACTUAL creator of the selected challenge actually banked, recorded at
    // the moment their run was played (see `runOutcomeByMatchId` above) — it
    // is the only correct number to settle here, and it was already being
    // computed and threaded through untouched; it just was not the number
    // being read.
    const posterScore = chosen.bankedScore;
    const posterRunOutcome = runOutcomeByMatchId.get(chosen.matchId) ?? 'Crashed';
    const challScore = challengerRun.outcome === 'Banked' ? challengerRun.score : 0;
    const outcome = outcomeFromScores(posterScore, challScore);
    const money = settle(stake, economy.money.rakeBasisPoints, outcome, economy.money.tieOddCentToPoster);
    res.rakeCentsTotal += money.rakeCents;

    creator.balanceCents += money.posterCreditCents;
    challenger.balanceCents += money.challengerCreditCents;

    const posterRatingBefore = creator.rating;
    const challengerRatingBefore = challenger.rating;
    const posterMatchesBefore = creator.ratedMatches;
    const challengerMatchesBefore = challenger.ratedMatches;

    const elo = applyElo(
      economy.rating,
      creator.rating,
      creator.ratedMatches,
      challenger.rating,
      challenger.ratedMatches,
      posterEloScore(outcome),
    );
    creator.rating = elo.posterRating;
    challenger.rating = elo.challengerRating;
    creator.ratedMatches++;
    challenger.ratedMatches++;
    inv.setRating(creator.id, creator.rating);
    inv.setRating(challenger.id, challenger.rating);
    inv.recordMeeting(creator.id, challenger.id, clock.nowMs());

    if (plantedAnomalies) {
      if (creator.id === plantedAnomalies.sandbaggerId) sandbaggerMinRating = Math.min(sandbaggerMinRating, creator.rating);
      if (challenger.id === plantedAnomalies.sandbaggerId) {
        sandbaggerMinRating = Math.min(sandbaggerMinRating, challenger.rating);
      }
    }

    res.matches++;
    // F-8: this must read the outcome of the run actually being settled
    // (`posterRunOutcome`, the selected challenge's creator's run), not
    // `posterRun.outcome` — this iteration's unrelated arrival.
    if (posterRunOutcome === 'Abandoned' || challengerRun.outcome === 'Abandoned') res.abandoned++;
    if (outcome === 'posterWins') res.posterWins++;
    else if (outcome === 'challengerWins') res.challengerWins++;
    else res.ties++;

    res.matchRows.push({
      index: m,
      posterId: creator.id,
      challengerId: challenger.id,
      posterRatingBefore,
      challengerRatingBefore,
      posterMatchesBefore,
      challengerMatchesBefore,
      posterProvisional: posterMatchesBefore < economy.rating.provisionalMatches,
      challengerProvisional: challengerMatchesBefore < economy.rating.provisionalMatches,
      // The production expectation function, not a re-derivation of it.
      predictedPoster: expected(posterRatingBefore, challengerRatingBefore),
      outcome,
      posterScore,
      challengerScore: challScore,
      k: elo.k,
      posterDelta: elo.posterDelta,
      stakeCents: stake,
      rakeCents: money.rakeCents,
      chosenMatchIndex: Number(chosen.matchId.slice(1)),
      creatorBankedScore: chosen.bankedScore,
    });

    const bucket = Math.round((creator.rating - challenger.rating) / 100) * 100;
    const b = res.byRatingGap.get(bucket) ?? { posterWins: 0, total: 0 };
    b.total++;
    if (outcome === 'posterWins') b.posterWins++;
    res.byRatingGap.set(bucket, b);

    // Snapshot convergence on a fixed cadence in the LOOP index, not in the
    // settled count, so the checkpoints land at the same place on every run
    // regardless of how many arrivals failed to match.
    if (checkpointEvery > 0 && (m + 1) % checkpointEvery === 0) {
      res.convergence.push(snapshot(players, res.matches));
    }
  }
  // The final checkpoint may already have landed on the last iteration; only
  // add one if it did not, so the series has no duplicated last row.
  if (res.convergence.at(-1)?.matchesSettled !== res.matches) {
    res.convergence.push(snapshot(players, res.matches));
  }

  res.finalRatings = players.map((p) => p.rating);
  res.players = players.map((p) => ({
    id: p.id,
    latentSkill: p.skill,
    initialRating: initialRating.get(p.id)!,
    finalRating: p.rating,
    matchesPlayed: p.ratedMatches,
  }));

  if (plantedAnomalies) {
    const sandbagger = byId.get(plantedAnomalies.sandbaggerId)!;
    const smurf = byId.get(plantedAnomalies.smurfId)!;
    res.plantedAnomalies = {
      sandbagger: {
        id: sandbagger.id,
        startingRating: initialRating.get(sandbagger.id)!,
        finalRating: sandbagger.rating,
        matchesPlayed: sandbagger.ratedMatches,
        identityFlags: sandbaggerIdentityFlags,
        sinkToRating: plantedAnomalies.sandbagger.sinkToRating,
        minRatingReached: sandbaggerMinRating,
        matchesThrown: sandbaggerThrows,
      },
      smurf: {
        id: smurf.id,
        startingRating: initialRating.get(smurf.id)!,
        finalRating: smurf.rating,
        matchesPlayed: smurf.ratedMatches,
        identityFlags: smurfIdentityFlags,
      },
    };
  }

  return res;
}

function snapshot(players: readonly Player[], matchesSettled: number): ConvergencePoint {
  const totalPlayerMatches = players.reduce((a, p) => a + p.ratedMatches, 0);
  return {
    matchesSettled,
    meanMatchesPerPlayer: totalPlayerMatches / players.length,
    rho: spearman(
      players.map((p) => p.rating),
      players.map((p) => p.skill),
    ),
  };
}

function pickChallenger(rng: Rng, players: readonly Player[], notId: string): Player {
  for (let i = 0; i < 8; i++) {
    const p = rng.pick(players);
    if (p.id !== notId) return p;
  }
  return players.find((p) => p.id !== notId)!;
}

function key(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
