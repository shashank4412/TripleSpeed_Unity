/**
 * createMatch — the poster stakes and a challenge is born. Ported from
 * MatchEndpoints.CreateMatchAsync.
 *
 * The stake-and-create transaction itself lives in shared/challenge.ts so the
 * matchmaking starvation fallback (matchmakeFn) can call the exact same path
 * instead of a second copy of it — see that file's header.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { requireUid, requireIdempotencyKey, callerIp } from '../shared/auth.js';
import { loadConfig } from '../shared/config.js';
import { createChallengeTxn } from '../shared/challenge.js';

interface Req {
  stakeCents: number;
  idempotencyKey: string;
}

const ROUTE = 'createMatch';

export const createMatchFn = onCall<Req>({ region: 'asia-south1' }, async (request) => {
  const uid = requireUid(request);
  const key = requireIdempotencyKey(request.data?.idempotencyKey);
  const stakeCents = request.data?.stakeCents;
  const now = Date.now();
  const { economy, configHash } = await loadConfig(now);
  const ip = callerIp(request);

  if (typeof stakeCents !== 'number' || !economy.money.stakesCents.includes(stakeCents)) {
    throw new HttpsError('invalid-argument', 'Stake is not on the configured ladder.');
  }

  return createChallengeTxn({ uid, stakeCents, idempotencyKey: key, route: ROUTE, ip, now, economy, configHash });
});
