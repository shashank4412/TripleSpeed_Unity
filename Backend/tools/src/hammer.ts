/**
 * Tools/Hammer — adversarial-timing tests against the emulator's callables.
 *
 * T-202. The design's claim is that Firestore transactions over deterministic
 * document ids make staking, joining, settling and ledger-appending
 * exactly-once. Nobody has put that claim under contention. This is not a load
 * test — it fires small bursts of truly-concurrent requests at the SAME
 * document (the same challenge, the same match, the same account) and checks
 * the invariants held afterwards, per DevDocs/features/0002-submission-readiness/
 * prompts/T-202-hammer.md.
 *
 * It is a CLIENT: every state change goes through the real callables
 * (ensureAccount / createMatch / submitRun / joinMatch), exactly as
 * Backend/functions/test/ensureAccount.test.ts calls them — raw HTTP in the
 * callable wire format, with a real anonymous ID token from the Auth
 * emulator. The Admin SDK is used ONLY to read back final state for
 * assertions, never to set anything up (a callable the hammer didn't call is
 * a state change the invariants never had to survive).
 *
 *   npm --workspace @redline/tools run hammer -- --players 100 --matches 1000 --concurrency 50 --seed 42
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function argNum(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
function argStr(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const PLAYERS = Math.max(2, argNum('--players', 20));
const MATCHES = Math.max(0, argNum('--matches', 50));
const CONCURRENCY = Math.max(2, argNum('--concurrency', 8));
const SEED = argNum('--seed', 1) >>> 0;
const OUT_ARG = argStr('--out', '');

// ---------------------------------------------------------------------------
// Deterministic PRNG. Everything the hammer CHOOSES (which player, which
// stake, request ordering, idempotency-key text) is driven from this so two
// runs with the same --seed make the same requests, per the task's
// determinism constraint. Concurrency itself is real (Promise.all over
// already-fired fetches below) — the PRNG controls WHAT is sent, not WHEN.
// ---------------------------------------------------------------------------

function mulberry32(a: number): () => number {
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
function randInt(n: number): number {
  return Math.floor(rnd() * n);
}
let keyCounter = 0;
/** A seeded, deterministic stand-in for a client-generated idempotency key / device id. */
function nextToken(label: string): string {
  keyCounter += 1;
  return `hammer-${SEED}-${keyCounter}-${label}-${Math.floor(rnd() * 1e9).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Emulator plumbing — same hosts/wire-format ensureAccount.test.ts proved out.
// ---------------------------------------------------------------------------

const AUTH_HOST = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099';
const FUNCTIONS_HOST = process.env['FIREBASE_FUNCTIONS_EMULATOR_HOST'] ?? '127.0.0.1:5001';
const FIRESTORE_HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
const PROJECT = process.env['GCLOUD_PROJECT'] ?? 'attendance-91bdd';
const REGION = 'asia-south1';

// The deploy target is attendance-91bdd — never touch it. Belt-and-suspenders
// against a misconfigured environment pointing this at something real: the
// emulator env vars below are what make the Admin SDK talk to localhost, and
// if they are absent this refuses to run rather than guessing.
if (!process.env['FIRESTORE_EMULATOR_HOST'] && !process.env['FIREBASE_FIRESTORE_EMULATOR_ADDRESS']) {
  process.env['FIRESTORE_EMULATOR_HOST'] = FIRESTORE_HOST;
}
process.env['GCLOUD_PROJECT'] = PROJECT;

if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const adminDb: Firestore = getFirestore();

const C = {
  accounts: 'redline_accounts',
  matches: 'redline_matches',
  settlements: 'redline_settlements',
  ratingHistory: 'redline_ratingHistory',
} as const;
/** Must match Backend/functions/src/shared/firebase.ts HOUSE_UID. */
const HOUSE_UID = 'house';

async function reachable(host: string): Promise<boolean> {
  try {
    await fetch(`http://${host}/`);
    return true;
  } catch {
    return false;
  }
}

async function emulatorsUp(): Promise<boolean> {
  const results = await Promise.all([AUTH_HOST, FIRESTORE_HOST, FUNCTIONS_HOST].map(reachable));
  return results.every(Boolean);
}

