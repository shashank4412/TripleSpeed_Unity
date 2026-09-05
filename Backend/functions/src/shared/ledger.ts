/**
 * The append-only money ledger. Ported from src/Redline.Data/Ledger.cs.
 *
 * Every balance movement is a row under redline_matches/{id}/ledger with a
 * reason. The row id is deterministic — `{accountUid}__{reason}` — so a second
 * append for the same (match, account, reason) is refused by Firestore, which is
 * how staking, payout and refund stay exactly-once (the C# unique index
 * ux_ledger_account_match_reason). Amounts are signed integer cents: a stake is
 * negative, a payout positive.
 *
 * This writes the row only. The caller updates redline_accounts/{uid}.balanceCents
 * in the SAME transaction, from a value it read before any write — that pairing
 * is what makes a check-then-stake sequence safe against a concurrent copy.
 */
import type { Transaction } from 'firebase-admin/firestore';
import { db, C, SUB, Timestamp } from './firebase.js';

export type LedgerReason = 'stake' | 'payout' | 'rake' | 'refund' | 'rollback' | 'deposit';

function signOk(amountCents: number, reason: LedgerReason): boolean {
  switch (reason) {
    case 'stake':
      return amountCents < 0;
    case 'payout':
    case 'rake':
    case 'refund':
    case 'deposit':
      return amountCents > 0;
    case 'rollback':
      return amountCents !== 0;
  }
}

/**
 * Appends one movement. `existingKeys` is the set of ledger-row ids already read
 * in this transaction (reads must precede writes in Firestore); pass the ids you
 * pre-read, or an empty set when the (match, account, reason) combination is
 * provably fresh (a newly minted matchId). A duplicate is silently skipped —
 * the effect already happened.
 */
export function appendLedger(
  txn: Transaction,
  matchId: string,
  accountUid: string,
  amountCents: number,
  reason: LedgerReason,
  atMs: number,
  alreadyPresent: ReadonlySet<string> = new Set(),
): void {
  if (!Number.isInteger(amountCents) || amountCents === 0) {
    throw new Error(`a ledger row must move a whole number of cents, got ${amountCents}`);
  }
  if (!signOk(amountCents, reason)) {
    throw new Error(`a '${reason}' row cannot have amount ${amountCents}`);
  }

  const rowId = `${accountUid}__${reason}`;
  if (alreadyPresent.has(rowId)) return;

  const rowRef = db.collection(C.matches).doc(matchId).collection(SUB.ledger).doc(rowId);
  txn.create(rowRef, {
    accountUid,
    matchId,
    amountCents,
    reason,
    createdAt: Timestamp.fromMillis(atMs),
  });
}
