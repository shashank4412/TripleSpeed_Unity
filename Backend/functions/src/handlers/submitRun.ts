/**
 * submitRun — the endpoint the whole anti-cheat design rests on. Ported from
 * SubmitEndpoints.
 *
 * Take the server's seed, the server's config and the client's swipes, run the
 * SAME core the client ran, and store what it says. The client's claimed score
 * reaches exactly two places — a field and a `disagreed` flag in the log — and
 * neither is a decision. There is no seed field in the request.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { db, C, SUB, Timestamp } from '../shared/firebase.js';
import { requireUid, requireIdempotencyKey } from '../shared/auth.js';
import {
  readReservation,
  writeReservation,
  complete,
  fingerprint,
  IdempotencyConflict,
} from '../shared/idempotency.js';
import { loadConfig } from '../shared/config.js';
import { settleMatch } from '../shared/settle.js';
import { isProvisional, type EconomyConfig } from '@redline/rating';
import { runSimulation, parseInputLog, formatInputLog } from '@redline/sim-core';
import type { InputEvent } from '@redline/sim-core';
import type { MatchDoc, MatchRole, SubmissionDoc } from '../shared/types.js';

interface Req {
  matchId: string;
  inputLog: string;
  clientScore?: number;
  clientOutcome?: string;
  finalTick: number;
  configHash: string;
  idempotencyKey: string;
}

const ROUTE = 'submitRun';
const MAX_INPUT_LOG_CHARS = 256 * 1024;
const REFUSED = 'This run cannot be submitted.';

export const submitRunFn = onCall<Req>({ region: 'asia-south1' }, async (request) => {
  const uid = requireUid(request);
  const key = requireIdempotencyKey(request.data?.idempotencyKey);
  const d = request.data;
  const now = Date.now();

  if (
    !d ||
    typeof d.matchId !== 'string' ||
    typeof d.inputLog !== 'string' ||
    typeof d.finalTick !== 'number' ||
    typeof d.configHash !== 'string'
  ) {
    throw new HttpsError('invalid-argument', 'matchId, inputLog, finalTick and configHash are required.');
  }
  if (d.inputLog.length > MAX_INPUT_LOG_CHARS) throw new HttpsError('invalid-argument', 'inputLog is too large.');

  const { gameConfig, configHash, economy } = await loadConfig(now);

  let events: InputEvent[];
  try {
    events = parseInputLog(d.inputLog);
    assertStrictlyIncreasing(events);
    if (events.length > gameConfig.maxRunTicks) throw new Error('more events than ticks');
  } catch (e) {
    throw new HttpsError('invalid-argument', `Malformed input log: ${(e as Error).message}`);
  }
  if (d.finalTick < 0 || d.finalTick > gameConfig.maxRunTicks) {
    throw new HttpsError('invalid-argument', `finalTick ${d.finalTick} is outside [0, ${gameConfig.maxRunTicks}].`);
  }

  const fp = fingerprint(ROUTE, d.matchId, d.configHash, events.map((e) => `${e.tick}${e.direction}`).join(','));

  let settleId = '';

  try {
    const body = await db.runTransaction(async (txn) => {
      const matchRef = db.collection(C.matches).doc(d.matchId);
      const subRef = matchRef.collection(SUB.submissions).doc(uid);

      // ---- reads ----
      const reservation = await readReservation(txn, uid, key, fp);
      if (reservation.kind === 'replay') return reservation.response.body;

      const [matchSnap, subSnap] = await Promise.all([txn.get(matchRef), txn.get(subRef)]);

      if (!matchSnap.exists) {
        writeReservation(txn, uid, key, ROUTE, fp);
        const b = notFoundBody();
        complete(txn, uid, key, 404, b);
        return b;
      }
      const match = matchSnap.data() as MatchDoc;
      const role: MatchRole | null =
        match.posterUid === uid ? 'poster' : match.challengerUid === uid ? 'challenger' : null;

      // If the poster is about to open the challenge, we need their rating for the
      // matchmaker inventory. One extra read, still before any write.
      const posterAccSnap =
        role === 'poster' && match.state === 'created'
          ? await txn.get(db.collection(C.accounts).doc(uid))
          : null;

      // ---- writes ----
      writeReservation(txn, uid, key, ROUTE, fp);

      if (!role) {
        const b = notFoundBody();
        complete(txn, uid, key, 404, b);
        return b;
      }

      const refusal = refusalReason(match, role, subSnap.exists, d.configHash, configHash, economy, now);
      if (refusal) {
        const b = JSON.stringify({ result: 'refused', error: REFUSED, reason: refusal });
        complete(txn, uid, key, 409, b);
        return b;
      }

      const sim = runSimulation(gameConfig, { seed: match.seed, events, maxRunTicks: gameConfig.maxRunTicks });

      const disagreed =
        (typeof d.clientScore === 'number' && d.clientScore !== sim.score) ||
        (d.clientOutcome != null && d.clientOutcome.toLowerCase() !== sim.outcome.toLowerCase()) ||
        sim.endTick !== d.finalTick;

      const submission: SubmissionDoc = {
        role,
        inputLog: formatInputLog(events),
        clientClaimedScore: typeof d.clientScore === 'number' ? d.clientScore : null,
        serverScore: sim.score,
        outcome: sim.outcome,
        rejectedInputs: sim.rejectedInputs,
        configHash: sim.configHash,
        receivedAt: Timestamp.fromMillis(now),
      };
      txn.create(subRef, submission);

      let nextState = match.state;
      if (role === 'poster' && match.state === 'created') {
        nextState = 'open';
        txn.update(matchRef, { state: 'open' });
        const posterAcc = posterAccSnap?.data();
        txn.create(db.collection(C.challenges).doc(d.matchId), {
          stakeCents: match.stakeCents,
          bankedScore: sim.score,
          creatorUid: uid,
          creatorRating: (posterAcc?.['rating'] as number | undefined) ?? economy.rating.initial,
          creatorProvisional: isProvisional(economy.rating, (posterAcc?.['ratedMatches'] as number | undefined) ?? 0),
          createdAt: match.createdAt,
          seed: match.seed,
        });
      }

      if (match.challengerUid && role === 'challenger') settleId = d.matchId;

      const okBody = JSON.stringify({
        result: 'ok',
        matchId: d.matchId,
        role,
        serverScore: sim.score,
        outcome: sim.outcome,
        endTick: sim.endTick,
        distance: sim.distance,
        finalLane: sim.finalLane,
        rejectedInputs: sim.rejectedInputs,
        configHash: sim.configHash,
        disagreed,
        state: nextState,
      });
      complete(txn, uid, key, 200, okBody);
      return okBody;
    });

    if (settleId) {
      try {
        await settleMatch(settleId, Date.now());
      } catch (e) {
        console.error('settlement after submission failed; sweep will retry', settleId, e);
      }
    }
    return JSON.parse(body) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof IdempotencyConflict) throw new HttpsError('aborted', err.message);
    throw err;
  }
});

function notFoundBody(): string {
  return JSON.stringify({ result: 'not_found', error: 'No challenge with that Game ID.' });
}

function assertStrictlyIncreasing(events: readonly InputEvent[]): void {
  let last = -1;
  for (const e of events) {
    if (!Number.isInteger(e.tick) || e.tick < 0) throw new Error('a tick must be a non-negative integer');
    if (e.tick <= last) throw new Error('ticks must strictly increase');
    last = e.tick;
  }
}

function refusalReason(
  match: MatchDoc,
  role: MatchRole,
  alreadySubmitted: boolean,
  claimedHash: string,
  currentHash: string,
  economy: EconomyConfig,
  nowMs: number,
): string | null {
  if (alreadySubmitted) return 'already-submitted';
  if (claimedHash !== currentHash) return `config-mismatch client=${claimedHash} server=${currentHash}`;
  if (match.configHash !== currentHash) return `match-config-stale match=${match.configHash} server=${currentHash}`;

  const committedAtMs =
    role === 'poster' ? match.createdAt.toMillis() : (match.answeredAt?.toMillis() ?? match.createdAt.toMillis());
  if (nowMs > committedAtMs + economy.money.noSubmissionWindowSeconds * 1000) return 'window-closed';

  if (role === 'poster' && match.state === 'created') return null;
  if (role === 'challenger' && match.state === 'answered') return null;
  return `state=${match.state} role=${role}`;
}
