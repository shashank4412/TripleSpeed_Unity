/**
 * Tools/Seed — the demo fixture.
 *
 * The brief asks for "seeded accounts holding a balance so we can play
 * immediately". That is about twenty opponents and a lobby that is not empty on
 * install; it is NOT the 2,000-player proof population, which lives entirely in
 * memory and never touches Firestore (Backend/proof, guarded by
 * proof/test/isolation.test.ts). Scale here is twenty.
 *
 *   ./Tools/Seed --seed 1                    # emulator (default)
 *   ./Tools/Seed --seed 1 --project live     # the real project, announces first
 *
 * WHY IT WRITES THROUGH THE PRODUCTION HELPERS
 *
 * Every document below is produced by the same functions the Cloud Functions
 * use — `createAccount`, `appendLedger`, `settleMatch`. A fixture assembled by
 * hand-writing raw documents is a fixture that reconciles to nothing and tests
 * nothing: feature 0002's T-205 reconciles `balance == Σ ledger rows` across the
 * WHOLE database, and a seeded balance with no ledger row behind it fails that
 * for the entire product, not just for itself. So the seeder stakes, banks and
 * settles the way a player does, and the books balance for the same reason
 * production's do.
 *
 * WHY IT DEFAULTS TO THE EMULATOR
 *
 * This tool creates balances. A seeder that defaults to production is a seeder
 * that is one day run against production by accident, so `--project live` is
 * required, is spelled out, and prints what it is about to do first.
 *
 * WHY IT IS DETERMINISTIC
 *
 * Document ids are derived from `--seed`, never auto-allocated, and every
 * write is skipped when the document already exists. Running it twice is
 * therefore a no-op rather than a doubling — which matters because the thing
 * being doubled would be money.
 */
// FIRST, and by itself: `@redline/functions/lib/shared/firebase.js` calls
// initializeApp() and getFirestore() at module load, and the Admin SDK reads
// FIRESTORE_EMULATOR_HOST at that moment. ES module imports are evaluated in
// order, so choosing the target has to happen in an earlier import — deciding
// it in this file's body would already be too late, and the seeder would write
// to whatever project the ambient credentials point at.
import './seedTarget.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Deep imports into the functions workspace, deliberately: this reuses the
// production write path rather than re-implementing it. Importing the package
// root would pull in firebase-functions and register every callable.
import { db, C, SUB, HOUSE_UID, Timestamp } from '@redline/functions/lib/shared/firebase.js';
import { accountRef, createAccount, readAccount, DEMO_GRANT_CENTS } from '@redline/functions/lib/shared/accounts.js';
import { appendLedger } from '@redline/functions/lib/shared/ledger.js';
import { settleMatch } from '@redline/functions/lib/shared/settle.js';
import { parseGameConfig, runSimulation, formatInputLog } from '@redline/sim-core';
import { parseEconomyConfig, isProvisional } from '@redline/rating';
const REPO_ROOT = new URL('../../../', import.meta.url);
function parseArgs(argv) {
    const opts = {
        seed: 1,
        accounts: 20,
        challenges: 8,
        live: false,
        dump: false,
        challengeTtlSeconds: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined)
                throw new Error(`${arg} needs a value`);
            return v;
        };
        switch (arg) {
            case '--seed':
                opts.seed = intArg(value(), '--seed');
                break;
            case '--accounts':
                opts.accounts = intArg(value(), '--accounts');
                break;
            case '--challenges':
                opts.challenges = intArg(value(), '--challenges');
                break;
            case '--challenge-ttl-seconds':
                opts.challengeTtlSeconds = intArg(value(), '--challenge-ttl-seconds');
                break;
            case '--project':
                opts.live = requireProject(value());
                break;
            case '--yes':
                // Consumed by seedTarget.ts, which runs before the Admin SDK is
                // imported. Accepted (and ignored) here so the parser does not reject it.
                break;
            case '--dump':
                opts.dump = true;
                break;
            case '--help':
            case '-h':
                console.log(USAGE);
                process.exit(0);
            // eslint-disable-next-line no-fallthrough
            default:
                throw new Error(`unknown argument '${arg}'\n\n${USAGE}`);
        }
    }
    return opts;
}
function intArg(text, name) {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0)
        throw new Error(`${name} must be a non-negative integer, got '${text}'`);
    return n;
}
function requireProject(value) {
    if (value === 'emulator')
        return false;
    if (value === 'live')
        return true;
    throw new Error(`--project must be 'emulator' or 'live', got '${value}'`);
}
const USAGE = `Tools/Seed — populate a REDLINE database with a demo fixture.

  --seed N                     deterministic fixture seed (default 1)
  --accounts N                 how many opponent accounts (default 20)
  --challenges N               how many open challenges (default 8)
  --challenge-ttl-seconds N    override the config challenge TTL for this fixture
  --project emulator|live      where to write (default emulator)
  --yes                        skip the confirmation pause on --project live
  --dump                       write nothing; print every document as sorted
                               JSON, so two runs can be diffed

Writing to the live project also needs GOOGLE_APPLICATION_CREDENTIALS.`;
// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
/**
 * mulberry32 — a small, well-distributed 32-bit PRNG. This decides fixture
 * shape (ratings, stakes, swipe timings) and NOTHING about the game: hazards
 * come from the core's Pcg32 keyed on the road seed, which this only chooses.
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Crockford base32 minus I, L, O, U — the same alphabet as a real Game ID. */
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * A ten-character Game ID that looks like a minted one but is a pure function
 * of (fixture seed, index). Deterministic ids are what make a re-run a no-op
 * instead of a second fixture beside the first.
 */