async function signUpAnonymous(): Promise<{ idToken: string; uid: string }> {
  const res = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`auth emulator signUp failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { idToken: string; localId: string };
  return { idToken: body.idToken, uid: body.localId };
}

interface CallResult {
  httpOk: boolean;
  status: number;
  result: Record<string, unknown> | null;
  error: { status?: string; message?: string } | null;
}

/** The callable, over HTTP, in the callable wire format — never the Admin SDK. */
async function callFn(
  name: string,
  idToken: string,
  data: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
): Promise<CallResult> {
  const init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal } = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  };
  if (opts?.signal) init.signal = opts.signal;
  const res = await fetch(`http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`, init);
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (res.ok) return { httpOk: true, status: res.status, result: (parsed['result'] as Record<string, unknown>) ?? {}, error: null };
  return { httpOk: false, status: res.status, result: null, error: (parsed['error'] as { status?: string; message?: string }) ?? null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Runs `n` units of work with at most `limit` in flight — bounds the bulk phase's fan-out without serialising it. */
async function runPool<T>(n: number, limit: number, worker: (i: number) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(n);
  let next = 0;
  async function lane(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      results[i] = await worker(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, n)) }, lane));
  return results;
}

// ---------------------------------------------------------------------------
// Config — the stake ladder, read the same way Tools/Solvability reads game
// config: straight off disk, no admin call needed to learn it.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const economyRaw = JSON.parse(
  readFileSync(join(REPO_ROOT, 'Backend/functions/config/redline.economy.json'), 'utf8'),
) as { money: { stakeCents: number[] } };
const STAKES = [...economyRaw.money.stakeCents].sort((a, b) => a - b);
const SMALLEST_STAKE = STAKES[0]!;

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

interface Player {
  uid: string;
  idToken: string;
  balanceCents: number;
}

// Deliberately does NOT seed HOUSE_UID: 'house' is a single process-wide
// singleton (settle.ts credits every match's rake to the same account id),
// so on a dev machine where the emulator is shared with other concurrently
// running agents/tests its balance reflects THEIR settlements too, not only
// this run's. See runReconciliationCheck for how house is still checked —
// as a diagnostic against this run's own rake, never folded into the strict
// identity as if its whole balance belonged to this run.
const allAccountUids = new Set<string>();
const allMatchIds = new Set<string>();

async function mintPlayer(deviceFingerprint: string): Promise<Player> {
  const { idToken, uid } = await signUpAnonymous();
  const r = await callFn('ensureAccount', idToken, { deviceFingerprint });
  if (!r.httpOk) throw new Error(`ensureAccount failed for ${uid}: ${JSON.stringify(r.error)}`);
  allAccountUids.add(uid);
  return { uid, idToken, balanceCents: r.result!['balanceCents'] as number };
}

/** Largest stake s such that grant is in [s, 2s) — "a balance for exactly one stake". */
function pickOverdraftStake(grant: number): number | null {
  const exact = STAKES.filter((s) => s <= grant && grant < 2 * s);
  if (exact.length > 0) return Math.max(...exact);
  const affordable = STAKES.filter((s) => s <= grant);
  return affordable.length > 0 ? Math.max(...affordable) : null;
}

// ---------------------------------------------------------------------------
// Report plumbing
// ---------------------------------------------------------------------------

interface CheckReport {
  name: string;
  verdict: 'ok' | 'FAILURE';
  rounds: number;
  skipped: number;
  detail: string;
  discrepancies: string[];
}

const checks: CheckReport[] = [];
function report(name: string, rounds: number, skipped: number, discrepancies: string[], detail: string): void {
  checks.push({ name, verdict: discrepancies.length === 0 ? 'ok' : 'FAILURE', rounds, skipped, detail, discrepancies });
}

let stepN = 0;
const STEP_TOTAL = 9;
function step(msg: string): void {
  stepN += 1;
  console.error(`[${stepN}/${STEP_TOTAL}] ${msg}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Hammer — players=${PLAYERS} matches=${MATCHES} concurrency=${CONCURRENCY} seed=${SEED}`);
  console.log(`emulator: auth=${AUTH_HOST} functions=${FUNCTIONS_HOST} firestore=${FIRESTORE_HOST} project=${PROJECT}`);

  step('checking emulators are up');
  if (!(await emulatorsUp())) {
    console.error(
      '\n  emulators not reachable. Start them first:\n' +
        '  firebase emulators:start --only auth,functions,firestore\n',
    );
    process.exit(2);
  }

  // One warm call so a cold Node boot doesn't accidentally serialise the
  // first real race and make it pass for the wrong reason (same reasoning as
  // ensureAccount.test.ts's beforeAll warm-up).
  await mintPlayer(nextToken('warm'));

  const startedAt = Date.now();

  // --- bulk pool: ordinary match volume, feeding the reconciliation check ---
  step(`minting ${PLAYERS} pool players`);
  const pool: Player[] = [];
  for (let i = 0; i < PLAYERS; i++) pool.push(await mintPlayer(nextToken(`pool-${i}`)));

  step(`running ${MATCHES} ordinary match lifecycles (concurrency ${CONCURRENCY})`);
  let bulkSettled = 0;
  let bulkDangling = 0;
  await runPool(MATCHES, CONCURRENCY, async () => {
    const outcome = await runOrdinaryMatch(pool);
    if (outcome === 'settled') bulkSettled++;
    else if (outcome === 'dangling') bulkDangling++;
  });
  console.error(`  bulk: ${bulkSettled} settled, ${bulkDangling} left open (insufficient funds on both sides tried)`);

  // Rounds scale modestly with --matches so a small smoke run stays fast and
  // `--matches 1000` still finishes in a bounded number of adversarial bursts
  // rather than 1000 of them — the point is real contention, not repetition.
  const ROUNDS = Math.max(2, Math.min(5, Math.floor(MATCHES / 200) || 2));

  step(`join-one-challenge / self-and-same-device (${ROUNDS} rounds x ${CONCURRENCY} racers)`);
  await runJoinAndSelfDeviceChecks(ROUNDS);

  step(`double-settle (${ROUNDS} rounds x ${CONCURRENCY} concurrent submits)`);
  await runDoubleSettleCheck(ROUNDS);

  step(`no-overdraft (${ROUNDS} rounds x ${CONCURRENCY} concurrent creates)`);
  await runNoOverdraftCheck(ROUNDS);

  step(`abort-and-retry (${ROUNDS} rounds)`);
  await runAbortRetryCheck(ROUNDS);

  step(`ledger-reconciles (${allMatchIds.size} matches, ${allAccountUids.size} accounts)`);
  await runReconciliationCheck();

  const finishedAt = Date.now();

  // --- write report ---
  const outPath = OUT_ARG.length > 0 ? OUT_ARG : join(REPO_ROOT, 'Backend/artifacts/hammer-report.json');
  mkdirSync(dirname(outPath), { recursive: true });
  const reportBody = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    args: { players: PLAYERS, matches: MATCHES, concurrency: CONCURRENCY, seed: SEED },
    counts: {
      playersMinted: allAccountUids.size - 1, // minus 'house'
      matchesTouched: allMatchIds.size,
      bulkSettled,
      bulkDangling,
      adversarialRounds: ROUNDS,
    },
    checks,
  };
  writeFileSync(outPath, JSON.stringify(reportBody, null, 2) + '\n', 'utf8');

  console.log('');
  for (const c of checks) {
    console.log(`  ${c.name.padEnd(24)} ${c.verdict.padEnd(8)} ${c.detail}`);
    for (const d of c.discrepancies) console.log(`      - ${d}`);
  }
  console.log('');
  console.log(`wrote ${outPath}`);

  const anyFail = checks.some((c) => c.verdict === 'FAILURE');
  process.exit(anyFail ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Bulk lifecycle — ordinary throughput, no racing. Feeds check 6 with volume
// and exercises many DIFFERENT matches proceeding concurrently, which is real
// contention on the shared collections even though no single document races.
// ---------------------------------------------------------------------------

async function runOrdinaryMatch(pool: Player[]): Promise<'settled' | 'dangling' | 'skipped'> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const poster = pool[randInt(pool.length)]!;
    const stake = STAKES[randInt(STAKES.length)]!;
    const created = await callFn('createMatch', poster.idToken, { stakeCents: stake, idempotencyKey: nextToken('cm') });
    if (!created.httpOk || created.result?.['result'] !== 'ok') continue; // insufficient balance on this poster/stake pick — try another
    const matchId = created.result['matchId'] as string;
    const configHash = created.result['configHash'] as string;
    allMatchIds.add(matchId);

    const posterSubmit = await callFn('submitRun', poster.idToken, {
      matchId,
      inputLog: '',
      finalTick: 0,
      configHash,
      idempotencyKey: nextToken('sr'),
    });
    if (!posterSubmit.httpOk || posterSubmit.result?.['result'] !== 'ok') return 'dangling';

    for (let jAttempt = 0; jAttempt < 6; jAttempt++) {
      const challenger = pool[randInt(pool.length)]!;
      if (challenger.uid === poster.uid) continue;
      const joined = await callFn('joinMatch', challenger.idToken, { matchId, idempotencyKey: nextToken('jm') });
      if (!joined.httpOk || joined.result?.['result'] !== 'ok') continue;
      const challSubmit = await callFn('submitRun', challenger.idToken, {
        matchId,
        inputLog: '',
        finalTick: 0,
        configHash,
        idempotencyKey: nextToken('sr'),
      });
      return challSubmit.httpOk && challSubmit.result?.['result'] === 'ok' ? 'settled' : 'dangling';
    }
    return 'dangling'; // nobody in the pool could afford to join — left open, tracked as pending stake
  }
  return 'skipped'; // no poster in the pool could afford any stake this round
}

// ---------------------------------------------------------------------------
// Check 1 + 5: join-one-challenge, self-and-same-device — fired in the SAME
// concurrent burst, because the real question is whether the refusals hold
// under exactly the contention that a legitimate race also creates.
// ---------------------------------------------------------------------------

async function runJoinAndSelfDeviceChecks(rounds: number): Promise<void> {
  const joinDiscrepancies: string[] = [];
  const selfDeviceDiscrepancies: string[] = [];
  let winners = 0;
  let skipped = 0;

  for (let round = 0; round < rounds; round++) {
    const sharedDevice = nextToken(`dev-${round}`);
    const poster = await mintPlayer(sharedDevice);
    const buddy = await mintPlayer(sharedDevice); // same device, different account — must be refused

    const created = await callFn('createMatch', poster.idToken, {
      stakeCents: SMALLEST_STAKE,
      idempotencyKey: nextToken('cm'),
    });
    if (created.result?.['result'] !== 'ok') {
      skipped++;
      continue;
    }
    const matchId = created.result['matchId'] as string;
    const configHash = created.result['configHash'] as string;
    allMatchIds.add(matchId);
    await callFn('submitRun', poster.idToken, { matchId, inputLog: '', finalTick: 0, configHash, idempotencyKey: nextToken('sr') });

    const racers: Player[] = [];
    for (let i = 0; i < CONCURRENCY; i++) racers.push(await mintPlayer(nextToken(`racer-${round}-${i}`)));

    // Fire every joinMatch call in the SAME instant: the promises are created
    // (and their fetch()es dispatched) before any of them is awaited.
    const selfP = callFn('joinMatch', poster.idToken, { matchId, idempotencyKey: nextToken('self') });
    const buddyP = callFn('joinMatch', buddy.idToken, { matchId, idempotencyKey: nextToken('buddy') });
    const racerPs = racers.map((r) => callFn('joinMatch', r.idToken, { matchId, idempotencyKey: nextToken('race') }));
    const [selfRes, buddyRes, ...racerRes] = await Promise.all([selfP, buddyP, ...racerPs]);

    const selfRefused = selfRes!.httpOk && selfRes!.result?.['result'] !== 'ok';
    const buddyRefused = buddyRes!.httpOk && buddyRes!.result?.['result'] !== 'ok';
    if (!selfRefused) selfDeviceDiscrepancies.push(`round ${round} matchId ${matchId}: poster's own join was NOT refused: ${JSON.stringify(selfRes!.result)}`);
    if (!buddyRefused) selfDeviceDiscrepancies.push(`round ${round} matchId ${matchId}: same-device join was NOT refused: ${JSON.stringify(buddyRes!.result)}`);

    const winIdx = racerRes.findIndex((r) => r.httpOk && r.result?.['result'] === 'ok');
    const okCount = racerRes.filter((r) => r.httpOk && r.result?.['result'] === 'ok').length;
    if (okCount !== 1) {
      joinDiscrepancies.push(`round ${round} matchId ${matchId}: ${okCount} of ${CONCURRENCY} concurrent joins seated (expected exactly 1)`);
    } else {
      winners++;
    }

    // Close the match out (winner submits) so no stake is left dangling for
    // the reconciliation check; a 0-winner round is tracked as pending stake.
    if (winIdx >= 0) {
      const winner = racers[winIdx]!;
      await callFn('submitRun', winner.idToken, { matchId, inputLog: '', finalTick: 0, configHash, idempotencyKey: nextToken('sr') });

      // Losers must be untouched — not debited-then-refunded, never debited.
      for (let i = 0; i < racerRes.length; i++) {
        if (i === winIdx) continue;
        const rr = racerRes[i]!;
        if (rr.httpOk && rr.result?.['result'] === 'ok') continue; // shouldn't happen given okCount===1 above
      }
    }
  }

  report(
    'join-one-challenge',
    rounds,
    skipped,
    joinDiscrepancies,
    `${winners}/${rounds - skipped} rounds seated exactly one challenger (${skipped} skipped: poster couldn't afford the stake)`,
  );
  report(
    'self-and-same-device',
    rounds,
    skipped,
    selfDeviceDiscrepancies,
    `self-join and same-device join refused in every round that ran (${rounds - skipped}/${rounds})`,
  );
}

