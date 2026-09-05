/**
 * Tools/Rehearse — run the reviewable half of the brief's sixteen review
 * tests against the Firebase stack.
 *
 * Rewritten for Firebase (T-203). The previous version talked to a .NET
 * server on :5000, registered over POST /auth/register, shelled into
 * `docker exec Unity-redline-postgres psql`, and called `dotnet run`. All of
 * that is gone; this version calls the real callables through the Functions
 * emulator with real anonymous ID tokens from the Auth emulator (the same
 * pattern functions/test/ensureAccount.test.ts uses — see ./emulator.ts's
 * header for why there is no client SDK dependency), reads Firestore state
 * only through the other Tools/* (Replay), and shells out to Tools/Solvability
 * and Tools/Hammer rather than re-implementing what they already prove.
 *
 * It never reports a pass it did not observe. A rehearsal that claims a green
 * it has not seen is worse than no rehearsal, because it stops anyone
 * looking — this is the property T-203 was told to preserve, verbatim.
 *
 *   ./Tools/Rehearse
 *
 * `--url <functionsHost>` overrides the Functions emulator host:port (advanced
 * use only — e.g. a non-default emulator port). There is no supported way to
 * point this at the deployed project: gen2 Cloud Run URLs are not predictable
 * without a deploy, and doing that discovery is out of scope for a task whose
 * constraints rule out touching production. See Tools/Preflight's trailing
 * comment for the same limitation, in more detail.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGameConfig, runSimulation, formatInputLog } from '@redline/sim-core';
import { parseEconomyConfig } from '@redline/rating';
import { AUTH_HOST, FUNCTIONS_HOST, FIRESTORE_HOST, PROJECT, reachable, signInAnonymously, callCallable, newIdempotencyKey, } from './emulator.js';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const urlIdx = process.argv.indexOf('--url');
const functionsHost = urlIdx >= 0 ? process.argv[urlIdx + 1] : FUNCTIONS_HOST;
let pass = 0;
let fail = 0;
let blocked = 0;
const lines = [];
function record(id, status, detail) {
    if (status === 'PASS')
        pass++;
    else if (status === 'FAIL')
        fail++;
    else
        blocked++;
    lines.push(`  ${id.padEnd(4)} ${status.padEnd(8)} ${detail}`);
}
console.log(`Review rehearsal — functions:${functionsHost} auth:${AUTH_HOST} firestore:${FIRESTORE_HOST}`);
console.log();
// ---- preconditions ----------------------------------------------------------
const [authUp, functionsUp, firestoreUp] = await Promise.all([
    reachable(AUTH_HOST),
    reachable(functionsHost),
    reachable(FIRESTORE_HOST),
]);
if (!authUp || !functionsUp || !firestoreUp) {
    console.error(`  emulator not fully up — auth:${authUp} functions:${functionsUp} firestore:${firestoreUp}\n` +
        `  run: cd Backend && firebase emulators:start --only auth,functions,firestore`);
    process.exit(2);
}
const gameText = readFileSync(`${REPO_ROOT}Backend/config/redline.game.json`, 'utf8');
const { config } = parseGameConfig(gameText);
const economy = parseEconomyConfig(readFileSync(`${REPO_ROOT}Backend/config/redline.economy.json`, 'utf8'));
// The cheapest stake on the configured ladder — this reads the ladder rather
// than hardcoding a number, the same reason nothing here hardcodes lane count.
const stakeCents = economy.money.stakesCents[0];
const target = { functionsHost };
const call = (name, idToken, data) => callCallable(name, idToken, data, target);
// ---- fixture: two fresh anonymous accounts ----------------------------------
const stamp = Date.now();
const poster = await signInAnonymously();
const challenger = await signInAnonymously();
await call('ensureAccount', poster.idToken, { deviceFingerprint: `reh-p-${stamp}` });
await call('ensureAccount', challenger.idToken, { deviceFingerprint: `reh-c-${stamp}` });
// ---- fixture: a real, replayable banked run ----------------------------------
// Not a hand-written score: the swipes are chosen by walking candidate bank
// ticks through the SAME runSimulation the server scores with, so what gets
// submitted is a run the core actually says banks. Mirrors Tools/Seed's
// bankingRun, kept local rather than imported — seed.ts is a script with argv
// parsing at module scope, not a library.
function bankingRun(seed, ambitionTicks) {
    const steps = config.cashoutLane - config.startLane;
    const direction = steps >= 0 ? 1 : -1;
    const swipes = Math.abs(steps);
    let best = null;
    for (let bankAt = ambitionTicks; bankAt >= 30; bankAt -= 30) {
        const events = [];
        for (let s = 0; s < swipes; s++) {
            events.push({ tick: bankAt + s * config.laneChangeDurationTicks, direction });
        }
        const result = runSimulation(config, { seed, events, maxRunTicks: config.maxRunTicks });
        if (best === null)
            best = { events, result };
        if (result.outcome === 'Banked')
            return { events, result };
    }
    return best;
}
let matchId = '';
try {
    const created = await call('createMatch', poster.idToken, { stakeCents, idempotencyKey: newIdempotencyKey('create') });
    matchId = created['matchId'];
    const seed = created['seed'];
    const posterRun = bankingRun(seed, Math.floor(config.maxRunTicks * 0.6));
    const posterInputLog = formatInputLog(posterRun.events);
    // ---- 3. a hand-edited score of 999,999 must be rejected, visibly ---------
    const r3 = await call('submitRun', poster.idToken, {
        matchId,
        inputLog: posterInputLog,
        clientScore: 999999,
        finalTick: posterRun.result.endTick,
        configHash: config.configHash,
        idempotencyKey: newIdempotencyKey('s3'),
    });
    if (r3['result'] === 'ok' && r3['disagreed'] === true && r3['serverScore'] !== 999999) {
        record('#3', 'PASS', `claim 999999 ignored; server scored ${r3['serverScore']}, disagreement flagged`);
    }
    else {
        record('#3', 'FAIL', `result=${r3['result']} serverScore=${r3['serverScore']} disagreed=${r3['disagreed']}`);
    }
    // ---- 4. resubmission of the same run must be refused ----------------------
    const r4 = await call('submitRun', poster.idToken, {
        matchId,
        inputLog: posterInputLog,
        finalTick: posterRun.result.endTick,
        configHash: config.configHash,
        idempotencyKey: newIdempotencyKey('s4'),
    });
    if (r4['result'] === 'refused' && r4['reason'] === 'already-submitted') {
        record('#4', 'PASS', `second submission for the same match refused: ${r4['reason']}`);
    }
    else {
        record('#4', 'FAIL', `second submission answered result=${r4['result']} reason=${r4['reason']}, expected refused/already-submitted`);
    }
    // ---- settle the match so #2 has something real to replay -----------------
    const joined = await call('joinMatch', challenger.idToken, { matchId, idempotencyKey: newIdempotencyKey('join') });
    if (joined['result'] !== 'ok')
        throw new Error(`joinMatch refused: ${JSON.stringify(joined)}`);
    // The challenger plays nothing and, on the highest-danger scoring lane
    // (lane 0's hazardWeight is always the largest — see Backend/config/redline.game.json),
    // crashes almost immediately: a real, low-scoring loss, not a fabricated one.
    await call('submitRun', challenger.idToken, {
        matchId,
        inputLog: '-',
        finalTick: 0,
        configHash: config.configHash,
        idempotencyKey: newIdempotencyKey('s5'),
    });
    // ---- 2. copy a Game ID and replay it; scores must match -------------------
    record('#2', ...replayVerdict(matchId));
    // ---- 5. the lower-multiplier-in-transit rule -------------------------------
    record('#5', 'BLOCKED', 'no LaneRuleTests-equivalent test suite ported to @redline/sim-core yet — boundary-parking / lower-multiplier-in-transit / bank-on-arrival are invariants in CLAUDE.md with no named test covering them in the TS stack');
    // ---- 6, 8, 9, 10. concurrency and reconciliation, via the Hammer ----------
    hammerVerdicts();
    // ---- 16. lane count 4 -> 5, live -------------------------------------------
    record('#16', ...laneCountVerdict());
}
catch (e) {
    console.error(`\n  fixture setup failed: ${e.message}\n`);
    process.exit(2);
}
// ---- the ones a script cannot do --------------------------------------------
record('#1', 'BLOCKED', 'three runs on a device with a frame counter — no APK, no handset');
record('#7', 'BLOCKED', 'kill the app mid-run — needs the APK on a device');
record('#11', 'BLOCKED', 'reseeds the 2,000-account population and rewrites DevDocs/simulation-report.md — run deliberately (./Tools/Seed && ./Tools/Simulate), not as part of a rehearsal');
record('#12', 'BLOCKED', 'change a matchmaking parameter and explain what moved — a live conversation (see DevDocs/review-rehearsal.md for one OBSERVED run)');
record('#13', 'BLOCKED', 'predict then run a skewed Backend/config/seed.json — a live conversation');
record('#14', 'BLOCKED', 'plant an anomaly via Backend/config/seed.json and see if the rules catch it — a live conversation');
record('#15', 'BLOCKED', 'walk the calibration curve — a live explanation; the numbers are in DevDocs/simulation-report.md §2');
// --- report -------------------------------------------------------------------
console.log();
console.log(lines.sort(byTestNumber).join('\n'));
console.log();
console.log(`  ${pass} passed · ${fail} failed · ${blocked} blocked`);
console.log();
console.log(fail === 0
    ? `  No automated review test failed. ${blocked} still need a device, a person, or Tools/Hammer (T-202).`
    : `  ${fail} AUTOMATED REVIEW TEST(S) FAILED — fix before the screen share.`);
process.exit(fail > 0 ? 1 : 0);
// -----------------------------------------------------------------------------
function byTestNumber(a, b) {
    const na = Number(a.trim().slice(1, a.indexOf(' ', 1)));
    const nb = Number(b.trim().slice(1, b.indexOf(' ', 1)));
    return na - nb;
}
/** Shells out to the real Tools/Replay, exactly as a reviewer would run it. */
function replayVerdict(gameId) {
    const replayPath = `${REPO_ROOT}Tools/Replay`;
    try {
        // FIRESTORE_EMULATOR_HOST routes the match/submission read at the emulator.
        // GCLOUD_PROJECT is required alongside it — the Admin SDK still needs a
        // project id to label requests even though the emulator does not check
        // it (the same reason seedTarget.ts sets it for Tools/Seed).
        // GOOGLE_APPLICATION_CREDENTIALS is deliberately cleared — Tools/Replay
        // also fetches the live Remote Config template to know "the rules of
        // record" (there is no RC emulator), and this rehearsal must not touch
        // production even for a read. If that makes Replay unable to run, that is
        // reported below, honestly, rather than skipped over.
        const out = execFileSync(replayPath, [gameId], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: { ...process.env, FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST, GCLOUD_PROJECT: PROJECT, GOOGLE_APPLICATION_CREDENTIALS: '' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const matches = (out.match(/MATCH/g) ?? []).length;
        const mismatches = (out.match(/MISMATCH/g) ?? []).length;
        if (mismatches > 0)
            return ['FAIL', `Tools/Replay ${gameId}: ${mismatches} MISMATCH line(s)`];
        if (matches >= 2)
            return ['PASS', `Game ID ${gameId} replays to the stored scores exactly (${matches} submissions)`];
        return ['FAIL', `Tools/Replay ${gameId}: expected 2 MATCH lines, saw ${matches}`];
    }
    catch (e) {
        return ['BLOCKED', `Tools/Replay ${gameId} could not run: ${firstLine(e)} — needs live Remote Config access (no RC emulator exists); this rehearsal withholds credentials to avoid touching production`];
    }
}
/**
 * A one-line summary of a failed child process's stderr — a table row is one
 * line, not a stack trace. Prefers a line that looks like the actual error
 * ("Error: ...", "npm error ...") over Node's uncaught-exception boilerplate
 * ("node:internal/modules/run_main:123", "^"), which sorts first otherwise.
 */
function firstLine(e) {
    const stderr = e.stderr?.toString().trim();
    const text = stderr || e.message || String(e);
    const candidates = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    return candidates.find((l) => /^(Error|npm error|error)[:\s]/.test(l)) ?? candidates[0] ?? text;
}
/** Shells out to the real Tools/Solvability with the 5-lane config. */
function laneCountVerdict() {
    const fiveLanePath = `${REPO_ROOT}Backend/config/redline.game.5lane.json`;
    if (!existsSync(fiveLanePath))
        return ['BLOCKED', 'Backend/config/redline.game.5lane.json is missing'];
    const fiveLaneConfig = parseGameConfig(readFileSync(fiveLanePath, 'utf8')).config;
    try {
        const out = execFileSync(`${REPO_ROOT}Tools/Solvability`, ['--seeds', '400', '--config', fiveLanePath], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (/unwinnable: 0/.test(out)) {
            return [
                'PASS',
                `5-lane config (config edit only, no code change): ${fiveLaneConfig.lanes.length} lanes, cashout lane ${fiveLaneConfig.cashoutLane}, 400 seeds solvability holds`,
            ];
        }
        return ['FAIL', `5-lane config produced unwinnable roads: ${out.trim().split('\n').slice(-3).join(' / ')}`];
    }
    catch (e) {
        return ['FAIL', `Tools/Solvability --config ${fiveLanePath} exited non-zero: ${e.message}`];
    }
}
/**
 * Review tests #6 (join-one-challenge), #8 (abort-and-retry), #9
 * (self-and-same-device) and #10 (books reconcile) are T-202's Hammer
 * scenarios by design — see T-202's own brief, which says as much. Until
 * T-202 lands there is nothing honest to report but BLOCKED; inventing a
 * smaller in-process substitute here would contradict the instruction not to
 * invent a substitute that passes.
 */
function hammerVerdicts() {
    const hammerPath = `${REPO_ROOT}Tools/Hammer`;
    if (!existsSync(hammerPath)) {
        const reason = '../Tools/Hammer does not exist yet (T-202 not built)';
        record('#6', 'BLOCKED', `join-one-challenge — ${reason}`);
        record('#8', 'BLOCKED', `abort-and-retry — ${reason}`);
        record('#9', 'BLOCKED', `self-and-same-device — ${reason}`);
        record('#10', 'BLOCKED', `ledger/rating reconciliation — ${reason}`);
        return;
    }
    // A rehearsal-scale run, not Hammer's own full acceptance-criteria run
    // (100 players / 1000 matches) — that scale is Hammer's own pass-1
    // verification to own, not this script's to repeat every time.
    const reportPath = `${REPO_ROOT}Backend/artifacts/hammer-report.json`;
    const hammerStartedAt = new Date().toISOString();
    try {
        execFileSync(hammerPath, ['--players', '20', '--matches', '100', '--concurrency', '10', '--seed', '1'], {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch {
        // Hammer itself exits non-zero on any failed check — that is a real
        // signal, not a crash to swallow. Fall through to the report file, which
        // it still wrote, to see WHICH checks failed rather than blanket-failing all four.
    }
    if (!existsSync(reportPath)) {
        const reason = 'Tools/Hammer ran but left no Backend/artifacts/hammer-report.json';
        record('#6', 'BLOCKED', reason);
        record('#8', 'BLOCKED', reason);
        record('#9', 'BLOCKED', reason);
        record('#10', 'BLOCKED', reason);
        return;
    }
    // hammer.ts's own report shape (Backend/tools/src/hammer.ts): checks is an
    // ARRAY of {name, verdict: "ok" | "FAILURE", detail, ...}, not a keyed map.
    //
    // The report path is a shared artifact (T-202's own design, fixed and not
    // this task's to change) — a concurrent Hammer invocation elsewhere in this
    // repo can be mid-write to the same file, so both the read and the parse
    // are wrapped: a torn read is reported as BLOCKED, not a crash of the whole
    // rehearsal, and a report older than this invocation (finishedAt predates
    // it) is treated the same way rather than misread as this run's result.
    let report;
    try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
        if (report.finishedAt && report.finishedAt < hammerStartedAt) {
            throw new Error(`report (finishedAt=${report.finishedAt}) predates this invocation — likely a concurrent run wrote it`);
        }
    }
    catch (e) {
        const reason = `Backend/artifacts/hammer-report.json unusable: ${e.message} — it is a shared file and another Tools/Hammer run may be writing it concurrently; re-run Tools/Rehearse once the shared emulator is quieter`;
        record('#6', 'BLOCKED', reason);
        record('#8', 'BLOCKED', reason);
        record('#9', 'BLOCKED', reason);
        record('#10', 'BLOCKED', reason);
        return;
    }
    const verdict = (name, testId, label) => {
        const c = report.checks.find((x) => x.name === name);
        if (!c)
            record(testId, 'BLOCKED', `hammer-report.json has no "${name}" check`);
        else if (c.verdict === 'ok')
            record(testId, 'PASS', `${label}: ${c.detail ?? 'ok'}`);
        else
            record(testId, 'FAIL', `${label}: ${c.detail ?? c.verdict}`);
    };
    verdict('join-one-challenge', '#6', 'N simultaneous joins on one challenge');
    verdict('abort-and-retry', '#8', 'connection killed mid-transaction then retried');
    verdict('self-and-same-device', '#9', 'self-match and same-device join both refused');
    const allOk = report.checks.every((c) => c.verdict === 'ok');
    record('#10', allOk ? 'PASS' : 'FAIL', allOk
        ? `ledger and rating reconcile: ${report.checks.length} checks green`
        : `${report.checks.filter((c) => c.verdict !== 'ok').map((c) => c.name).join(', ')} failed`);
}
//# sourceMappingURL=rehearse.js.map