function fixtureMatchId(rand) {
    let out = '';
    for (let i = 0; i < 10; i++)
        out += ID_ALPHABET[Math.floor(rand() * ID_ALPHABET.length)];
    return out;
}
/** A 64-bit road seed as a decimal string, from the fixture PRNG. */
function fixtureRoadSeed(rand) {
    let v = 0n;
    for (let i = 0; i < 8; i++)
        v = (v << 8n) | BigInt(Math.floor(rand() * 256));
    return v.toString();
}
/** Deterministic account uid. Prefixed so a fixture account is obvious in the console. */
function fixtureUid(fixtureSeed, index) {
    return `seed${fixtureSeed}-p${String(index).padStart(2, '0')}`;
}
// ---------------------------------------------------------------------------
// A run that banks
// ---------------------------------------------------------------------------
/**
 * Produce a real, replayable run for `roadSeed` by driving to the cashout lane
 * and letting the core decide what happened.
 *
 * The swipes are generated, not invented: the run is re-simulated by the same
 * `runSimulation` the server scores with, so `serverScore` on the seeded
 * submission is a score the server would compute from this input log. A fixture
 * whose banked score did not come from the core is a fixture that Tools/Replay
 * would contradict.
 *
 * Later bank tick -> longer time in the scoring lanes -> higher score, but also
 * more road to survive. We walk candidate bank ticks from ambitious to timid and
 * take the first that actually banks; if none does, the run crashed and that is
 * a legitimate fixture too (an open challenge at zero is a real product state).
 */
