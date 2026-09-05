#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Redline.Core;
using UnityEngine;
using UnityEngine.Networking;

namespace Redline.Client.Net
{
    /// <summary>
    /// An in-process <see cref="IRedlineBackend"/> for the Editor only.
    ///
    /// WHY THIS EXISTS
    /// The Firebase Unity SDK's async operations (Remote Config Fetch/Activate,
    /// and callable Functions past the first) routinely never complete in the
    /// macOS Editor — the native completion callbacks are not pumped, so every
    /// Task sits at WaitingForActivation. That makes the staked online flow
    /// (matchmake → arm → drive → submit → settle) impossible to exercise from
    /// Play mode. The real integration is validated on-device; this backend lets
    /// the same UI and flow run in the Editor with instant, deterministic,
    /// network-free responses.
    ///
    /// It is NOT a simulation of the server's rules — the score of record still
    /// comes from the client's own run here (loopback trusts the local run,
    /// which is the point). The synthetic opponent's score is derived from the
    /// match seed so a given seed always settles the same way.
    ///
    /// Selected in <see cref="RedlineSession"/> behind <c>#if UNITY_EDITOR</c>.
    /// </summary>
    public sealed class EditorLoopbackBackend : IRedlineBackend
    {
        private const long DemoGrantCents = 1000;
        private const long DemoMaxBalanceCents = 10000;
        private const int RakeBasisPoints = 1000;                 // 10%
        private static readonly long[] Ladder = { 50, 100, 200, 500, 1000 };

        /// <summary>
        /// Editor-only stand-in for the persisted Firebase anonymous credential.
        /// There is no Firebase SDK in Play mode (this whole class exists because
        /// its async calls never complete on the macOS Editor), so the
        /// Authentication screen's "returning user" state is simulated with
        /// PlayerPrefs: <see cref="CachedUidKey"/> holds the uid (minted on the
        /// first <see cref="EnsureAccountAsync"/>), and <see cref="CachedUidActiveKey"/>
        /// is a 0/1 flag standing in for "the backend confirmed this identity"
        /// (drives the green/red dot). Menu "Redline/Clear Local Anonymous Id"
        /// deletes them; "Redline/Toggle Local Anonymous Id Backend State" flips
        /// the flag so the red state is demoable in-Editor. On device the real
        /// <see cref="FirebaseRedlineBackend"/> uses <c>FirebaseAuth</c> and a
        /// real token refresh instead, and these keys are never written.
        /// </summary>
        private const string CachedUidKey = "redline.editor.anonUid";
        private const string CachedUidActiveKey = "redline.editor.anonActive";

        // Starts as the bundled config; replaced by the live Remote Config value
        // on the first GameConfigTextAsync / MatchmakeAsync so a change published
        // from the hosting page reaches Editor Play mode. See gameConfig.ts.
        private string _configText;
        private string _configHash;

        /// <summary>Public HTTP mirror of the live redline_game Remote Config value (no auth).</summary>
        private const string GameConfigUrl = "https://asia-south1-attendance-91bdd.cloudfunctions.net/gameConfig";

        private long _balanceCents = DemoGrantCents;
        private int _rating = 1200;
        private int _ratedMatches = 0;

        // The one match in flight (the flow is strictly sequential).
        private string _matchId;
        private ulong _seed;
        private long _stakeCents;
        private long _mySubmittedScore = -1;
        private bool _myBanked;
        private bool _awaitingSettle;
        private bool _matchRefunded;   // withdrawChallenge already returned this match's stake
        private Action<MatchView> _matchListener;

        private readonly Task _configFetch;

        public EditorLoopbackBackend(string bundledConfigText)
        {
            _configText = bundledConfigText ?? "{}";
            _configHash = GameConfig.Parse(_configText).ConfigHash;
            Debug.Log("[redline] EditorLoopbackBackend active — Play-mode staked flow runs locally, no Firebase.");
            // Start pulling the live redline_game value now; GameConfigTextAsync
            // waits on it briefly. Started here so it has the whole sign-in step
            // to finish before the config is read.
            _configFetch = RefreshGameConfigFromRemoteAsync();
        }

