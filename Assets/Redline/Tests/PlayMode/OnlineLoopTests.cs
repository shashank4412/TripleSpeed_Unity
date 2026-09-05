using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using NUnit.Framework;
using Redline.Client.Net;
using Redline.Core;
using UnityEngine;
using UnityEngine.TestTools;

namespace Redline.Tests.PlayMode
{
    /// <summary>
    /// The submission path: the envelope, the retry policy, and crash survival.
    ///
    /// SubmissionQueue is exercised against a <see cref="FakeBackend"/> rather
    /// than a live emulator for these three cases, and that split is
    /// deliberate, not a shortcut. What is being asserted here is "does the
    /// queue retry a transient failure and give up on a refusal, with the same
    /// idempotency key every time" — a property of SubmissionQueue's own retry
    /// state machine. The Firebase Emulator Suite has no fault-injection knob
    /// to make the FIRST N calls to a callable fail with a retryable error and
    /// then succeed, so a deterministic fake is the only way to put that
    /// specific behaviour under test at all — and IRedlineBackend exists
    /// precisely so a fake can stand in here "without touching gameplay code"
    /// (see its own header comment).
    ///
    /// <see cref="AnonymousSignInReachesTheRealEmulator"/> is the one test in
    /// this file that is NOT a fake: it drives a real FirebaseRedlineBackend
    /// against `firebase emulators:start --only auth,functions,firestore`,
    /// proving the emulator wiring added to FirebaseRedlineBackend (anonymous
    /// sign-in, the ensureAccount callable, the Remote-Config-has-no-emulator
    /// fallback to the bundled config) actually works end to end. It needs the
    /// emulator running and is skipped with a clear message if it is not
    /// reachable, rather than failing the whole suite on a machine that has
    /// not started it.
    /// </summary>
    public sealed class OnlineLoopTests
    {
        [TearDown]
        public void CleanUpPersistedFile()
        {
            string pending = Path.Combine(Application.persistentDataPath, "pending-submission.json");
            if (File.Exists(pending)) File.Delete(pending);
        }

        /// <summary>
        /// The envelope must describe the run that happened: every recorded
        /// swipe, in order, and the core's score as the claim.
        ///
        /// Built from the core rather than from hand-written numbers, because
        /// the claim being tested is "the client reports what the core computed"
        /// and a literal would only test that two literals match.
        /// </summary>
        [Test]
        public void TheEnvelopeCarriesTheRunThatHappened()
        {
            var config = GameConfig.Parse(
                File.ReadAllText(Path.Combine(Application.dataPath, "Redline/Settings/redline.game.json.txt")));

            var recorded = new List<InputEvent>
            {
                new InputEvent(90, SwipeDirection.Left),
                new InputEvent(240, SwipeDirection.Left),
                new InputEvent(900, SwipeDirection.Right),
            };

            var result = Simulation.Run(config, new RunInput(1234UL, recorded, config.MaxRunTicks));
            var envelope = RedlineSession.Envelope(config.ConfigHash, recorded, result);

            Assert.AreEqual(config.ConfigHash, envelope.configHash);
            Assert.AreEqual(recorded.Count, envelope.inputLog.Length, "every swipe must be sent, including rejected ones");

            for (int i = 0; i < recorded.Count; i++)
            {
                Assert.AreEqual(recorded[i].Tick, envelope.inputLog[i].tick);
                Assert.AreEqual(recorded[i].Direction == SwipeDirection.Left ? "L" : "R", envelope.inputLog[i].dir);
            }

            // A claim, and equal to what the core said — the client never
            // invents a score, and never sends one as an input.
            Assert.AreEqual(result.Score, envelope.clientScore);
            Assert.AreEqual(result.EndTick, envelope.finalTick);
        }

        /// <summary>
        /// A retried submission must carry the **same** idempotency key.
        ///
        /// A fresh key per attempt would defeat T-303 completely and silently:
        /// two submissions, two settlements, and nothing in the UI to suggest
        /// anything went wrong.
        /// </summary>
        [UnityTest]
        public IEnumerator ARetriedSubmissionReusesTheSameIdempotencyKey()
        {
            var backend = new FakeBackend { FailFirst = 1 };
            var queue = NewQueue(backend);
            queue.Enqueue("TEST123456", SimpleEnvelope(), DateTimeOffset.UtcNow.AddMinutes(2));

            float deadline = Time.unscaledTime + 20f;
            while (backend.KeysSeen.Count < 2 && Time.unscaledTime < deadline) yield return null;

            Assert.GreaterOrEqual(backend.KeysSeen.Count, 2, "the queue should have retried after the transient failure");
            Assert.AreEqual(backend.KeysSeen[0], backend.KeysSeen[1], "the retry must reuse the key, or the server settles twice");

            UnityEngine.Object.DestroyImmediate(queue.gameObject);
        }