function bankingRun(config, roadSeed, ambitionTicks) {
    const stepsToCashout = config.cashoutLane - config.startLane;
    const direction = stepsToCashout >= 0 ? 1 : -1;
    const swipes = Math.abs(stepsToCashout);
    let best = null;
    for (let bankAt = ambitionTicks; bankAt >= 30; bankAt -= 30) {
        const events = [];
        for (let s = 0; s < swipes; s++) {
            // One swipe per lane crossed, spaced by the transit duration so the
            // second is not queued behind the first.
            events.push({ tick: bankAt + s * config.laneChangeDurationTicks, direction });
        }
        const result = runSimulation(config, { seed: roadSeed, events, maxRunTicks: config.maxRunTicks });
        if (best === null)
            best = { events, result };
        if (result.outcome === 'Banked')
            return { events, result };
    }
    return best;
}
/**
 * Create one fixture account, or leave the existing one exactly as it is.
 *
 * Balance comes from `createAccount`'s demo-grant deposit row plus one extra
 * `seed-topup` deposit, because the grant alone ($10) cannot post more than one
 * challenge on the top rung of the ladder. Both are deposit rows, so
 * `balance == Σ deposits + Σ match ledger rows` still holds — the same shape
 * production writes, with one more row of it.
 */
async function seedAccount(acc, nowMs) {
    return db.runTransaction(async (txn) => {
        const existing = await readAccount(txn, acc.uid);
        if (existing)
            return 'exists';
        createAccount(txn, acc.uid, acc.rating, { displayName: `Driver-${acc.uid.slice(-2)}` }, nowMs, DEMO_GRANT_CENTS + acc.topUpCents);
        if (acc.topUpCents > 0) {
            txn.create(accountRef(acc.uid).collection('deposits').doc('seed-topup'), {
                amountCents: acc.topUpCents,
                reason: 'seed-topup',
                createdAt: Timestamp.fromMillis(nowMs),
            });
        }
        // ratedMatches is fixture history that did not happen: the matchmaker's
        // new-player protection and provisional flag are driven by it, so a
        // population where everyone has zero would exercise neither. Set in the same
        // transaction as the create so the account never exists in a half state.
        if (acc.ratedMatches > 0) {
            txn.update(accountRef(acc.uid), { ratedMatches: acc.ratedMatches });
        }
        return 'created';
    });
}
/**
 * Post one challenge: stake, drive, bank, open it for answers.
 *
 * This is createMatch's transaction followed by submitRun's poster branch,
 * written in one transaction because there is no client here to be between
 * them. Every money movement is an `appendLedger` row, exactly as the callables
 * would have written it.
 */
async function seedOpenChallenge(spec, config, configHash, economy, ttlSeconds, nowMs) {
    const run = bankingRun(config, spec.roadSeed, spec.ambitionTicks);
    const status = await db.runTransaction(async (txn) => {
        const matchRef = db.collection(C.matches).doc(spec.matchId);
        const [matchSnap, poster] = await Promise.all([txn.get(matchRef), readAccount(txn, spec.posterUid)]);
        if (matchSnap.exists)
            return 'exists';
        if (!poster)
            throw new Error(`poster ${spec.posterUid} does not exist`);
        if (poster.balanceCents < spec.stakeCents)
            return 'skipped';
        const createdAt = Timestamp.fromMillis(nowMs);
        const expiresAt = Timestamp.fromMillis(nowMs + ttlSeconds * 1000);
        const match = {
            stakeCents: spec.stakeCents,
            state: 'open',
            posterUid: spec.posterUid,
            challengerUid: null,
            seed: spec.roadSeed,
            configHash,
            createdAt,
            expiresAt,
            answeredAt: null,
            settledAt: null,
            posterIp: null,
        };
        txn.create(matchRef, match);
        txn.create(db.collection(C.ttl).doc(spec.matchId), {
            matchId: spec.matchId,
            kind: 'challenge',
            expireAt: expiresAt,
        });
        appendLedger(txn, spec.matchId, spec.posterUid, -spec.stakeCents, 'stake', nowMs);
        txn.update(accountRef(spec.posterUid), { balanceCents: poster.balanceCents - spec.stakeCents });
        txn.create(matchRef.collection(SUB.submissions).doc(spec.posterUid), submissionDoc('poster', run, nowMs));
        txn.create(db.collection(C.challenges).doc(spec.matchId), {
            stakeCents: spec.stakeCents,
            bankedScore: run.result.score,
            creatorUid: spec.posterUid,
            creatorRating: poster.rating,
            creatorProvisional: isProvisional(economy.rating, poster.ratedMatches),
            createdAt,
            seed: spec.roadSeed,
        });
        return 'created';
    });
    return { status, bankedScore: run.result.score, outcome: run.result.outcome };
}
/**
 * A match both sides have played, settled by the production settlement
 * transaction. The result screen and any history view need something real to
 * render, and "real" here means a settlement the same code produced.
 */
