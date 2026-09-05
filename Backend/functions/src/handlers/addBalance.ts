/**
 * addBalance — demo-only, in-game currency top-up.
 *
 * There is NO real-money deposit path in this build (shared/accounts.ts) and
 * this does not add one. It raises an EXISTING play balance by one stake-ladder
 * rung so the game can be demonstrated without a real settlement clearing
 * first — see DevDocs/decisions/0017-demo-balance-topup.md.
 *
 * The money invariants still hold:
 *   - integer cents only, no float anywhere (lint:money covers this file);
 *   - the amount must be a value already on the configured stake ladder — the
 *     client never names an arbitrary sum;
 *   - one Firestore transaction covers the idempotency key, the balanceCents
 *     write and the deposit row, so a retried call credits at most once;
 *   - the balance is server-capped at DEMO_MAX_BALANCE_CENTS.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { db, Timestamp } from '../shared/firebase.js';
import { requireUid, requireIdempotencyKey, callerIp } from '../shared/auth.js';
import { loadConfig } from '../shared/config.js';
import {
  readReservation,
  writeReservation,
  complete,
  fingerprint,
  moneyPart,
  IdempotencyConflict,
} from '../shared/idempotency.js';
import {
  readAccount,
  createAccount,
  accountRef,
  DEMO_GRANT_CENTS,
  DEMO_MAX_BALANCE_CENTS,
} from '../shared/accounts.js';

interface Req {
  amountCents: number;
  idempotencyKey: string;
}

const ROUTE = 'addBalance';

export const addBalanceFn = onCall<Req>({ region: 'asia-south1' }, async (request) => {
  const uid = requireUid(request);
  const key = requireIdempotencyKey(request.data?.idempotencyKey);
  const amountCents = request.data?.amountCents;
  const now = Date.now();
  const { economy } = await loadConfig(now);
  const ip = callerIp(request);

  if (
    typeof amountCents !== 'number' ||
    !Number.isInteger(amountCents) ||
    !economy.money.stakesCents.includes(amountCents)
  ) {
    throw new HttpsError('invalid-argument', 'Top-up amount must be a value on the configured stake ladder.');
  }

  // Namespaced by route and amount so a coincidentally reused key from another
  // call is a fingerprint mismatch, not a silent wrong replay.
  const fp = fingerprint(ROUTE, moneyPart(amountCents));

  try {
    const body = await db.runTransaction(async (txn) => {
      // ---- reads ----
      const reservation = await readReservation(txn, uid, key, fp);
      if (reservation.kind === 'replay') return reservation.response.body;
      const account = await readAccount(txn, uid);

      // ---- writes ----
      writeReservation(txn, uid, key, ROUTE, fp);

      const currentCents = account ? account.balanceCents : DEMO_GRANT_CENTS;
      const headroomCents = DEMO_MAX_BALANCE_CENTS - currentCents;
      // Integer min, no Math.* on a money path.
      const creditedCents =
        headroomCents <= 0 ? 0 : amountCents < headroomCents ? amountCents : headroomCents;
      const newBalanceCents = currentCents + creditedCents;

      if (!account) {
        // First interaction is a top-up: mint the account (with its one-time
        // demo grant + grant deposit row) already carrying the credited amount.
        createAccount(txn, uid, economy.rating.initial, { ip }, now, newBalanceCents);
      } else if (creditedCents > 0) {
        txn.update(accountRef(uid), { balanceCents: newBalanceCents });
      }

      if (creditedCents > 0) {
        // Standalone deposit row (references no match), same shape as the
        // demo-grant row. Keyed by the idempotency key so a retry that slips
        // past the reservation still cannot double-write it.
        txn.create(accountRef(uid).collection('deposits').doc(key), {
          amountCents: creditedCents,
          reason: 'demo-topup',
          createdAt: Timestamp.fromMillis(now),
        });
      }

      const ok = JSON.stringify({
        ok: true,
        credited: creditedCents,
        balanceCents: newBalanceCents,
        capped: creditedCents < amountCents,
        maxBalanceCents: DEMO_MAX_BALANCE_CENTS,
      });
      complete(txn, uid, key, 200, ok);
      return ok;
    });

    return JSON.parse(body) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof IdempotencyConflict) throw new HttpsError('aborted', err.message);
    throw err;
  }
});
