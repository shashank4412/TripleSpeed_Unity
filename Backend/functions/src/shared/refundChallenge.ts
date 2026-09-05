/**
 * The one place an unanswered challenge's stake is returned to its poster.
 *
 * Extracted from sweep.ts's expireStaleChallenges so the scheduled sweep (the
 * 15-minute backstop) and the withdrawChallenge callable (the same-session
 * "I cancelled, give it back now" path) share exactly one implementation. Two
 * copies of a money movement drift the same way two copies of the sim core or
 * the rating model would — see CLAUDE.md, "One simulation core".
 *
 * WRITES ONLY. Firestore transactions require every read before every write, so
 * the caller does all the reads — the match doc, the poster's balance — and
 * passes the balance in. The caller is also responsible for the state guard
 * (`state ∈ {created, open}`): the sweep additionally checks the TTL has
 * elapsed, the withdraw additionally checks the caller owns the challenge.
 */
import type { Transaction } from 'firebase-admin/firestore';
import { db, C, Timestamp } from './firebase.js';
import { appendLedger } from './ledger.js';
import type { MatchDoc } from './types.js';

export function refundOpenChallenge(
  txn: Transaction,
  matchId: string,
  m: MatchDoc,
  posterBalanceCents: number,
  nowMs: number,
): void {
  // Deterministic ledger key `${posterUid}__refund` makes a second refund for
  // this challenge impossible even if two writers somehow got past the state
  // guard: txn.create on the existing row would abort the transaction.
  appendLedger(txn, matchId, m.posterUid, m.stakeCents, 'refund', nowMs);

  txn.update(db.collection(C.accounts).doc(m.posterUid), {
    balanceCents: posterBalanceCents + m.stakeCents,
  });
  txn.update(db.collection(C.matches).doc(matchId), {
    state: 'expired',
    settledAt: Timestamp.fromMillis(nowMs),
  });
  txn.delete(db.collection(C.challenges).doc(matchId));
  txn.delete(db.collection(C.ttl).doc(matchId));
  // No rating_history row: an unanswered challenge is not a result, so no
  // rating moves for either side — money and rating stay consistent trivially.
}
