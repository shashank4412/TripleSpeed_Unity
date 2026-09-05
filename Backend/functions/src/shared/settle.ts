/**
 * Settlement. Ported from src/Redline.Server/Money/SettlementService.cs +
 * SettlementCalculator.cs, adapted to a Firestore transaction.
 *
 * Exactly-once three independent ways:
 *   1. redline_settlements/{matchId} is read first; if it exists, this returns.
 *   2. the match state is re-read inside the transaction and must be `answered`.
 *   3. every ledger row and rating-history row has a deterministic id, so a
 *      second write of one is refused by Firestore.
 *
 * Money and rating move in the SAME transaction — a rating applied by a
 * follow-up would survive a money rollback and the two would then disagree
 * about who won.
 */
import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import { db, C, SUB, HOUSE_UID, Timestamp, FieldValue } from './firebase.js';
import { appendLedger } from './ledger.js';
import { recordMeeting } from './sightings.js';
import { loadConfig } from './config.js';
import {
  settle,
  outcomeFromScores,
  applyElo,
  posterEloScore,
  type EconomyConfig,
} from '@redline/rating';
import type { MatchDoc, SubmissionDoc, AccountDoc, ResultDoc } from './types.js';

export type SettleStatus = 'settled' | 'alreadySettled' | 'notSettleable';

export interface SettleResult {
  status: SettleStatus;
  matchId: string;
}