async function seedSettledMatch(spec, config, configHash, economy, nowMs) {
    const posterRun = bankingRun(config, spec.roadSeed, spec.ambitionTicks);
    const challengerRun = bankingRun(config, spec.roadSeed, spec.challengerAmbitionTicks);
    const prepared = await db.runTransaction(async (txn) => {
        const matchRef = db.collection(C.matches).doc(spec.matchId);
        const [matchSnap, poster, challenger] = await Promise.all([
            txn.get(matchRef),
            readAccount(txn, spec.posterUid),
            readAccount(txn, spec.challengerUid),
        ]);
        if (matchSnap.exists)
            return 'exists';
        if (!poster || !challenger)
            throw new Error('settled-match parties must exist');
        if (poster.balanceCents < spec.stakeCents || challenger.balanceCents < spec.stakeCents)
            return 'skipped';
        const createdAt = Timestamp.fromMillis(nowMs);
        const answeredAt = Timestamp.fromMillis(nowMs);
        const match = {
            stakeCents: spec.stakeCents,
            state: 'answered',
            posterUid: spec.posterUid,
            challengerUid: spec.challengerUid,
            seed: spec.roadSeed,
            configHash,
            createdAt,
            // Already answered, so the live window is the submission window.
            expiresAt: Timestamp.fromMillis(nowMs + economy.money.noSubmissionWindowSeconds * 1000),
            answeredAt,
            settledAt: null,
            posterIp: null,
        };
        txn.create(matchRef, match);
        appendLedger(txn, spec.matchId, spec.posterUid, -spec.stakeCents, 'stake', nowMs);
        appendLedger(txn, spec.matchId, spec.challengerUid, -spec.stakeCents, 'stake', nowMs);
        txn.update(accountRef(spec.posterUid), { balanceCents: poster.balanceCents - spec.stakeCents });
        txn.update(accountRef(spec.challengerUid), { balanceCents: challenger.balanceCents - spec.stakeCents });
        txn.create(matchRef.collection(SUB.submissions).doc(spec.posterUid), submissionDoc('poster', posterRun, nowMs));
        txn.create(matchRef.collection(SUB.submissions).doc(spec.challengerUid), submissionDoc('challenger', challengerRun, nowMs));
        return 'staked';
    });
    if (prepared !== 'staked') {
        return { status: prepared, posterScore: posterRun.result.score, challengerScore: challengerRun.result.score };
    }
    // The production settlement transaction — money, rake and Elo together, or
    // not at all. Not re-implemented here for the same reason the proof does not
    // re-implement the matchmaker: two copies drift.
    const settled = await settleMatch(spec.matchId, nowMs);
    return {
        status: settled.status,
        posterScore: posterRun.result.score,
        challengerScore: challengerRun.result.score,
    };
}
function submissionDoc(role, run, nowMs) {
    return {
        role,
        inputLog: formatInputLog(run.events),
        // A fixture player has no client, so there is no claimed score to disagree
        // with. Leaving this null is honest; inventing one would put a number in the
        // anti-cheat trail that no client ever sent.
        clientClaimedScore: null,
        serverScore: run.result.score,
        outcome: run.result.outcome,
        rejectedInputs: run.result.rejectedInputs,
        configHash: run.result.configHash,
        receivedAt: Timestamp.fromMillis(nowMs),
    };
}
// ---------------------------------------------------------------------------
// Dump — how "running it twice changes nothing" is proved
// ---------------------------------------------------------------------------
/**
 * Print every REDLINE document as canonical, sorted JSON so two runs can be
 * diffed.
 *
 * `firebase emulators:export` would be the obvious tool and it writes a binary
 * LevelDB directory, which tells a reader nothing about WHAT changed when the
 * diff is not empty. A text dump makes the idempotency claim checkable rather
 * than merely assertable — which is the whole difference between evidence and
 * "verified working".
 */
