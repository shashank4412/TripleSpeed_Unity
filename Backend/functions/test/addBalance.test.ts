/**
 * addBalance — the demo-only, in-game currency top-up, tested through the real
 * boundary (callable over HTTP against the Functions emulator, Admin SDK read
 * back). Nothing mocked: the properties under test are "does a retried call
 * credit once" and "does the server cap hold", and only Firestore can answer
 * either.
 *
 *   firebase emulators:start --only auth,functions,firestore   # separate terminal
 *   npm test --workspace @redline/functions
 *
 * A skip is not a pass — if the emulators are down the top-up is UNVERIFIED.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const AUTH_HOST = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099';
const FUNCTIONS_HOST = '127.0.0.1:5001';
const FIRESTORE_HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
const PROJECT = process.env['GCLOUD_PROJECT'] ?? 'attendance-91bdd';
const REGION = 'asia-south1';

process.env['FIRESTORE_EMULATOR_HOST'] = FIRESTORE_HOST;
process.env['GCLOUD_PROJECT'] = PROJECT;

if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const adminDb = getFirestore();

/** Must match shared/accounts.ts, which reads the same env vars. */
const GRANT_CENTS = Number(process.env['REDLINE_DEMO_GRANT_CENTS'] ?? 1000);
const MAX_BALANCE_CENTS = Number(process.env['REDLINE_DEMO_MAX_BALANCE_CENTS'] ?? 10000);
const RUNG_CENTS = 1000; // top stake-ladder rung — money.stakeCents in redline.economy.json

async function emulatorsUp(): Promise<boolean> {
  const reachable = (host: string) =>
    fetch(`http://${host}/`).then(() => true).catch(() => false);
  const results = await Promise.all([AUTH_HOST, FIRESTORE_HOST, FUNCTIONS_HOST].map(reachable));
  return results.every(Boolean);
}

const up = await emulatorsUp();
if (!up) {
  console.warn(
    `\n  SKIPPED: addBalance tests need the emulators.\n` +
      `  firebase emulators:start --only auth,functions,firestore\n` +
      `  A skip is not a pass — the demo top-up is UNVERIFIED in this run.\n`,
  );
}

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

async function callable(name: string, idToken: string, data: Record<string, unknown>) {
  const res = await fetch(`http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function addBalance(idToken: string, amountCents: number, idempotencyKey = randomUUID()) {
  const { status, text } = await callable('addBalance', idToken, { amountCents, idempotencyKey });
  if (status !== 200) throw new Error(`addBalance ${status}: ${text}`);
  return (JSON.parse(text) as { result: Record<string, unknown> }).result;
}

async function readAccount(uid: string): Promise<Record<string, unknown> | null> {
  const snap = await adminDb.collection('redline_accounts').doc(uid).get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

async function readDeposits(uid: string): Promise<Array<Record<string, unknown>>> {
  const snap = await adminDb.collection('redline_accounts').doc(uid).collection('deposits').get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

describe.skipIf(!up)('addBalance — demo in-game top-up', () => {
  beforeAll(async () => {
    const warm = await signInAnonymously();
    await callable('ensureAccount', warm.idToken, {});
  }, 60_000);

  it('adds one stake-ladder rung to the balance, with a demo-topup deposit row', async () => {
    const { idToken, uid } = await signInAnonymously();
    await callable('ensureAccount', idToken, {});

    const r = await addBalance(idToken, RUNG_CENTS);

    expect(r['ok']).toBe(true);
    expect(r['credited']).toBe(RUNG_CENTS);
    expect(r['capped']).toBe(false);
    expect(r['balanceCents']).toBe(GRANT_CENTS + RUNG_CENTS);
    expect(r['maxBalanceCents']).toBe(MAX_BALANCE_CENTS);

    expect((await readAccount(uid))!['balanceCents']).toBe(GRANT_CENTS + RUNG_CENTS);

    const topups = (await readDeposits(uid)).filter((d) => d['reason'] === 'demo-topup');
    expect(topups).toHaveLength(1);
    expect(topups[0]!['amountCents']).toBe(RUNG_CENTS);
  });

  it('rejects an amount that is not on the stake ladder', async () => {
    const { idToken } = await signInAnonymously();
    await callable('ensureAccount', idToken, {});

    const { status } = await callable('addBalance', idToken, {
      amountCents: 333,
      idempotencyKey: randomUUID(),
    });
    expect(status).toBe(400);
  });

  it('credits once for one idempotency key, however many times it is retried', async () => {
    const { idToken, uid } = await signInAnonymously();
    await callable('ensureAccount', idToken, {});
    const key = randomUUID();

    const a = await addBalance(idToken, RUNG_CENTS, key);
    const b = await addBalance(idToken, RUNG_CENTS, key);
    const [c, d] = await Promise.all([
      addBalance(idToken, RUNG_CENTS, key),
      addBalance(idToken, RUNG_CENTS, key),
    ]);

    for (const r of [a, b, c, d]) expect(r['balanceCents']).toBe(GRANT_CENTS + RUNG_CENTS);
    expect((await readAccount(uid))!['balanceCents']).toBe(GRANT_CENTS + RUNG_CENTS);
    expect((await readDeposits(uid)).filter((x) => x['reason'] === 'demo-topup')).toHaveLength(1);
  });

  it('never raises the balance past the server cap', async () => {
    const { idToken, uid } = await signInAnonymously();
    await callable('ensureAccount', idToken, {});

    let last: Record<string, unknown> | null = null;
    // GRANT + N*RUNG reaches the cap; a dozen iterations covers it with margin.
    for (let i = 0; i < 12; i++) {
      last = await addBalance(idToken, RUNG_CENTS);
      expect(last['balanceCents'] as number).toBeLessThanOrEqual(MAX_BALANCE_CENTS);
    }

    expect(last!['balanceCents']).toBe(MAX_BALANCE_CENTS);
    expect(last!['capped']).toBe(true);
    expect(last!['credited']).toBe(0);
    expect((await readAccount(uid))!['balanceCents']).toBe(MAX_BALANCE_CENTS);
  }, 30_000);
});
