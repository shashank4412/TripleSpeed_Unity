/**
 * REDLINE rating + matchmaking — public surface. Ported from src/Redline.Rating
 * plus the money arithmetic from src/Redline.Data/SettlementCalculator.cs.
 *
 * The Cloud Functions and the fairness proof both import THIS module, so the
 * 50,000-match run exercises the exact code the server runs. Zero runtime deps.
 */
export { roundHalfAwayFromZero, divRoundHalfEven } from './math.js';

export { EloScore, kFor, isProvisional, sharedK, expected, applyElo } from './elo.js';
export type { EloScoreValue, KFactorBand, EloSettings, EloUpdate } from './elo.js';

export { leagueCount, leagueIndexOf } from './leagues.js';
export type { LeagueSettings } from './leagues.js';

export { SystemClock, VirtualClock } from './clock.js';
export type { IClock } from './clock.js';

export type { CollusionPolicy, CollusionLink } from './collusion.js';

export type {
  RatingBandSettings,
  RecentOpponentSettings,
  NewPlayerProtectionSettings,
  MatchmakingSettings,
  RoleAsymmetrySettings,
} from './matchmakingSettings.js';

export { InMemoryChallengeInventory, discretePercentileIndex } from './challengeInventory.js';
export type { IChallengeInventory, Challenge, Challenger } from './challengeInventory.js';

export { Matchmaker } from './matchmaker.js';
export type { MatchmakingResult, MatchmakingOutcome, Excluded, ExclusionReason } from './matchmaker.js';

export { settle, outcomeFromScores } from './settlement.js';
export type { Settlement, SettlementOutcome } from './settlement.js';

export { parseEconomyConfig, parseLeagueBoundaries } from './economyConfig.js';
export type { EconomyConfig, MoneySettings } from './economyConfig.js';

import { EloScore } from './elo.js';
import type { EloScoreValue } from './elo.js';
import type { SettlementOutcome } from './settlement.js';

/**
 * The poster's Elo score (thousandths) for a settlement outcome. A tie is S=0.5
 * for both sides, including a double-crash — ADR 0002 treats them as one case.
 */
export function posterEloScore(outcome: SettlementOutcome): EloScoreValue {
  switch (outcome) {
    case 'posterWins':
      return EloScore.Win;
    case 'challengerWins':
      return EloScore.Loss;
    case 'tie':
      return EloScore.Draw;
  }
}
