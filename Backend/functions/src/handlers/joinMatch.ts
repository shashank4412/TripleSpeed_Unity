/**
 * joinMatch — the challenger stakes into an open challenge. Ported from
 * MatchEndpoints.JoinMatchAsync.
 *
 * The collusion check runs before the transaction (a read-only resolution that
 * does not change second to second, like the C# version's pre-lock read); the
 * transaction then re-checks state, expiry and balance under Firestore's own
 * serialisation on the match doc, which is the "FOR UPDATE" equivalent. Every
 * refusal — taken, expired, collusion — is the SAME opaque message; the real
 * reason is written to redline_accountLinks / logs.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { db, C, Timestamp } from '../shared/firebase.js';
import { requireUid, requireIdempotencyKey, callerIp } from '../shared/auth.js';
import {
  readReservation,
  writeReservation,
  complete,
  fingerprint,
  IdempotencyConflict,
} from '../shared/idempotency.js';
import { readAccount, createAccount, DEMO_GRANT_CENTS } from '../shared/accounts.js';
import { appendLedger } from '../shared/ledger.js';
import { recordIp } from '../shared/sightings.js';
import { isLinked, recordAccountLink } from '../shared/collusion.js';
import { loadConfig } from '../shared/config.js';
import type { MatchDoc } from '../shared/types.js';

interface Req {
  matchId: string;
  idempotencyKey: string;
}

const ROUTE = 'joinMatch';
const UNAVAILABLE = 'This challenge is no longer available.';

export const joinMatchFn = onCall<Req>({ region: 'asia-south1' }, async (request) => {
  const uid = requireUid(request);
  const key = requireIdempotencyKey(request.data?.idempotencyKey);
  const matchId = request.data?.matchId;
  const now = Date.now();
  const { economy } = await loadConfig(now);
  const ip = callerIp(request);

  if (typeof matchId !== 'string') throw new HttpsError('invalid-argument', 'matchId is required.');

  // Plain read to learn the poster, then resolve collusion outside the txn.
  const preSnap = await db.collection(C.matches).doc(matchId).get();
  const posterUid = preSnap.exists ? (preSnap.data() as MatchDoc).posterUid : null;
  const link =
    posterUid && posterUid !== uid
      ? await isLinked(uid, posterUid, economy.matchmaking.collusion, now)
      : posterUid === uid
        ? 'sameAccount'
        : 'none';

  const fp = fingerprint(ROUTE, matchId);

  try {
    const body = await db.runTransaction(async (txn) => {
      const matchRef = db.collection(C.matches).doc(matchId);

      // ---- reads ----
      const reservation = await readReservation(txn, uid, key, fp);
      if (reservation.kind === 'replay') return reservation.response.body;
      const [matchSnap, account] = await Promise.all([txn.get(matchRef), readAccount(txn, uid)]);
      const balanceCents = account ? account.balanceCents : DEMO_GRANT_CENTS;

      // ---- writes ----
      writeReservation(txn, uid, key, ROUTE, fp);

      if (!matchSnap.exists) {
        const b = JSON.stringify({ result: 'not_found', error: 'No challenge with that Game ID.' });
        complete(txn, uid, key, 404, b);
        return b;
      }
      const match = matchSnap.data() as MatchDoc;

      const open = match.state === 'open' && match.expiresAt.toMillis() > now;
      const refused =
        link !== 'none' ? `collusion=${link}` : !open ? `state=${match.state}` : null;

      if (refused) {
        if (link !== 'none' && posterUid) {
          recordAccountLink(uid, posterUid, link, `join:${matchId}`, now).catch(() => {});
        }
        console.warn('join refused', { matchId, uid, reason: refused });
        const b = JSON.stringify({ result: 'unavailable', error: UNAVAILABLE });
        complete(txn, uid, key, 409, b);
        return b;
      }

      if (balanceCents < match.stakeCents) {
        if (!account) createAccount(txn, uid, economy.rating.initial, { ip }, now);
        const b = JSON.stringify({
          result: 'insufficient_balance',
          requiredCents: match.stakeCents,
          balanceCents,
        });
        complete(txn, uid, key, 402, b);
        return b;
      }

      const answeredAt = Timestamp.fromMillis(now);
      txn.update(matchRef, { challengerUid: uid, state: 'answered', answeredAt });

      // The TTL doc now tracks the submission window, not the challenge TTL.
      txn.set(db.collection(C.ttl).doc(matchId), {
        matchId,
        kind: 'submission',
        expireAt: Timestamp.fromMillis(now + economy.money.noSubmissionWindowSeconds * 1000),
      });

      appendLedger(txn, matchId, uid, -match.stakeCents, 'stake', now);
      if (account) {
        txn.update(db.collection(C.accounts).doc(uid), { balanceCents: balanceCents - match.stakeCents });
      } else {
        createAccount(txn, uid, economy.rating.initial, { ip }, now, balanceCents - match.stakeCents);
      }
      recordIp(txn, uid, ip, now);

      const b = JSON.stringify({
        result: 'ok',
        matchId,
        stakeCents: match.stakeCents,
        state: 'answered',
        seed: match.seed, // the poster's seed, unchanged — same road
        configHash: match.configHash,
        balanceCents: balanceCents - match.stakeCents,
      });
      complete(txn, uid, key, 200, b);
      return b;
    });

    return JSON.parse(body) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof IdempotencyConflict) throw new HttpsError('aborted', err.message);
    throw err;
  }
});
