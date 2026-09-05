import { describe, it, expect } from 'vitest';
import { Matchmaker } from '../src/matchmaker.js';
import { InMemoryChallengeInventory } from '../src/challengeInventory.js';
import { VirtualClock } from '../src/clock.js';
import type { MatchmakingSettings } from '../src/matchmakingSettings.js';

const SETTINGS: MatchmakingSettings = {
  exactStakeOnly: true,
  band: { initial: 100, widenPer10s: 25, cap: 600 },
  recentOpponent: { maxMatches: 2, windowHours: 24 },
  newPlayerProtection: { matches: 5, excludeTopDecile: true },
  collusion: {
    blockSameAccount: true,
    blockSameDevice: true,
    blockSamePaymentInstrument: true,
    sharedIpWindowMinutes: 60,
  },
};

const T0 = 1_700_000_000_000;

function challenge(id: string, creator: string, rating: number, at = T0, stakeCents = 200) {
  return {
    matchId: id,
    stakeCents,
    bankedScore: 1000,
    creatorAccountId: creator,
    creatorRating: rating,
    creatorProvisional: false,
    createdAt: at,
    seed: '123',
  };
}

describe('Matchmaker', () => {
  it('picks the closest rating, then the oldest, then the id', async () => {
    const inv = new InMemoryChallengeInventory();
    inv.register('a', 'devA', null, 1200);
    inv.register('b', 'devB', null, 1400);
    inv.register('c', 'devC', null, 1250);
    inv.post(challenge('M2', 'b', 1400, T0));
    inv.post(challenge('M1', 'c', 1250, T0 + 5_000));
    const mm = new Matchmaker(inv, new VirtualClock(T0 + 10_000), SETTINGS);
    const r = await mm.select({ accountId: 'a', rating: 1200, settledMatches: 30, stakeCents: 200 });
    expect(r.outcome).toBe('matched');
    expect(r.selected?.matchId).toBe('M1'); // 50 away beats 200 away
  });

  it('widens the band with challenge age', async () => {
    const inv = new InMemoryChallengeInventory();
    inv.register('a', 'devA', null, 1200);
    inv.register('b', 'devB', null, 1360); // 160 away — outside the initial ±100
    inv.post(challenge('M1', 'b', 1360, T0));
    // +30s -> band 100 + 25*3 = 175 -> now in range
    const mm = new Matchmaker(inv, new VirtualClock(T0 + 30_000), SETTINGS);
    const r = await mm.select({ accountId: 'a', rating: 1200, settledMatches: 30, stakeCents: 200 });
    expect(r.selected?.matchId).toBe('M1');
  });

  it('excludes a shared-device opponent and records why', async () => {
    const inv = new InMemoryChallengeInventory();
    inv.register('a', 'shared', null, 1200);
    inv.register('b', 'shared', null, 1200);
    inv.post(challenge('M1', 'b', 1200, T0));
    const mm = new Matchmaker(inv, new VirtualClock(T0 + 1_000), SETTINGS);
    const r = await mm.select({ accountId: 'a', rating: 1200, settledMatches: 30, stakeCents: 200 });
    expect(r.outcome).toBe('postOwnChallenge');
    expect(r.excluded).toEqual([{ matchId: 'M1', reason: 'sameDevice' }]);
  });

  it('protects a new player from the top decile', async () => {
    const inv = new InMemoryChallengeInventory();
    inv.register('new', 'devN', null, 1200);
    for (let i = 0; i < 9; i++) inv.register(`low${i}`, `d${i}`, null, 1000 + i);
    inv.register('top', 'devT', null, 2400);
    inv.post(challenge('M1', 'top', 2400, T0, 200));
    const mm = new Matchmaker(inv, new VirtualClock(T0 + 1_000), SETTINGS);
    const r = await mm.select({ accountId: 'new', rating: 1200, settledMatches: 1, stakeCents: 200 });
    expect(r.excluded.some((e) => e.reason === 'newPlayerProtection')).toBe(true);
  });

  it('stops pairing after the recent-opponent cap', async () => {
    const inv = new InMemoryChallengeInventory();
    inv.register('a', 'devA', null, 1200);
    inv.register('b', 'devB', null, 1200);
    inv.recordMeeting('a', 'b', T0 - 1_000);
    inv.recordMeeting('a', 'b', T0 - 500);
    inv.post(challenge('M1', 'b', 1200, T0));
    const mm = new Matchmaker(inv, new VirtualClock(T0 + 1_000), SETTINGS);
    const r = await mm.select({ accountId: 'a', rating: 1200, settledMatches: 30, stakeCents: 200 });
    expect(r.excluded).toEqual([{ matchId: 'M1', reason: 'recentOpponent' }]);
  });

  // Decision #11 (DevDocs/assignment-refined.md §4): when nothing survives even
  // at the widened band cap, the arriving player posts their own challenge
  // instead of queueing against an empty pool -- never a bot. Matchmaker
  // itself only decides ('postOwnChallenge'); the server (matchmakeFn, via
  // shared/challenge.ts's createChallengeTxn) is what actually posts. This
  // exercises that contract at the inventory seam both sides share: after the
  // outcome is acted on the way the handler acts on it, the pool must show a
  // real challenge with the starved player as its creator, and a later
  // arrival must be able to match into it -- proof the inventory grew instead
  // of staying empty.
  it('a starved player becomes the creator of a new challenge, matchable by the next arrival', async () => {
    const inv = new InMemoryChallengeInventory();
    inv.register('a', 'devA', null, 1200);
    inv.register('b', 'devB', null, 1210);

    const mm = new Matchmaker(inv, new VirtualClock(T0), SETTINGS);

    // 'a' arrives to an empty pool. Nothing at any rating survives, even at
    // this challenge's own widest possible band (there IS no challenge to
    // widen a band against), so the outcome is the starvation fallback.
    const first = await mm.select({ accountId: 'a', rating: 1200, settledMatches: 30, stakeCents: 200 });
    expect(first.outcome).toBe('postOwnChallenge');
    expect(first.selected).toBeNull();

    // What the server does with that outcome: 'a' posts their own challenge,
    // same shape as a manual post (createMatch's path), never a simulated
    // opponent.
    inv.post(challenge('M-STARVED', 'a', 1200, T0));

    const postedByA = await inv.openAtStake(200);
    expect(postedByA).toHaveLength(1);
    expect(postedByA[0]?.matchId).toBe('M-STARVED');
    expect(postedByA[0]?.creatorAccountId).toBe('a');

    // The pool grew: 'b' arriving next matches straight into the challenge
    // 'a' was converted into, rather than finding an empty pool too.
    const second = await mm.select({ accountId: 'b', rating: 1210, settledMatches: 30, stakeCents: 200 });
    expect(second.outcome).toBe('matched');
    expect(second.selected?.matchId).toBe('M-STARVED');
    expect(second.selected?.creatorAccountId).toBe('a');
  });
});
