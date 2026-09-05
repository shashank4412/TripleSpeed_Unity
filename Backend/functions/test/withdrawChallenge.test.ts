/**
 * withdrawChallenge — the poster-initiated refund of an unanswered challenge,
 * tested through the real callable boundary against the emulators (same style
 * as matchmakeStarvation.test.ts).
 *
 * The property under test: a challenge the starvation fallback posted for a
 * player can be handed back, in one call, with the stake returned exactly once
 * — and that this cannot double-refund against the 15-minute sweep, cannot be
 * triggered by a non-owner, and is replay-safe.
 *
 *   firebase emulators:start --only auth,functions,firestore   # separate terminal
 *   npm test --workspace @redline/functions
 *
 * A skip is not a pass; the console says so if the emulators are down.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const AUTH_HOST = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099';
const FUNCTIONS_HOST = '127.0.0.1:5001';
const FIRESTORE_HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
const PROJECT = process.env['GCLOUD_PROJECT'] ?? 'attendance-91bdd';
const REGION = 'asia-south1';

// A stake no other suite's fixtures use, so a withdraw here never races a
// challenge another test posted.
const STAKE_CENTS = 200;
const GRANT = 1000; // DEMO_GRANT_CENTS default

process.env['FIRESTORE_EMULATOR_HOST'] = FIRESTORE_HOST;
process.env['GCLOUD_PROJECT'] = PROJECT;

if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const adminDb = getFirestore();

async function emulatorsUp(): Promise<boolean> {
  const reachable = (host: string) => fetch(`http://${host}/`).then(() => true).catch(() => false);
  return (await Promise.all([AUTH_HOST, FIRESTORE_HOST, FUNCTIONS_HOST].map(reachable))).every(Boolean);
}

const up = await emulatorsUp();
if (!up) {
  console.warn(
    `\n  SKIPPED: withdrawChallenge tests need the emulators.\n` +
      `  firebase emulators:start --only auth,functions,firestore\n` +
      `  A skip is not a pass — the withdraw path is UNVERIFIED in this run.\n`,
  );
}

async function signInAnonymously(): Promise<{ idToken: string; uid: string }> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) },
  );
  if (!res.ok) throw new Error(`auth emulator signUp failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { idToken: string; localId: string };
  return { idToken: body.idToken, uid: body.localId };
}

async function callFn(name: string, idToken: string, data: Record<string, unknown>) {
  const res = await fetch(`http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} ${res.status}: ${text}`);
  return (JSON.parse(text) as { result: Record<string, unknown> }).result;
}

const callEnsureAccount = (t: string, d: Record<string, unknown> = {}) => callFn('ensureAccount', t, d);
const callMatchmake = (t: string, d: Record<string, unknown>) => callFn('matchmake', t, d);
const callWithdraw = (t: string, d: Record<string, unknown>) => callFn('withdrawChallenge', t, d);

async function readMatch(id: string) {
  const s = await adminDb.collection('redline_matches').doc(id).get();
  return s.exists ? (s.data() as Record<string, unknown>) : null;
}
async function readAccount(uid: string) {
  const s = await adminDb.collection('redline_accounts').doc(uid).get();
  return s.exists ? (s.data() as Record<string, unknown>) : null;
}
async function ledgerRows(matchId: string) {
  const s = await adminDb.collection('redline_matches').doc(matchId).collection('ledger').get();
  return s.docs.map((d) => d.data() as Record<string, unknown>);
}

/** Post a challenge for a fresh account and return its ids. */
async function postChallenge(idemSuffix: string) {
  const { idToken, uid } = await signInAnonymously();
  await callEnsureAccount(idToken);
  const r = await callMatchmake(idToken, { stakeCents: STAKE_CENTS, idempotencyKey: `wc-mm-${uid}-${idemSuffix}` });
  expect(r['outcome']).toBe('posted');
  const matchId = (r['posted'] as Record<string, unknown>)['matchId'] as string;
  return { idToken, uid, matchId };
}

