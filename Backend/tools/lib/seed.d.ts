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
import './seedTarget.js';
//# sourceMappingURL=seed.d.ts.map