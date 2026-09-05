/**
 * REDLINE Cloud Functions entry point. Everything is gen 2 in asia-south1.
 *
 * Callables (client, over the Firebase Functions SDK with the anonymous ID token):
 *   ensureAccount · preview · createMatch · submitRun · matchmake · joinMatch · withdrawChallenge · addBalance
 *   adminConfig  — operator-only Remote Config editor behind a Secret Manager passphrase (Backend/hosting/)
 * Background:
 *   sweep        — Cloud Scheduler, every 60s: the real deadline enforcer
 *   onTtlMarkerDeleted — Firestore TTL cleanup, a fast path only
 *
 * settleMatch is internal (called by submitRun and the sweep) and is not exported.
 */
import { setGlobalOptions } from 'firebase-functions/v2';

setGlobalOptions({ region: 'asia-south1', maxInstances: 10 });

export { ensureAccountFn as ensureAccount } from './handlers/ensureAccount.js';
export { previewFn as preview } from './handlers/preview.js';
export { createMatchFn as createMatch } from './handlers/createMatch.js';
export { submitRunFn as submitRun } from './handlers/submitRun.js';
export { matchmakeFn as matchmake } from './handlers/matchmake.js';
export { joinMatchFn as joinMatch } from './handlers/joinMatch.js';
export { withdrawChallengeFn as withdrawChallenge } from './handlers/withdrawChallenge.js';
export { addBalanceFn as addBalance } from './handlers/addBalance.js';
export { adminConfigFn as adminConfig } from './handlers/adminConfig.js';
export { gameConfigFn as gameConfig } from './handlers/gameConfig.js';
export { sweepFn as sweep } from './handlers/sweep.js';
export { onTtlMarkerDeleted } from './handlers/ttl.js';
