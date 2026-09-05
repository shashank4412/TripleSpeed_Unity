/**
 * Firestore-TTL cleanup trigger. When the TTL policy deletes a redline_ttl
 * marker, this fires and nudges the match to its terminal state — a fast path
 * for when the 60s sweep has not run yet. It is NOT the enforcer (TTL deletion
 * is best-effort within 24h); it just avoids waiting a sweep interval in the
 * common case where TTL happens to fire first.
 */
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { db, C, Timestamp } from '../shared/firebase.js';
import { loadConfig } from '../shared/config.js';
import { settleMatch } from '../shared/settle.js';
import { appendLedger } from '../shared/ledger.js';
import type { MatchDoc } from '../shared/types.js';

export const onTtlMarkerDeleted = onDocumentDeleted(
  { region: 'asia-south1', document: 'redline_ttl/{matchId}' },
  async (event) => {
    const matchId = event.params['matchId'] as string;
    const kind = (event.data?.data()?.['kind'] as string | undefined) ?? 'challenge';
    const now = Date.now();

    if (kind === 'submission') {
      await settleMatch(matchId, now);
      return;
    }

    // kind === 'challenge': expire it if still unanswered.
    const { economy } = await loadConfig(now);
    void economy;
    await db.runTransaction(async (txn) => {
      const ref = db.collection(C.matches).doc(matchId);
      const snap = await txn.get(ref);
      if (!snap.exists) return;
      const m = snap.data() as MatchDoc;
      if (m.state !== 'created' && m.state !== 'open') return;

      const posterAccRef = db.collection(C.accounts).doc(m.posterUid);
      const posterAcc = await txn.get(posterAccRef);
      const bal = (posterAcc.data()?.['balanceCents'] as number | undefined) ?? 0;

      appendLedger(txn, matchId, m.posterUid, m.stakeCents, 'refund', now);
      txn.update(posterAccRef, { balanceCents: bal + m.stakeCents });
      txn.update(ref, { state: 'expired', settledAt: Timestamp.fromMillis(now) });
      txn.delete(db.collection(C.challenges).doc(matchId));
    });
  },
);