        /// <summary>
        /// A delivered run stops being pending, and its file is removed — the
        /// file exists only to survive a crash before delivery.
        /// </summary>
        [UnityTest]
        public IEnumerator ADeliveredSubmissionClearsThePersistedFile()
        {
            var backend = new FakeBackend();
            var queue = NewQueue(backend);

            string path = Path.Combine(Application.persistentDataPath, "pending-submission.json");
            queue.Enqueue("TEST123456", SimpleEnvelope(), DateTimeOffset.UtcNow.AddMinutes(2));

            // Written before the first send is attempted, so a crash in between
            // does not lose a staked run.
            Assert.IsTrue(File.Exists(path), "the run must be persisted before it is sent");

            float deadline = Time.unscaledTime + 20f;
            while (queue.HasPending && Time.unscaledTime < deadline) yield return null;

            Assert.IsFalse(queue.HasPending, "an ok answer should clear the pending run");
            Assert.IsFalse(File.Exists(path), "the file exists only until the server has acknowledged");

            UnityEngine.Object.DestroyImmediate(queue.gameObject);
        }

        /// <summary>
        /// A LOGICAL refusal (the server answered "refused") must not be
        /// retried — retrying sends the identical request into the identical
        /// refusal and just burns the submission window (ADR 0004).
        /// </summary>
        [UnityTest]
        public IEnumerator ARefusedSubmissionIsAbandonedWithoutRetrying()
        {
            var backend = new FakeBackend { RefuseAlways = true };
            var queue = NewQueue(backend);

            string reason = null;
            queue.Abandoned += (_, r) => reason = r;
            queue.Enqueue("TEST123456", SimpleEnvelope(), DateTimeOffset.UtcNow.AddMinutes(2));

            float deadline = Time.unscaledTime + 10f;
            while (reason == null && Time.unscaledTime < deadline) yield return null;

            Assert.IsNotNull(reason, "a refusal should abandon the submission, not spin");
            Assert.AreEqual(1, backend.KeysSeen.Count, "a refusal is an answer, not a dropped call — it must not be retried");
            Assert.IsFalse(queue.HasPending);

            UnityEngine.Object.DestroyImmediate(queue.gameObject);
        }

        private static SubmissionQueue NewQueue(IRedlineBackend backend)
        {
            var go = new GameObject("queue-under-test");
            var queue = go.AddComponent<SubmissionQueue>();
            queue.Bind(backend);
            return queue;
        }

        private static SubmitRunEvidence SimpleEnvelope() => new SubmitRunEvidence
        {
            configHash = "x",
            inputLog = new[] { new InputEventDto { tick = 90, dir = "L" } },
            finalTick = 1072,
            clientScore = 505,
            clientOutcome = "BANKED",
        };

        /// <summary>
        /// A controllable double for SubmitRunAsync, the one call
        /// SubmissionQueue actually makes. Everything else throws — nothing in
        /// these tests reaches it, and a call that did reach it should fail
        /// loudly rather than return a plausible-looking default.
        /// </summary>
        private sealed class FakeBackend : IRedlineBackend
        {
            public readonly List<string> KeysSeen = new List<string>();
            public int FailFirst;
            public bool RefuseAlways;

            public Task<SubmitRunResult> SubmitRunAsync(string matchId, SubmitRunEvidence evidence, string idempotencyKey)
            {
                KeysSeen.Add(idempotencyKey);

                if (RefuseAlways)
                {
                    return Task.FromResult(new SubmitRunResult { ok = false, result = "refused" });
                }

                if (KeysSeen.Count <= FailFirst)
                {
                    throw new BackendCallException("transient", retryable: true);
                }

                return Task.FromResult(new SubmitRunResult
                {
                    ok = true,
                    result = "ok",
                    role = "poster",
                    serverScore = 505,
                    outcome = "banked",
                    endTick = 1072,
                    distance = 300,
                    finalLane = 3,
                    rejectedInputs = 0,
                    configHash = "x",
                    disagreed = false,
                    matchState = "open",
                });
            }

