/**
 * The deadline enforcer. Ported from src/Redline.Server/Money/MatchSweeper.cs.
 *
 * Firestore TTL deletion is only "within 24h", far too slow for a 15-minute
 * challenge TTL or a 180-second submission window, so this scheduled function
 * every 60s is the real enforcer; the onDocumentDeleted TTL trigger is just
 * marker cleanup. Each match is handled in its own transaction, guarded on its
 * re-read state, so two overlapping sweeps cannot both act on one match.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, C, Timestamp } from '../shared/firebase.js';
import { loadConfig } from '../shared/config.js';
import { settleMatch } from '../shared/settle.js';
import { refundOpenChallenge } from '../shared/refundChallenge.js';
import type { MatchDoc } from '../shared/types.js';

const BATCH = 200;

export const sweepFn = onSchedule(
  { region: 'asia-south1', schedule: 'every 1 minutes', timeoutSeconds: 120 },
  async () => {
    const now = Date.now();
    const { economy } = await loadConfig(now);

    const expired = await expireStaleChallenges(now);
    const settled = await settleClosedWindows(now, economy.money.noSubmissionWindowSeconds);

    if (expired || settled) console.log(`sweep: expired ${expired}, settled ${settled}`);
  },
);

async function expireStaleChallenges(nowMs: number): Promise<number> {
  const cutoff = Timestamp.fromMillis(nowMs);
  const snap = await db
    .collection(C.matches)
    .where('state', 'in', ['created', 'open'])
    .where('expiresAt', '<=', cutoff)
    .limit(BATCH)
    .get();

  let n = 0;
  for (const doc of snap.docs) {
    const ok = await db.runTransaction(async (txn) => {
      const ref = db.collection(C.matches).doc(doc.id);
      const fresh = await txn.get(ref);
      if (!fresh.exists) return false;
      const m = fresh.data() as MatchDoc;
      if ((m.state !== 'created' && m.state !== 'open') || m.expiresAt.toMillis() > nowMs) return false;

      const posterAcc = await txn.get(db.collection(C.accounts).doc(m.posterUid));
      const bal = (posterAcc.data()?.['balanceCents'] as number | undefined) ?? 0;

      // The poster staked and got no game, and the 15-minute TTL has passed.
      // Same writer the withdrawChallenge callable uses for the same-session case.
      refundOpenChallenge(txn, doc.id, m, bal, nowMs);
      return true;
    });
    if (ok) n++;
  }
  return n;
}

async function settleClosedWindows(nowMs: number, windowSeconds: number): Promise<number> {
  const deadline = Timestamp.fromMillis(nowMs - windowSeconds * 1000);
  const snap = await db
    .collection(C.matches)
    .where('state', '==', 'answered')
    .where('answeredAt', '<=', deadline)
    .limit(BATCH)
    .get();

  let n = 0;
  for (const doc of snap.docs) {
    const r = await settleMatch(doc.id, nowMs);
    if (r.status === 'settled') n++;
  }
  return n;
}