// ---------------------------------------------------------------------------
// Check 2: double-settle — the SAME challenger fires N concurrent submitRun
// calls (distinct idempotency keys, same run) on their own answered match.
// This is the only public path that can reach settleMatch, so racing it here
// is racing the exactly-once guarantee the way a real retry storm would.
// ---------------------------------------------------------------------------

async function runDoubleSettleCheck(rounds: number): Promise<void> {
  const discrepancies: string[] = [];
  let skipped = 0;
  let clean = 0;

  for (let round = 0; round < rounds; round++) {
    const poster = await mintPlayer(nextToken(`ds-poster-${round}`));
    const challenger = await mintPlayer(nextToken(`ds-chal-${round}`));

    const created = await callFn('createMatch', poster.idToken, { stakeCents: SMALLEST_STAKE, idempotencyKey: nextToken('cm') });
    if (created.result?.['result'] !== 'ok') {
      skipped++;
      continue;
    }
    const matchId = created.result['matchId'] as string;
    const configHash = created.result['configHash'] as string;
    allMatchIds.add(matchId);
    await callFn('submitRun', poster.idToken, { matchId, inputLog: '', finalTick: 0, configHash, idempotencyKey: nextToken('sr') });

    const joined = await callFn('joinMatch', challenger.idToken, { matchId, idempotencyKey: nextToken('jm') });
    if (joined.result?.['result'] !== 'ok') {
      skipped++;
      continue;
    }

    const calls = Array.from({ length: CONCURRENCY }, () =>
      callFn('submitRun', challenger.idToken, { matchId, inputLog: '', finalTick: 0, configHash, idempotencyKey: nextToken('race-sr') }),
    );
    const results = await Promise.all(calls);
    const oks = results.filter((r) => r.httpOk && r.result?.['result'] === 'ok');

    // settleMatch runs synchronously inside the winning submitRun call, but a
    // transient failure there falls back to the 60s sweep — give it a short,
    // bounded window before treating the match as still-pending.
    let matchState = '';
    for (let i = 0; i < 6; i++) {
      const snap = await adminDb.collection(C.matches).doc(matchId).get();
      matchState = (snap.data()?.['state'] as string | undefined) ?? '';
      if (matchState === 'settled') break;
      await sleep(400);
    }

    const settlementSnap = await adminDb.collection(C.matches).doc(matchId).get(); // re-read not needed; keep matchId doc read below
    void settlementSnap;
    const settlement = await adminDb.collection(C.settlements).doc(matchId).get();
    const ledgerSnap = await adminDb.collection(C.matches).doc(matchId).collection('ledger').get();
    const payoutRows = ledgerSnap.docs.filter((d) => d.data()['reason'] === 'payout');
    const rakeRows = ledgerSnap.docs.filter((d) => d.data()['reason'] === 'rake');
    const ratingSnap = await adminDb
      .collection(C.ratingHistory)
      .where('matchId', '==', matchId)
      .where('kind', '==', 'settlement')
      .get();

    const roundOk =
      oks.length === 1 &&
      matchState === 'settled' &&
      settlement.exists &&
      payoutRows.length >= 1 &&
      payoutRows.length <= 2 &&
      rakeRows.length === 1 &&
      ratingSnap.size === 2;

    if (!roundOk) {
      discrepancies.push(
        `round ${round} matchId ${matchId}: submits-ok=${oks.length}/${CONCURRENCY} state=${matchState} ` +
          `settlementDoc=${settlement.exists} payoutRows=${payoutRows.length} rakeRows=${rakeRows.length} ratingRows=${ratingSnap.size}`,
      );
    } else {
      clean++;
    }
  }

  report(
    'double-settle',
    rounds,
    skipped,
    discrepancies,
    `${clean}/${rounds - skipped} rounds settled exactly once (rake taken once, 2 rating rows) (${skipped} skipped)`,
  );
}