describe.skipIf(!up)('withdrawChallenge', () => {
  beforeAll(async () => {
    const warm = await signInAnonymously();
    await callEnsureAccount(warm.idToken);
  }, 60_000);

  it('returns the stake once, closes the challenge, leaves one stake + one refund row', async () => {
    const { idToken, uid, matchId } = await postChallenge('ok');

    expect((await readAccount(uid))!['balanceCents']).toBe(GRANT - STAKE_CENTS);

    const r = await callWithdraw(idToken, { matchId, idempotencyKey: `wc-${uid}-ok` });
    expect(r['result']).toBe('withdrawn');
    expect(r['balanceCents']).toBe(GRANT);

    expect((await readAccount(uid))!['balanceCents']).toBe(GRANT);

    const m = await readMatch(matchId);
    expect(m!['state']).toBe('expired');

    // the challenges mirror and the ttl marker are gone
    expect((await adminDb.collection('redline_challenges').doc(matchId).get()).exists).toBe(false);
    expect((await adminDb.collection('redline_ttl').doc(matchId).get()).exists).toBe(false);

    const rows = await ledgerRows(matchId);
    expect(rows.filter((x) => x['reason'] === 'stake')).toHaveLength(1);
    expect(rows.filter((x) => x['reason'] === 'refund')).toHaveLength(1);
    expect(rows.find((x) => x['reason'] === 'refund')!['amountCents']).toBe(STAKE_CENTS);
  });

  it('is replay-safe: same key twice returns the same body and credits once', async () => {
    const { idToken, uid, matchId } = await postChallenge('replay');
    const key = `wc-${uid}-replay`;

    const a = await callWithdraw(idToken, { matchId, idempotencyKey: key });
    const b = await callWithdraw(idToken, { matchId, idempotencyKey: key });

    expect(b).toEqual(a);
    expect((await readAccount(uid))!['balanceCents']).toBe(GRANT); // not GRANT + STAKE
  });

  it('a second withdraw with a fresh key is a no-op: already_expired, no extra credit', async () => {
    const { idToken, uid, matchId } = await postChallenge('twice');

    await callWithdraw(idToken, { matchId, idempotencyKey: `wc-${uid}-twice-1` });
    const second = await callWithdraw(idToken, { matchId, idempotencyKey: `wc-${uid}-twice-2` });

    expect(second['result']).toBe('already_expired');
    expect((await readAccount(uid))!['balanceCents']).toBe(GRANT);
    expect((await ledgerRows(matchId)).filter((x) => x['reason'] === 'refund')).toHaveLength(1);
  });

  it('cannot double-refund against the sweep: the sweep\'s own selection query no longer returns it', async () => {
    const { idToken, uid, matchId } = await postChallenge('sweep');
    await callWithdraw(idToken, { matchId, idempotencyKey: `wc-${uid}-sweep` });

    // This is exactly expireStaleChallenges()'s query. A withdrawn challenge
    // must fall out of it, so the sweep can never run refundOpenChallenge on it.
    const snap = await adminDb
      .collection('redline_matches')
      .where('state', 'in', ['created', 'open'])
      .where('expiresAt', '<=', Timestamp.fromMillis(Date.now() + 3600_000))
      .get();
    expect(snap.docs.some((d) => d.id === matchId)).toBe(false);

    expect((await readAccount(uid))!['balanceCents']).toBe(GRANT);
  });

  it('refuses a non-owner and moves no money', async () => {
    const { uid: posterUid, matchId } = await postChallenge('owner');
    const stranger = await signInAnonymously();
    await callEnsureAccount(stranger.idToken);

    const r = await callWithdraw(stranger.idToken, { matchId, idempotencyKey: `wc-${stranger.uid}-owner` });
    expect(r['result']).toBe('forbidden');

    expect((await readAccount(posterUid))!['balanceCents']).toBe(GRANT - STAKE_CENTS); // still staked
    expect((await readMatch(matchId))!['state']).toBe('created');
  });

  it('reports not_found for an unknown matchId', async () => {
    const { idToken, uid } = await signInAnonymously();
    await callEnsureAccount(idToken);
    const r = await callWithdraw(idToken, { matchId: 'no-such-match', idempotencyKey: `wc-${uid}-404` });
    expect(r['result']).toBe('not_found');
  });
});