export async function settleMatch(matchId: string, nowMs = Date.now()): Promise<SettleResult> {
  const { economy } = await loadConfig(nowMs);

  return db.runTransaction(async (txn) => {
    const matchRef = db.collection(C.matches).doc(matchId);
    const settlementRef = db.collection(C.settlements).doc(matchId);

    // --- reads (all before any write) ---
    const [settlementSnap, matchSnap] = await Promise.all([txn.get(settlementRef), txn.get(matchRef)]);

    if (settlementSnap.exists) return { status: 'alreadySettled', matchId };
    if (!matchSnap.exists) return { status: 'notSettleable', matchId };

    const match = matchSnap.data() as MatchDoc;
    if (match.state !== 'answered' || !match.challengerUid) return { status: 'notSettleable', matchId };

    const posterUid = match.posterUid;
    const challengerUid = match.challengerUid;

    const [posterSubSnap, challengerSubSnap, posterAccSnap, challengerAccSnap, houseAccSnap] = await Promise.all([
      txn.get(matchRef.collection(SUB.submissions).doc(posterUid)),
      txn.get(matchRef.collection(SUB.submissions).doc(challengerUid)),
      txn.get(db.collection(C.accounts).doc(posterUid)),
      txn.get(db.collection(C.accounts).doc(challengerUid)),
      txn.get(db.collection(C.accounts).doc(HOUSE_UID)),
    ]);

    const posterSub = posterSubSnap.exists ? (posterSubSnap.data() as SubmissionDoc) : null;
    const challengerSub = challengerSubSnap.exists ? (challengerSubSnap.data() as SubmissionDoc) : null;
    const posterAcc = posterAccSnap.data() as AccountDoc;
    const challengerAcc = challengerAccSnap.data() as AccountDoc;

    // A missing submission is ABANDONED at zero and settles as an ordinary loss (ADR 0004).
    const posterScore = posterSub?.serverScore ?? 0;
    const challengerScore = challengerSub?.serverScore ?? 0;
    const posterOutcome = posterSub?.outcome ?? 'Abandoned';
    const challengerOutcome = challengerSub?.outcome ?? 'Abandoned';

    const outcome = outcomeFromScores(posterScore, challengerScore);
    const money = settle(
      match.stakeCents,
      economy.money.rakeBasisPoints,
      outcome,
      economy.money.tieOddCentToPoster,
    );

    const elo = applyElo(
      economy.rating,
      posterAcc.rating,
      posterAcc.ratedMatches,
      challengerAcc.rating,
      challengerAcc.ratedMatches,
      posterEloScore(outcome),
    );

    // --- writes ---
    txn.create(settlementRef, {
      settledAt: Timestamp.fromMillis(nowMs),
      outcome,
      potCents: money.potCents,
      rakeCents: money.rakeCents,
      posterScore,
      challengerScore,
    });

    if (money.posterCreditCents > 0) appendLedger(txn, matchId, posterUid, money.posterCreditCents, 'payout', nowMs);
    if (money.challengerCreditCents > 0)
      appendLedger(txn, matchId, challengerUid, money.challengerCreditCents, 'payout', nowMs);
    if (money.rakeCents > 0) appendLedger(txn, matchId, HOUSE_UID, money.rakeCents, 'rake', nowMs);

    writeRatingHistory(txn, matchId, posterUid, posterAcc.rating, elo.posterRating, elo.k, posterEloScore(outcome));
    writeRatingHistory(
      txn,
      matchId,
      challengerUid,
      challengerAcc.rating,
      elo.challengerRating,
      elo.k,
      1000 - posterEloScore(outcome),
    );

    txn.update(posterAccSnap.ref, {
      balanceCents: posterAcc.balanceCents + money.posterCreditCents,
      rating: elo.posterRating,
      ratedMatches: posterAcc.ratedMatches + 1,
    });
    txn.update(challengerAccSnap.ref, {
      balanceCents: challengerAcc.balanceCents + money.challengerCreditCents,
      rating: elo.challengerRating,
      ratedMatches: challengerAcc.ratedMatches + 1,
    });
    if (houseAccSnap.exists) {
      txn.update(houseAccSnap.ref, { balanceCents: FieldValue.increment(money.rakeCents) });
    } else {
      txn.create(houseAccSnap.ref, houseAccount(money.rakeCents, nowMs));
    }

    writeResult(txn, matchRef, posterUid, {
      score: posterScore,
      outcome: posterOutcome,
      opponentScore: challengerScore,
      opponentOutcome: challengerOutcome,
      result: outcome === 'posterWins' ? 'won' : outcome === 'challengerWins' ? 'lost' : 'draw',
      potCents: money.potCents,
      rakeCents: money.rakeCents,
      creditedCents: money.posterCreditCents,
      netCents: money.posterCreditCents - match.stakeCents,
      ratingBefore: posterAcc.rating,
      ratingAfter: elo.posterRating,
      ratingDelta: elo.posterDelta,
    });
    writeResult(txn, matchRef, challengerUid, {
      score: challengerScore,
      outcome: challengerOutcome,
      opponentScore: posterScore,
      opponentOutcome: posterOutcome,
      result: outcome === 'challengerWins' ? 'won' : outcome === 'posterWins' ? 'lost' : 'draw',
      potCents: money.potCents,
      rakeCents: money.rakeCents,
      creditedCents: money.challengerCreditCents,
      netCents: money.challengerCreditCents - match.stakeCents,
      ratingBefore: challengerAcc.rating,
      ratingAfter: elo.challengerRating,
      ratingDelta: elo.challengerDelta,
    });

    txn.update(matchRef, { state: 'settled', settledAt: Timestamp.fromMillis(nowMs) });
    txn.delete(db.collection(C.challenges).doc(matchId));
    txn.delete(db.collection(C.ttl).doc(matchId));
    recordMeeting(txn, posterUid, challengerUid, nowMs);

    return { status: 'settled', matchId };
  });
}

function writeRatingHistory(
  txn: Transaction,
  matchId: string,
  accountUid: string,
  ratingBefore: number,
  ratingAfter: number,
  kFactor: number,
  scoreMilli: number,
): void {
  const ref = db.collection(C.ratingHistory).doc(`${matchId}__${accountUid}__settlement`);
  txn.create(ref, {
    accountUid,
    matchId,
    kind: 'settlement',
    ratingBefore,
    ratingAfter,
    kFactor,
    scoreMilli,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function writeResult(
  txn: Transaction,
  matchRef: DocumentReference,
  uid: string,
  result: ResultDoc,
): void {
  txn.create(matchRef.collection(SUB.result).doc(uid), result);
}

function houseAccount(rakeCents: number, nowMs: number) {
  return {
    displayName: 'House',
    deviceFingerprint: '',
    paymentInstrument: null,
    lastSeenIp: null,
    rating: 0,
    ratedMatches: 0,
    balanceCents: rakeCents,
    createdAt: Timestamp.fromMillis(nowMs),
  };
}

export type { EconomyConfig };
