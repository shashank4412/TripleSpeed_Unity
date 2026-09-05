# REDLINE — submission

Asynchronous real-money 1v1 lane-runner. Two players stake the same amount and
drive the same seeded road. Score = distance × lane multiplier, and is worthless
until you reach the cashout lane; one collision zeroes it. The higher **banked**
score takes the pot.

See [`OVERVIEW.md`](OVERVIEW.md) for the short version with diagrams. This
file has the build & run commands for the current stack.

---

## 1. Build & run — the current (Firebase) stack

The backend is TypeScript Cloud Functions + Firestore + Remote Config +
Anonymous Auth (Firebase project **`attendance-91bdd`**, functions + Firestore
in **`asia-south1`**), deployed 2026-09-02. Setup and deploy notes are
written separately.

```bash
# --- Backend (from Backend/) ---
npm install                       # workspaces: sim-core-ts rating functions proof tools
npm run typecheck                 # tsc --noEmit, every workspace
npm test                          # vitest: vector parity, elo, settlement, matchmaker
npm run lint:money                # fails the build on a float on a money path
npm run proof                     # 2,000 players / 50,000 matches -> report + CSVs

firebase emulators:start --only auth,functions,firestore    # local
firebase deploy --only functions:redline,firestore:rules,firestore:indexes
node tools/lib/push-remote-config.mjs --publish             # redline_game + redline_economy

# --- Unity client (Editor must be closed for headless) ---
./Tools/unity-test EditMode       # 48 tests: vector parity, stepped-run, scene wiring
./Tools/unity-test PlayMode       # 5 tests: the online loop
./Tools/unity-build               # Android APK -> artifacts/

# --- Harnesses (Node CLIs; thin bash wrappers give the brief's exact paths) ---
./Tools/Solvability                                  # N seeds through the independent checker
./Tools/Solvability --config Backend/config/redline.game.5lane.json   # review test #16
./Tools/Replay <gameId>                              # fetch a match, re-simulate from its seed
./Tools/Simulate                                     # the fairness proof
./Tools/Hammer                                       # concurrent joins + settlements
./Tools/Rollback <gameId> --reason "..."             # compensating Firestore transaction
```

The Unity client talks to Firebase behind an `IRedlineBackend` seam; it falls
back to an offline **Practice** run when the backend is unreachable, and in the
Editor it uses an in-process loopback fake so the staked flow is testable
without the desktop Firebase SDK's known hangs.
