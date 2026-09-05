/**
 * lint-money — fails the build if a float-shaped operation appears on a money
 * path.
 *
 *   node Backend/tools/lint-money.mjs        (npm run lint:money)
 *
 * WHY THIS EXISTS
 *
 * `DevDocs/assignment.md:178` requires "no floating point anywhere near a balance",
 * and one point of score — or one cent — decides who takes a real-money pot. A
 * rule like that is one a reviewer checks by reading, a contributor breaks by
 * accident, and a build can check every time for free.
 *
 * The precedent is already in this repository and this imitates it deliberately:
 * `Packages/com.redline.core/Runtime/Redline.Core.asmdef` sets
 * `noEngineReferences: true`, so Unity REFUSES TO COMPILE the simulation core if
 * anyone adds `using UnityEngine;`. The engine-decoupling is enforced by the
 * build, not by review. Money deserves the same treatment for the same reason.
 *
 * Deliberately not eslint. The repository has no lint setup, and adding one
 * toolchain, one config format and one plugin ecosystem to express six regexes
 * would be a worse answer than six regexes. If eslint ever arrives for other
 * reasons, port these rules to `no-restricted-syntax` and delete this file.
 *
 * Lives at `Backend/tools/`, NOT `Backend/tools/lib/`, because `.gitignore:158`
 * ignores every `lib/` directory under `Backend/` as a tsc output directory — the
 * glob is not spelled out here because its `**` + `/` would close this very block
 * comment, which is exactly how this file shipped unparseable. A hand-written script put
 * there is silently never committed. (`push-remote-config.mjs` is in exactly that
 * position today and is untracked; see the Batch 2 report.)
 *
 * CI: run as `npm run lint:money` from Backend/. There is no workflow file in
 * this repository yet — feature 0002's T-105 creates it — so this is wired to an
 * npm script and nothing else. T-105 must add the step; a second competing
 * workflow file would be worse than the gap.
 *
 * NO SUPPRESSIONS. There is no ignore comment, no environment variable and no
 * "only in dev" branch, on purpose. If real code trips this rule, either the
 * rule is mis-scoped (fix the scope, below, in the one place it is written) or
 * the code has a bug. Adding an escape hatch is how the twenty-first suppression
 * becomes the one that hides the bug.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BACKEND = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// SCOPE — the one place the covered set is written. Nothing else decides it.
// ---------------------------------------------------------------------------

/**
 * Files and directories that compute or move cents. A directory entry covers
 * every `.ts` file under it, recursively.
 */
const COVERED = [
  'rating/src/settlement.ts', // the pot, the rake, the tie split
  'rating/src/economyConfig.ts', // where cents enter the process
  'functions/src/handlers', // every callable that stakes, pays or refunds
  'functions/src/shared/settle.ts', // the settlement transaction
  'functions/src/shared/ledger.ts', // the append-only balance movements
  'functions/src/shared/accounts.ts', // balanceCents creation and grants
  'functions/src/shared/idempotency.ts', // the money fingerprint behind a retry
  'functions/src/shared/challenge.ts', // the stake-and-create transaction shared by createMatch and the matchmaking starvation fallback (decision #11)
  'functions/src/shared/refundChallenge.ts', // the return-an-unanswered-stake writer shared by the sweep and withdrawChallenge (feature 0010)
];

/**
 * Deliberately NOT covered, with the reason. An over-broad rule that forces
 * twenty suppressions is worse than no rule, because the twenty-first
 * suppression is where the bug hides.
 */
const NOT_COVERED = [
  ['rating/src/elo.ts', 'Rating, not money. `expected()` is float by design (elo.ts:97-104) and the delta is rounded to a whole rating point before storage, so the last bits cannot survive to be compared.'],
  ['rating/src/math.ts', 'Hosts both a money helper and a rating helper. `divRoundHalfEven` is pure BigInt and touches no float; `roundHalfAwayFromZero` wraps `Math.round` on purpose, for Elo. Covering the file would demand a suppression, which this rule does not have.'],
  ['rating/src/matchmaker.ts', 'Divides milliseconds by 1000 for a challenge age in seconds. No cents pass through it.'],
  ['functions/src/shared/inventory.ts', 'Computes the top-decile rating percentile (0.9). A rating percentile, not an amount.'],
  ['proof/', 'The simulation models outcomes; its money is a bookkeeping copy of settle(), and the production settlement code it calls IS covered above.'],
];

// ---------------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------------