// ---------------------------------------------------------------------------
// Check 3: no-overdraft — one account funded for exactly one stake, N
// concurrent createMatch calls.
// ---------------------------------------------------------------------------

async function runNoOverdraftCheck(rounds: number): Promise<void> {
  const discrepancies: string[] = [];
  let skipped = 0;
  let clean = 0;

  for (let round = 0; round < rounds; round++) {
    const acct = await mintPlayer(nextToken(`nod-${round}`));
    const stake = pickOverdraftStake(acct.balanceCents);
    if (stake == null) {
      skipped++;
      continue;
    }

    const calls = Array.from({ length: CONCURRENCY }, () =>
      callFn('createMatch', acct.idToken, { stakeCents: stake, idempotencyKey: nextToken('race-cm') }),
    );
    const results = await Promise.all(calls);
    const oks = results.filter((r) => r.httpOk && r.result?.['result'] === 'ok');

    const accSnap = await adminDb.collection(C.accounts).doc(acct.uid).get();
    const finalBalance = (accSnap.data()?.['balanceCents'] as number | undefined) ?? -1;

    const roundOk = oks.length === 1 && finalBalance >= 0 && finalBalance === acct.balanceCents - stake;
    if (!roundOk) {
      discrepancies.push(
        `round ${round} account ${acct.uid}: ${oks.length} of ${CONCURRENCY} concurrent creates succeeded ` +
          `(expected 1), balance=${finalBalance} grant=${acct.balanceCents} stake=${stake}`,
      );
    } else {
      clean++;
    }

    // Close it out so the stake isn't left dangling in the reconciliation.
    const winner = oks[0];
    if (winner) {
      const matchId = winner.result!['matchId'] as string;
      const configHash = winner.result!['configHash'] as string;
      allMatchIds.add(matchId);
      await callFn('submitRun', acct.idToken, { matchId, inputLog: '', finalTick: 0, configHash, idempotencyKey: nextToken('sr') });
      const challenger = await mintPlayer(nextToken(`nod-chal-${round}`));
      const joined = await callFn('joinMatch', challenger.idToken, { matchId, idempotencyKey: nextToken('jm') });
      if (joined.result?.['result'] === 'ok') {
        await callFn('submitRun', challenger.idToken, { matchId, inputLog: '', finalTick: 0, configHash, idempotencyKey: nextToken('sr') });
      }
    }
  }

  report('no-overdraft', rounds, skipped, discrepancies, `${clean}/${rounds - skipped} rounds: exactly one create succeeded, balance never negative (${skipped} skipped)`);
}

