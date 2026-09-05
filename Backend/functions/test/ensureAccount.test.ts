/**
 * ensureAccount — the first-run grant, tested through the real boundary.
 *
 * These call the deployed callable over HTTP against the Functions emulator,
 * with a real anonymous ID token from the Auth emulator, and read the result
 * back with the Admin SDK. Nothing here is mocked, because the property under
 * test is not "does the code branch correctly" — it is "does Firestore serialise
 * two concurrent first calls for the same uid", and a mock of Firestore cannot
 * answer that.
 *
 *   firebase emulators:start --only auth,functions,firestore   # separate terminal
 *   npm test --workspace @redline/functions
 *
 * WHY THE CONCURRENT CASE IS THE ONE THAT MATTERS
 *
 * DevDocs/assignment.md's concurrency section requires that "a retried or
 * duplicated request charges once and produces one slot", and says the reviewer
 * will make the network fail on purpose. ensureAccount is exactly that shape: a
 * cold-start callable that times out on the client and is retried. Two
 * SEQUENTIAL calls pass on code a real retry storm breaks, because by the time
 * the second read runs the first write has landed. Only the concurrent case
 * exercises the lock.
 *
 * If the emulators are not running the suite skips loudly rather than failing,
 * so `npm test` is still usable without them — but a skip is not a pass and the
 * console says so.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const AUTH_HOST = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099';
const FUNCTIONS_HOST = '127.0.0.1:5001';
const FIRESTORE_HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
const PROJECT = process.env['GCLOUD_PROJECT'] ?? 'attendance-91bdd';
const REGION = 'asia-south1';

/** Must match shared/accounts.ts DEMO_GRANT_CENTS, which reads the same env var. */
const EXPECTED_GRANT_CENTS = Number(process.env['REDLINE_DEMO_GRANT_CENTS'] ?? 1000);

process.env['FIRESTORE_EMULATOR_HOST'] = FIRESTORE_HOST;
process.env['GCLOUD_PROJECT'] = PROJECT;

if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const adminDb = getFirestore();

/**
 * Probe every port the tests actually use, including Functions.
 *
 * An earlier version checked only Auth and Firestore. The Functions emulator
 * then failed to start on its own (a wrong working directory) and the suite
 * decided the emulators were "up", skipped nothing, and died in beforeAll on
 * ECONNREFUSED — a liveness check that does not check the thing being called is
 * worse than none, because it turns a clear skip into a confusing failure.
 */
async function emulatorsUp(): Promise<boolean> {
  const reachable = (host: string) =>
    fetch(`http://${host}/`).then(() => true).catch(() => false);
  const results = await Promise.all([AUTH_HOST, FIRESTORE_HOST, FUNCTIONS_HOST].map(reachable));
  return results.every(Boolean);
}

const up = await emulatorsUp();
if (!up) {
  console.warn(
    `\n  SKIPPED: ensureAccount tests need the emulators.\n` +
      `  firebase emulators:start --only auth,functions,firestore\n` +
      `  A skip is not a pass — the first-run grant is UNVERIFIED in this run.\n`,
  );
}

/** A brand-new anonymous user, exactly as an install mints one. */
async function signInAnonymously(): Promise<{ idToken: string; uid: string }> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    },
  );
  if (!res.ok) throw new Error(`auth emulator signUp failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { idToken: string; localId: string };
  return { idToken: body.idToken, uid: body.localId };
}

/** The callable, over HTTP, in the callable wire format. */
async function callEnsureAccount(idToken: string, data: Record<string, unknown> = {}) {
  const res = await fetch(`http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/ensureAccount`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ensureAccount ${res.status}: ${text}`);
  return (JSON.parse(text) as { result: Record<string, unknown> }).result;
}

/**
 * Read back with the Admin SDK.
 *
 * Not the plain Firestore REST API, which goes through firestore.rules and is
 * correctly denied: `redline_accounts` allows a signed-in player to read only
 * their own document and nothing to list. The rule is doing its job, so the
 * test uses the privileged path instead of weakening it.
 */
