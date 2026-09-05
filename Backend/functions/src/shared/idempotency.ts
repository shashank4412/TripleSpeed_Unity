/**
 * Makes a money-moving callable happen at most once, however many times the
 * client retries. Ported from src/Redline.Data/IdempotencyStore.cs.
 *
 * Firestore transactions require every read before every write, so this is split
 * read/write: `readReservation` (a get) runs with the handler's other reads,
 * then `writeReservation` + `complete` run with its writes. Firestore serialises
 * concurrent copies on the key document, so a duplicate reads the first copy's
 * committed answer rather than racing past it.
 */
import { createHash } from 'node:crypto';
import type { Transaction } from 'firebase-admin/firestore';
import { db, C, Timestamp } from './firebase.js';

export interface StoredResponse {
  status: number;
  body: string;
}

export type Reservation =
  | { kind: 'fresh' }
  | { kind: 'replay'; response: StoredResponse };

export class IdempotencyConflict extends Error {}

function ref(uid: string, key: string) {
  return db.collection(C.idempotency).doc(`${uid}__${key}`);
}

/** SHA-256 of the request content behind a key — a collision here replays a wrong money outcome. */
export function fingerprint(...parts: string[]): string {
  return createHash('sha256').update(parts.join('')).digest('hex');
}

/** Formats cents into a fingerprint so 150 and 1.50 cannot look like different requests. */
export function moneyPart(cents: number): string {
  return `${cents}c`;
}

/** READ phase: is this key fresh, or already used? Throws on a fingerprint mismatch. */
export async function readReservation(
  txn: Transaction,
  uid: string,
  key: string,
  requestFingerprint: string,
): Promise<Reservation> {
  const snap = await txn.get(ref(uid, key));
  if (!snap.exists) return { kind: 'fresh' };

  const data = snap.data() as {
    requestFingerprint: string;
    responseStatus?: number;
    responseBody?: string;
  };
  if (data.requestFingerprint !== requestFingerprint) {
    throw new IdempotencyConflict('This idempotencyKey was already used for a different request.');
  }
  if (typeof data.responseStatus === 'number' && typeof data.responseBody === 'string') {
    return { kind: 'replay', response: { status: data.responseStatus, body: data.responseBody } };
  }
  // Reserved but unfilled: the first transaction is still open. Firestore's own
  // serialisation makes this effectively unreachable; treat it as retryable.
  throw new IdempotencyConflict('This request is still being processed. Retry with the same idempotencyKey.');
}

/** WRITE phase: claim a fresh key. */
export function writeReservation(txn: Transaction, uid: string, key: string, endpoint: string, requestFingerprint: string): void {
  txn.create(ref(uid, key), { endpoint, requestFingerprint, createdAt: Timestamp.now() });
}

/** WRITE phase: record the response the caller is about to return. */
export function complete(txn: Transaction, uid: string, key: string, status: number, body: string): void {
  txn.update(ref(uid, key), { responseStatus: status, responseBody: body });
}