        public string AccountId
        {
            get
            {
                string id = PlayerPrefs.GetString(CachedUidKey, string.Empty);
                return id.Length > 0 ? id : "editor-local";
            }
        }

        public Task<CachedIdentity> PeekCachedAccountIdAsync()
        {
            if (!PlayerPrefs.HasKey(CachedUidKey))
                return Task.FromResult(new CachedIdentity { accountId = null, backendActive = false });

            return Task.FromResult(new CachedIdentity
            {
                accountId = PlayerPrefs.GetString(CachedUidKey),
                backendActive = PlayerPrefs.GetInt(CachedUidActiveKey, 1) == 1,
            });
        }

        public Task ForgetCachedIdentityAsync()
        {
            PlayerPrefs.DeleteKey(CachedUidKey);
            PlayerPrefs.DeleteKey(CachedUidActiveKey);
            PlayerPrefs.Save();
            return Task.CompletedTask;
        }

        public Task<AccountView> EnsureAccountAsync(string deviceFingerprint)
        {
            // First "sign-in" of this Editor profile: mint and persist a uid so a
            // later launch shows the "Enter with same account" state, and mark it
            // backend-active (the green dot).
            if (!PlayerPrefs.HasKey(CachedUidKey))
            {
                PlayerPrefs.SetString(CachedUidKey, "editor-" + Guid.NewGuid().ToString("N").Substring(0, 12));
                PlayerPrefs.SetInt(CachedUidActiveKey, 1);
                PlayerPrefs.Save();
            }
            return Task.FromResult(Account());
        }

        private AccountView Account() => new AccountView
        {
            accountId = AccountId,
            displayName = "Editor",
            rating = _rating,
            ratedMatches = _ratedMatches,
            provisional = _ratedMatches < 10,
            league = 4,
            leagueCount = 10,
            balanceCents = _balanceCents,
            stakesCents = Ladder,
        };

        public Task<GameConfigText> GameConfigTextAsync()
        {
            // Synchronous on purpose. The live redline_game value is pulled by
            // the constructor's fire-and-forget fetch (_configFetch); if it has
            // already landed this returns the updated config, otherwise it
            // returns the bundled one and the change shows on the next Play.
            // Startup never awaits the network here — that was wedging Play mode
            // in the Editor.
            _ = _configFetch;   // keep the field referenced
            return Task.FromResult(new GameConfigText { rawText = _configText, configHash = _configHash });
        }

        [Serializable] private struct GameConfigDto { public string gameJson; public string configHash; }

        /// <summary>
        /// Pull the live redline_game value from the public HTTP mirror so an
        /// edit made on the hosting page shows up in the next Editor session /
        /// next match. Best-effort: on any failure the bundled config stays.
        /// </summary>
        private async Task RefreshGameConfigFromRemoteAsync()
        {
            try
            {
                using var req = UnityWebRequest.Get(GameConfigUrl);
                req.timeout = 8;

                var op = req.SendWebRequest();
                var tcs = new TaskCompletionSource<bool>();
                op.completed += _ => tcs.TrySetResult(true);
                if (await Task.WhenAny(tcs.Task, Task.Delay(8000)) != tcs.Task) return;   // gave up

                if (req.result != UnityWebRequest.Result.Success) return;

                var dto = JsonUtility.FromJson<GameConfigDto>(req.downloadHandler.text);
                if (string.IsNullOrEmpty(dto.gameJson)) return;

                var parsedHash = GameConfig.Parse(dto.gameJson).ConfigHash;
                if (parsedHash == _configHash) return;   // unchanged

                _configText = dto.gameJson;
                _configHash = parsedHash;
                Debug.Log("[redline] EditorLoopbackBackend: game config updated from Remote Config (hash " + _configHash + ").");
            }
            catch (Exception e)
            {
                Debug.LogWarning("[redline] EditorLoopbackBackend: Remote Config fetch failed, keeping bundled config — " + e.Message);
            }
        }

