/**
 * The identity trails the collusion checks read: which device fingerprints an
 * account has used, and which IPs it has been seen at. Written at account
 * creation, at posting a challenge, and at answering one. Ported from
 * DeviceFingerprints / IpSightings in src/Redline.Data.
 */
import type { Transaction } from 'firebase-admin/firestore';
import { db, C, Timestamp } from './firebase.js';

export function recordDeviceFingerprint(txn: Transaction, uid: string, fingerprint: string, atMs: number): void {
  if (!fingerprint) return;
  // Keyed by (fingerprint, account) so re-seeing a pair just refreshes lastSeenAt.
  const ref = db.collection(C.deviceFingerprints).doc(`${fingerprint}__${uid}`);
  txn.set(
    ref,
    { fingerprint, accountUid: uid, lastSeenAt: Timestamp.fromMillis(atMs), firstSeenAt: Timestamp.fromMillis(atMs) },
    { merge: true },
  );
}

export function recordIp(txn: Transaction, uid: string, ip: string | null, atMs: number): void {
  if (!ip) return;
  // Keyed by (ip, account) and merged, exactly like recordDeviceFingerprint
  // above. Before this it created a fresh auto-id doc on EVERY backend call, so
  // redline_ipSightings grew without bound; behind one NAT the shared-IP
  // collusion scan in collusion.ts then went quadratic and matchmake blew its
  // request timeout (feature 0012). One row per pair now, lastSeenAt refreshed.
  const ref = db.collection(C.ipSightings).doc(`${ip}__${uid}`);
  const at = Timestamp.fromMillis(atMs);
  txn.set(ref, { accountUid: uid, ip, firstSeenAt: at, lastSeenAt: at }, { merge: true });
}

export function recordMeeting(txn: Transaction, aUid: string, bUid: string, atMs: number): void {
  const ref = db.collection(C.meetings).doc();
  txn.create(ref, { aUid, bUid, at: Timestamp.fromMillis(atMs) });
}
