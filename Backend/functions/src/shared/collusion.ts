/**
 * Which accounts are believed to be the same person. Ported from
 * src/Redline.Data/CollusionCheck.cs.
 *
 * One primitive, two callers: joinMatch asks about a single opponent, the
 * matchmaker (via FirestoreChallengeInventory) asks for the whole linked set.
 * Same rule, one code path, so a challenge the matchmaker offers can never be
 * refused at join. Accounts are labelled weakest-signal first, so a stronger
 * signal found later overwrites it.
 */
import { db, C } from './firebase.js';
import type { CollusionPolicy, CollusionLink } from '@redline/rating';

export async function linkedAccounts(
  accountId: string,
  policy: CollusionPolicy,
  nowMs: number,
): Promise<Map<string, CollusionLink>> {
  const links = new Map<string, CollusionLink>();

  if (policy.sharedIpWindowMinutes > 0) {
    for (const other of await shareAnAddress(accountId, policy.sharedIpWindowMinutes)) links.set(other, 'sharedIp');
  }
  if (policy.blockSamePaymentInstrument) {
    for (const other of await shareAnInstrument(accountId)) links.set(other, 'samePaymentInstrument');
  }
  if (policy.blockSameDevice) {
    for (const other of await shareADevice(accountId)) links.set(other, 'sameDevice');
  }

  links.delete(accountId);
  return links;
}

/** True when `accountId` is linked to `opponentId` by any active signal. */
export async function isLinked(
  accountId: string,
  opponentId: string,
  policy: CollusionPolicy,
  nowMs: number,
): Promise<CollusionLink> {
  if (policy.blockSameAccount && accountId === opponentId) return 'sameAccount';
  const links = await linkedAccounts(accountId, policy, nowMs);
  return links.get(opponentId) ?? 'none';
}

async function myFingerprints(accountId: string): Promise<string[]> {
  const snap = await db.collection(C.deviceFingerprints).where('accountUid', '==', accountId).get();
  return [...new Set(snap.docs.map((d) => d.get('fingerprint') as string))];
}

async function shareADevice(accountId: string): Promise<string[]> {
  const fps = await myFingerprints(accountId);
  if (fps.length === 0) return [];
  const others = new Set<string>();
  for (const fp of fps) {
    const snap = await db.collection(C.deviceFingerprints).where('fingerprint', '==', fp).get();
    for (const d of snap.docs) {
      const u = d.get('accountUid') as string;
      if (u !== accountId) others.add(u);
    }
  }
  return [...others];
}

async function myInstrument(accountId: string): Promise<string | null> {
  const snap = await db.collection(C.accounts).doc(accountId).get();
  const v = snap.get('paymentInstrument');
  return typeof v === 'string' ? v : null;
}

async function shareAnInstrument(accountId: string): Promise<string[]> {
  const mine = await myInstrument(accountId);
  if (mine == null) return []; // null never matches null
  const snap = await db.collection(C.accounts).where('paymentInstrument', '==', mine).get();
  return snap.docs.map((d) => d.id).filter((id) => id !== accountId);
}

async function shareAnAddress(accountId: string, windowMinutes: number): Promise<string[]> {
  const windowMs = windowMinutes * 60_000;

  // My sightings, collapsed to one entry per DISTINCT IP (keeping my most recent
  // time there). recordIp now writes one row per (ip, account), so `mine` is
  // already small — but a NAT full of legacy per-call rows still collapses here,
  // which is what stops this scan going quadratic: one `where('ip', '==', ip)`
  // query per distinct address, never one per raw sighting (feature 0012).
  const mine = await db.collection(C.ipSightings).where('accountUid', '==', accountId).get();
  const myLastSeenByIp = new Map<string, number>();
  for (const s of mine.docs) {
    const ip = s.get('ip') as string;
    const at = seenAtMs(s);
    myLastSeenByIp.set(ip, Math.max(myLastSeenByIp.get(ip) ?? 0, at));
  }

  const others = new Set<string>();
  for (const [ip, myAt] of myLastSeenByIp) {
    const atAddress = await db.collection(C.ipSightings).where('ip', '==', ip).get();
    for (const o of atAddress.docs) {
      const u = o.get('accountUid') as string;
      if (u === accountId || others.has(u)) continue;
      // Both accounts seen at this address within the window of each other — a
      // household sharing a connection, not two strangers who once used the
      // same public wifi.
      if (Math.abs(myAt - seenAtMs(o)) <= windowMs) others.add(u);
    }
  }
  return [...others];
}

/** Last-seen time of an ipSightings doc; falls back to the legacy `at` field. */
function seenAtMs(doc: { get(field: string): unknown }): number {
  const v = (doc.get('lastSeenAt') ?? doc.get('at')) as { toMillis(): number } | undefined;
  return v ? v.toMillis() : 0;
}

export async function recordAccountLink(
  aUid: string,
  bUid: string,
  link: CollusionLink,
  context: string,
  atMs: number,
): Promise<void> {
  await db.collection(C.accountLinks).add({ aUid, bUid, link, context, at: new Date(atMs) });
}
