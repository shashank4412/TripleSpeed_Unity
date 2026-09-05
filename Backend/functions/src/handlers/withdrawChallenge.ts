/**
 * withdrawChallenge — the poster asks for an unanswered challenge to be closed
 * and the stake returned NOW, instead of waiting out the 15-minute sweep.
 *
 * WHY THIS EXISTS
 * matchmake on an empty pool stakes a challenge for the caller in the same call
 * (starvation fallback, decision #11). If that call is slow — a gen-2 cold
 * start — the client can give up waiting before the response lands, or the
 * player can tap Cancel. Either way the stake has already moved. Before this
 * function the only way back was `sweep`, which refunds a poster only once the
 * challenge is older than money.challengeTtlSeconds (900s). A staked player
 * seeing an error and their balance gone for 15 minutes is the money pillar
 * failing in the most direct way; this closes it to one round-trip.
 *
 * It is the poster-initiated twin of the sweep's expiry path and shares its one
 * writer, shared/refundChallenge.ts. It refunds ONLY while the challenge is
 * still unanswered: once a challenger has staked (state 'answered') the match is
 * a real contest and settles under ADR 0004 — a poster cannot pull their stake
 * out from under an opponent.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { db, C } from '../shared/firebase.js';
import { requireUid, requireIdempotencyKey } from '../shared/auth.js';
import {
  readReservation,
  writeReservation,
  complete,
  fingerprint,
  IdempotencyConflict,
} from '../shared/idempotency.js';
import { readAccount } from '../shared/accounts.js';
import { refundOpenChallenge } from '../shared/refundChallenge.js';
import type { MatchDoc } from '../shared/types.js';

interface Req {
  matchId: string;
  idempotencyKey: string;
}

const ROUTE = 'withdrawChallenge';

export const withdrawChallengeFn = onCall<Req>({ region: 'asia-south1' }, async (request) => {
  const uid = requireUid(request);
  const key = requireIdempotencyKey(request.data?.idempotencyKey);
  const matchId = request.data?.matchId;
  const now = Date.now();

  if (typeof matchId !== 'string') throw new HttpsError('invalid-argument', 'matchId is required.');

  const fp = fingerprint(ROUTE, matchId);

  try {
    const body = await db.runTransaction(async (txn) => {
      // ---- reads ----
      const reservation = await readReservation(txn, uid, key, fp);
      if (reservation.kind === 'replay') return reservation.response.body;

      const [matchSnap, account] = await Promise.all([
        txn.get(db.collection(C.matches).doc(matchId)),
        readAccount(txn, uid),
      ]);
      const balanceCents = account ? account.balanceCents : 0;

      // ---- writes ----
      writeReservation(txn, uid, key, ROUTE, fp);

      if (!matchSnap.exists) {
        const b = JSON.stringify({ result: 'not_found', balanceCents });
        complete(txn, uid, key, 404, b);
        return b;
      }

      const m = matchSnap.data() as MatchDoc;

      if (m.posterUid !== uid) {
        // Only the poster can withdraw their own challenge. Opaque on purpose —
        // it does not confirm the challenge exists to a non-owner.
        const b = JSON.stringify({ result: 'forbidden', balanceCents });
        complete(txn, uid, key, 403, b);
        return b;
      }

      if (m.state === 'created' || m.state === 'open') {
        // Still unanswered — return the stake now. `balanceCents` was read
        // before any write, so the +stake is applied to a clean base exactly
        // as the sweep does.
        refundOpenChallenge(txn, matchId, m, balanceCents, now);
        const b = JSON.stringify({ result: 'withdrawn', balanceCents: balanceCents + m.stakeCents });
        complete(txn, uid, key, 200, b);
        return b;
      }

      // 'answered'  — a challenger has staked; the match proceeds (ADR 0004).
      // 'expired'   — the sweep or a prior withdraw already refunded.
      // 'settled' / 'rolledBack' — terminal.
      // Every one is a no-op that reports the current balance, so a client
      // retry (or a race with the sweep) is harmless.
      const b = JSON.stringify({ result: `already_${m.state}`, balanceCents });
      complete(txn, uid, key, 200, b);
      return b;
    });

    return JSON.parse(body) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof IdempotencyConflict) throw new HttpsError('aborted', err.message);
    throw err;
  }
});
