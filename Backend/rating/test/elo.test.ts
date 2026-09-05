import { describe, it, expect } from 'vitest';
import { applyElo, sharedK, kFor, isProvisional, EloScore } from '../src/elo.js';
import type { EloSettings } from '../src/elo.js';

// Ported from EloRatingTests.cs.
const SETTINGS: EloSettings = {
  initial: 1200,
  floor: 100,
  ceiling: null,
  provisionalMatches: 10,
  kFactors: [
    { maxMatches: 10, maxRating: null, k: 40 },
    { maxMatches: null, maxRating: 2100, k: 24 },
    { maxMatches: null, maxRating: null, k: 16 },
  ],
};

describe('kFor', () => {
  it('is provisional for the first 10 matches', () => {
    expect(kFor(SETTINGS, 1200, 0)).toBe(40);
    expect(kFor(SETTINGS, 1200, 9)).toBe(40);
    expect(kFor(SETTINGS, 1200, 10)).toBe(24);
  });
  it('slows at the top of the ladder', () => {
    expect(kFor(SETTINGS, 2099, 50)).toBe(24);
    expect(kFor(SETTINGS, 2100, 50)).toBe(16);
  });
});

describe('applyElo', () => {
  it('is zero-sum away from the floor: one delta, negated', () => {
    const u = applyElo(SETTINGS, 1200, 30, 1200, 30, EloScore.Win);
    expect(u.posterDelta).toBe(-u.challengerDelta);
    expect(u.floorInjection).toBe(0);
    expect(u.k).toBe(24);
    // K=24, expected 0.5, actual 1 -> delta = round(24*0.5) = 12
    expect(u.posterDelta).toBe(12);
  });

  it('shares one K across a mismatched pair (ADR 0007)', () => {
    // provisional (40) vs established below 2100 (24) -> mean 32
    expect(sharedK(SETTINGS, 1200, 3, 1500, 200)).toBe(32);
    const u = applyElo(SETTINGS, 1200, 3, 1500, 200, EloScore.Win);
    expect(u.k).toBe(32);
    expect(u.posterDelta).toBe(-u.challengerDelta);
  });

  it('a draw moves nothing between equal players', () => {
    const u = applyElo(SETTINGS, 1400, 20, 1400, 20, EloScore.Draw);
    expect(u.posterDelta).toBe(0);
    expect(u.challengerDelta).toBe(0);
  });

  it('holds the floor and records the injection', () => {
    // A near-floor player losing to a moderately stronger one: the raw delta
    // would push them below 100, so the floor catches it and injects points.
    const u = applyElo(SETTINGS, 105, 50, 300, 50, EloScore.Loss);
    expect(u.posterRating).toBe(100);
    expect(u.floorInjection).toBeGreaterThan(0);
  });
});

describe('isProvisional', () => {
  it('flips at provisionalMatches', () => {
    expect(isProvisional(SETTINGS, 9)).toBe(true);
    expect(isProvisional(SETTINGS, 10)).toBe(false);
  });
});
