/**
 * Admin SDK init and the handful of Firestore primitives the handlers share.
 * One initializeApp for the whole process.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

if (getApps().length === 0) initializeApp();

export const db = getFirestore();
export { FieldValue, Timestamp };

/**
 * The account that holds the house's rake. A real document, so the rake
 * reconciles like any other row.
 *
 * NOT `__house__`. Firestore reserves every document id matching `__.*__` and
 * refuses the write with INVALID_ARGUMENT, which made `settleMatch` throw on its
 * house-account read — i.e. NO match could settle, on the emulator or in
 * production. submitRun catches that failure and logs "sweep will retry", so the
 * player saw a successful submit and a match that stayed `answered` for ever.
 * Found by Tools/Seed the first time this backend was ever executed.
 *
 * `house` cannot collide with a real uid: Firebase anonymous UIDs are 28
 * characters.
 */
export const HOUSE_UID = 'house';

/** Collection names — every REDLINE document is under a redline_ prefix so this
 *  project can be shared with an unrelated app without a collision. */
export const C = {
  accounts: 'redline_accounts',
  matches: 'redline_matches',
  challenges: 'redline_challenges',
  idempotency: 'redline_idempotency',
  settlements: 'redline_settlements',
  ratingHistory: 'redline_ratingHistory',
  deviceFingerprints: 'redline_deviceFingerprints',
  ipSightings: 'redline_ipSightings',
  accountLinks: 'redline_accountLinks',
  meetings: 'redline_meetings',
  ttl: 'redline_ttl',
} as const;

/** Subcollections of a match document. */
export const SUB = {
  ledger: 'ledger',
  submissions: 'submissions',
  result: 'result',
} as const;
