/**
 * Decides where Tools/Seed writes, and does it before anything imports the
 * Admin SDK.
 *
 * This is a side-effect module on purpose. `shared/firebase.js` runs
 * `initializeApp()` and `getFirestore()` at module load, and the Admin SDK
 * latches FIRESTORE_EMULATOR_HOST at that moment. Anything that sets it later
 * is ignored, silently, and the difference between "ignored" and "honoured" is
 * whether a tool that creates balances ran against production.
 *
 * So: the emulator is the default, it is chosen here, and the live project has
 * to be asked for by name.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const argv = process.argv.slice(2);
const projectFlag = argv.indexOf('--project');
const target = projectFlag >= 0 ? argv[projectFlag + 1] : 'emulator';

if (target !== 'live') {
  // Matches Backend/firebase.json's firestore emulator port.
  process.env['FIRESTORE_EMULATOR_HOST'] ??= '127.0.0.1:8080';
  // The Admin SDK needs a project id even against the emulator; the emulator
  // does not check it, but initializeApp() refuses without one.
  process.env['GCLOUD_PROJECT'] ??= process.env['FIREBASE_PROJECT_ID'] ?? 'attendance-91bdd';
  // Ambient application-default credentials would make the Remote Config read
  // inside loadConfig() reach the real project. Against the emulator we want
  // the committed fallback config, which is what an unauthenticated RC read
  // falls back to.
  delete process.env['GOOGLE_APPLICATION_CREDENTIALS'];
} else {
  // The announcement lives HERE, not in seed.ts's main(), for the same reason
  // the target does: initializeApp() runs at import time, so a message printed
  // from main() arrives after the SDK has already tried to reach production —
  // or, as happened the first time this path was exercised, never arrives at
  // all because the SDK threw first.
  console.log('*** WRITING TO THE LIVE PROJECT ***');
  console.log(`  project : ${process.env['FIREBASE_PROJECT_ID'] ?? process.env['GCLOUD_PROJECT'] ?? '(from credentials)'}`);
  console.log('  effect  : creates real account documents holding a real balance.');

  const cred = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (!cred) {
    console.error('  --project live needs GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account key.');
    process.exit(2);
  }
  // .env states the key path relative to the repo root, but every Tools/*
  // wrapper cd's into Backend/ first, so the Admin SDK resolves it against the
  // wrong directory and reports a missing file. Anchor it to the repo root.
  if (!isAbsolute(cred) && !existsSync(cred)) {
    const anchored = resolve(REPO_ROOT, cred);
    if (existsSync(anchored)) process.env['GOOGLE_APPLICATION_CREDENTIALS'] = anchored;
  }
  if (!existsSync(process.env['GOOGLE_APPLICATION_CREDENTIALS']!)) {
    console.error(`  credentials not found: ${cred}`);
    process.exit(2);
  }

  if (!argv.includes('--yes')) {
    console.log('\n  Re-run with --yes to confirm. Nothing has been written.');
    process.exit(2);
  }
  console.log('  --yes given; proceeding.\n');

  delete process.env['FIRESTORE_EMULATOR_HOST'];
}

export const TARGET_IS_LIVE = target === 'live';
