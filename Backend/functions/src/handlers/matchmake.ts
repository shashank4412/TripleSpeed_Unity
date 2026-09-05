/**
 * matchmake — selects a posted challenge for the caller, or, if none exists
 * even at the widened rating-band cap, posts one on the caller's behalf.
 * Ported from MatchmakeEndpoints, extended for decision #11 ("Starvation
 * policy", DevDocs/assignment-refined.md §4).
 *
 * Selecting a match stays read-only: it stakes nothing and joins nothing. The
 * client follows up with joinMatch (which takes the money under its own
 * idempotency key), so a network retry cannot answer a different challenge
 * than the one the player was shown. The poster's banked score is withheld by
 * NOT sending it — a patched client shows whatever it receives (ADR 0009).
 *
 * Posting is different: the pool is a live inventory of challenges, not
 * players, and "nothing to match against" means the arriving player should
 * grow that inventory rather than wait on an empty one — never a bot. That
 * decision has to be made and acted on in the same server round trip, or it
 * is a client retry loop racing other callers instead of an atomic outcome:
 * once select() decides the pool is genuinely empty at this player's stake,
 * this handler immediately calls the same stake-and-create path createMatch
 * uses (shared/challenge.ts) so the fallback happens exactly once per call,
 * under the same idempotency guarantee every other money-moving endpoint gets.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { db, C } from '../shared/firebase.js';
import { requireUid, requireIdempotencyKey, callerIp } from '../shared/auth.js';
import { FirestoreChallengeInventory } from '../shared/inventory.js';
import { loadConfig } from '../shared/config.js';
import { createChallengeTxn } from '../shared/challenge.js';
import { Matchmaker, SystemClock, type Challenger } from '@redline/rating';
import type { AccountDoc } from '../shared/types.js';

interface Req {
  stakeCents: number;
  /**
   * Required, like every other money-moving call. Not spent unless this
   * arrival is the one that ends up posting its own challenge (outcome
   * `posted`); a plain match or a shown-but-unanswered offer never touches it.
   */
  idempotencyKey: string;
}

const ROUTE = 'matchmake';

export const matchmakeFn = onCall<Req>({ region: 'asia-south1' }, async (request) => {
  const uid = requireUid(request);
  const key = requireIdempotencyKey(request.data?.idempotencyKey);
  const stakeCents = request.data?.stakeCents;
  const now = Date.now();
  const { economy, configHash } = await loadConfig(now);
  const ip = callerIp(request);

  if (typeof stakeCents !== 'number' || !economy.money.stakesCents.includes(stakeCents)) {
    throw new HttpsError('invalid-argument', 'Stake is not on the configured ladder.');
  }

  const accSnap = await db.collection(C.accounts).doc(uid).get();
  if (!accSnap.exists) throw new HttpsError('failed-precondition', 'Call ensureAccount first.');
  const account = accSnap.data() as AccountDoc;

  const matchmaker = new Matchmaker(new FirestoreChallengeInventory(), new SystemClock(), economy.matchmaking);
  const challenger: Challenger = {
    accountId: uid,
    rating: account.rating,
    settledMatches: account.ratedMatches,
    stakeCents,
  };
  const result = await matchmaker.select(challenger);

  const excludedByReason: Record<string, number> = {};
  for (const e of result.excluded) excludedByReason[e.reason] = (excludedByReason[e.reason] ?? 0) + 1;

  if (result.outcome === 'matched') {
    const offer = result.selected!;
    return {
      outcome: 'matched',
      offer: {
        matchId: offer.matchId,
        stakeCents: offer.stakeCents,
        // Withheld while the mitigation is on (default). null !== "unavailable" —
        // the flag tells the lobby which copy to show.
        targetScore: economy.roleAsymmetry.hideTargetFromChallenger ? null : offer.bankedScore,
        targetHidden: economy.roleAsymmetry.hideTargetFromChallenger,
        creatorRating: offer.creatorRating,
        creatorProvisional: offer.creatorProvisional,
        createdAtMs: offer.createdAt,
      },
      considered: result.considered,
      excluded: excludedByReason,
    };
  }

  // Starvation fallback: nothing survived even at result.ratingBandCap (the
  // widest band any candidate was judged against — config-driven via
  // economy.matchmaking.band.cap, never a separate hardcoded threshold here).
  // Convert this arrival into a poster, atomically, in the same call.
  const posted = await createChallengeTxn({
    uid,
    stakeCents,
    idempotencyKey: key,
    route: ROUTE,
    ip,
    now,
    economy,
    configHash,
  });

  if (posted['result'] === 'insufficient_balance') {
    return {
      outcome: 'insufficient_balance',
      offer: null,
      considered: result.considered,
      excluded: excludedByReason,
      requiredCents: posted['requiredCents'],
      balanceCents: posted['balanceCents'],
    };
  }

  return {
    outcome: 'posted',
    offer: null,
    considered: result.considered,
    excluded: excludedByReason,
    posted: {
      matchId: posted['matchId'],
      stakeCents: posted['stakeCents'],
      seed: posted['seed'],
      configHash: posted['configHash'],
      balanceCents: posted['balanceCents'],
    },
  };
});
