/**
 * The Firestore implementation of IChallengeInventory. The production Matchmaker
 * runs over this in matchmake(); the proof runs the same Matchmaker over
 * InMemoryChallengeInventory. Neither implementation makes a decision — they
 * answer facts — so swapping them cannot change an outcome (the Liskov claim).
 */
import { db, C } from './firebase.js';
import type { IChallengeInventory, Challenge, CollusionPolicy, CollusionLink } from '@redline/rating';
import { discretePercentileIndex } from '@redline/rating';
import { linkedAccounts } from './collusion.js';

export class FirestoreChallengeInventory implements IChallengeInventory {
  async openAtStake(stakeCents: number): Promise<readonly Challenge[]> {
    // Total order is part of the contract: oldest first, then match id.
    const snap = await db
      .collection(C.challenges)
      .where('stakeCents', '==', stakeCents)
      .orderBy('createdAt', 'asc')
      .get();

    return snap.docs
      .map((d) => {
        const x = d.data();
        return {
          matchId: d.id,
          stakeCents: x['stakeCents'] as number,
          bankedScore: x['bankedScore'] as number,
          creatorAccountId: x['creatorUid'] as string,
          creatorRating: x['creatorRating'] as number,
          creatorProvisional: x['creatorProvisional'] as boolean,
          createdAt: (x['createdAt'] as { toMillis(): number }).toMillis(),
          seed: x['seed'] as string,
        } satisfies Challenge;
      })
      .sort((a, b) => a.createdAt - b.createdAt || (a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0));
  }

  async recentOpponentCounts(accountId: string, sinceMs: number): Promise<ReadonlyMap<string, number>> {
    const since = new Date(sinceMs);
    const counts = new Map<string, number>();
    for (const field of ['aUid', 'bUid'] as const) {
      const snap = await db.collection(C.meetings).where(field, '==', accountId).where('at', '>=', since).get();
      for (const d of snap.docs) {
        const other = (field === 'aUid' ? d.get('bUid') : d.get('aUid')) as string;
        counts.set(other, (counts.get(other) ?? 0) + 1);
      }
    }
    return counts;
  }

  linkedAccounts(accountId: string, policy: CollusionPolicy, nowMs: number): Promise<ReadonlyMap<string, CollusionLink>> {
    return linkedAccounts(accountId, policy, nowMs);
  }

  async topDecileRating(): Promise<number> {
    const snap = await db.collection(C.accounts).orderBy('rating', 'asc').get();
    const ratings = snap.docs.map((d) => d.get('rating') as number);
    if (ratings.length === 0) return Number.MAX_SAFE_INTEGER;
    return ratings[discretePercentileIndex(ratings.length, 0.9)]!;
  }
}
