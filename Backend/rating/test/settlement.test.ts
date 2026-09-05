import { describe, it, expect } from 'vitest';
import { settle, outcomeFromScores } from '../src/settlement.js';

// Ported from SettlementCalculatorTests.cs. Money is integer cents throughout.
describe('settle', () => {
  const RAKE_BP = 1000; // 10%

  it.each([50, 100, 200, 500, 1000])('balances to the pot at stake %d cents', (stake) => {
    for (const outcome of ['posterWins', 'challengerWins', 'tie'] as const) {
      const s = settle(stake, RAKE_BP, outcome);
      expect(s.potCents).toBe(stake * 2);
      expect(s.payoutCents).toBe(s.potCents - s.rakeCents);
      expect(s.posterCreditCents + s.challengerCreditCents + s.rakeCents).toBe(s.potCents);
    }
  });

  it('takes 10% rake, exact on the current ladder', () => {
    expect(settle(50, RAKE_BP, 'posterWins').rakeCents).toBe(10);
    expect(settle(200, RAKE_BP, 'posterWins').rakeCents).toBe(40);
    expect(settle(1000, RAKE_BP, 'posterWins').rakeCents).toBe(200);
  });

  it('pays the whole payout to the winner', () => {
    const s = settle(200, RAKE_BP, 'posterWins');
    expect(s.posterCreditCents).toBe(s.payoutCents);
    expect(s.challengerCreditCents).toBe(0);
  });

  it('splits a tie evenly, odd cent to the poster', () => {
    // Force an odd payout: pot 202, rake round-half-even(202*1000/10000)=round(20.2)=20, payout 182 -> 91/91.
    const even = settle(101, RAKE_BP, 'tie');
    expect(even.posterCreditCents).toBe(91);
    expect(even.challengerCreditCents).toBe(91);
    // pot 206, rake round(20.6)=21, payout 185 -> 93 / 92, poster gets the odd cent.
    const odd = settle(103, RAKE_BP, 'tie');
    expect(odd.posterCreditCents - odd.challengerCreditCents).toBe(1);
    expect(odd.posterCreditCents + odd.challengerCreditCents + odd.rakeCents).toBe(odd.potCents);
  });

  it('uses banker’s rounding for the rake', () => {
    // pot*bp/10000 = 5.5 -> nearest even = 6 ; = 4.5 -> nearest even = 4
    expect(settle(275, 100, 'posterWins').rakeCents).toBe(6); // 550*100/10000 = 5.5
    expect(settle(225, 100, 'posterWins').rakeCents).toBe(4); // 450*100/10000 = 4.5
  });

  it('rejects a non-positive or non-integer stake', () => {
    expect(() => settle(0, RAKE_BP, 'tie')).toThrow();
    expect(() => settle(-5, RAKE_BP, 'tie')).toThrow();
    expect(() => settle(1.5, RAKE_BP, 'tie')).toThrow();
  });
});

describe('outcomeFromScores', () => {
  it('treats equal scores as a tie, including a double-crash', () => {
    expect(outcomeFromScores(0, 0)).toBe('tie');
    expect(outcomeFromScores(1340, 1340)).toBe('tie');
    expect(outcomeFromScores(900, 200)).toBe('posterWins');
    expect(outcomeFromScores(200, 900)).toBe('challengerWins');
  });
});