const RULES = [
  {
    id: 'no-float-literal',
    re: /(?<![\w.$])\d+\.\d+|(?<![\w.$])\d+(?:\.\d+)?[eE]-\d+/g,
    why: 'a non-integer numeric literal on a money path. Money is integer cents: write 50, not 0.50.',
  },
  {
    id: 'no-parse-float',
    re: /\b(?:Number\.)?parseFloat\b/g,
    why: 'parseFloat produces a double. Parse cents with Number.isInteger-checked integers instead.',
  },
  {
    id: 'no-to-fixed',
    re: /\.toFixed\s*\(/g,
    why: 'toFixed formats a double and is how a rounding error becomes a displayed amount.',
  },
  {
    id: 'no-math-rounding',
    re: /\bMath\s*\.\s*(?:round|floor|ceil|trunc)\s*\(/g,
    why: 'rounding on a money path. Integer cents never need rounding; a rounding call means a fraction got in. Use % and integer division, or BigInt via divRoundHalfEven.',
  },
  {
    id: 'no-math-float-fn',
    re: /\bMath\s*\.\s*(?:pow|sqrt|exp|log|log10|random|hypot|cbrt)\s*\(/g,
    why: 'a float-producing Math function on a money path.',
  },
  {
    id: 'no-exponent-operator',
    re: /\*\*/g,
    why: 'the ** operator produces a double for number operands. Use BigInt ** BigInt, or a constant.',
  },
];

// ---------------------------------------------------------------------------
// Masking — comments and string literals are prose, not code.
// ---------------------------------------------------------------------------

/**
 * Replaces the characters of comments and string-literal text with spaces,
 * preserving every offset so reported line/column numbers stay exact.
 *
 * A character scanner rather than a regex, because the regex version has to be
 * wrong in at least one direction: it either fires on the word `Math.round`
 * inside a doc comment (a rule that cries wolf is a rule people disable) or it
 * blanks a whole template literal including its `${...}` holes, where real code
 * lives. Template interpolations are kept as code here.
 */
function maskCommentsAndStrings(src) {
  const out = src.split('');
  const blank = (i) => {
    if (out[i] !== '\n') out[i] = ' ';
  };

  let i = 0;
  const n = src.length;
  // Stack of open template literals, so `${ `nested` }` behaves.
  const templateDepths = [];
  let braceDepth = 0;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') blank(i++);
      continue;
    }
    if (c === '/' && d === '*') {
      blank(i++);
      blank(i++);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++; // keep the opening quote so the token is still visible
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') blank(i++);
        if (i < n) blank(i++);
      }
      i++;
      continue;
    }
    if (c === '`') {
      i++;
      templateDepths.push(braceDepth);
      while (i < n) {
        if (src[i] === '\\') {
          blank(i++);
          blank(i++);
          continue;
        }
        if (src[i] === '`') {
          i++;
          templateDepths.pop();
          break;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          // Leave the interpolation alone: it is code.
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth === 0) break;
            i++;
          }
          i++;
          continue;
        }
        blank(i++);
      }
      continue;
    }
    if (c === '{') braceDepth++;
    if (c === '}') braceDepth--;
    i++;
  }

  return out.join('');
}

// ---------------------------------------------------------------------------

function tsFilesUnder(abs) {
  const st = statSync(abs);
  if (st.isFile()) return abs.endsWith('.ts') ? [abs] : [];
  return readdirSync(abs)
    .flatMap((entry) => tsFilesUnder(path.join(abs, entry)))
    .sort();
}

function lineColOf(src, index) {
  const upto = src.slice(0, index);
  const line = upto.split('\n').length;
  const col = index - (upto.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

const files = COVERED.flatMap((rel) => tsFilesUnder(path.join(BACKEND, rel)));
const violations = [];

for (const abs of files) {
  const src = readFileSync(abs, 'utf8');
  const masked = maskCommentsAndStrings(src);
  const rel = path.relative(BACKEND, abs);

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(masked)) !== null) {
      const { line, col } = lineColOf(src, m.index);
      violations.push({
        rel,
        line,
        col,
        rule: rule.id,
        why: rule.why,
        text: src.split('\n')[line - 1].trim(),
      });
    }
  }
}

if (violations.length === 0) {
  console.log(`lint:money — ${files.length} file(s) on the money path, 0 violations, 0 suppressions.`);
  for (const f of files) console.log(`  ok  ${path.relative(BACKEND, f)}`);
  process.exit(0);
}

console.error(`lint:money FAILED — ${violations.length} violation(s) on the money path.\n`);
for (const v of violations) {
  console.error(`Backend/${v.rel}:${v.line}:${v.col}  [${v.rule}]`);
  console.error(`    ${v.text}`);
  console.error(`    ${v.why}\n`);
}
console.error(
  'Money is integer cents end to end (CLAUDE.md, DevDocs/assignment.md:178). One cent\n' +
    'decides who takes a real-money pot, so there is no tolerance and no suppression\n' +
    'comment. If this rule is wrong about your file, change the COVERED/NOT_COVERED\n' +
    'lists at the top of Backend/tools/lint-money.mjs and say why in the same commit.',
);
process.exit(1);
