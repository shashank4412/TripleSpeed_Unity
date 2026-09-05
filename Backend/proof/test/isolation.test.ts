/**
 * S-203 — the proof can never reach Firestore.
 *
 * The single most important property of the fairness proof is one nobody had
 * written down: `Backend/proof/src/` imports no Firebase, no Google Cloud
 * client, and nothing that opens a socket. That is what makes review test #11
 * possible — a reviewer clones the repo, runs `npm run proof`, and gets the same
 * report with no credentials, no project, no network and no cost. The
 * alternative reading, where 50,000 matches are driven through the live backend,
 * is roughly 400,000 Firestore writes per run against a 20,000-per-day free tier.
 *
 * Nothing enforced it. One `import { getFirestore }` added in good faith — to
 * read a real challenge inventory, say — would quietly destroy the property, and
 * the first person to notice would be the reviewer, on the call, when the run
 * asks for credentials.
 *
 * This imitates the pattern the repository already uses for exactly this job:
 * `Packages/com.redline.core/Runtime/Redline.Core.asmdef` sets
 * `noEngineReferences: true`, so Unity REFUSES TO COMPILE the simulation core if
 * anyone writes `using UnityEngine;`. Same reasoning, different toolchain.
 *
 * ALLOW-LIST, NOT DENY-LIST. A deny-list is a list of the network clients that
 * existed on the day it was written; `undici` was not on anyone's list in 2018.
 * The allow-list below is the whole policy, in one place.
 *
 * CI: runs as part of `npm test --workspace @redline/proof`. There is no
 * workflow file in this repository yet — feature 0002's T-105 creates it — so
 * T-105 must include that step. No competing workflow file is added here.
 *
 * There is deliberately NO escape hatch — no environment variable, no ignore
 * comment, no "only in dev" branch. If a future task genuinely needs Firestore
 * in the proof, the right move is to delete this file in a commit that explains
 * what was given up.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROOF = fileURLToPath(new URL('../', import.meta.url));
const SRC = path.join(PROOF, 'src');

// ---------------------------------------------------------------------------
// THE ALLOW-LIST — the one place the policy is written.
// ---------------------------------------------------------------------------

/** Packages the proof may import. Both are pure, in-process and dependency-free. */
const ALLOWED_PACKAGES = ['@redline/rating', '@redline/sim-core'];

/**
 * Node builtins the proof may import. `fs` reads the config files and writes the
 * report and the CSVs; `path` joins their names; `url` turns this module's own
 * `import.meta.url` into a directory so the repo root can be found from the
 * compiled `lib/` output. Anything that can open a socket is absent on purpose,
 * and that absence is the property under test.
 *
 * `node:url` was added by 0003 S-204 when the proof started writing CSVs to the
 * directory named in Backend/config/sim.json. It is a pure string parser with no I/O of
 * any kind — it cannot resolve a name, open a socket, or read a file — so it
 * does not weaken the property this file exists to protect. Recorded here rather
 * than waved through, because the allow-list IS the policy.
 */
const ALLOWED_BUILTINS = ['node:fs', 'node:path', 'node:url'];

const WHY =
  'The fairness proof must run in-process, on a virtual clock, with no credentials and no network.\n' +
  'That is what makes review test #11 possible: a reviewer clones the repo, runs `npm run proof`,\n' +
  'and reproduces the report on their own machine for free. Driving 50,000 matches through the live\n' +
  'backend would be ~400,000 Firestore writes per run against a 20,000/day free tier, and the\n' +
  'simulation would no longer be re-runnable by anyone but us.\n' +
  'If you genuinely need this import, do not add a suppression — delete Backend/proof/test/isolation.test.ts\n' +
  'in a commit that says what was given up. See DevDocs/assignment-refined.md 1.2 and S-203.';

// ---------------------------------------------------------------------------

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) return tsFilesUnder(abs);
      return e.isFile() && abs.endsWith('.ts') ? [abs] : [];
    })
    .sort();
}

/**
 * Every module specifier in a file: static `from '...'`, dynamic `import('...')`
 * and `require('...')`. Matching on `from '...'` rather than on the whole import
 * statement is what makes this work for multi-line import blocks.
 */
function specifiersOf(src: string): { spec: string; line: number }[] {
  const re = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  const found: { spec: string; line: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    found.push({ spec: m[1]!, line: src.slice(0, m.index).split('\n').length });
  }
  return found;
}

function verdict(spec: string): 'ok' | string {
  if (spec.startsWith('.')) {
    // Relative is fine, but only inside the workspace. `../../functions/...`
    // would reach code that does import firebase-admin.
    return spec.split('/').includes('..') ? 'reaches outside the proof workspace' : 'ok';
  }
  if (spec.startsWith('node:')) {
    return ALLOWED_BUILTINS.includes(spec) ? 'ok' : 'a Node builtin that is not on the allow-list';
  }
  return ALLOWED_PACKAGES.includes(spec) ? 'ok' : 'a package that is not on the allow-list';
}

describe('the proof is isolated from Firestore and the network', () => {
  const files = tsFilesUnder(SRC);

  it('has source files to check (a guard that walked nothing would pass silently)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('imports nothing outside the allow-list', () => {
    const violations: string[] = [];

    for (const abs of files) {
      const rel = path.relative(PROOF, abs);
      for (const { spec, line } of specifiersOf(readFileSync(abs, 'utf8'))) {
        const v = verdict(spec);
        if (v !== 'ok') violations.push(`Backend/proof/${rel}:${line}  imports '${spec}' — ${v}.`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `The fairness proof imports something it must not:\n\n${violations.join('\n')}\n\n` +
          `Allowed packages: ${ALLOWED_PACKAGES.join(', ')}\n` +
          `Allowed builtins: ${ALLOWED_BUILTINS.join(', ')}\n` +
          `Relative imports inside Backend/proof/src are always allowed.\n\n${WHY}\n`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('declares no runtime dependency at all in package.json', () => {
    // The DIRECT check only. A transitive walk would need an installed tree and
    // would make this test slower than the thing it guards; the import test
    // above is what actually closes the hole, because an undeclared package
    // still has to be imported by name to be used.
    const pkg = JSON.parse(readFileSync(path.join(PROOF, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const runtime = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    };
    expect(Object.keys(runtime)).toEqual([]);

    // devDependencies may exist, but not for anything that talks to a server.
    const forbidden = /firebase|google-cloud|gcp|axios|node-fetch|undici|got|superagent/i;
    const offendingDev = Object.keys(pkg.devDependencies ?? {}).filter((d) => forbidden.test(d));
    expect(offendingDev).toEqual([]);
  });
});
