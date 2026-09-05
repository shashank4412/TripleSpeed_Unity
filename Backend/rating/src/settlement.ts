/**
 * The one place the money arithmetic of a match is written. Ported from
 * src/Redline.Data/SettlementCalculator.cs, converted to INTEGER CENTS.
 *
 * The payout preview the lobby shows and settlement itself both call this, so
 * "the number previewed is the number paid" is true by construction. Pure: no
 * clock, no Firestore, no config file — every input is an argument.
 */
import { divRoundHalfEven } from './math.js';

export type SettlementOutcome = 'posterWins' | 'challengerWins' | 'tie';

export interface Settlement {
  /** Both stakes, in cents. */
  readonly potCents: number;
  /** The house's cut, in cents. */
  readonly rakeCents: number;
  /** What is left for the players. Always potCents - rakeCents. */
  readonly payoutCents: number;
  /** Credited to the poster. Zero if they lost. */
  readonly posterCreditCents: number;
  /** Credited to the challenger. Zero if they lost. */
  readonly challengerCreditCents: number;
}

/**
 * Splits a match at `stakeCents` per player.
 *
 * @param rakeBasisPoints money.rakeBasisPoints. 1000 bp = 10%.
 * @param tieOddCentToPoster the leftover cent on an odd tie split. Always the
 *   poster, who set their number blind (ADR 0002).
 */
export function settle(
  stakeCents: number,
  rakeBasisPoints: number,
  outcome: SettlementOutcome,
  tieOddCentToPoster = true,
): Settlement {
  if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
    throw new RangeError(`stakeCents must be a positive integer, got ${stakeCents}`);
  }
  if (!Number.isInteger(rakeBasisPoints) || rakeBasisPoints < 0 || rakeBasisPoints > 10000) {
    throw new RangeError(`rakeBasisPoints must be an integer in [0, 10000], got ${rakeBasisPoints}`);
  }

  const potCents = stakeCents * 2;

  // Banker's rounding, as ADR 0002 specifies: away-from-zero would bias the
  // half-cent toward the house on every match.
  const rakeCents = Number(divRoundHalfEven(BigInt(potCents) * BigInt(rakeBasisPoints), 10000n));
  const payoutCents = potCents - rakeCents;

  let posterCreditCents: number;
  let challengerCreditCents: number;

  switch (outcome) {
    case 'posterWins':
      posterCreditCents = payoutCents;
      challengerCreditCents = 0;
      break;
    case 'challengerWins':
      posterCreditCents = 0;
      challengerCreditCents = payoutCents;
      break;
    case 'tie': {
      // Written as `Math.floor(payoutCents / 2)` until S-102. Identical result
      // for a non-negative integer, but `Math.floor` is the shape a float bug
      // takes, and `npm run lint:money` cannot tell a safe one from a wrong one.
      // Taking the remainder first says what the odd cent IS, rather than
      // recovering it from a rounding step.
      const odd = payoutCents % 2; // 0 or 1: the cent that cannot be split
      const each = (payoutCents - odd) / 2; // exact — the numerator is even
      posterCreditCents = each + (tieOddCentToPoster ? odd : 0);
      challengerCreditCents = each + (tieOddCentToPoster ? 0 : odd);
      break;
    }
  }

  // The invariant the whole product rests on, checked rather than trusted.
  if (posterCreditCents + challengerCreditCents + rakeCents !== potCents) {
    throw new Error(
      `settlement does not balance: ${posterCreditCents} + ${challengerCreditCents} + ${rakeCents} != ${potCents}`,
    );
  }

  return { potCents, rakeCents, payoutCents, posterCreditCents, challengerCreditCents };
}

/** From two server scores, which settlement outcome applies. Equal (incl. both 0) is a tie. */
export function outcomeFromScores(posterScore: number, challengerScore: number): SettlementOutcome {
  if (posterScore === challengerScore) return 'tie';
  return posterScore > challengerScore ? 'posterWins' : 'challengerWins';
}