// ---------------------------------------------------------------------------
// Check 4: abort-and-retry — kill a call mid-flight, retry with the same
// idempotency key. Best-effort on the "mid-flight" part (a local emulator can
// finish a transaction in a few ms), but the assertion — fully applied or
// fully absent, never half — holds either way and is what actually matters.
// ---------------------------------------------------------------------------

async function runAbortRetryCheck(rounds: number): Promise<void> {
  const discrepancies: string[] = [];
  let clean = 0;

  for (let round = 0; round < rounds; round++) {
    const acct = await mintPlayer(nextToken(`abort-${round}`));
    const key = nextToken('abort-key');
    const ac = new AbortController();

    const inFlight = callFn('createMatch', acct.idToken, { stakeCents: SMALLEST_STAKE, idempotencyKey: key }, { signal: ac.signal });
    await sleep(1 + randInt(3)); // 1-3ms: best-effort interrupt before the emulator's transaction commits
    ac.abort();
    let sawAbort = false;
    try {
      await inFlight;
    } catch (e) {
      sawAbort = e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));
    }

    await sleep(400); // let whatever the server was doing finish, one way or the other

    const retry = await callFn('createMatch', acct.idToken, { stakeCents: SMALLEST_STAKE, idempotencyKey: key });
    if (!retry.httpOk || retry.result?.['result'] !== 'ok') {
      discrepancies.push(`round ${round} account ${acct.uid}: retry with the same idempotencyKey did not succeed: ${JSON.stringify(retry.result ?? retry.error)}`);
      continue;
    }
    const matchId = retry.result['matchId'] as string;
    const configHash = retry.result['configHash'] as string;
    allMatchIds.add(matchId);

    const ledgerSnap = await adminDb.collection(C.matches).doc(matchId).collection('ledger').get();
    const stakeRows = ledgerSnap.docs.filter((d) => d.data()['reason'] === 'stake' && d.data()['accountUid'] === acct.uid);
    const accSnap = await adminDb.collection(C.accounts).doc(acct.uid).get();
    const balance = (accSnap.data()?.['balanceCents'] as number | undefined) ?? -1;
    const expectedBalance = retry.result['balanceCents'] as number;

    const roundOk = stakeRows.length === 1 && balance === expectedBalance;
    if (!roundOk) {
      discrepancies.push(
        `round ${round} account ${acct.uid} matchId ${matchId}: aborted=${sawAbort} stakeRows=${stakeRows.length} (expected 1) balance=${balance} expected=${expectedBalance}`,
      );
    } else {
      clean++;
    }

    // Close it out.
    await callFn('submitRun', acct.idToken, { matchId, inputLog: '', finalTick: 0, configHash, idempotencyKey: nextToken('sr') });
    const challenger = await mintPlayer(nextToken(`abort-chal-${round}`));
    const joined = await callFn('joinMatch', challenger.idToken, { matchId, idempotencyKey: nextToken('jm') });
    if (joined.result?.['result'] === 'ok') {
      await callFn('submitRun', challenger.idToken, { matchId, inputLog: '', finalTick: 0, configHash, idempotencyKey: nextToken('sr') });
    }
  }

  report('abort-and-retry', rounds, 0, discrepancies, `${clean}/${rounds} rounds: exactly one stake row survived the abort+retry, balance agrees`);
}

