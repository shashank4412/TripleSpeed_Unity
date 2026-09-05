/**
 * The one place a challenge is staked into existence. Ported out of
 * MatchEndpoints.CreateMatchAsync (createMatch.ts) so a second caller — the
 * matchmaking starvation fallback (decision #11, assignment-refined §4) — can
 * post on a player's behalf without re-implementing the balance check, the
 * idempotency reservation or the ledger row. Two copies of "how a stake is
 * taken" drift exactly like two copies of the sim core or the rating model
 * would (see CLAUDE.md, "One simulation core" / "src/Redline.Simulation");
 * this is that same rule applied to money.
 *
 * One transaction covers the idempotency key, the balance check, the match
 * doc, the −stake ledger row and the balance decrement. The seed is issued
 * HERE and never accepted from the client — the request has nowhere to put
 * one, whichever caller invoked this.
 */
import { db, C, Timestamp } from './firebase.js';
import { readReservation, writeReservation, complete, fingerprint, moneyPart, IdempotencyConflict } from './idempotency.js';
import { readAccount, createAccount, DEMO_GRANT_CENTS } from './accounts.js';
import { appendLedger } from './ledger.js';
import { recordIp } from './sightings.js';
import { nextGameId, nextSeed } from './ids.js';
import type { MatchDoc } from './types.js';
import type { EconomyConfig } from '@redline/rating';
import { HttpsError } from 'firebase-functions/v2/https';

export interface CreateChallengeParams {
  readonly uid: string;
  readonly stakeCents: number;
  readonly idempotencyKey: string;
  /** Namespaces the idempotency fingerprint so a manual post and an auto-post never collide on a coincidentally reused key. */
  readonly route: string;
  readonly ip: string | null;
  readonly now: number;
  readonly economy: EconomyConfig;
  readonly configHash: string;
}

/**
 * Runs the stake-and-create transaction and returns the parsed response body —
 * the same shape createMatchFn has always returned (`result: 'ok' | 'insufficient_balance'`,
 * matchId, stakeCents, seed, configHash, balanceCents). Throws HttpsError('aborted', …)
 * on an idempotency-key reuse-with-different-request, exactly as createMatchFn did.
 */
export async function createChallengeTxn(params: CreateChallengeParams): Promise<Record<string, unknown>> {
  const { uid, stakeCents, idempotencyKey: key, route, ip, now, economy, configHash } = params;
  const fp = fingerprint(route, moneyPart(stakeCents));

  try {
    const body = await db.runTransaction(async (txn) => {
      // ---- reads ----
      const reservation = await readReservation(txn, uid, key, fp);
      if (reservation.kind === 'replay') return reservation.response.body;
      const account = await readAccount(txn, uid);

      const balanceCents = account ? account.balanceCents : DEMO_GRANT_CENTS;

      // ---- writes ----
      writeReservation(txn, uid, key, route, fp);

      if (balanceCents < stakeCents) {
        if (!account) createAccount(txn, uid, economy.rating.initial, { ip }, now);
        const refusal = JSON.stringify({
          result: 'insufficient_balance',
          requiredCents: stakeCents,
          balanceCents,
        });
        complete(txn, uid, key, 402, refusal);
        return refusal;
      }

      // The account doc is written once — created already debited, or updated below.
      if (!account) {
        createAccount(txn, uid, economy.rating.initial, { ip }, now, balanceCents - stakeCents);
      }

      const matchId = nextGameId();
      const seed = nextSeed();
      const createdAt = Timestamp.fromMillis(now);
      const expiresAt = Timestamp.fromMillis(now + economy.money.challengeTtlSeconds * 1000);

      const match: MatchDoc = {
        stakeCents,
        state: 'created',
        posterUid: uid,
        challengerUid: null,
        seed,
        configHash,
        createdAt,
        expiresAt,
        answeredAt: null,
        settledAt: null,
        posterIp: ip,
      };
      txn.create(db.collection(C.matches).doc(matchId), match);
      txn.create(db.collection(C.ttl).doc(matchId), { matchId, kind: 'challenge', expireAt: expiresAt });

      appendLedger(txn, matchId, uid, -stakeCents, 'stake', now);
      if (account) {
        txn.update(db.collection(C.accounts).doc(uid), { balanceCents: balanceCents - stakeCents });
      }
      recordIp(txn, uid, ip, now);

      const okBody = JSON.stringify({
        result: 'ok',
        matchId,
        stakeCents,
        state: 'created',
        seed,
        configHash,
        balanceCents: balanceCents - stakeCents,
      });
      complete(txn, uid, key, 200, okBody);
      return okBody;
    });

    return JSON.parse(body) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof IdempotencyConflict) throw new HttpsError('aborted', err.message);
    throw err;
  }
}
