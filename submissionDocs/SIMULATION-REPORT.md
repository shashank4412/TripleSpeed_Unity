# REDLINE — fairness proof (submission headline)

**Run:** 2026-09-02 · `Backend/proof` (the **behavioural** arm — a bot that plays
every run through `@redline/sim-core`, the same core the server scores with,
against the **production** `Matchmaker`, `applyElo` and `settle` from
`@redline/rating`).
**Population:** 2,000 players, ~50,000 matches, seed `20260101`, game-config hash
`5088b8b1eac58908`.
**Two arms:** `control` = the target rating is shown to the challenger;
`treatment` = it is hidden (the shipped default, ADR 0009, Section 5).

Raw: [`artifacts/sim-output/report.txt`](../artifacts/sim-output/report.txt) and
the CSVs beside it. Reproduce: `cd Backend && npm run proof` (same seed + config
→ same numbers; the brief will run it). A longer write-up, including the history
of the two defects fixed since 2026-08-30, is written separately.

---

## 1. Rating convergence — Spearman(final rating, latent skill)

| | ρ | 95 % CI |
| --- | --- | --- |
| Treatment, all players (≥1 match), n=2000 | **+0.699** | [+0.676, +0.721] |
| **Seeding baseline** — Spearman(*starting* rating, latent skill) | **−0.026** | [−0.070, +0.018] |

The baseline is what the population generator hands the rating system for free.
It is ~0, so the +0.699 is **earned by match outcomes**, not inherited. (Before
the F-1 fix the generator drew latent skill *from* the starting rating, making
the baseline a circular +0.859 of a final +0.867 — that is fixed:
`population.ts` now draws skill from its own independent Normal.)

**How it improves over match count** — one population measured as it accumulates
matches (the trajectory, since this harness gives every player ~the same number
of matches so per-bucket cohorts are empty):

| matches settled | mean matches / player | ρ(rating, latent skill) |
| --- | --- | --- |
| 2,260 | 2.3 | +0.030 |
| 11,963 | 12.0 | +0.263 |
| 24,451 | 24.5 | +0.444 |
| 36,948 | 37.0 | +0.593 |
| 49,448 | 49.5 | **+0.699** |

Monotone, still rising at the end of the run — it has not plateaued at 50 matches/player.

## 2. Calibration — predicted vs observed poster win probability (treatment)

| predicted bucket | matches | mean pred | observed | error |
| --- | --- | --- | --- | --- |
| 0.3–0.4 | 2,663 | 0.361 | 0.441 | +0.080 |
| **0.4–0.5** | **19,490** | 0.472 | 0.474 | **+0.001** |
| **0.5–0.6** | **21,964** | 0.526 | 0.514 | **−0.012** |
| 0.6–0.7 | 2,660 | 0.639 | 0.568 | −0.071 |
| 0.8–0.9 | 287 | 0.842 | 0.554 | −0.288 |

Near-perfect where the mass is (the 0.4–0.6 band holds ~84 % of all matches).
The tails are miscalibrated and thin — under 300 matches per bucket past 0.8;
`calibration.csv` carries the counts. Honest read: the model predicts the
common case well and is unreliable at the extremes it rarely reaches.

## 3. Role neutrality (ADR 0009, Section 5, pre-registered)

Win rate, ties excluded:

| | poster win rate | n (decided) |
| --- | --- | --- |
| control (target visible) | 21.71 % | 45,637 |
| treatment (target hidden) | 49.64 % | 45,336 |

**Treatment poster − challenger: −0.72 pp, 95 % CI [−1.64, +0.20] pp.**

- Test A — gap under 1.0 pp: **HELD**
- Test B — 95 % CI contains zero: **HELD**
- The control arm (21.7 % vs ~78 %) shows the mitigation *matters*; treatment shows it *works*.

At equal rating (both ratings within 50 pts), poster win rate stays within
[47.8 %, 56.0 %] across every rating band 400–1799, CIs spanning 50 % in all but
the smallest (n=193) band.

## 4. Settlement integrity (defect F-8, fixed)

| | |
| --- | --- |
| settled matches | 49,448 |
| took a challenge posted by an earlier arrival | 45,722 (92.5 %) — normal |
| **settled a score that is NOT that challenge's banked score** | **0 (0.00 %)** |

