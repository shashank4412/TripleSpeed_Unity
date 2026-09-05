// The Firebase implementation of IRedlineBackend.
//
// Guarded by the REDLINE_FIREBASE scripting define. The Firebase Unity SDK
// (Auth, Firestore, Functions, RemoteConfig) is under Assets/Firebase/ —
// gitignored; re-import with `./Tools/import-firebase-sdk` on a fresh clone.
// BuildScript adds REDLINE_FIREBASE to both APK variants. google-services.json
// for com.DefaultCompany.Test lives in Assets/Firebase/ (SDK convention).
//
// When the define is off, a stub throws a clear message so a mis-wired build
// fails loudly instead of silently doing nothing.
//
// No JSON library: callable results arrive as nested IDictionary<string,object>
// and are read field by field, which also keeps money as long (integer cents)
// with no float ever in the path.

using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Redline.Client.Net
{
#if REDLINE_FIREBASE
    using Firebase;
    using Firebase.Auth;
    using Firebase.Functions;
    using Firebase.Firestore;
    using Firebase.RemoteConfig;

    public sealed class FirebaseRedlineBackend : IRedlineBackend
    {
        private const string Region = "asia-south1";

        /// <summary>
        /// How stale a cached Remote Config may be before a fetch goes to the
        /// network. **This is a demo-build setting and it is deliberate.**
        ///
        /// The Firebase client SDK's default is twelve hours. Two of the sixteen
        /// review tests are live config changes (#12 matchmaking parameter, #16
        /// lane count 4 to 5) — with the default, the reviewer publishes, the
        /// Cloud Functions pick it up, the phone does not, and what they see is
        /// a config change that did not work. Five seconds is short enough that
        /// a Publish lands before anyone finishes explaining it.
        ///
        /// It is NOT a shippable value: Remote Config throttles fetches
        /// server-side (roughly five per hour per app instance in production),
        /// so a build that fetches every five seconds spends most of its life
        /// throttled. A shipping build would use hours. If this ever becomes a
        /// real product, this constant is the thing to change, and the honest
        /// version of that change is a build flag, not a smaller number.
        ///
        /// Previously this was <c>TimeSpan.Zero</c> — fetch every single call,
        /// which is the same trap one step further along.
        /// </summary>
        private static readonly TimeSpan DemoFetchInterval = TimeSpan.FromSeconds(5);

#if UNITY_EDITOR
        // Remote Config's FetchAsync / ActivateAsync routinely return Tasks that
        // never complete in the Editor (Firebase desktop SDK limitation — the
        // native completion callback is not pumped for RC on macOS Editor).
        // GetValue() still returns the cached remote value, so on a timeout we
        // proceed with what Remote Config already has instead of hanging
        // startup forever. Device builds await these normally.
        private const int RemoteConfigEditorTimeoutMs = 4000;
#endif

        /// <summary>
        /// The config actually in force on this device, for the lobby to show.
        ///
        /// Without it, "did the change land on the phone?" is answered by
        /// watching behaviour and guessing. `null` until the first successful
        /// fetch-and-activate; the lobby renders that state rather than an
        /// empty string, because "we do not know" and "unchanged" are different
        /// answers and only one of them is a reason to stop the demo.
        /// </summary>
        public string ActiveConfigHash { get; private set; }

        /// <summary>Wall-clock of the last successful Remote Config fetch, or null.</summary>
        public DateTime? LastConfigFetchUtc { get; private set; }

        /// <summary>
        /// Non-null when the last fetch did not reach the network — throttled,
        /// offline, or refused.
        ///
        /// The previous code awaited FetchAsync and then called ActivateAsync
        /// without ever looking at <c>Info.LastFetchStatus</c>, so a throttled
        /// fetch silently activated the config already in the cache. That is
        /// indistinguishable, on screen, from a config change that did not
        /// happen — during the one demo where the difference matters. Surfacing
        /// it is not the same as hiding behind a bundled fallback, which the
        /// task forbids: this reports the failure, it does not paper over it.
        /// </summary>
        public string LastConfigFetchError { get; private set; }

        /// <summary>
        /// Fetch and activate, then record what actually happened.
        /// </summary>
        private async Task RefreshRemoteConfigAsync(FirebaseApp app)
        {
            var rc = FirebaseRemoteConfig.GetInstance(app);
            try
            {
#if UNITY_EDITOR
                bool completed = await AwaitOrTimeout(rc.FetchAsync(DemoFetchInterval), RemoteConfigEditorTimeoutMs)
                                 && await AwaitOrTimeout(rc.ActivateAsync(), RemoteConfigEditorTimeoutMs);
#else
                await rc.FetchAsync(DemoFetchInterval);
                await rc.ActivateAsync();
                const bool completed = true;
#endif

                if (!completed)
                {
                    // Editor only: the async calls stalled. GetValue below still
                    // returns the cached remote value, so startup continues.
                    LastConfigFetchError = "remote config fetch/activate did not complete (Editor) — using the cached value";
                }
                else if (rc.Info.LastFetchStatus == LastFetchStatus.Success)
                {
                    LastConfigFetchError = null;
                    LastConfigFetchUtc = DateTime.UtcNow;
                }
                else
                {
                    LastConfigFetchError = $"fetch {rc.Info.LastFetchStatus} ({rc.Info.LastFetchFailureReason})";
                }

                string raw = rc.GetValue("redline_game").StringValue;
                if (!string.IsNullOrEmpty(raw))
                    ActiveConfigHash = Redline.Core.GameConfig.Parse(raw).ConfigHash;
            }
            catch (Exception ex)
            {
                LastConfigFetchError = ex.Message;
            }
        }

#if UNITY_EDITOR
        /// <summary>
        /// Awaits <paramref name="task"/>, or gives up after <paramref name="ms"/>
        /// and returns false (leaving the task to finish or hang on its own —
        /// harmless, nothing else awaits it). Editor-only: it exists solely to
        /// stop a never-completing Remote Config call from blocking startup.
        /// </summary>
        private static async Task<bool> AwaitOrTimeout(Task task, int ms)
        {
            if (await Task.WhenAny(task, Task.Delay(ms)) != task) return false;
            await task;   // observe any exception on the completed path
            return true;
        }
#endif

        private FirebaseAuth _auth;
        private FirebaseFunctions _functions;
        private FirebaseFirestore _db;

        /// <summary>
        /// "host:port" of a local Firebase Emulator Suite (e.g. "127.0.0.1:5001"),
        /// or null for the real project. RedlineSession resolves this the same
        /// way it used to resolve the old REST base URL — see
        /// <c>ResolveEmulatorHostPort</c> there.
        /// </summary>
        private readonly string _emulatorHostPort;

        /// <summary>
        /// Bundled <c>redline.game.json.txt</c> text, used ONLY as the "server"
        /// config when <see cref="_emulatorHostPort"/> is set and Remote Config
        /// — which the Firebase Emulator Suite cannot emulate at all; there is
        /// no "remoteconfig" entry in `firebase emulators:start --only` — comes
        /// back empty. The Cloud Functions emulator falls back to the byte-
        /// identical <c>Backend/functions/config/redline.game.json</c> in that
        /// same situation (see shared/config.ts), so this mirrors the server's
        /// own fallback rather than inventing a separate one. Never consulted
        /// against a real project: a release build passes null here.
        /// </summary>
        private readonly string _localConfigFallback;

        public FirebaseRedlineBackend(string emulatorHostPort = null, string localConfigFallback = null)
        {
            _emulatorHostPort = emulatorHostPort;
            _localConfigFallback = localConfigFallback;
        }

        private bool _emulatorWired;

        /// <summary>
        /// Points Auth/Firestore/Functions at the local emulator suite, once.
        /// Ports match Backend/firebase.json (auth 9099, firestore 8080); only
        /// the functions port is read from <see cref="_emulatorHostPort"/>
        /// since that is the one BuildScript already bakes for a debug APK to
        /// reach a LAN emulator (DevDocs/firebase-setup.md step 7).
        /// </summary>
        private void WireEmulatorIfNeeded(FirebaseApp app)
        {
            if (_emulatorWired || string.IsNullOrEmpty(_emulatorHostPort)) return;
            _emulatorWired = true;

            string host = _emulatorHostPort;
            int colon = host.IndexOf(':');
            if (colon >= 0) host = host.Substring(0, colon);

            FirebaseAuth.GetAuth(app).UseEmulator(host, 9099);

            var db = FirebaseFirestore.GetInstance(app);
            db.Settings.Host = $"{host}:8080";
            db.Settings.SslEnabled = false;
            db.Settings.PersistenceEnabled = false;

            FirebaseFunctions.GetInstance(app, Region).UseFunctionsEmulator($"http://{_emulatorHostPort}");
        }

        public string AccountId => _auth?.CurrentUser?.UserId;

        /// <summary>
        /// The persisted anonymous identity, if the Firebase SDK restored one
        /// from a previous launch, plus whether its token still refreshes
        /// against Firebase (i.e. the user is not disabled/deleted and the
        /// device is online). Does not sign in — <see cref="EnsureAccountAsync"/>
        /// is still what creates an identity. On a cold start the SDK populates
        /// <c>CurrentUser</c> from disk a beat after Auth initialises, so this
        /// polls briefly before concluding "none". Any failure is swallowed and
        /// reported as a null id: the Authentication screen shows the "fresh"
        /// state, and the subsequent sign-in reuses the cached credential anyway
        /// if there is one, so no wrong identity is created.
        /// </summary>
        public async Task<CachedIdentity> PeekCachedAccountIdAsync()
        {
            try
            {
                var app = FirebaseApp.DefaultInstance;
                WireEmulatorIfNeeded(app);
                _auth = FirebaseAuth.GetAuth(app);

                for (int i = 0; i < 10 && _auth.CurrentUser == null; i++)
                    await Task.Delay(50);

                var user = _auth.CurrentUser;
                if (user == null) return new CachedIdentity { accountId = null, backendActive = false };

                // Force-refresh the ID token: this round-trips Firebase's secure
                // token server and throws if the user was disabled or deleted,
                // or if we are offline. Bounded so a stalled call reports
                // "inactive" instead of hanging the auth screen.
                bool active = false;
                try
                {
                    var tokenTask = user.TokenAsync(true);
                    if (await Task.WhenAny(tokenTask, Task.Delay(4000)) == tokenTask && !tokenTask.IsFaulted)
                        active = true;
                }
                catch (Exception ex)
                {
                    UnityEngine.Debug.LogWarning($"[redline] cached uid token refresh failed (inactive/offline): {ex.Message}");
                }

                return new CachedIdentity { accountId = user.UserId, backendActive = active };
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogWarning($"[redline] cached-uid peek failed, treating as a fresh install: {ex.Message}");
                return new CachedIdentity { accountId = null, backendActive = false };
            }
        }

        /// <summary>
        /// Sign the cached anonymous user out so the next
        /// <see cref="EnsureAccountAsync"/> creates a fresh one. Local: it does
        /// not touch the old user on the backend.
        /// </summary>
        public Task ForgetCachedIdentityAsync()
        {
            try
            {
                var app = FirebaseApp.DefaultInstance;
                WireEmulatorIfNeeded(app);
                FirebaseAuth.GetAuth(app).SignOut();
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogWarning($"[redline] sign-out before new identity failed: {ex.Message}");
            }
            return Task.CompletedTask;
        }

        public async Task<AccountView> EnsureAccountAsync(string deviceFingerprint)
        {
            var app = FirebaseApp.DefaultInstance;
            WireEmulatorIfNeeded(app);

            _auth = FirebaseAuth.GetAuth(app);
            _functions = FirebaseFunctions.GetInstance(app, Region);
            _db = FirebaseFirestore.GetInstance(app);

            if (_auth.CurrentUser == null)
                await _auth.SignInAnonymouslyAsync();

            await RefreshRemoteConfigAsync(app);

            var d = await Call("ensureAccount", new Dictionary<string, object>
            {
                ["deviceFingerprint"] = deviceFingerprint ?? string.Empty,
            });

            return new AccountView
            {
                accountId = AccountId,
                displayName = Str(d, "displayName"),
                rating = (int)Lng(d, "rating"),
                ratedMatches = (int)Lng(d, "ratedMatches"),
                provisional = Bool(d, "provisional"),
                league = (int)Lng(d, "league"),
                leagueCount = (int)Lng(d, "leagueCount"),
                balanceCents = Lng(d, "balanceCents"),
                stakesCents = LngArray(d, "stakesCents"),
            };
        }

        public async Task<GameConfigText> GameConfigTextAsync()
        {
            var app = FirebaseApp.DefaultInstance;
            WireEmulatorIfNeeded(app);
            await RefreshRemoteConfigAsync(app);

            string raw = FirebaseRemoteConfig.GetInstance(app).GetValue("redline_game").StringValue;

            if (string.IsNullOrEmpty(raw) && !string.IsNullOrEmpty(_emulatorHostPort) && !string.IsNullOrEmpty(_localConfigFallback))
            {
                // Remote Config has no local emulator — `firebase emulators:start
                // --only` does not even list "remoteconfig" as a valid target —
                // so against the emulator it will always come back empty here.
                // The Cloud Functions emulator does not treat that as fatal: it
                // falls back to the file bundled with the function (shared/
                // config.ts), so falling back to the client's OWN bundled copy
                // is the same recovery, not a weaker one. This branch can only
                // run when RedlineSession resolved an explicit emulator host —
                // a release build never passes one, so this never fires against
                // production.
                raw = _localConfigFallback;
            }

            if (string.IsNullOrEmpty(raw))
            {
                // No bundled fallback here on purpose. A client that silently
                // substitutes its own rules is a client that demos a config
                // change which did not land, and then scores a run under rules
                // the server will reject at submit.
                throw new InvalidOperationException(
                    "Remote Config returned no redline_game value" +
                    (LastConfigFetchError == null ? "." : $": {LastConfigFetchError}"));
            }
            return new GameConfigText { rawText = raw, configHash = Redline.Core.GameConfig.Parse(raw).ConfigHash };
        }

        public async Task<PayoutPreviewView> PreviewAsync(long stakeCents)
        {
            var d = await Call("preview", new Dictionary<string, object> { ["stakeCents"] = stakeCents });
            return new PayoutPreviewView
            {
                stakeCents = Lng(d, "stakeCents"),
                potCents = Lng(d, "potCents"),
                rakeCents = Lng(d, "rakeCents"),
                winCents = Lng(d, "winCents"),
                tiePosterCents = Lng(d, "tiePosterCents"),
                tieChallengerCents = Lng(d, "tieChallengerCents"),
            };
        }

        public async Task<AddBalanceResult> AddBalanceAsync(long amountCents, string idempotencyKey)
        {
            var d = await Call("addBalance", new Dictionary<string, object>
            {
                ["amountCents"] = amountCents,
                ["idempotencyKey"] = idempotencyKey,
            });
            return new AddBalanceResult
            {
                ok = Bool(d, "ok"),
                creditedCents = Lng(d, "credited"),
                balanceCents = Lng(d, "balanceCents"),
                capped = Bool(d, "capped"),
                maxBalanceCents = Lng(d, "maxBalanceCents"),
            };
        }

        public async Task<CreateMatchResult> CreateMatchAsync(long stakeCents, string idempotencyKey)
        {
            var d = await Call("createMatch", new Dictionary<string, object>
            {
                ["stakeCents"] = stakeCents,
                ["idempotencyKey"] = idempotencyKey,
            });
            return new CreateMatchResult
            {
                result = Str(d, "result"),
                ok = Str(d, "result") == "ok",
                matchId = Str(d, "matchId"),
                stakeCents = Lng(d, "stakeCents"),
                seed = Seed(d, "seed"),
                configHash = Str(d, "configHash"),
                balanceCents = Lng(d, "balanceCents"),
                requiredCents = Lng(d, "requiredCents"),
            };
        }

        /// <summary>
        /// Selecting is read-only; the fallback is not. When the pool is
        /// empty even at the widened band cap the server posts a challenge
        /// FOR the caller in this same call (decision #11) — so this always
        /// sends the idempotencyKey a money-moving call needs, even though it
        /// is only spent on the "posted" branch.
        /// </summary>
        public async Task<MatchmakeResult> MatchmakeAsync(long stakeCents, string idempotencyKey)
        {
            var d = await Call("matchmake", new Dictionary<string, object>
            {
                ["stakeCents"] = stakeCents,
                ["idempotencyKey"] = idempotencyKey,
            });
            var result = new MatchmakeResult
            {
                outcome = Str(d, "outcome"),
                considered = (int)Lng(d, "considered"),
            };
            if (d.TryGetValue("offer", out var o) && o is IDictionary<string, object> offer)
            {
                result.hasOffer = true;
                result.offer = new MatchmakeOfferView
                {
                    matchId = Str(offer, "matchId"),
                    stakeCents = Lng(offer, "stakeCents"),
                    targetHidden = Bool(offer, "targetHidden"),
                    targetScore = offer.TryGetValue("targetScore", out var ts) && ts != null ? Convert.ToInt64(ts) : 0,
                    creatorRating = (int)Lng(offer, "creatorRating"),
                    creatorProvisional = Bool(offer, "creatorProvisional"),
                };
            }
            if (d.TryGetValue("posted", out var p) && p is IDictionary<string, object> posted)
            {
                result.hasPosted = true;
                result.posted = new CreateMatchResult
                {
                    result = "ok",
                    ok = true,
                    matchId = Str(posted, "matchId"),
                    stakeCents = Lng(posted, "stakeCents"),
                    seed = Seed(posted, "seed"),
                    configHash = Str(posted, "configHash"),
                    balanceCents = Lng(posted, "balanceCents"),
                };
            }
            return result;
        }

        public async Task<JoinMatchResult> JoinMatchAsync(string matchId, string idempotencyKey)
        {
            var d = await Call("joinMatch", new Dictionary<string, object>
            {
                ["matchId"] = matchId,
                ["idempotencyKey"] = idempotencyKey,
            });
            return new JoinMatchResult
            {
                result = Str(d, "result"),
                ok = Str(d, "result") == "ok",
                matchId = Str(d, "matchId"),
                stakeCents = Lng(d, "stakeCents"),
                seed = Seed(d, "seed"),
                configHash = Str(d, "configHash"),
                balanceCents = Lng(d, "balanceCents"),
            };
        }

        public async Task<WithdrawChallengeResult> WithdrawChallengeAsync(string matchId, string idempotencyKey)
        {
            var d = await Call("withdrawChallenge", new Dictionary<string, object>
            {
                ["matchId"] = matchId,
                ["idempotencyKey"] = idempotencyKey,
            });
            string result = Str(d, "result");
            return new WithdrawChallengeResult
            {
                result = result,
                // Anything but a transport error means no stake is stuck: it was
                // returned ("withdrawn"), already returned ("already_expired"),
                // or the challenge is a live match now ("already_answered").
                ok = result is "withdrawn" or "already_answered" or "already_expired"
                    or "already_settled" or "already_rolledBack",
                balanceCents = Lng(d, "balanceCents"),
            };
        }

        public async Task<SubmitRunResult> SubmitRunAsync(string matchId, SubmitRunEvidence e, string idempotencyKey)
        {
            var tokens = new List<string>(e.inputLog.Length);
            foreach (var ev in e.inputLog) tokens.Add($"{ev.tick}{ev.dir}");

            var d = await Call("submitRun", new Dictionary<string, object>
            {
                ["matchId"] = matchId,
                ["inputLog"] = string.Join(",", tokens),
                ["clientScore"] = e.clientScore,
                ["clientOutcome"] = e.clientOutcome ?? string.Empty,
                ["finalTick"] = e.finalTick,
                ["configHash"] = e.configHash,
                ["idempotencyKey"] = idempotencyKey,
            });
            return new SubmitRunResult
            {
                result = Str(d, "result"),
                ok = Str(d, "result") == "ok",
                role = Str(d, "role"),
                serverScore = Lng(d, "serverScore"),
                outcome = Str(d, "outcome"),
                endTick = (int)Lng(d, "endTick"),
                distance = Lng(d, "distance"),
                finalLane = (int)Lng(d, "finalLane"),
                rejectedInputs = (int)Lng(d, "rejectedInputs"),
                configHash = Str(d, "configHash"),
                disagreed = Bool(d, "disagreed"),

                // submitRun.ts returns the match's new lifecycle state as
                // "state", not "matchState" — this was reading the wrong key
                // and matchState was silently always null.
                matchState = Str(d, "state"),
            };
        }

        public IDisposable ObserveAccount(Action<AccountView> onChange)
        {
            var reg = _db.Collection("redline_accounts").Document(AccountId).Listen(snap =>
            {
                if (!snap.Exists) return;
                var x = snap.ToDictionary();
                onChange(new AccountView
                {
                    accountId = AccountId,
                    displayName = DictStr(x, "displayName"),
                    rating = (int)DictLng(x, "rating"),
                    ratedMatches = (int)DictLng(x, "ratedMatches"),
                    balanceCents = DictLng(x, "balanceCents"),
                });
            });
            return new ListenerHandle(reg);
        }

        public IDisposable ObserveMyMatches(Action<IReadOnlyList<MatchView>> onChange)
        {
            var mine = new Dictionary<string, MatchView>();
            void Push() => onChange(new List<MatchView>(mine.Values));

            ListenerRegistration Make(string field) =>
                _db.Collection("redline_matches").WhereEqualTo(field, AccountId).Listen(qs =>
                {
                    foreach (var c in qs.GetChanges())
                    {
                        var v = ToMatchView(c.Document, AccountId);
                        mine[v.matchId] = v;
                    }
                    Push();
                });

            return new ListenerHandle(Make("posterUid"), Make("challengerUid"));
        }

        public IDisposable ObserveMatch(string matchId, Action<MatchView> onChange)
        {
            var reg = _db.Collection("redline_matches").Document(matchId)
                .Listen(snap => { if (snap.Exists) onChange(ToMatchView(snap, AccountId)); });
            return new ListenerHandle(reg);
        }

        public async Task<ResultView> GetResultAsync(string matchId)
        {
            var snap = await _db.Collection("redline_matches").Document(matchId)
                .Collection("result").Document(AccountId).GetSnapshotAsync();
            if (!snap.Exists) return default;
            var x = snap.ToDictionary();
            return new ResultView
            {
                yourScore = DictLng(x, "score"),

                // "result" here is won/lost/draw (Firestore rules deny reading
                // the opponent's own result/{uid} doc, so settleMatch mirrors
                // their score/outcome and the win/lose/draw verdict onto THIS
                // side's doc — see ResultDoc.opponentScore). "outcome" is the
                // run outcome (banked/crashed/abandoned); ResultView has no
                // field for it, matching what the old wire shape carried.
                opponentScore = DictLng(x, "opponentScore"),
                result = DictStr(x, "result"),
                potCents = DictLng(x, "potCents"),
                rakeCents = DictLng(x, "rakeCents"),
                creditedCents = DictLng(x, "creditedCents"),
                netCents = DictLng(x, "netCents"),
                ratingBefore = (int)DictLng(x, "ratingBefore"),
                ratingAfter = (int)DictLng(x, "ratingAfter"),
                ratingDelta = (int)DictLng(x, "ratingDelta"),
            };
        }

        // ---- plumbing ----

        /// <summary>
        /// The one seam every callable goes through, so retryability is decided
        /// here once rather than at each of the eight call sites above.
        ///
        /// <see cref="SubmissionQueue"/> needs to tell "the network dropped, try
        /// again" from "the server understood and said no" apart, but it must
        /// not know about <c>Firebase.Functions</c> — that would defeat the
        /// point of <see cref="IRedlineBackend"/>. So a <c>FunctionsException</c>
        /// is translated into the engine-agnostic <see cref="BackendCallException"/>
        /// here, using the same UNAVAILABLE/DEADLINE_EXCEEDED/etc. guidance the
        /// gRPC status codes document. A raw exception that never reached a
        /// function at all (no connection) is always retryable — the call did
        /// not happen, so nothing about the server's answer is at stake.
        /// </summary>
        // Longer than a gen-2 cold start plus submitRun's re-simulation, shorter
        // than the 180s match window so a stalled submit still has room to
        // retry before it forfeits.
        private const int CallTimeoutMs = 30_000;

        private async Task<IDictionary<string, object>> Call(string name, Dictionary<string, object> data)
        {
            HttpsCallableResult result;
            try
            {
                var call = _functions.GetHttpsCallable(name).CallAsync(data);

                // A callable whose Task never completes — the app was paused
                // mid-flight and the Firebase SDK's main-thread pump stopped, so
                // the native completion callback landed in a halted loop and the
                // continuation is orphaned — must not wedge the caller forever.
                // SubmissionQueue in particular then sits in this await with
                // _sending == true and stops re-checking its abandon deadline.
                // Treat a stall as a transport failure: the retry is safe
                // because every money-moving callable carries an idempotency key
                // and the server returns the stored response on a replay
                // (submitRun.ts) rather than acting twice.
                if (await Task.WhenAny(call, Task.Delay(CallTimeoutMs)) != call)
                    throw new BackendCallException(
                        $"{name} did not respond within {CallTimeoutMs / 1000}s.", retryable: true);

                result = await call;   // completed — observe its value or its exception
            }
            catch (FunctionsException fx)
            {
                throw new BackendCallException(fx.Message, IsRetryable(fx.ErrorCode), fx);
            }
            catch (Exception ex) when (ex is not BackendCallException)
            {
                throw new BackendCallException(ex.Message, retryable: true, ex);
            }
            return result.Data as IDictionary<string, object> ?? new Dictionary<string, object>();
        }

        /// <summary>
        /// Same client/server split RedlineApi used to make over HTTP status:
        /// a 5xx-equivalent (the service itself failed) or a timeout is worth
        /// retrying; a 4xx-equivalent (bad argument, refused, not found) is the
        /// server's considered answer and retrying sends the identical refusal.
        /// </summary>
        private static bool IsRetryable(FunctionsErrorCode code) => code switch
        {
            FunctionsErrorCode.Unavailable => true,
            FunctionsErrorCode.DeadlineExceeded => true,
            FunctionsErrorCode.Internal => true,
            FunctionsErrorCode.Unknown => true,
            FunctionsErrorCode.ResourceExhausted => true,
            FunctionsErrorCode.Aborted => true,
            _ => false,
        };

        private static string Str(IDictionary<string, object> m, string k) =>
            m != null && m.TryGetValue(k, out var v) && v != null ? v.ToString() : null;

        private static long Lng(IDictionary<string, object> m, string k) =>
            m != null && m.TryGetValue(k, out var v) && v != null ? Convert.ToInt64(v) : 0L;

        private static bool Bool(IDictionary<string, object> m, string k) =>
            m != null && m.TryGetValue(k, out var v) && v is bool b && b;

        private static long[] LngArray(IDictionary<string, object> m, string k)
        {
            if (m == null || !m.TryGetValue(k, out var v) || v is not System.Collections.IEnumerable e) return Array.Empty<long>();
            var list = new List<long>();
            foreach (var item in e) if (item != null) list.Add(Convert.ToInt64(item));
            return list.ToArray();
        }

        private static ulong Seed(IDictionary<string, object> m, string k) =>
            m != null && m.TryGetValue(k, out var v) && v != null && ulong.TryParse(v.ToString(), out var s) ? s : 0UL;

        private static string DictStr(Dictionary<string, object> x, string k) =>
            x != null && x.TryGetValue(k, out var v) && v != null ? v.ToString() : null;

        private static long DictLng(Dictionary<string, object> x, string k) =>
            x != null && x.TryGetValue(k, out var v) && v != null ? Convert.ToInt64(v) : 0L;

        /// <summary>
        /// Builds the lobby's view of one match doc.
        ///
        /// `role` is derived client-side from posterUid/challengerUid — both
        /// are on the doc and readable by either party, so this needs no extra
        /// read. `waiting` is coarser than the retired REST server's version:
        /// that one also knew whether the OTHER side had submitted, which lived
        /// server-side; here, Firestore rules deny reading anyone's
        /// submissions/{uid} but their own (see firestore.rules), so "opponent
        /// is playing" and "opponent hasn't started" are indistinguishable from
        /// this doc alone and both fold into "waiting on your opponent". `you`/
        /// `opponent` are left at their zero value here for the same reason —
        /// ResultScreen is where the authoritative per-side detail is shown,
        /// via GetResultAsync, once the match is actually settled.
        /// </summary>
        private static MatchView ToMatchView(DocumentSnapshot snap, string myAccountId)
        {
            var x = snap.ToDictionary();
            string state = DictStr(x, "state") ?? "created";
            string posterUid = DictStr(x, "posterUid");
            string challengerUid = DictStr(x, "challengerUid");
            string role = myAccountId == posterUid ? "poster" : myAccountId == challengerUid ? "challenger" : null;

            string waiting = state switch
            {
                "created" => role == "poster" ? "your_run" : "opponent_to_play",
                "open" => "opponent_to_join",
                "answered" => "opponent_playing",
                "settled" => "settled",
                "expired" => "expired",
                "rolledBack" => "rolled_back",
                _ => state,
            };

            return new MatchView
            {
                matchId = snap.Id,
                stakeCents = DictLng(x, "stakeCents"),
                state = state,
                role = role,
                waiting = waiting,
                settled = state == "settled" || state == "rolledBack",
            };
        }

        private sealed class ListenerHandle : IDisposable
        {
            private readonly ListenerRegistration[] _regs;
            public ListenerHandle(params ListenerRegistration[] regs) => _regs = regs;
            public void Dispose() { foreach (var r in _regs) r?.Stop(); }
        }
    }
#else
    /// <summary>
    /// Compiled when the Firebase Unity SDK is not present / REDLINE_FIREBASE is
    /// unset. Every call fails loudly.
    /// </summary>
    public sealed class FirebaseRedlineBackend : IRedlineBackend
    {
        private const string Msg =
            "Firebase backend not compiled. Import the Firebase Unity SDK (./Tools/import-firebase-sdk) " +
            "and set the REDLINE_FIREBASE scripting define — see DevDocs/firebase-setup.md.";

        // Same constructor shape as the real implementation so RedlineSession
        // compiles under either define; the arguments are meaningless here
        // since every call throws anyway.
        public FirebaseRedlineBackend(string emulatorHostPort = null, string localConfigFallback = null) { }

        public string AccountId => null;

        public Task<CachedIdentity> PeekCachedAccountIdAsync() =>
            Task.FromResult(new CachedIdentity { accountId = null, backendActive = false });

        public Task ForgetCachedIdentityAsync() => Task.CompletedTask;

        // Same shape as the real implementation so the lobby's config-version
        // line compiles under either define. Nothing was fetched, and the
        // corner line says exactly that rather than showing a blank.
        public string ActiveConfigHash => null;
        public DateTime? LastConfigFetchUtc => null;
        public string LastConfigFetchError => Msg;

        public Task<AccountView> EnsureAccountAsync(string deviceFingerprint) => throw new NotSupportedException(Msg);
        public Task<GameConfigText> GameConfigTextAsync() => throw new NotSupportedException(Msg);
        public Task<PayoutPreviewView> PreviewAsync(long stakeCents) => throw new NotSupportedException(Msg);
        public Task<CreateMatchResult> CreateMatchAsync(long stakeCents, string idempotencyKey) => throw new NotSupportedException(Msg);
        public Task<MatchmakeResult> MatchmakeAsync(long stakeCents, string idempotencyKey) => throw new NotSupportedException(Msg);
        public Task<JoinMatchResult> JoinMatchAsync(string matchId, string idempotencyKey) => throw new NotSupportedException(Msg);
        public Task<WithdrawChallengeResult> WithdrawChallengeAsync(string matchId, string idempotencyKey) => throw new NotSupportedException(Msg);
        public Task<SubmitRunResult> SubmitRunAsync(string matchId, SubmitRunEvidence evidence, string idempotencyKey) => throw new NotSupportedException(Msg);
        public Task<AddBalanceResult> AddBalanceAsync(long amountCents, string idempotencyKey) => throw new NotSupportedException(Msg);
        public IDisposable ObserveAccount(Action<AccountView> onChange) => throw new NotSupportedException(Msg);
        public IDisposable ObserveMyMatches(Action<IReadOnlyList<MatchView>> onChange) => throw new NotSupportedException(Msg);
        public IDisposable ObserveMatch(string matchId, Action<MatchView> onChange) => throw new NotSupportedException(Msg);
        public Task<ResultView> GetResultAsync(string matchId) => throw new NotSupportedException(Msg);
    }
#endif
}