async function dump() {
    const out = {};
    for (const name of Object.values(C)) {
        const snap = await db.collection(name).orderBy('__name__').get();
        for (const doc of snap.docs) {
            out[`${name}/${doc.id}`] = canonical(doc.data());
            for (const sub of await doc.ref.listCollections()) {
                const kids = await sub.orderBy('__name__').get();
                for (const kid of kids.docs)
                    out[`${name}/${doc.id}/${sub.id}/${kid.id}`] = canonical(kid.data());
            }
        }
    }
    for (const key of Object.keys(out).sort()) {
        console.log(`${key}  ${JSON.stringify(out[key])}`);
    }
}
/** Timestamps become millis and keys are sorted, so the text is stable. */
function canonical(data) {
    const out = {};
    for (const key of Object.keys(data).sort()) {
        const v = data[key];
        out[key] = v && typeof v === 'object' && 'toMillis' in v ? v.toMillis() : v;
    }
    return out;
}
// ---------------------------------------------------------------------------
// Reconciliation — the check that makes the fixture trustworthy
// ---------------------------------------------------------------------------
/**
 * `balance == Σ deposits + Σ match ledger rows`, per account, read back from the
 * database after seeding. Feature 0002's T-205 does this across the whole
 * product; doing it here means the seeder cannot quietly ship a fixture that
 * fails it.
 */