The harness used to settle the arrival's run against the *creator's* rating/money
for whichever challenge the matchmaker picked — 91.07 % mismatched. It now
settles `chosen.bankedScore` directly (that challenge's own creator's own
recorded run), so this is a standing invariant check reading 0 by construction.

## 5. Economy & starvation

| | control | treatment |
| --- | --- | --- |
| matches settled | 49,342 | 49,448 |
| `post_own_challenge` (no fit / starvation) | 658 (1.3 %) | 552 (1.1 %) |
| abandoned (a side DNF) | 0 | 0 |
| tie frequency | 7.51 % | 8.32 % |
| rake collected | $19,736.80 | $19,779.20 |
| final rating p05 / p50 / p95 | 778 / 1194 / 1600 (treatment) | |
| provisional player-matches (first 10/player) | 20,000 (20.2 %); 0 players still provisional at end | |

Tie frequency 7–8 % (both-banked-equal + both-crashed). ADR 0003 (the rejected
full-refund proposal) is the pre-written reversal if this were ever judged "a
common bucket, not an edge case"; 8 % reads as an edge case.

## 6. Collusion exclusion (treatment)

| filter | rejections |
| --- | --- |
| outside rating band | 9,076,663 |
| new-player protection | 1,539,945 |
| same account | 12,494 |
| recent opponent | 1,284 |
| same payment instrument | 228 |
| same device | 42 |
| **known colluding pairs matched anyway (leaks)** | **0** (want 0) |

## 7. Planted anomalies (`Backend/config/seed.json`, treatment arm)

| | rating move | matches | thrown | identity flags | verdict |
| --- | --- | --- | --- | --- | --- |
| sandbagger | 1051 → 893 (min 871, sink target 900) | 48 | 24 | 0 | **MISSED** |
| smurf | 1200 → 1533 | 51 | — | 0 | **MISSED** |

Both are **behavioural** anomalies with no shared device / IP / payment
instrument with any other account. Production's only collusion detection is
identity-based exclusion, which by
construction cannot see a lone account that sinks its own rating or climbs fast.
The `identity flags: 0` above is the measured confirmation, not an assumption.
This is a legitimate false negative — **no behavioural detector was built** — and
it is reported, not hidden.

## 8. Brief Section 6.3 coverage

| # | Section 6.3 item | State |
| --- | --- | --- |
| 1 | Rating convergence + how it improves over match count | ✅ Section 1 |
| 2 | Calibration | ✅ Section 2 |
| 3 | Role neutrality | ✅ Section 3 |
| 6 | No rating inflation | ✅ — final-rating percentiles stable (Section 5); 0 players stuck provisional |
| — | Settlement integrity | ✅ Section 4 (F-8 fixed) |
| — | No collusion leaks | ✅ Section 6 |
| 4 | **Match quality** — rating-gap percentiles at the moment of matching | ❌ not produced |
| 5 | **Wait time** before a challenge is answered, incl. ladder extremes | ❌ not produced |
| 7 | **Economics by rating decile** (net $ per decile) | ❌ not produced |
| 8 | **New-player experience** — first-5 win rate and net $ for new accounts | ❌ not produced |
| 9 | **Anomaly false-positive rate** over 2,000 honest accounts | ❌ not computed — the planted pair is 2 of 2,000, not a rate |

**6 of 10 produced.** The four gaps are time cuts, named here and in the
longer write-up (Section 5); the anomaly section is honestly `MISSED`, not
rounded up.

## 9. Reproducibility

```bash
cd Backend && npm run proof     # -> report on stdout + CSVs
```

Fixed seed (`20260101`) and config hash (`5088b8b1eac58908`) → identical output.
The CSVs behind every table: `artifacts/sim-output/{run,convergence,calibration,role-neutrality,exclusions,spearman-by-matches,players,matches}.csv`.

## 10. What this report does not claim

- It is **one arm** — behavioural, not the statistical-sampling baseline (Section 6.2
  offered either; the bonus one was built and kept).
- The tail calibration (Section 2, buckets past 0.8) is thin and miscalibrated — do not
  quote it as a headline.
