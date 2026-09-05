/**
 * Tools/Rollback <gameId> --reason "..." — reverse a settlement later found
 * invalid. Ported from RollbackService.cs.
 *
 * Three rules: compensate never edit (original rows stay, new rows are
 * appended); money and rating move together in one transaction; nobody else's
 * history is touched. The compensating amount per account is −Σ(that account's
 * rows for this match), read from the rows rather than re-derived from the
 * rules, so it reverses every settlement shape.
 *
 *   GOOGLE_APPLICATION_CREDENTIALS=Backend/.secrets/<key>.json \
 *   npm --workspace @redline/tools run rollback -- <gameId> --reason "duplicate detected"
 */
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Transaction, type DocumentSnapshot } from 'firebase-admin/firestore';

const gameId = process.argv[2];
const reasonIdx = process.argv.indexOf('--reason');
const reason = reasonIdx >= 0 ? process.argv[reasonIdx + 1] : undefined;

if (!gameId || !reason) {
  console.error('usage: rollback <gameId> --reason "why"');
  process.exit(2);
}

if (getApps().length === 0) initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const now = Date.now();

const outcome = await db.runTransaction(async (txn: Transaction) => {
  const matchRef = db.collection('redline_matches').doc(gameId);
  const matchSnap = await txn.get(matchRef);
  if (!matchSnap.exists) return 'no-such-match';
  const match = matchSnap.data() as { state: string };
  if (match.state === 'rolledBack') return 'already-rolled-back';
  if (match.state !== 'settled') return 'not-settleable';

  // Every ledger row for this match, grouped by account.
  const ledgerSnap = await txn.get(matchRef.collection('ledger'));
  const netByAccount = new Map<string, number>();
  for (const d of ledgerSnap.docs) {
    const { accountUid, amountCents } = d.data() as { accountUid: string; amountCents: number };
    netByAccount.set(accountUid, (netByAccount.get(accountUid) ?? 0) + amountCents);
  }

  // Settlement rating rows to reverse.
  const ratingSnap = await txn.get(
    db.collection('redline_ratingHistory').where('matchId', '==', gameId),
  );
  const settlementRows = ratingSnap.docs
    .map((d) => d.data() as { accountUid: string; kind: string; ratingBefore: number; ratingAfter: number; kFactor: number; scoreMilli: number })
    .filter((r) => r.kind === 'settlement');

  const accountSnaps = new Map<string, DocumentSnapshot>();
  for (const uid of new Set([...netByAccount.keys(), ...settlementRows.map((r) => r.accountUid)])) {
    accountSnaps.set(uid, await txn.get(db.collection('redline_accounts').doc(uid)));
  }

  // --- writes ---
  for (const [uid, net] of [...netByAccount].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (net === 0) continue;
    const compensation = -net;
    txn.create(matchRef.collection('ledger').doc(`${uid}__rollback`), {
      accountUid: uid,
      matchId: gameId,
      amountCents: compensation,
      reason: 'rollback',
      createdAt: Timestamp.fromMillis(now),
    });
    const acc = accountSnaps.get(uid)!;
    const bal = (acc.data()?.['balanceCents'] as number | undefined) ?? 0;
    txn.update(acc.ref, { balanceCents: bal + compensation });
  }

  for (const row of settlementRows.sort((a, b) => (a.accountUid < b.accountUid ? -1 : 1))) {
    const acc = accountSnaps.get(row.accountUid)!;
    const currentRating = (acc.data()?.['rating'] as number | undefined) ?? row.ratingAfter;
    const ratedMatches = (acc.data()?.['ratedMatches'] as number | undefined) ?? 0;
    txn.create(db.collection('redline_ratingHistory').doc(`${gameId}__${row.accountUid}__rollback`), {
      accountUid: row.accountUid,
      matchId: gameId,
      kind: 'rollback',
      ratingBefore: currentRating,
      ratingAfter: row.ratingBefore,
      kFactor: row.kFactor,
      scoreMilli: row.scoreMilli,
      createdAt: Timestamp.fromMillis(now),
    });
    txn.update(acc.ref, {
      rating: row.ratingBefore,
      ratedMatches: Math.max(0, ratedMatches - 1),
    });
  }

  txn.update(matchRef, { state: 'rolledBack', rolledBackAt: Timestamp.fromMillis(now), rollbackReason: reason });
  return 'rolled-back';
});

console.log(`${gameId}: ${outcome}`);
process.exit(outcome === 'rolled-back' || outcome === 'already-rolled-back' ? 0 : 1);
