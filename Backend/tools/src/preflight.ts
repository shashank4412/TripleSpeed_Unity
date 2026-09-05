/**
 * Tools/Preflight — is the stack ready for someone to press Play?
 *
 * Read-only: it never migrates, never seeds, never deploys. It answers one
 * question — can the Editor talk to a working emulator right now — by probing
 * the same things a cold start would touch: the three emulator ports, one
 * callable actually loading and running (not just a port accepting TCP), and
 * the game config the client and server are supposed to agree on staying
 * byte-identical between its two copies (CLAUDE.md's "Configuration, not
 * constants" section; this exact copy drifted once already — see
 * shared/firebase.ts's HOUSE_UID comment for what a silent drift costs).
 *
 * Rewritten for the Firebase stack (T-203). The old Preflight shelled out to
 * `dotnet run --project src/Redline.Tools -- preflight`, a project deleted in
 * the Firebase migration. This version has no relationship to that binary's
 * checklist beyond the name and the "read-only" promise.
 *
 *   ./Tools/Preflight                 # against the local emulator (default)
 *
 * Firestore rules/indexes and Backend/.secrets/*.json are reported as present
 * or missing, never read or printed: this tool cannot confirm a rules/indexes
 * DEPLOY happened without calling the (mutating-adjacent, credentialed) admin
 * API, which is out of scope for something that promises to be read-only. A
 * live-project check is deliberately not implemented — see the note at the
 * bottom of this file for why, and what it would take.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGameConfig } from '@redline/sim-core';
import { AUTH_HOST, FUNCTIONS_HOST, FIRESTORE_HOST, PROJECT, reachable, callCallable, CallableError } from './emulator.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Level = 'OK' | 'WARN' | 'FAIL';
const rows: Array<{ level: Level; label: string; detail: string }> = [];
function check(level: Level, label: string, detail: string): void {
  rows.push({ level, label, detail });
}

// ---- 1. emulator ports reachable --------------------------------------------
const [authUp, functionsUp, firestoreUp] = await Promise.all([
  reachable(AUTH_HOST),
  reachable(FUNCTIONS_HOST),
  reachable(FIRESTORE_HOST),
]);
check(authUp ? 'OK' : 'FAIL', 'auth emulator', authUp ? AUTH_HOST : `nothing answering at ${AUTH_HOST}`);
check(
  functionsUp ? 'OK' : 'FAIL',
  'functions emulator',
  functionsUp ? FUNCTIONS_HOST : `nothing answering at ${FUNCTIONS_HOST}`,
);
check(
  firestoreUp ? 'OK' : 'FAIL',
  'firestore emulator',
  firestoreUp ? FIRESTORE_HOST : `nothing answering at ${FIRESTORE_HOST}`,
);

// ---- 2. a real callable loads and runs, not just "port open" ---------------
// Calling ensureAccount with NO Authorization header exercises requireUid()
// without ever reaching a Firestore write — a HttpsError('unauthenticated', …)
// proves the module imported cleanly and the handler ran; a connection error
// or an "internal" 500 means something failed to load.
if (functionsUp) {
  try {
    await callCallable('ensureAccount', null, {});
    check('FAIL', 'functions load cleanly', 'ensureAccount accepted an unauthenticated call — auth.uid gate is not running');
  } catch (e) {
    if (e instanceof CallableError && e.code === 'UNAUTHENTICATED') {
      check('OK', 'functions load cleanly', 'ensureAccount rejected an unauthenticated call as expected — module loaded, handler ran');
    } else if (e instanceof CallableError) {
      check('FAIL', 'functions load cleanly', `ensureAccount answered ${e.code}, expected UNAUTHENTICATED`);
    } else {
      check('FAIL', 'functions load cleanly', `ensureAccount unreachable/errored: ${(e as Error).message}`);
    }
  }
} else {
  check('FAIL', 'functions load cleanly', 'skipped — functions emulator is not up');
}

// ---- 3. the two copies of redline.game.json are byte-identical -------------
// shared/config.ts falls back to Backend/functions/config/*.json whenever
// Remote Config is unreachable (always true under the emulator — there is no
// RC emulator). If that copy has drifted from the root config, the server
// silently scores under different rules than the ones just edited.
const rootGamePath = `${REPO_ROOT}Backend/config/redline.game.json`;
const fallbackGamePath = `${REPO_ROOT}Backend/functions/config/redline.game.json`;
if (existsSync(rootGamePath) && existsSync(fallbackGamePath)) {
  const rootText = readFileSync(rootGamePath, 'utf8').trim();
  const fallbackText = readFileSync(fallbackGamePath, 'utf8').trim();
  if (rootText === fallbackText) {
    const { configHash } = parseGameConfig(rootText);
    check('OK', 'Backend/config/redline.game.json <-> functions/config copy', `byte-identical, hash ${configHash}`);
  } else {
    const rootHash = safeHash(rootText);
    const fallbackHash = safeHash(fallbackText);
    check('FAIL', 'Backend/config/redline.game.json <-> functions/config copy', `DRIFTED — root ${rootHash}, fallback ${fallbackHash}`);
  }
} else {
  check('FAIL', 'Backend/config/redline.game.json <-> functions/config copy', 'one or both files are missing');
}

// Same byte-identity claim, made for the economy config (CLAUDE.md's config
// section names both files; economy has no stamped hash of its own, so this
// is a plain content comparison).
const rootEconomyPath = `${REPO_ROOT}Backend/config/redline.economy.json`;
const fallbackEconomyPath = `${REPO_ROOT}Backend/functions/config/redline.economy.json`;
if (existsSync(rootEconomyPath) && existsSync(fallbackEconomyPath)) {
  const same = readFileSync(rootEconomyPath, 'utf8').trim() === readFileSync(fallbackEconomyPath, 'utf8').trim();
  check(same ? 'OK' : 'FAIL', 'Backend/config/redline.economy.json <-> functions/config copy', same ? 'byte-identical' : 'DRIFTED');
} else {
  check('FAIL', 'Backend/config/redline.economy.json <-> functions/config copy', 'one or both files are missing');
}

// ---- 4. rules / indexes / remote config template present -------------------
// Presence and syntax only. Confirming an actual DEPLOY happened needs a
// credentialed, non-emulator API call, which is out of scope for a read-only
// local check — see the note at the end of this file.
checkPresentAndParseable(`${REPO_ROOT}Backend/firestore.rules`, 'firestore.rules', (text) => text.trim().length > 0);
checkPresentAndParseable(`${REPO_ROOT}Backend/firestore.indexes.json`, 'firestore.indexes.json', (text) => {
  const parsed = JSON.parse(text) as { indexes?: unknown[] };
  return Array.isArray(parsed.indexes);
});
checkPresentAndParseable(`${REPO_ROOT}Backend/remoteconfig.template.json`, 'remoteconfig.template.json', (text) => {
  const parsed = JSON.parse(text) as { parameters?: Record<string, unknown> };
  return !!parsed.parameters?.['redline_game'] && !!parsed.parameters?.['redline_economy'];
});

// ---- 5. credentials present, never read ------------------------------------
// Needed only for a --project live run of the other Tools/* (Replay,
// Rollback, Simulate --out to a shared location, push-remote-config). Path
// reference only: this never opens the file.
const secretsDir = `${REPO_ROOT}Backend/.secrets`;
if (existsSync(secretsDir)) {
  const keys = readdirSync(secretsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'));
  check(
    keys.length > 0 ? 'OK' : 'WARN',
    'service account key',
    keys.length > 0 ? `${keys.length} file(s) in Backend/.secrets/ (not opened)` : 'Backend/.secrets/ exists but has no .json key — only needed for --project live',
  );
} else {
  check('WARN', 'service account key', 'Backend/.secrets/ does not exist — only needed for --project live');
}

// --- report -------------------------------------------------------------------
console.log(`Preflight — emulator at auth:${AUTH_HOST} functions:${FUNCTIONS_HOST} firestore:${FIRESTORE_HOST} (project ${PROJECT})`);
console.log();
const width = Math.max(...rows.map((r) => r.label.length));
for (const r of rows) console.log(`  ${r.level.padEnd(5)} ${r.label.padEnd(width)}  ${r.detail}`);
console.log();

const blocking = rows.filter((r) => r.level === 'FAIL');
if (blocking.length === 0) {
  console.log('  READY — press Play.');
  process.exit(0);
} else {
  console.log(`  NOT READY — ${blocking.length} check(s) failed:`);
  for (const r of blocking) console.log(`    - ${r.label}: ${r.detail}`);
  process.exit(1);
}

function checkPresentAndParseable(path: string, label: string, validate: (text: string) => boolean): void {
  if (!existsSync(path)) {
    check('WARN', label, 'missing');
    return;
  }
  try {
    const ok = validate(readFileSync(path, 'utf8'));
    check(ok ? 'OK' : 'WARN', label, ok ? 'present, parses' : 'present but failed its shape check');
  } catch (e) {
    check('WARN', label, `present but did not parse: ${(e as Error).message}`);
  }
}

function safeHash(text: string): string {
  try {
    return parseGameConfig(text).configHash;
  } catch {
    return '(does not parse)';
  }
}

/**
 * WHY THERE IS NO --project live HERE
 *
 * A genuine live-readiness check ("is the deployed project ready") needs to:
 * confirm the last `firebase deploy --only firestore:rules,firestore:indexes`
 * actually landed (the Admin SDK has no "list deployed rules" call; it needs
 * either the Firebase Management API or shelling out to `firebase
 * firestore:indexes` and parsing its output), and reach each gen2 function's
 * actual Cloud Run URL, which is not a predictable path the way gen1's
 * `https://<region>-<project>.cloudfunctions.net/<name>` was — it has to be
 * discovered per function, normally via `firebase functions:list` or the
 * console, after a deploy. Building that discovery is real, separate work,
 * not a read-only local check, and this task's constraints rule out deploying
 * anything to find out. `Tools/Rehearse --url <base>` has the same gap for the
 * same reason — see its header comment.
 */
