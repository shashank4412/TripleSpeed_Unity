/**
 * S-103 — the winner is decided by integer comparison only.
 *
 * The brief: "One point decides who takes the pot, so a system that is usually
 * right is a system that occasionally robs someone." This file is the guard on
 * the last step of that — how two banked scores become an outcome, and how that
 * outcome becomes an Elo S value.
 *
 * THE TRACED CHAIN (the actual deliverable; these tests are what keep it true):
 *
 *   Backend/sim-core-ts/src/simulation.ts:142   scoreUnits += BigInt * BigInt
 *   Backend/sim-core-ts/src/simulation.ts:235   crash zeroes it (0n)
 *   Backend/sim-core-ts/src/simulation.ts:240   score = Number(scoreUnits / BigInt(positionScale))
 *   Backend/functions/src/handlers/submitRun.ts:131  serverScore: sim.score
 *   -> entry point A: submitRun.ts:155,177   (challenger submitted; settle now)
 *   -> entry point B: sweep.ts:79            (submission window closed; settle)
 *      Both call the SAME settleMatch(); there is no second settlement path.
 *   Backend/functions/src/shared/settle.ts:69-70  serverScore ?? 0
 *   Backend/functions/src/shared/settle.ts:74     outcomeFromScores(...)
 *   Backend/rating/src/settlement.ts:86-87        === and >, on integers
 *   Backend/rating/src/index.ts:49-58             posterEloScore -> 0 | 500 | 1000
 *   Backend/functions/src/shared/settle.ts:88     applyElo(..., posterEloScore)
 *   Backend/rating/src/elo.ts:125-131             rejects anything but 0/500/1000
 *   Backend/rating/src/elo.ts:136                 posterScoreMilli / 1000 -> 0 | 0.5 | 1
 *
 * No float appears anywhere in it. The one division (elo.ts:136) is guarded by
 * the validation immediately above it, so its three possible results are exact.
 *
 * TWO FINDINGS, recorded here because this file is where someone will look:
 *
 * 1. The hazard S-103 was written to guard against is UNREACHABLE under the
 *    shipped game config, and `maxReachableScore` below proves it from the
 *    config rather than by assertion. That is worth more than the guard itself:
 *    it means the bound is the thing to protect, and raising maxRunTicks or a
 *    lane multiplier is the change that would need re-checking.
 *
 * 2. The score of record is the FLOORED display score, not `scoreUnits`. Two
 *    runs whose scoreUnits differ by less than positionScale (60,000) settle as
 *    a tie. That is defensible and probably deliberate — the number the player
 *    watched is the number they are paid on, which is the trust property the
 *    result screen lives or dies by — but it is a real design consequence and it
 *    is not written down anywhere else. Not changed here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { settle, outcomeFromScores } from '../src/settlement.js';
import { posterEloScore } from '../src/index.js';
import { applyElo, EloScore } from '../src/elo.js';
import { parseEconomyConfig } from '../src/economyConfig.js';

const economy = parseEconomyConfig(
  readFileSync(new URL('../../../Backend/config/redline.economy.json', import.meta.url), 'utf8'),
);

describe('outcomeFromScores is an exact integer comparison', () => {
  it('separates two scores one unit apart at the top of the exact-integer range', () => {
    // 2^53 - 2 and 2^53 - 1. Both are exactly representable; one step further up
    // is where consecutive integers start to collide. This is the largest
    // magnitude at which a strict win is even askable of a JS number, which is
    // why the test is here rather than at two comfortable small numbers.
    const lo = Number.MAX_SAFE_INTEGER - 1; // 9007199254740990
    const hi = Number.MAX_SAFE_INTEGER; //     9007199254740991

    expect(hi - lo).toBe(1); // the premise: they really are adjacent
    expect(outcomeFromScores(hi, lo)).toBe('posterWins');
    expect(outcomeFromScores(lo, hi)).toBe('challengerWins');
    expect(outcomeFromScores(hi, hi)).toBe('tie');
  });

  it('characterises the cliff: one unit further up, adjacency is gone', () => {
    // Not a bug being blessed — a fact being pinned, so the bound test below is
    // visibly load-bearing rather than decorative. At 2^53 the double grid is
    // coarser than one point, and any comparison built on `number` silently
    // returns a tie. Nothing in this product can reach here (see below), and if
    // that ever changes, the score must move to BigInt end to end.
    const at = 2 ** 53;
    expect(at + 1).toBe(at); // JavaScript, not a typo
    expect(outcomeFromScores(at + 1, at)).toBe('tie');
  });

  it('treats equal scores as a tie, including a double-crash at zero', () => {
    expect(outcomeFromScores(0, 0)).toBe('tie');
    expect(outcomeFromScores(49_500, 49_500)).toBe('tie');
  });

  it('separates adjacent scores across the whole reachable range', () => {
    for (const n of [0, 1, 2, 999, 1000, 49_499, 49_500, 1_000_000]) {
      expect(outcomeFromScores(n + 1, n)).toBe('posterWins');
      expect(outcomeFromScores(n, n + 1)).toBe('challengerWins');
      expect(outcomeFromScores(n, n)).toBe('tie');
    }
  });
});

describe('the reachable score is bounded far below the double cliff', () => {
  // Computed from the SHIPPED game config, not from remembered numbers. This is
  // the test that fails if someone raises maxRunTicks or a lane multiplier into
  // territory where `number` stops being an exact integer type for the score.
  const game = JSON.parse(
    readFileSync(new URL('../../../Backend/config/redline.game.json', import.meta.url), 'utf8'),
  ) as {
    lanes: { multiplier: number }[];
    time: { ticksPerSecond: number; maxRunTicks: number };
    speed: { maxMilliUnitsPerSec: number };
  };

  const maxMultiplier = Math.max(...game.lanes.map((l) => l.multiplier));
  const positionScale = 1000 * game.time.ticksPerSecond;
  const maxScoreUnits = game.time.maxRunTicks * game.speed.maxMilliUnitsPerSec * maxMultiplier;
  const maxReachableScore = maxScoreUnits / positionScale;

  it('is exact as a Number by an enormous margin', () => {
    // Every tick adds at most maxSpeedMilli * maxMultiplier, and a run is at
    // most maxRunTicks ticks. Nothing in the core can exceed this product.
    expect(maxScoreUnits).toBe(2_970_000_000);
    expect(maxReachableScore).toBe(49_500);

    // Both the accumulator and the display score sit ~11 orders of magnitude
    // below the point where adjacent integers stop being distinguishable.
    expect(Number.isSafeInteger(maxScoreUnits)).toBe(true);
    expect(maxReachableScore).toBeLessThan(Number.MAX_SAFE_INTEGER / 1e9);
  });

  it('leaves the BigInt -> Number narrowing at simulation.ts:240 lossless', () => {
    // `score: Number(scoreUnits / scale)` narrows a BigInt. The division is
    // exact integer truncation in BigInt; the narrowing is lossless only while
    // the quotient is a safe integer, which the bound above guarantees.
    const scale = BigInt(positionScale);
    for (const units of [0n, 1n, 59_999n, 60_000n, BigInt(maxScoreUnits)]) {
      const narrowed = Number(units / scale);
      expect(Number.isSafeInteger(narrowed)).toBe(true);
      expect(BigInt(narrowed)).toBe(units / scale);
    }
  });
});

describe('a tie pays S = 0.5 to both sides and the odd cent to the poster', () => {
  it('maps an equal-score outcome to EloScore.Draw', () => {
    expect(posterEloScore(outcomeFromScores(1340, 1340))).toBe(EloScore.Draw);
    expect(posterEloScore(outcomeFromScores(0, 0))).toBe(EloScore.Draw);
    expect(EloScore.Draw / 1000).toBe(0.5); // exact: 500/1000
  });

  it('moves no rating between two equally rated players on a draw', () => {
    // S = 0.5 against an expectation of exactly 0.5 is a zero delta. If the
    // draw ever stopped being exactly 0.5 this is the assertion that notices.
    const u = applyElo(economy.rating, 1200, 30, 1200, 30, posterEloScore('tie'));
    expect(u.posterDelta).toBe(0);
    expect(u.challengerDelta).toBe(0);
    expect(u.floorInjection).toBe(0);
  });

  it('is zero-sum on a decided result, so a win cannot inflate the pool', () => {
    const win = applyElo(economy.rating, 1200, 30, 1400, 30, posterEloScore('posterWins'));
    expect(win.posterDelta + win.challengerDelta).toBe(0);
    expect(win.posterDelta).toBeGreaterThan(0);
  });

  it('rejects any S that is not 0, 500 or 1000 — the guard that makes /1000 safe', () => {
    // elo.ts:136 divides by 1000. That is exact for exactly three inputs, and
    // this validation is what restricts it to them. Do not remove it as
    // redundant; it is the reason the division is not a float hazard.
    expect(() => applyElo(economy.rating, 1200, 30, 1200, 30, 501)).toThrow(
      /score must be 0, 500 or 1000/,
    );
  });

  it('splits the pot to the cent, odd cent to the poster', () => {
    // pot 206, rake 21, payout 185 -> 93 / 92. ADR 0002: the poster set their
    // number blind, so the cent that cannot be split goes to them.
    const odd = settle(103, economy.money.rakeBasisPoints, 'tie', economy.money.tieOddCentToPoster);
    expect(odd.posterCreditCents - odd.challengerCreditCents).toBe(1);
    expect(odd.posterCreditCents + odd.challengerCreditCents + odd.rakeCents).toBe(odd.potCents);
  });

  it('carries a one-point win all the way to the money, over the whole ladder', () => {
    // The end-to-end statement the brief actually makes: one point decides the
    // pot. Enumerated over the shipped ladder so a stake change extends it.
    for (const stakeCents of economy.money.stakesCents) {
      const outcome = outcomeFromScores(1341, 1340);
      expect(outcome).toBe('posterWins');
      const money = settle(stakeCents, economy.money.rakeBasisPoints, outcome, true);
      expect(money.posterCreditCents).toBe(money.payoutCents);
      expect(money.challengerCreditCents).toBe(0);
      expect(posterEloScore(outcome)).toBe(EloScore.Win);
    }
  });
});
