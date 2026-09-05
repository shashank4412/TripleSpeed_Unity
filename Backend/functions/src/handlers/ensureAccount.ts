/**
 * ensureAccount — called right after anonymous sign-in. Creates the account doc
 * (with the demo grant) if this uid is new, and returns the lobby's view of the
 * player. Idempotent by nature: a second call just reads the existing doc.
 */
import { onCall } from 'firebase-functions/v2/https';
import { db } from '../shared/firebase.js';
import { requireUid, callerIp } from '../shared/auth.js';
import { ensureAccount } from '../shared/accounts.js';
import { recordDeviceFingerprint, recordIp } from '../shared/sightings.js';
import { loadConfig } from '../shared/config.js';
import { leagueIndexOf, isProvisional } from '@redline/rating';

interface Req {
  deviceFingerprint?: string;
  displayName?: string;
  paymentInstrument?: string | null;
}

export const ensureAccountFn = onCall<Req>({ region: 'asia-south1' }, async (request) => {
  const uid = requireUid(request);
  const now = Date.now();
  const { economy } = await loadConfig(now);
  const ip = callerIp(request);
  const fingerprint = (request.data?.deviceFingerprint ?? '').slice(0, 128);

  const account = await db.runTransaction(async (txn) => {
    const acc = await ensureAccount(
      txn,
      uid,
      economy.rating.initial,
      {
        displayName: request.data?.displayName,
        deviceFingerprint: fingerprint,
        paymentInstrument: request.data?.paymentInstrument ?? null,
        ip,
      },
      now,
    );
    recordDeviceFingerprint(txn, uid, fingerprint, now);
    recordIp(txn, uid, ip, now);
    return acc;
  });

  return {
    accountId: uid,
    displayName: account.displayName,
    rating: account.rating,
    ratedMatches: account.ratedMatches,
    provisional: isProvisional(economy.rating, account.ratedMatches),
    league: leagueIndexOf(economy.leagues, account.rating),
    leagueCount: economy.leagues.boundaries.length + 1,
    balanceCents: account.balanceCents,
    stakesCents: economy.money.stakesCents,
  };
});