        public Task<PayoutPreviewView> PreviewAsync(long stakeCents)
        {
            long pot = stakeCents * 2;
            long rake = pot * RakeBasisPoints / 10000;
            long win = pot - rake;
            long tieEach = (pot - rake) / 2;
            return Task.FromResult(new PayoutPreviewView
            {
                stakeCents = stakeCents,
                potCents = pot,
                rakeCents = rake,
                winCents = win,
                tiePosterCents = (pot - rake) - tieEach,   // odd cent to the poster
                tieChallengerCents = tieEach,
            });
        }

        public Task<CreateMatchResult> CreateMatchAsync(long stakeCents, string idempotencyKey)
        {
            ArmLocalMatch(stakeCents);
            return Task.FromResult(new CreateMatchResult
            {
                ok = true, result = "ok", matchId = _matchId, stakeCents = stakeCents,
                seed = _seed, configHash = _configHash, balanceCents = _balanceCents,
            });
        }

        public Task<MatchmakeResult> MatchmakeAsync(long stakeCents, string idempotencyKey)
        {
            // Config is pulled once at startup (GameConfigTextAsync). Like the
            // real client, a value published mid-session takes effect on the
            // next Play — not this one — so match/session hashes stay consistent.
            ArmLocalMatch(stakeCents);
            return Task.FromResult(new MatchmakeResult
            {
                outcome = "posted",
                hasOffer = false,
                considered = 0,
                hasPosted = true,
                posted = new CreateMatchResult
                {
                    ok = true, result = "ok", matchId = _matchId, stakeCents = stakeCents,
                    seed = _seed, configHash = _configHash, balanceCents = _balanceCents,
                },
            });
        }

        public Task<JoinMatchResult> JoinMatchAsync(string matchId, string idempotencyKey) =>
            Task.FromResult(new JoinMatchResult
            {
                ok = true, result = "ok", matchId = matchId, stakeCents = _stakeCents,
                seed = _seed, configHash = _configHash, balanceCents = _balanceCents,
            });

        public Task<WithdrawChallengeResult> WithdrawChallengeAsync(string matchId, string idempotencyKey)
        {
            // Mirror the server: return the stake once while the challenge is
            // still "posted" (in loopback that is: this match, not yet settled,
            // not already refunded); any later call is a harmless no-op.
            bool current = matchId == _matchId && !_matchRefunded && !_awaitingSettle;
            if (current)
            {
                _balanceCents += _stakeCents;
                _matchRefunded = true;
            }
            return Task.FromResult(new WithdrawChallengeResult
            {
                ok = true,
                result = current ? "withdrawn" : "already_expired",
                balanceCents = _balanceCents,
            });
        }

        public Task<SubmitRunResult> SubmitRunAsync(string matchId, SubmitRunEvidence evidence, string idempotencyKey)
        {
            _mySubmittedScore = evidence.clientScore;
            _myBanked = string.Equals(evidence.clientOutcome, "BANKED", StringComparison.OrdinalIgnoreCase);
            _awaitingSettle = true;

            // If GameFlowUi is already watching the match (ObserveMatch ran
            // first), settle a beat later. Otherwise ObserveMatch will kick it
            // off when the listener attaches — the submission on this backend is
            // instant, so it usually lands before the result screen exists.
            if (_matchListener != null) FireSettleSoon();

            return Task.FromResult(new SubmitRunResult
            {
                ok = true, result = "ok", role = "poster",
                serverScore = evidence.clientScore,
                outcome = (evidence.clientOutcome ?? "abandoned").ToLowerInvariant(),
                endTick = evidence.finalTick, distance = 0, finalLane = 0, rejectedInputs = 0,
                configHash = _configHash, disagreed = false, matchState = "answered",
            });
        }

        public IDisposable ObserveAccount(Action<AccountView> onChange)
        {
            onChange?.Invoke(Account());
            return new Sub(() => { });
        }

        public IDisposable ObserveMyMatches(Action<IReadOnlyList<MatchView>> onChange)
        {
            onChange?.Invoke(Array.Empty<MatchView>());
            return new Sub(() => { });
        }