async function readAccount(uid: string): Promise<Record<string, unknown> | null> {
  const snap = await adminDb.collection('redline_accounts').doc(uid).get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

async function readDeposits(uid: string): Promise<Array<Record<string, unknown>>> {
  const snap = await adminDb.collection('redline_accounts').doc(uid).collection('deposits').get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

describe.skipIf(!up)('ensureAccount — the first-run grant', () => {
  beforeAll(async () => {
    // One warm call on a throwaway uid, so the cold start is not inside the
    // concurrency test's timing window. A cold Node boot serialises the two
    // "concurrent" calls by accident and would make the test pass for the
    // wrong reason.
    const warm = await signInAnonymously();
    await callEnsureAccount(warm.idToken);
  }, 60_000);

  it('grants a fresh uid exactly the configured starting balance, with a deposit row naming it', async () => {
    const { idToken, uid } = await signInAnonymously();
    const result = await callEnsureAccount(idToken, { deviceFingerprint: 'test-device' });

    expect(result['accountId']).toBe(uid);
    expect(result['balanceCents']).toBe(EXPECTED_GRANT_CENTS);

    const account = await readAccount(uid);
    expect(account).not.toBeNull();
    expect(account!['balanceCents']).toBe(EXPECTED_GRANT_CENTS);

    const deposits = await readDeposits(uid);
    expect(deposits).toHaveLength(1);
    expect(deposits[0]!['amountCents']).toBe(EXPECTED_GRANT_CENTS);
    expect(deposits[0]!['reason']).toBe('demo-grant');
  });

  it('two SEQUENTIAL calls for one uid produce one grant and one deposit row', async () => {
    const { idToken, uid } = await signInAnonymously();

    const first = await callEnsureAccount(idToken);
    const second = await callEnsureAccount(idToken);

    expect(first['balanceCents']).toBe(EXPECTED_GRANT_CENTS);
    expect(second['balanceCents']).toBe(EXPECTED_GRANT_CENTS);

    expect((await readAccount(uid))!['balanceCents']).toBe(EXPECTED_GRANT_CENTS);
    expect(await readDeposits(uid)).toHaveLength(1);
  });

  it('two CONCURRENT calls for one uid produce one grant and one deposit row', async () => {
    const { idToken, uid } = await signInAnonymously();

    // Both in flight before either can commit. This is the retry storm the
    // brief promises to create, reduced to its smallest reproducible form.
    const [a, b] = await Promise.all([callEnsureAccount(idToken), callEnsureAccount(idToken)]);

    expect(a['balanceCents']).toBe(EXPECTED_GRANT_CENTS);
    expect(b['balanceCents']).toBe(EXPECTED_GRANT_CENTS);

    const account = await readAccount(uid);
    expect(account!['balanceCents']).toBe(EXPECTED_GRANT_CENTS);

    const deposits = await readDeposits(uid);
    expect(deposits).toHaveLength(1);
    expect(deposits[0]!['amountCents']).toBe(EXPECTED_GRANT_CENTS);
  });

  it('four CONCURRENT calls for one uid still produce one grant', async () => {
    // Two racers can be serialised by luck. Four makes luck harder to mistake
    // for a lock.
    const { idToken, uid } = await signInAnonymously();

    const results = await Promise.all([
      callEnsureAccount(idToken),
      callEnsureAccount(idToken),
      callEnsureAccount(idToken),
      callEnsureAccount(idToken),
    ]);

    for (const r of results) expect(r['balanceCents']).toBe(EXPECTED_GRANT_CENTS);
    expect((await readAccount(uid))!['balanceCents']).toBe(EXPECTED_GRANT_CENTS);
    expect(await readDeposits(uid)).toHaveLength(1);
    // Four contended transactions against a cold emulator can exceed the 5s
    // default when the machine is also running the other suites.
  }, 30_000);

  it('the granted balance reconciles to its deposit rows', async () => {
    const { idToken, uid } = await signInAnonymously();
    await callEnsureAccount(idToken);

    const balance = (await readAccount(uid))!['balanceCents'] as number;
    const deposits = await readDeposits(uid);
    const summed = deposits.reduce((total, d) => total + (d['amountCents'] as number), 0);

    // The invariant 0002's T-205 reconciles across the whole database. A grant
    // that creates a balance without a row behind it breaks it for every
    // account, not just this one.
    expect(summed).toBe(balance);
  });
});