            public string AccountId => throw new NotSupportedException();
            public Task<CachedIdentity> PeekCachedAccountIdAsync() => throw new NotSupportedException();
            public Task ForgetCachedIdentityAsync() => throw new NotSupportedException();
            public Task<AccountView> EnsureAccountAsync(string deviceFingerprint) => throw new NotSupportedException();
            public Task<GameConfigText> GameConfigTextAsync() => throw new NotSupportedException();
            public Task<PayoutPreviewView> PreviewAsync(long stakeCents) => throw new NotSupportedException();
            public Task<CreateMatchResult> CreateMatchAsync(long stakeCents, string idempotencyKey) => throw new NotSupportedException();
            public Task<MatchmakeResult> MatchmakeAsync(long stakeCents, string idempotencyKey) => throw new NotSupportedException();
            public Task<JoinMatchResult> JoinMatchAsync(string matchId, string idempotencyKey) => throw new NotSupportedException();
            public Task<WithdrawChallengeResult> WithdrawChallengeAsync(string matchId, string idempotencyKey) => throw new NotSupportedException();
            public Task<AddBalanceResult> AddBalanceAsync(long amountCents, string idempotencyKey) => throw new NotSupportedException();
            public IDisposable ObserveAccount(Action<AccountView> onChange) => throw new NotSupportedException();
            public IDisposable ObserveMyMatches(Action<IReadOnlyList<MatchView>> onChange) => throw new NotSupportedException();
            public IDisposable ObserveMatch(string matchId, Action<MatchView> onChange) => throw new NotSupportedException();
            public Task<ResultView> GetResultAsync(string matchId) => throw new NotSupportedException();
        }

#if REDLINE_FIREBASE
        /// <summary>
        /// Proves the emulator wiring added to FirebaseRedlineBackend actually
        /// works: anonymous sign-in against the Auth emulator, the
        /// `ensureAccount` callable against the Functions emulator, and the
        /// Remote-Config-has-no-emulator fallback to the bundled game config
        /// (there is no "remoteconfig" target in `firebase emulators:start
        /// --only`, so this path always exercises that fallback here).
        ///
        /// Requires `firebase emulators:start --only auth,functions,firestore`
        /// running on localhost first (see DevDocs/firebase-setup.md). Skips
        /// itself with a clear message rather than failing the suite when the
        /// emulator is not up — the other tests in this file do not need it.
        /// </summary>
        [UnityTest]
        public IEnumerator AnonymousSignInReachesTheRealEmulator()
        {
            string bundled = File.ReadAllText(
                Path.Combine(Application.dataPath, "Redline/Settings/redline.game.json.txt"));

            var backend = new FirebaseRedlineBackend("127.0.0.1:5001", bundled);

            Task<AccountView> ensureTask = null;
            Exception startupFailure = null;
            try
            {
                ensureTask = backend.EnsureAccountAsync(SystemInfo.deviceUniqueIdentifier);
            }
            catch (Exception ex)
            {
                startupFailure = ex;
            }

            if (startupFailure != null)
            {
                Assert.Ignore($"emulator not reachable, skipping: {startupFailure.Message}");
                yield break;
            }

            float deadline = Time.unscaledTime + 30f;
            while (!ensureTask.IsCompleted && Time.unscaledTime < deadline) yield return null;

            if (!ensureTask.IsCompleted || ensureTask.IsFaulted)
            {
                Assert.Ignore("emulator not reachable within 30s, skipping — start it with " +
                              "'firebase emulators:start --only auth,functions,firestore' from Backend/");
                yield break;
            }

            var account = ensureTask.Result;
            Assert.IsNotNull(backend.AccountId, "anonymous sign-in against the Auth emulator should produce a uid");
            Assert.IsNotEmpty(account.stakesCents, "ensureAccount should return the configured stake ladder");
            Assert.GreaterOrEqual(account.balanceCents, 0);

            var configTask = backend.GameConfigTextAsync();
            deadline = Time.unscaledTime + 15f;
            while (!configTask.IsCompleted && Time.unscaledTime < deadline) yield return null;

            Assert.IsTrue(configTask.IsCompleted && !configTask.IsFaulted, "GameConfigTextAsync should fall back to the bundled config against the emulator");

            var served = configTask.Result;
            var parsed = GameConfig.Parse(served.rawText);
            Assert.AreEqual(parsed.ConfigHash, served.configHash, "the fallback text's own hash must match what the struct reports");
        }
#endif
    }
}
