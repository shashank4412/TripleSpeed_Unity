/**
 * Account creation. No real-money deposit/withdrawal path in this build, so a
 * new account is granted a demo balance (REDLINE_DEMO_GRANT_CENTS, default
 * $10.00) with a matching deposit row so the books still reconcile. Registering
 * the same device again deliberately creates a SECOND account — review
 * requirement #9 is shown working at matchmaking, not blocked here.
 *
 * The one thing that CAN raise an existing balance is the demo top-up
 * (handlers/addBalance.ts): in-game currency only, one stake-ladder rung at a
 * time, hard-capped at DEMO_MAX_BALANCE_CENTS. It exists so the game can be
 * demonstrated without waiting for a real settlement to clear. See
 * DevDocs/decisions/0017-demo-balance-topup.md.
 *
 * Split read/write for Firestore's reads-before-writes rule.
 */
import type { Transaction } from 'firebase-admin/firestore';
import { db, C, Timestamp } from './firebase.js';
import type { AccountDoc } from './types.js';

export const DEMO_GRANT_CENTS = Number(process.env['REDLINE_DEMO_GRANT_CENTS'] ?? 1000);

/** Ceiling the demo top-up (handlers/addBalance.ts) will not raise a balance past. Demo knob, not a rule. */
export const DEMO_MAX_BALANCE_CENTS = Number(process.env['REDLINE_DEMO_MAX_BALANCE_CENTS'] ?? 10000);

export function accountRef(uid: string) {
  return db.collection(C.accounts).doc(uid);
}

/** READ phase. */
export async function readAccount(txn: Transaction, uid: string): Promise<AccountDoc | null> {
  const snap = await txn.get(accountRef(uid));
  return snap.exists ? (snap.data() as AccountDoc) : null;
}

export interface NewAccountOpts {
  displayName?: string | undefined;
  deviceFingerprint?: string | undefined;
  paymentInstrument?: string | null | undefined;
  ip?: string | null | undefined;
}

/**
 * WRITE phase: create the account (+ demo deposit). `balanceCents` defaults to
 * the full demo grant; a caller that is about to stake in the same transaction
 * passes the post-stake balance so the account doc is written once, not created
 * then updated. The deposit row is always the full grant — deposit + stake still
 * nets to the balance.
 */
export function createAccount(
  txn: Transaction,
  uid: string,
  initialRating: number,
  opts: NewAccountOpts,
  nowMs: number,
  balanceCents: number = DEMO_GRANT_CENTS,
): AccountDoc {
  const doc: AccountDoc = {
    displayName: opts.displayName?.trim() || `Driver-${uid.slice(0, 6)}`,
    deviceFingerprint: opts.deviceFingerprint ?? '',
    paymentInstrument: opts.paymentInstrument ?? null,
    lastSeenIp: opts.ip ?? null,
    rating: initialRating,
    ratedMatches: 0,
    balanceCents,
    createdAt: Timestamp.fromMillis(nowMs),
  };
  txn.create(accountRef(uid), doc);

  if (DEMO_GRANT_CENTS > 0) {
    // A standalone deposit row (references no match): the reconciliation tool
    // treats deposits as the outer boundary, matching the C# ledger model.
    txn.create(accountRef(uid).collection('deposits').doc('demo-grant'), {
      amountCents: DEMO_GRANT_CENTS,
      reason: 'demo-grant',
      createdAt: Timestamp.fromMillis(nowMs),
    });
  }
  return doc;
}

/** Read-then-create in one call for handlers whose only account interaction is "ensure it exists". */
export async function ensureAccount(
  txn: Transaction,
  uid: string,
  initialRating: number,
  opts: NewAccountOpts,
  nowMs: number,
): Promise<AccountDoc> {
  const existing = await readAccount(txn, uid);
  if (existing) return existing;
  return createAccount(txn, uid, initialRating, opts, nowMs);
}

export async function getAccount(uid: string): Promise<AccountDoc | null> {
  const snap = await accountRef(uid).get();
  return snap.exists ? (snap.data() as AccountDoc) : null;
}
