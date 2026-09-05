/**
 * How the matchmaker is tuned. Ported from MatchmakingSettings.cs and
 * RoleAsymmetry.cs. Every field comes from `matchmaking` (and `roleAsymmetry`)
 * in the economy config, passed in rather than read so the proof can sweep a
 * parameter without a config file.
 */
import type { CollusionPolicy } from './collusion.js';

/**
 * How the rating band widens with a challenge's age.
 * `band = min(initial + widenPer10s * floor(age / 10s), cap)`.
 */
export interface RatingBandSettings {
  readonly initial: number;
  readonly widenPer10s: number;
  readonly cap: number;
}

/** How often two accounts may meet, and over what window. */
export interface RecentOpponentSettings {
  readonly maxMatches: number;
  readonly windowHours: number;
}

/** Shielding a player's first few matches from the top of the ladder. */
export interface NewPlayerProtectionSettings {
  readonly matches: number;
  readonly excludeTopDecile: boolean;
}

export interface MatchmakingSettings {
  /** True for `stakeMatch: "exact"`. Bucketing is the documented alternative and is not implemented (ADR 0008). */
  readonly exactStakeOnly: boolean;
  readonly band: RatingBandSettings;
  readonly recentOpponent: RecentOpponentSettings;
  readonly newPlayerProtection: NewPlayerProtectionSettings;
  readonly collusion: CollusionPolicy;
}

/**
 * What the server does about the challenger's information advantage. The poster
 * sets their number blind; the challenger, if told it, banks one point above.
 * See ADR 0009. The proof's outcome model needs the same switch for the control
 * run in report section 6.
 */
export interface RoleAsymmetrySettings {
  /**
   * When true the server never sends the poster's banked score to a challenger
   * who has not finished their run. Enforced by not sending it -- a patched
   * client displays whatever it receives.
   */
  readonly hideTargetFromChallenger: boolean;
}