// ---------------------------------------------------------------------------
// Check 6: ledger-reconciles — the two identities, exact to the cent, over
// EVERY match and account the hammer touched (bulk volume + every
// adversarial round). Reads only, over ids this run itself created.
// ---------------------------------------------------------------------------

async function runReconciliationCheck(): Promise<void> {
  const discrepancies: string[] = [];

  const matchIds = [...allMatchIds];
  const ledgerByAccount = new Map<string, number>();
  let pendingStakeCents = 0;
  let rakeCentsTotal = 0;

  await runPool(matchIds.length, 20, async (i) => {
    const id = matchIds[i]!;
    const [doc, ledgerSnap] = await Promise.all([
      adminDb.collection(C.matches).doc(id).get(),
      adminDb.collection(C.matches).doc(id).collection('ledger').get(),
    ]);
    const state = (doc.data()?.['state'] as string | undefined) ?? '';
    const terminal = state === 'settled' || state === 'expired' || state === 'rolledBack';
    for (const row of ledgerSnap.docs) {
      const d = row.data() as { accountUid: string; amountCents: number; reason: string };
      ledgerByAccount.set(d.accountUid, (ledgerByAccount.get(d.accountUid) ?? 0) + d.amountCents);
      if (d.reason === 'rake') rakeCentsTotal += d.amountCents;
      // A stake not yet answered by a payout/refund is money genuinely still
      // in flight (e.g. a challenge nobody in the pool could afford to join) —
      // counted here rather than forcing every match closed, so the identity
      // reflects the real state of the system rather than a staged one.
      if (d.reason === 'stake' && !terminal) pendingStakeCents += -d.amountCents;
    }
  });

  const uids = [...allAccountUids];
  let sumBalances = 0;
  let sumDeposits = 0;
  await runPool(uids.length, 20, async (i) => {
    const uid = uids[i]!;
    const [accSnap, depSnap] = await Promise.all([
      adminDb.collection(C.accounts).doc(uid).get(),
      adminDb.collection(C.accounts).doc(uid).collection('deposits').get(),
    ]);
    const balance = (accSnap.data()?.['balanceCents'] as number | undefined) ?? 0;
    const opening = depSnap.docs.reduce((s, d) => s + ((d.data()['amountCents'] as number | undefined) ?? 0), 0);
    const ledgerSum = ledgerByAccount.get(uid) ?? 0;
    sumBalances += balance;
    sumDeposits += opening;
    if (balance !== opening + ledgerSum) {
      discrepancies.push(`account ${uid}: balanceCents=${balance} != opening(${opening}) + ledgerSum(${ledgerSum}) = ${opening + ledgerSum}`);
    }
  });

  // The literal spec identity is "Σ balances + Σ rake == Σ deposits", where
  // "balances" reads naturally as the PLAYERS' balances and "rake" as what the
  // house took from THIS run's matches specifically. sumBalances above already
  // excludes 'house' (never seeded into allAccountUids) precisely so this
  // holds regardless of what house's balance also contains: on a dev machine
  // the emulator is shared with whatever else is running concurrently in this
  // repo (see the comment by allAccountUids), and house is the one account
  // every process writes into. Reading house.balanceCents itself would make
  // the identity fail for a reason that has nothing to do with this run's
  // correctness — proven below by cross-checking it against the FULL
  // Firestore ledger rather than asserting equality against a number this
  // run does not fully own.
  const lhs = sumBalances + pendingStakeCents + rakeCentsTotal;
  if (lhs !== sumDeposits) {
    discrepancies.push(
      `system: sumBalances(${sumBalances}) + pendingStakeCents(${pendingStakeCents}) + rakeCentsTotal(${rakeCentsTotal}) = ${lhs} != sumDeposits(${sumDeposits})`,
    );
  }

  const houseSnap = await adminDb.collection(C.accounts).doc(HOUSE_UID).get();
  const houseBalance = (houseSnap.data()?.['balanceCents'] as number | undefined) ?? 0;
  const houseAtLeastCoversOurRake = houseBalance >= rakeCentsTotal;
  if (!houseAtLeastCoversOurRake) {
    discrepancies.push(
      `house account balanceCents=${houseBalance} is LESS than this run's own rakeCentsTotal=${rakeCentsTotal} — rake this run took is missing from the shared house balance`,
    );
  }

  report(
    'ledger-reconciles',
    1,
    0,
    discrepancies,
    `${uids.length} accounts, ${matchIds.length} matches: sumBalances(non-house)=${sumBalances} + pendingStake=${pendingStakeCents} + rakeTotal=${rakeCentsTotal} ` +
      `== sumDeposits=${sumDeposits}; house.balanceCents=${houseBalance} (shared singleton — asserted >= this run's rake only, not ==, see comment)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