async function reconcile(uids) {
    const movements = new Map();
    const matches = await db.collection(C.matches).get();
    for (const m of matches.docs) {
        const ledger = await m.ref.collection(SUB.ledger).get();
        for (const row of ledger.docs) {
            const uid = row.get('accountUid');
            movements.set(uid, (movements.get(uid) ?? 0) + row.get('amountCents'));
        }
    }
    const lines = [];
    let ok = true;
    for (const uid of uids) {
        const snap = await accountRef(uid).get();
        if (!snap.exists)
            continue;
        const deposits = await accountRef(uid).collection('deposits').get();
        const depositCents = deposits.docs.reduce((sum, d) => sum + d.get('amountCents'), 0);
        const movementCents = movements.get(uid) ?? 0;
        const expected = depositCents + movementCents;
        const actual = snap.get('balanceCents');
        if (expected !== actual) {
            ok = false;
            lines.push(`  FAIL ${uid}: balance ${actual}c, deposits ${depositCents}c + ledger ${movementCents}c = ${expected}c`);
        }
    }
    return { ok, lines };
}
// ---------------------------------------------------------------------------
async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.dump) {
        await dump();
        return;
    }
    // The live-project announcement and the --yes gate are in seedTarget.ts, which
    // has to run before the Admin SDK is imported. All that is left here is to say
    // what the fixture will be.
    console.log(opts.live
        ? `Target: LIVE. Fixture: seed ${opts.seed} — ${opts.accounts} accounts, ${opts.challenges} open challenges, 1 settled match`
        : `Target: emulator at ${process.env['FIRESTORE_EMULATOR_HOST']}`);
    const gameText = readFileSync(fileURLToPath(new URL('Backend/config/redline.game.json', REPO_ROOT)), 'utf8');
    const economyText = readFileSync(fileURLToPath(new URL('Backend/config/redline.economy.json', REPO_ROOT)), 'utf8');
    const { config, configHash } = parseGameConfig(gameText);
    // Read the ladder through parseEconomyConfig, never the raw JSON: the key
    // names are the rating layer's business and it validates that every amount is
    // a whole number of cents.
    const economy = parseEconomyConfig(economyText);
    const ladder = economy.money.stakesCents;
    const ttlSeconds = opts.challengeTtlSeconds ?? economy.money.challengeTtlSeconds;
    console.log(`Config: hash ${configHash}, ${config.lanes.length} lanes, ladder ${ladder.join('/')}c`);
    const rand = mulberry32(opts.seed);
    const nowMs = Date.now();
    // --- accounts ---------------------------------------------------------
    // Ratings spread either side of the initial rating so the matchmaker has a
    // band to widen through and new-player protection has a top decile to exclude.
    const accounts = [];
    for (let i = 0; i < opts.accounts; i++) {
        const spread = Math.floor((rand() - 0.5) * 900);
        accounts.push({
            uid: fixtureUid(opts.seed, i),
            rating: Math.max(economy.rating.floor, economy.rating.initial + spread),
            // A third of the population is still provisional, which is what makes
            // new-player protection observable in the lobby rather than theoretical.
            ratedMatches: i % 3 === 0 ? Math.floor(rand() * 4) : economy.rating.provisionalMatches + Math.floor(rand() * 40),
            topUpCents: ladder[ladder.length - 1] * 3,
        });
    }
    let created = 0;
    for (const acc of accounts) {
        if ((await seedAccount(acc, nowMs)) === 'created')
            created++;
    }
    console.log(`Accounts: ${accounts.length} in fixture, ${created} created, ${accounts.length - created} already present`);
    // --- open challenges --------------------------------------------------
    const posted = [];
    for (let i = 0; i < opts.challenges; i++) {
        const poster = accounts[i % accounts.length];
        const spec = {
            matchId: fixtureMatchId(rand),
            roadSeed: fixtureRoadSeed(rand),
            posterUid: poster.uid,
            // Walk the ladder so the lobby shows every rung, not one.
            stakeCents: ladder[i % ladder.length],
            ambitionTicks: 240 + Math.floor(rand() * 900),
        };
        const r = await seedOpenChallenge(spec, config, configHash, economy, ttlSeconds, nowMs);
        posted.push(`  ${spec.matchId}  ${String(spec.stakeCents).padStart(5)}c  ` +
            `poster ${spec.posterUid} rated ${poster.rating}  banked ${r.bankedScore} (${r.outcome})  [${r.status}]`);
    }
    console.log(`Open challenges (${opts.challenges}), TTL ${ttlSeconds}s:`);
    for (const line of posted)
        console.log(line);
    // --- one settled match ------------------------------------------------
    const settledSpec = {
        matchId: fixtureMatchId(rand),
        roadSeed: fixtureRoadSeed(rand),
        posterUid: accounts[0].uid,
        challengerUid: accounts[1].uid,
        stakeCents: ladder[1] ?? ladder[0],
        ambitionTicks: 600,
        challengerAmbitionTicks: 900,
    };
    const settled = await seedSettledMatch(settledSpec, config, configHash, economy, nowMs);
    console.log(`Settled match: ${settledSpec.matchId} ${settledSpec.stakeCents}c  ` +
        `poster ${settled.posterScore} vs challenger ${settled.challengerScore}  [${settled.status}]`);
    // --- reconciliation ---------------------------------------------------
    // The house is reconciled too: its balance is the sum of its rake rows, and a
    // rake that does not reconcile is money the product cannot account for.
    const uids = [...accounts.map((a) => a.uid), HOUSE_UID];
    const { ok, lines } = await reconcile(uids);
    if (!ok) {
        console.error('Reconciliation FAILED — a seeded balance does not equal its ledger rows:');
        for (const line of lines)
            console.error(line);
        process.exit(1);
    }
    console.log(`Reconciled: ${uids.length} accounts, balance == Σ deposits + Σ ledger rows.`);
}
main().then(() => process.exit(0), (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
//# sourceMappingURL=seed.js.map