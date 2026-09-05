/**
 * Elo with a non-constant K, applied as a symmetric transfer.
 * Ported verbatim from src/Redline.Rating/EloRating.cs.
 *
 * The rating pool is conserved: one delta is computed for the match and the two
 * players receive +delta and -delta. Applying each player's own K instead does
 * not net to zero -- a provisional at K=40 beating an established player at K=16
 * injects 24 points into the pool out of nothing, and over 50000 matches that
 * drifts the rating bands and therefore matchmaking. See ADR 0007.
 */
import { roundHalfAwayFromZero } from './math.js';

/**
 * One row of `rating.kFactors`. A band matches when every bound it states is
 * satisfied; a bound left null is not tested.
 */
export interface KFactorBand {
  /** Applies while the player has fewer settled matches than this. */
  readonly maxMatches: number | null;
  /** Applies while the player is rated below this. */
  readonly maxRating: number | null;
  /** How far one result may move a rating. */
  readonly k: number;
}

/** The `rating` section of the economy config, in the shape this code needs. */
export interface EloSettings {
  readonly initial: number;
  readonly floor: number;
  readonly ceiling: number | null;
  readonly provisionalMatches: number;
  readonly kFactors: readonly KFactorBand[];
}

/** How a match ended, for one side. Thousandths, so Elo's S never becomes a float. */
export const EloScore = {
  Loss: 0,
  Draw: 500,
  Win: 1000,
} as const;
export type EloScoreValue = (typeof EloScore)[keyof typeof EloScore];

/** The result of applying one match. */
export interface EloUpdate {
  readonly posterRating: number;
  readonly challengerRating: number;
  /** The K actually used. One value: both sides share it -- see ADR 0007. */
  readonly k: number;
  readonly posterDelta: number;
  readonly challengerDelta: number;
  /**
   * Points the rating pool gained because a player would otherwise have fallen
   * below the floor. Zero on almost every match, and the only way the pool is
   * not conserved. Surfaced so the proof can count it in report section 3.
   */
  readonly floorInjection: number;
}

/**
 * The first band whose bounds the player satisfies. Order in config is
 * significant and deliberately so -- it reads as a ladder.
 */
export function kFor(settings: EloSettings, rating: number, settledMatches: number): number {
  for (const band of settings.kFactors) {
    if (band.maxMatches !== null && settledMatches >= band.maxMatches) continue;
    if (band.maxRating !== null && rating >= band.maxRating) continue;
    return band.k;
  }
  throw new Error('no K factor band matched; the last entry in rating.kFactors must have no bounds.');
}

/**
 * True while the player has not yet played enough matches for their rating to
 * mean much -- for display, and for new-player protection in the matchmaker.
 */
export function isProvisional(settings: EloSettings, settledMatches: number): boolean {
  return settledMatches < settings.provisionalMatches;
}

/**
 * The K a pair of players share: the mean of what each one's band says, rounded
 * to an integer so the K recorded in ratingHistory is exactly the K applied and
 * an auditor can recompute the delta by hand.
 */
export function sharedK(
  settings: EloSettings,
  posterRating: number,
  posterMatches: number,
  challengerRating: number,
  challengerMatches: number,
): number {
  const posterK = kFor(settings, posterRating, posterMatches);
  const challengerK = kFor(settings, challengerRating, challengerMatches);
  return roundHalfAwayFromZero((posterK + challengerK) / 2);
}

/**
 * Standard Elo expectation. Plain float, safe here in a way it never is for
 * money: this number is multiplied by K and rounded to a whole rating point
 * before storage, so the last bits cannot survive to be compared.
 */
export function expected(rating: number, opponentRating: number): number {
  return 1 / (1 + Math.pow(10, (opponentRating - rating) / 400));
}

function applyFloor(settings: EloSettings, rating: number): number {
  if (rating < settings.floor) return settings.floor;
  if (settings.ceiling !== null && rating > settings.ceiling) return settings.ceiling;
  return rating;
}

/**
 * Applies one result. `posterScoreMilli` is the poster's side of it (EloScore),
 * and the challenger's is its complement, because a match has exactly one
 * result seen from two sides.
 */
export function applyElo(
  settings: EloSettings,
  posterRating: number,
  posterMatches: number,
  challengerRating: number,
  challengerMatches: number,
  posterScoreMilli: number,
): EloUpdate {
  if (
    posterScoreMilli !== EloScore.Loss &&
    posterScoreMilli !== EloScore.Draw &&
    posterScoreMilli !== EloScore.Win
  ) {
    throw new RangeError(`score must be 0, 500 or 1000, got ${posterScoreMilli}`);
  }

  const k = sharedK(settings, posterRating, posterMatches, challengerRating, challengerMatches);

  const exp = expected(posterRating, challengerRating);
  const actual = posterScoreMilli / 1000;

  // Computed once and negated, never rounded twice.
  const delta = roundHalfAwayFromZero(k * (actual - exp));

  const poster = applyFloor(settings, posterRating + delta);
  const challenger = applyFloor(settings, challengerRating - delta);

  const posterDelta = poster - posterRating;
  const challengerDelta = challenger - challengerRating;

  return {
    posterRating: poster,
    challengerRating: challenger,
    k,
    posterDelta,
    challengerDelta,
    // Non-zero only when the floor caught someone.
    floorInjection: posterDelta + challengerDelta,
  };
}
