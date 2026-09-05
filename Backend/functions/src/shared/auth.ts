/**
 * Identity comes from the verified Firebase ID token on the call, never from the
 * request body. Anonymous sign-in still yields a uid.
 */
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';

export function requireUid(request: CallableRequest<unknown>): string {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before calling this.');
  return uid;
}

/** Best-effort client IP for the collusion signals. Missing is fine — null never matches null. */
export function callerIp(request: CallableRequest<unknown>): string | null {
  const raw = request.rawRequest;
  const fwd = raw?.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return raw?.ip ?? null;
}

/** Idempotency key: required on every mutating call, so a timed-out retry is safe. */
export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new HttpsError('invalid-argument', 'idempotencyKey is required (1–128 chars).');
  }
  return value;
}
