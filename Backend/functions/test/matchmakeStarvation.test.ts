/**
 * matchmake's starvation fallback (decision #11, DevDocs/assignment-refined.md
 * §4) — tested through the real boundary, like ensureAccount.test.ts.
 *
 * The property under test is not "does Matchmaker.select() return
 * 'postOwnChallenge'" — Backend/rating/test/matchmaker.test.ts already covers
 * that decision in isolation. It is "when a real callable sees that outcome,
 * does it actually stake and create a challenge, atomically, inside the same
 * call" — which only the real transaction against real Firestore can answer.
 *
 *   firebase emulators:start --only auth,functions,firestore   # separate terminal
 *   npm test --workspace @redline/functions
 *
 * If the emulators are not running the suite skips loudly rather than
 * failing, so `npm test` is still usable without them — but a skip is not a
 * pass and the console says so.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const AUTH_HOST = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099';
const FUNCTIONS_HOST = '127.0.0.1:5001';
const FIRESTORE_HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
const PROJECT = process.env['GCLOUD_PROJECT'] ?? 'attendance-91bdd';
const REGION = 'asia-south1';

// A stake unused by any other test's fixtures, so this suite never risks
// matching into a challenge some other test posted at 100c.
const STAKE_CENTS = 500;

process.env['FIRESTORE_EMULATOR_HOST'] = FIRESTORE_HOST;
process.env['GCLOUD_PROJECT'] = PROJECT;

if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const adminDb = getFirestore();

async function emulatorsUp(): Promise<boolean> {
  const reachable = (host: string) => fetch(`http://${host}/`).then(() => true).catch(() => false);
  const results = await Promise.all([AUTH_HOST, FIRESTORE_HOST, FUNCTIONS_HOST].map(reachable));
  return results.every(Boolean);
}

const up = await emulatorsUp();
if (!up) {
  console.warn(
    `\n  SKIPPED: matchmake starvation tests need the emulators.\n` +
      `  firebase emulators:start --only auth,functions,firestore\n` +
      `  A skip is not a pass — the fallback is UNVERIFIED in this run.\n`,
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

const callEnsureAccount = (idToken: string, data: Record<string, unknown> = {}) => callFn('ensureAccount', idToken, data);
const callMatchmake = (idToken: string, data: Record<string, unknown>) => callFn('matchmake', idToken, data);

async function readMatch(matchId: string): Promise<Record<string, unknown> | null> {
  const snap = await adminDb.collection('redline_matches').doc(matchId).get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

async function readAccount(uid: string): Promise<Record<string, unknown> | null> {
  const snap = await adminDb.collection('redline_accounts').doc(uid).get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

describe.skipIf(!up)('matchmake — starvation fallback posts the caller\'s own challenge', () => {
  beforeAll(async () => {
    // One warm call so a cold Node boot is not inside a timing-sensitive test.
    const warm = await signInAnonymously();
    await callEnsureAccount(warm.idToken);
  }, 60_000);

  it('a lone arrival at an unused stake finds nobody, and posts instead — never a bot', async () => {
    const { idToken, uid } = await signInAnonymously();
    await callEnsureAccount(idToken);

    const key = `starvation-${uid}`;
    const result = await callMatchmake(idToken, { stakeCents: STAKE_CENTS, idempotencyKey: key });

    // The pool at this stake was empty (this uid is the only account that has
    // ever staked STAKE_CENTS in this emulator run), so even the widened band
    // cap finds nothing and the fallback fires.
    expect(result['outcome']).toBe('posted');
    expect(result['offer']).toBeNull();

    const posted = result['posted'] as Record<string, unknown>;
    expect(posted).toBeTruthy();
    expect(typeof posted['matchId']).toBe('string');
    expect(posted['stakeCents']).toBe(STAKE_CENTS);
    expect(typeof posted['seed']).toBe('string');

    // A real challenge exists, with the starved player as its creator — the
    // exact shape createMatch produces, not a simulated opponent.
    const matchId = posted['matchId'] as string;
    const match = await readMatch(matchId);
    expect(match).not.toBeNull();
    expect(match!['posterUid']).toBe(uid);
    expect(match!['challengerUid']).toBeNull();
    expect(match!['state']).toBe('created');
    expect(match!['stakeCents']).toBe(STAKE_CENTS);

    // And the stake was actually taken — this is a money-moving call now,
    // not a read-only "you should post" hint.
    const account = await readAccount(uid);
    expect(account!['balanceCents']).toBe(1000 - STAKE_CENTS); // DEMO_GRANT_CENTS default
  });

  it('is idempotent: retrying the same key does not post a second challenge or stake twice', async () => {
    const { idToken, uid } = await signInAnonymously();
    await callEnsureAccount(idToken);

    const key = `starvation-retry-${uid}`;
    const first = await callMatchmake(idToken, { stakeCents: STAKE_CENTS, idempotencyKey: key });
    const second = await callMatchmake(idToken, { stakeCents: STAKE_CENTS, idempotencyKey: key });

    const firstPosted = first['posted'] as Record<string, unknown>;
    const secondPosted = second['posted'] as Record<string, unknown>;
    expect(secondPosted['matchId']).toBe(firstPosted['matchId']);

    const account = await readAccount(uid);
    expect(account!['balanceCents']).toBe(1000 - STAKE_CENTS); // staked exactly once
  });

  it('a second arrival at the same stake matches into the first arrival\'s posted challenge only after it opens', async () => {
    // Posting alone does not make a challenge joinable -- submitRun.ts only
    // creates the redline_challenges mirror once the poster has actually
    // banked a run (see that handler). Before that, a second arrival at the
    // same stake is ALSO starved and becomes a poster too, which is the
    // "pool of challenges, not players" behaviour decision #11 describes:
    // two starved arrivals grow the pool by two, not zero.
    const posterA = await signInAnonymously();
    await callEnsureAccount(posterA.idToken);
    const a = await callMatchmake(posterA.idToken, { stakeCents: STAKE_CENTS, idempotencyKey: `two-${posterA.uid}-a` });
    expect(a['outcome']).toBe('posted');

    const posterB = await signInAnonymously();
    await callEnsureAccount(posterB.idToken);
    const b = await callMatchmake(posterB.idToken, { stakeCents: STAKE_CENTS, idempotencyKey: `two-${posterB.uid}-b` });

    // b arrives to a pool containing only a's unopened match (no bankedScore
    // yet), which is not a matchable challenge -- so b is starved too, and
    // becomes a second poster rather than being handed something unplayable.
    expect(b['outcome']).toBe('posted');
    const aMatchId = (a['posted'] as Record<string, unknown>)['matchId'];
    const bMatchId = (b['posted'] as Record<string, unknown>)['matchId'];
    expect(bMatchId).not.toBe(aMatchId);
  });
});