        public IDisposable ObserveMatch(string matchId, Action<MatchView> onChange)
        {
            _matchListener = onChange;
            onChange?.Invoke(new MatchView
            {
                matchId = matchId, stakeCents = _stakeCents, state = "answered", role = "poster",
                waiting = "opponent_playing", settled = false,
                you = new SideView2 { submitted = _mySubmittedScore >= 0, score = _mySubmittedScore, outcome = _myBanked ? "banked" : "crashed" },
                opponent = new SideView2 { submitted = false, score = -1, outcome = null },
            });

            // The run was already submitted before anyone watched (instant
            // loopback submission) — start the settle now that a listener exists.
            if (_awaitingSettle) FireSettleSoon();

            return new Sub(() => _matchListener = null);
        }

        public Task<ResultView> GetResultAsync(string matchId)
        {
            long myScore = _myBanked ? Math.Max(0, _mySubmittedScore) : 0;
            long oppScore = SyntheticOpponentScore();

            long pot = _stakeCents * 2;
            long rake = pot * RakeBasisPoints / 10000;
            long payout = pot - rake;

            string result;
            long credited;
            int s;   // Elo score
            if (myScore > oppScore) { result = "won"; credited = payout; s = 1; }
            else if (myScore < oppScore) { result = "lost"; credited = 0; s = 0; }
            else { result = "draw"; credited = (pot - rake) / 2; /* even split; odd cent ignored in loopback */ s = 0; }

            _balanceCents += credited;                       // stake was debited at ArmLocalMatch
            int before = _rating;
            int k = _ratedMatches < 10 ? 40 : 24;
            int delta = result == "draw" ? 0 : (int)Math.Round(k * (s - 0.5));
            _rating = Math.Max(100, _rating + delta);
            _ratedMatches++;

            long net = credited - _stakeCents;

            return Task.FromResult(new ResultView
            {
                yourScore = myScore, opponentScore = oppScore, result = result,
                potCents = pot, rakeCents = rake, creditedCents = credited, netCents = net,
                ratingBefore = before, ratingAfter = _rating, ratingDelta = _rating - before,
            });
        }

        public Task<AddBalanceResult> AddBalanceAsync(long amountCents, string idempotencyKey)
        {
            long headroom = DemoMaxBalanceCents - _balanceCents;
            long credited = headroom <= 0 ? 0 : Math.Min(amountCents, headroom);
            _balanceCents += credited;
            return Task.FromResult(new AddBalanceResult
            {
                ok = true, creditedCents = credited, balanceCents = _balanceCents,
                capped = credited < amountCents, maxBalanceCents = DemoMaxBalanceCents,
            });
        }

        // ---- internals ----

        private void ArmLocalMatch(long stakeCents)
        {
            _stakeCents = stakeCents;
            _balanceCents = Math.Max(0, _balanceCents - stakeCents);
            _matchId = "editor-" + DateTime.UtcNow.Ticks.ToString("x");
            _seed = unchecked((ulong)(DateTime.UtcNow.Ticks ^ 0x5DEECE66DL));
            _mySubmittedScore = -1;
            _myBanked = false;
            _awaitingSettle = false;
            _matchRefunded = false;
        }

        private long SyntheticOpponentScore()
        {
            // Deterministic from the seed: a spread that a cautious bank can beat
            // and a greedy overreach can lose to.
            ulong x = _seed;
            x ^= x >> 33; x *= 0xff51afd7ed558ccdUL; x ^= x >> 33;
            return 140 + (long)(x % 420);   // 140..559
        }

        private async void FireSettleSoon()
        {
            if (!_awaitingSettle) return;
            _awaitingSettle = false;
            await Task.Delay(1600);          // resumes on Unity's main thread in play mode
            _matchListener?.Invoke(new MatchView
            {
                matchId = _matchId, stakeCents = _stakeCents, state = "settled", role = "poster",
                waiting = "settled", settled = true,
                you = new SideView2 { submitted = true, score = Math.Max(0, _mySubmittedScore), outcome = _myBanked ? "banked" : "crashed" },
                opponent = new SideView2 { submitted = true, score = SyntheticOpponentScore(), outcome = "banked" },
            });
        }

        private sealed class Sub : IDisposable
        {
            private Action _dispose;
            public Sub(Action dispose) => _dispose = dispose;
            public void Dispose() { _dispose?.Invoke(); _dispose = null; }
        }
    }
}
#endif
