/**
 * Display tiers, from `rating.leagues` in config. Ported from Leagues.cs.
 *
 * No hysteresis, by decision: a league is a pure function of the current rating.
 * A buffer would need storing the league someone is currently in -- a second
 * source of truth that can disagree with the rating and one more thing to keep
 * correct through a rollback. A league is display only; nothing in matchmaking
 * or settlement reads it. ADR 0007.
 */
export interface LeagueSettings {
  /**
   * Ascending. A player is in tier i when their rating is below boundaries[i]
   * and at or above boundaries[i-1], so N boundaries describe N+1 tiers.
   */
  readonly boundaries: readonly number[];
}

export function leagueCount(settings: LeagueSettings): number {
  return settings.boundaries.length + 1;
}

/** Zero-based tier index. 0 is the lowest. */
export function leagueIndexOf(settings: LeagueSettings, rating: number): number {
  for (let i = 0; i < settings.boundaries.length; i++) {
    if (rating < settings.boundaries[i]!) return i;
  }
  return settings.boundaries.length;
}
