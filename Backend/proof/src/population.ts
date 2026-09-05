/**
 * The synthetic player base. Ratings are seeded from a normal so the matchmaker
 * has a real spread to work with.
 *
 * F-1 (fixed): latent skill used to be DERIVED from the player's own starting
 * rating (`skill = f(rating)`), which made the proof's headline Spearman
 * partly circular — a prior run measured Spearman(starting rating, latent
 * skill) at +0.859 before a single match was played, out of a final +0.867.
 * The population generator was handing the rating system almost the whole
 * answer. Latent skill is now drawn from its OWN independent Normal (matching
 * the distribution `Backend/config/seed.json`'s `latentSkill` block documents: mean
 * `rating.initial`, sd 250, clamped to 400..2600) and mapped onto the 0..1
 * execution-skill scale `strategy.ts` consumes with the same linear transform
 * the old code used — only the input changed, not the shape. Nothing in this
 * function reads `rating` when computing `skill`, so any correlation the
 * report measures between final rating and latent skill from here on has to
 * be earned by actual match outcomes.
 *
 * A configurable slice of players are wired as colluding pairs (shared device /
 * IP / instrument) so report §9 can report the exclusion rate and the
 * false-positive rate against the honest majority.
 *
 * Task 3: optionally plants `Backend/config/seed.json`'s sandbagger and smurf — the
 * two BEHAVIOURAL anomalies (no shared identity signal with anyone) that nothing
 * in production detects. See `plantedAnomalies` and harness.ts's throw logic.
 */
import { Rng } from './rng.js';

export interface Player {
  id: string;
  rating: number;
  ratedMatches: number;
  balanceCents: number;
  /** 0..1 — chance of reading and answering a hazard in time. */
  skill: number;
  /** How greedy: the score multiple of the "safe" number this player pushes for. */
  greed: number;
  deviceFingerprint: string;
  paymentInstrument: string | null;
  ip: string;
}

/** `Backend/config/seed.json`'s `anomalies.sandbagger` / `.smurf` blocks — the two
 * planted behavioural anomalies Task 3 wires into the population. */
export interface AnomalyConfig {
  sandbagger: { latentSkill: number; sinkToRating: number; throwRateMilli: number };
  smurf: { latentSkill: number };
}

/** Where the two planted anomalies ended up, so the harness and report can
 * find them by id without guessing indices. */
export interface PlantedAnomalies {
  sandbaggerId: string;
  smurfId: string;
  sandbagger: AnomalyConfig['sandbagger'];
}

export interface Population {
  players: Player[];
  /** Pairs the harness knows are the same person — the ground truth for §9. */
  colludingPairs: Array<[string, string]>;
  /** Present only when `opts.anomalies` was supplied. */
  plantedAnomalies?: PlantedAnomalies;
}

/**
 * Maps a latent-skill value expressed on the rating scale (seed.json's
 * `latentSkill`, same 400..2600 range as a rating) onto the 0..1
 * execution-skill scale `strategy.ts` consumes. Shared by the per-player draw
 * and the seed.json planted anomalies so both "skill" numbers mean the same
 * thing.
 */
function skillFromLatentPoints(points: number): number {
  return clamp((points - 800) / 1600, 0.05, 0.98);
}

export function buildPopulation(
  rng: Rng,
  count: number,
  opts: {
    startingBalanceCents: number;
    initialRating: number;
    collusionPairs: number;
    /** Task 3: Backend/config/seed.json's planted sandbagger + smurf, when wired. */
    anomalies?: AnomalyConfig;
  },
): Population {
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    // Starting ratings are spread from a normal around the initial: the
    // matchmaker needs a real distribution to band against, and with everyone
    // flat at 1200 the "top decile" is the whole population and new-player
    // protection starves every match (the thin-population trap in
    // DevDocs/architecture.md, here amplified into a feedback loop).
    const rating = clamp(Math.round(rng.normal(opts.initialRating, 250)), 100, 2600);
    // Independent of `rating` — see the F-1 note above the imports.
    const latentSkillPoints = clamp(Math.round(rng.normal(opts.initialRating, 250)), 400, 2600);
    const skill = clamp(skillFromLatentPoints(latentSkillPoints) + rng.range(-0.15, 0.15), 0.05, 0.98);
    players.push({
      id: `p${i.toString().padStart(5, '0')}`,
      rating,
      ratedMatches: 0,
      balanceCents: opts.startingBalanceCents,
      skill,
      greed: rng.range(0.7, 1.9),
      deviceFingerprint: `dev-${i}`,
      paymentInstrument: rng.next() < 0.85 ? `card-${i}` : null,
      ip: `10.${rng.int(255)}.${rng.int(255)}.${rng.int(255)}`,
    });
  }

  // Wire colluding pairs: give both members one shared signal.
  const colludingPairs: Array<[string, string]> = [];
  for (let i = 0; i < opts.collusionPairs && i * 2 + 1 < count; i++) {
    const a = players[i * 2]!;
    const b = players[i * 2 + 1]!;
    const shared = rng.int(3);
    if (shared === 0) b.deviceFingerprint = a.deviceFingerprint;
    else if (shared === 1) b.ip = a.ip;
    else b.paymentInstrument = a.paymentInstrument ?? `card-shared-${i}`, (a.paymentInstrument ??= b.paymentInstrument);
    colludingPairs.push([a.id, b.id]);
  }

  // Task 3: plant the sandbagger and smurf in the LAST two slots, well clear
  // of the colluding-pair indices above (at most `2 * collusionPairs`, and
  // collusionPairs is ~2% of count). Each keeps an ordinary, unique device /
  // IP / payment instrument — they share no identity signal with anyone,
  // which is the point: the false-negative this task measures has to come
  // from the absence of BEHAVIOURAL detection, not from also disabling the
  // identity checks these two would otherwise be exposed to.
  let plantedAnomalies: PlantedAnomalies | undefined;
  if (opts.anomalies && count >= 2) {
    const sandbagger = players[count - 2]!;
    sandbagger.skill = skillFromLatentPoints(opts.anomalies.sandbagger.latentSkill);
    // Starting rating is left as its ordinary seeded draw — seed.json's
    // $behaviour describes a sink FROM wherever they start TO sinkToRating,
    // not a fixed starting point.

    const smurf = players[count - 1]!;
    smurf.skill = skillFromLatentPoints(opts.anomalies.smurf.latentSkill);
    // "entering fresh at rating.initial with zero matches played" (seed.json)
    // — forced exact rather than left to the normal draw, which could land
    // anywhere in initialRating +/- 250.
    smurf.rating = opts.initialRating;

    plantedAnomalies = { sandbaggerId: sandbagger.id, smurfId: smurf.id, sandbagger: opts.anomalies.sandbagger };
  }

  return plantedAnomalies ? { players, colludingPairs, plantedAnomalies } : { players, colludingPairs };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
