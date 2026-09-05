using System;
using System.Threading.Tasks;
using PrimeTween;
using Redline.Client.Net;
using Redline.Core;
using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// The screen-flow state machine for a play session:
    ///
    ///   Home → Instructions → Ready/Go → (HUD, driving) → GameOver → OpponentPlaying → Home
    ///
    /// Owns which panel is visible and the one gate on when a run may tick
    /// (<see cref="RunHost.Frozen"/>). Owns no rule — the run is
    /// <see cref="RunHost"/>, the shake is <see cref="RunEndPresenter"/>, the
    /// submission is <see cref="SubmissionQueue"/>, every money figure is the
    /// server's.
    ///
    /// Two paths: **staked 1v1** (only when <see cref="RedlineSession.CanStake"/>)
    /// — matchmake, arm on the server's seed, drive, queue the envelope on run
    /// end, then walk the OpponentPlaying panel off submission events + an
    /// <c>ObserveMatch</c> listener; and **practice** — offline, fresh local
    /// seed, no matchmake or submission, result screen shows the seed.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class GameFlowUi : MonoBehaviour
    {
        [Header("Wiring")]
        [Tooltip("Identity + backend + rules. Drag the Online object's RedlineSession here.")]
        [SerializeField] private RedlineSession session;

        [Tooltip("The run loop. Drag the Run object's RunHost here.")]
        [SerializeField] private RunHost runHost;

        [Tooltip("The retrying submission queue. Drag the Online object's SubmissionQueue here.")]
        [SerializeField] private SubmissionQueue submissions;

        [Tooltip("The in-run HUD canvas root. Shown only while driving.")]
        [SerializeField] private GameObject hudRoot;

        [Tooltip("The in-run chevron exit control + its double-tap hint. Armed only between the ready screen and run end.")]
        [SerializeField] private RunExitControl runExit;

        [Header("Panels")]
        [Tooltip("The anonymous-identity screen shown before Home on launch.")]
        [SerializeField] private AuthPanel auth;

        [Tooltip("The home / stake screen.")]
        [SerializeField] private HomePanel home;

        [Tooltip("The pre-run instructions screen.")]
        [SerializeField] private InstructionsPanel instructions;

        [Tooltip("The READY / GO! countdown.")]
        [SerializeField] private ReadyGoPanel readyGo;

        [Tooltip("The CRASHED / BANKED screen.")]
        [SerializeField] private GameOverPanel gameOver;

        [Tooltip("The post-run waiting / settlement screen.")]
        [SerializeField] private OpponentPlayingPanel opponentPlaying;

        [Tooltip("The demo in-game top-up modal, opened from the home balance button. Overlay — not part of the panel flow.")]
        [SerializeField] private AddBalancePanel addBalance;

        [Header("Feel")]
        [Tooltip("Seconds the 'CRASHED' panel is held back so the blast reads first. A bank is immediate.")]
        [SerializeField] private float crashPanelHoldSeconds = 1f;

        private long _stakeCents;     // the amount the current run is played for
        private ulong _seed;
        private string _matchId;      // null for a practice run
        private string _configHash;   // the hash the seed was issued under
        private bool _busy;           // a matchmake call is in flight

        private IDisposable _matchSub;
        private bool _resultFetched;

        // A run's submission can be acknowledged BEFORE the player taps past the
        // game-over panel — SubmissionQueue starts sending the instant the run
        // ends (OnRunEnded), and a warm submitRun answers in a second or two. The
        // Submitted/Abandoned events are one-shot, so if they fire while the
        // "Sending…" panel is not yet on screen (Waiting == false) their result
        // has nowhere to go and the panel then spins forever. Stash it here and
        // replay it in OnGameOverDismissed. Cleared when the next match is set up.
        private SubmitRunResult? _pendingOwnScore;
        private string _pendingLostReason;
        private bool _inRun;          // true from the ready screen until the run ends
        private bool _quitting;       // a double-tap exit is in flight — skip the result screens

        // The two self-contained sub-flows, lifted out of this class (feature
        // 0009). Constructed in Awake, disposed in OnDestroy.
        private AuthScreen _authScreen;
        private BalanceTopUp _balance;

        private Tween _gameOverDelay;
        private float _nextPollAt;
        private float _nextRetryAt;
        private float _connectFill;      // the Play-button slider value while connecting / matchmaking
        private string _connectLabel;    // last main label pushed to the Play button (so we only SetText on change)
        private string _connectSub;      // last sub-line pushed to the Play button
        private float _matchmakeStartedAt;
        private int _matchmakeGen;       // bumped on every start / cancel; a stale MatchmakeAsync sees the mismatch and bails
        private float _matchmakeBudgetSeconds = 15f;   // the wait shown for THIS attempt, sized from live latency
        private bool _matchmakeJoining;  // past the first server reply, JoinMatch in flight

        // The wait is sized from live latency (RedlineSession.TypicalRoundTripSeconds),
        // clamped to this band; when it runs out with no match the button shows a
        // retry line rather than freezing on a zeroed countdown.
        private const float MatchmakeWaitFloorSeconds = 8f;
        private const float MatchmakeWaitCeilingSeconds = 30f;

        // The countdown above is only the *shown* wait. This is the separate,
        // longer backstop after which the client stops waiting on the call —
        // sized so a gen-2 cold start plus two Firestore round-trips finishes
        // inside it on the first staked Play of a session. When it fires, the
        // in-flight call still lands later and refunds any challenge it posted
        // (WithdrawPostedAsync) — the wait is abandoned, never the money.
        private const float MatchmakeAbandonSeconds = 90f;

#if UNITY_EDITOR
        // In the Editor the matchmake/join call is only abandoned after this
        // fixed backstop, not the adaptive budget. The Firebase Unity SDK's
        // callable path on desktop is slow and gen2 Cloud Functions cold-start,
        // so the first staked Play of a session routinely takes 15-40s from the
        // Editor. The visible countdown still ticks to zero and then reads
        // "Still trying…"; it just does not error out. Practice mode stays the
        // fast offline path — this only makes the staked flow testable in-Editor.
        private const float EditorMatchmakeAbandonSeconds = 180f;
#endif

        private bool AtHome => home != null && home.gameObject.activeSelf;
        private bool Waiting => opponentPlaying != null && opponentPlaying.gameObject.activeSelf;

        private void Awake()
        {
            _authScreen = new AuthScreen(auth, session);
            _authScreen.ReadyForHome += GoHome;
            _balance = new BalanceTopUp(home, addBalance, session, PracticeLadderCents);

            home.PlayRequested += OnPlayRequested;
            home.SelectionChanged += OnSelectionChanged;
            instructions.Dismissed += OnInstructionsDismissed;
            readyGo.Go += OnGo;
            gameOver.Dismissed += OnGameOverDismissed;
            opponentPlaying.Continued += OnContinued;

            if (runHost != null) runHost.RunEnded += OnRunEnded;
            if (submissions != null)
            {
                submissions.Submitted += OnSubmitted;
                submissions.Abandoned += OnAbandoned;
            }
            if (session != null) session.Changed += OnSessionChanged;

            if (runExit != null) runExit.QuitConfirmed += OnQuitToHome;
        }

        private void OnDestroy()
        {
            _authScreen.ReadyForHome -= GoHome;
            _authScreen.Dispose();
            _balance.Dispose();

            home.PlayRequested -= OnPlayRequested;
            home.SelectionChanged -= OnSelectionChanged;
            instructions.Dismissed -= OnInstructionsDismissed;
            readyGo.Go -= OnGo;
            gameOver.Dismissed -= OnGameOverDismissed;
            opponentPlaying.Continued -= OnContinued;

            if (runHost != null) runHost.RunEnded -= OnRunEnded;
            if (submissions != null)
            {
                submissions.Submitted -= OnSubmitted;
                submissions.Abandoned -= OnAbandoned;
            }
            if (session != null) session.Changed -= OnSessionChanged;

            if (runExit != null) runExit.QuitConfirmed -= OnQuitToHome;

            if (_gameOverDelay.isAlive) _gameOverDelay.Stop();
            _matchSub?.Dispose();
        }

        /// <summary>
        /// Stake rungs shown with no server ladder (offline, or before startup).
        /// Mirrors <c>money.stakeCents</c> in <c>redline.economy.json</c>. Nothing
        /// is debited offline, but the pick is carried through as the run's stake.
        /// </summary>
        private static readonly long[] PracticeLadderCents = { 50, 100, 200, 500, 1000 };

        private void Start()
        {
            home.SetLadder(PracticeLadderCents);   // swapped for the server ladder in OnSessionChanged

            // The identity screen comes first (AuthScreen). Its Enter tap calls
            // session.BeginSignIn(); OnSessionChanged routes to Home once the
            // session is Ready. Begin() returns false only when no auth panel is
            // wired (older scene) — then sign-in has already started and we go
            // straight Home.
            if (_authScreen.Begin())
            {
                ShowOnly(auth.gameObject);
                SetHud(false);
            }
            else
            {
                GoHome();
            }
        }

        private void Update()
        {
            // Android maps its hardware/gesture back to Escape. In a run it is
            // one press of the chevron: first press hints, second within the
            // window quits. Fully qualified: `Redline.Client.Input` is a
            // namespace in scope and would shadow `UnityEngine.Input`.
            if (UnityEngine.Input.GetKeyDown(KeyCode.Escape) && _inRun && runExit != null)
                runExit.Press();

            if (!AtHome || session == null) return;

            UpdateHomeConnectState();

            if (!session.CanStake)
            {
                // Opened (or dropped) offline — keep trying to reach the backend
                // so the home screen recovers on its own.
                if (!session.Connecting && Time.unscaledTime >= _nextRetryAt)
                {
                    _nextRetryAt = Time.unscaledTime + 5f;
                    session.RetryStartup();
                }
                return;
            }

            // Keep the balance / ladder fresh while the home screen is up, the
            // same 3 s poll the retired LobbyScreen ran.
            if (Time.unscaledTime < _nextPollAt) return;

            _nextPollAt = Time.unscaledTime + 3f;
            _ = session.RefreshMeAsync();
        }

        /// <summary>
        /// Drives the Play button between "PLAY" and its connecting look, the
        /// slider fill, and the balance line — every frame the home screen is up.
        /// </summary>
        private void UpdateHomeConnectState()
        {
            // The call has run long enough that we abandon it and hand the
            // button back with a retry line. The join phase gets extra room —
            // it is a second round-trip that only starts once the first has
            // answered. In the Editor a long fixed backstop replaces the
            // adaptive limit (slow desktop Firebase SDK + gen2 cold starts); the
            // visible countdown still ticks to zero and then reads "Still trying…".
            if (_busy)
            {
#if UNITY_EDITOR
                float cap = EditorMatchmakeAbandonSeconds;
#else
                // The join phase is a second round-trip that only starts after
                // the first has answered, so it gets extra room on top.
                float cap = MatchmakeAbandonSeconds * (_matchmakeJoining ? 1.5f : 1f);
#endif
                if (Time.unscaledTime - _matchmakeStartedAt >= cap)
                    MatchmakeTimedOut();
            }

            bool connecting = session.Connecting || _busy;

            if (connecting)
            {
                string label, sub;
                bool canCancel;

                if (_busy)
                {
                    // Matchmaking: the button is a cancel button now. The line
                    // under it counts down the wait we actually budgeted for this
                    // attempt (sized from live server latency, not a fixed 30),
                    // then names the join once the server has answered.
                    float elapsed = Time.unscaledTime - _matchmakeStartedAt;
                    float budget = Mathf.Max(1f, _matchmakeBudgetSeconds);
                    int count = Mathf.Max(0, Mathf.CeilToInt(budget - elapsed));

                    label = "Click to cancel";
                    sub = _matchmakeJoining ? "Joining your match…"
                        : count > 0 ? $"Finding a match in {count}"
                        : "Still trying…";
                    canCancel = true;

                    // Monotonic fill. Creep to ~70% while waiting on the first
                    // reply, then snap forward once the server has answered so
                    // the join reads as real progress.
                    float ramp = _matchmakeJoining
                        ? Mathf.Max(0.8f, Mathf.Clamp01(elapsed / budget))
                        : Mathf.Clamp01(elapsed / budget) * 0.7f;
                    _connectFill = Mathf.Max(_connectFill, ramp);
                }
                else
                {
                    label = session.SyncStatus;
                    sub = null;
                    canCancel = false;
                    _connectFill = Mathf.Max(_connectFill,
                        Mathf.MoveTowards(_connectFill, session.SyncProgress, 2f * Time.unscaledDeltaTime));
                }

                if (label != _connectLabel || sub != _connectSub)
                {
                    _connectLabel = label;
                    _connectSub = sub;
                    home.SetConnecting(true, label, sub, canCancel);
                }
                home.SetConnectProgress(_connectFill);
            }
            else if (_connectLabel != null)
            {
                _connectLabel = null;
                _connectSub = null;
                _connectFill = 0f;
                home.SetConnecting(false, null, null, false);
                home.SetPlayEnabled(true);
            }

            home.SetBalance(session.CanStake && session.Me.HasValue
                ? Money.Full(session.Me.Value.balanceCents)
                : string.Empty);

            // Low balance re-asserted every frame while it holds — a session
            // poll or a stale PreviewAsync callback would otherwise wipe the
            // notice the Play guard depends on (SetNotice de-dups, so this is a
            // cheap early-return once it is up). OnSelectionChanged clears it
            // when the pick becomes affordable.
            if (!connecting && Unaffordable(home.StakeCents))
                home.SetNotice($"Low balance. Add funds to play for {Money.Short(home.StakeCents)}.");
            // The startup failure, in yellow, once we are no longer mid-attempt.
            else if (!connecting && !session.CanStake && !string.IsNullOrEmpty(session.StartupError))
                home.SetNotice(session.StartupError.StartsWith("rules hash disagrees")
                    ? "Game rules changed — restart the app."
                    : "Can't reach the server — retrying…");
        }

        // ------------------------------------------------------------- states

        private void GoHome()
        {
            if (_gameOverDelay.isAlive) _gameOverDelay.Stop();
            _matchSub?.Dispose();
            _matchSub = null;
            _matchId = null;
            _configHash = null;
            _resultFetched = false;
            _busy = false;
            _matchmakeJoining = false;
            _inRun = false;
            _quitting = false;

            if (runHost != null)
            {
                runHost.Frozen = false;
                runHost.enabled = false;
            }

            if (runExit != null) runExit.SetArmed(false);
            _balance.Reset();
            _connectLabel = _connectSub = null;
            _matchmakeGen++;   // invalidate any in-flight matchmake
            home.SetConnecting(false, null, null, false);
            ShowOnly(home.gameObject);
            SetHud(false);
            home.SetNotice(string.Empty);
            home.SetPlayEnabled(true);
            OnSessionChanged();
        }

        private void OnSessionChanged()
        {
            // The identity screen consumes this while it is up (and raises
            // ReadyForHome -> GoHome once the session is Ready).
            if (_authScreen.OnSessionChanged()) return;

            if (!AtHome) return;

            long[] served = session != null && session.CanStake && session.Me.HasValue
                ? session.Me.Value.stakesCents
                : null;
            home.SetLadder(served != null && served.Length > 0 ? served : PracticeLadderCents);

            OnSelectionChanged();
        }

        private void OnSelectionChanged()
        {
            if (!AtHome) return;

            bool online = session != null && session.CanStake;

            // "Low balance" is a persistent property of the current selection,
            // not a one-shot on the Play tap — evaluated here (which runs on a
            // stake change AND on every session poll) so a routine RefreshMe
            // can't wipe the message the guard in OnPlayRequested relies on.
            home.SetNotice(Unaffordable(home.StakeCents)
                ? $"Low balance. Add funds to play for {Money.Short(home.StakeCents)}."
                : string.Empty);
            home.SetPlayEnabled(!_busy);

            if (online)
            {
                _ = RefreshPreviewAsync(home.StakeCents);
            }
            else
            {
                // Offline practice: no server PreviewAsync. Show the win after
                // 10% rake — pot = stake x 2, payout = pot x 0.9 = stake x 1.8,
                // in integer cents. Cosmetic; PreviewAsync fills it exactly once
                // staking is possible.
                home.SetPayoutReadout("WIN", Money.Short(home.StakeCents * 18 / 10));
            }
        }

        /// <summary>True when a staked play at this amount would exceed the known balance.</summary>
        private bool Unaffordable(long stakeCents) =>
            session != null && session.CanStake && session.Me.HasValue
            && stakeCents > session.Me.Value.balanceCents;

        private async Task RefreshPreviewAsync(long stakeCents)
        {
            try
            {
                var p = await session.Backend.PreviewAsync(stakeCents);
                if (AtHome)
                    home.SetPayoutReadout("WIN", Money.Full(p.winCents));   // server's number, never computed here
            }
            catch (BackendCallException ex)
            {
                if (AtHome) home.SetNotice(ex.Message);
            }
        }

        private void OnPlayRequested(long stakeCents)
        {
            // A second press while a matchmake is in flight is a cancel.
            if (_busy)
            {
                CancelMatchmake();
                return;
            }

            _stakeCents = stakeCents;   // the amount the run is played for

            bool staked = session != null && session.CanStake;

            // Refuse a stake we can already see the player can't afford, before
            // any call moves money. The server also returns insufficient_balance,
            // but only after a round-trip — and matchmake's starvation fallback
            // would post (and debit) a challenge first (feature 0010). The
            // notice itself is owned by OnSelectionChanged so a poll can't wipe
            // it; re-assert here so it is up the instant Play is pressed.
            if (staked && Unaffordable(stakeCents))
            {
                home.SetNotice($"Low balance. Add funds to play for {Money.Short(stakeCents)}.");
                home.SetPlayEnabled(true);
                return;
            }

            if (!staked)
            {
                _matchId = null;
                _configHash = null;
                _seed = unchecked((ulong)DateTime.UtcNow.Ticks);
                EnterInstructions();
                return;
            }

            _busy = true;
            _matchmakeGen++;
            _matchmakeStartedAt = Time.unscaledTime;
            _matchmakeJoining = false;
            // Size the wait from how the backend is answering right now: roughly
            // two round-trips (matchmake + join) plus slack, held to a sane band.
            _matchmakeBudgetSeconds = Mathf.Clamp(
                Mathf.Ceil(session.TypicalRoundTripSeconds * 4f) + 4f,
                MatchmakeWaitFloorSeconds, MatchmakeWaitCeilingSeconds);
            _connectLabel = _connectSub = null;
            _connectFill = 0f;
            home.SetNotice(string.Empty);
            // UpdateHomeConnectState paints the cancel look + countdown next frame.
            _ = MatchmakeAsync(stakeCents, _matchmakeGen);
        }

        /// <summary>
        /// Cancel: return the button to "PLAY" now and let the in-flight
        /// matchmake land on a stale generation. If that call posted a
        /// challenge, <see cref="MatchmakeAsync"/>'s stale-gen branch calls
        /// <see cref="WithdrawPostedAsync"/> and the stake comes straight back.
        /// </summary>
        private void CancelMatchmake()
        {
            if (!_busy) return;

            _matchmakeGen++;   // the in-flight MatchmakeAsync now holds a stale generation and will bail
            _busy = false;
            _matchmakeJoining = false;
            _connectLabel = _connectSub = null;
            _connectFill = 0f;

            home.SetConnecting(false, null, null, false);
            home.SetNotice(string.Empty);
            home.SetPlayEnabled(true);
            OnSelectionChanged();
        }

        /// <summary>
        /// The backstop wait elapsed with no match. Bump the generation so the
        /// in-flight call bails on landing — and if it posted a challenge,
        /// <see cref="WithdrawPostedAsync"/> refunds it then (not the 15-minute
        /// sweep). Hand the button back with a retry line meanwhile.
        /// </summary>
        private void MatchmakeTimedOut()
        {
            _matchmakeGen++;
            _matchmakeJoining = false;
            Fail("Couldn't reach a match in time — tap Play to try again.");
        }

        private async Task MatchmakeAsync(long stakeCents, int gen)
        {
            try
            {
                // One key for this arrival and its retries. Only ever spent if
                // the outcome is "posted" (the server stakes a challenge for the
                // caller), but sent every time like any money-moving call.
                var mm = await session.Backend.MatchmakeAsync(stakeCents, Guid.NewGuid().ToString("N"));

                if (gen != _matchmakeGen)
                {
                    // Cancelled or abandoned during the call. If the server
                    // posted a challenge for us the stake has already moved —
                    // hand it straight back rather than leaving it stuck until
                    // the 15-minute sweep (feature 0010).
                    if (mm.outcome == "posted" && mm.hasPosted)
                        _ = WithdrawPostedAsync(mm.posted.matchId);
                    return;
                }

                switch (mm.outcome)
                {
                    case "matched":
                        // The first round-trip has answered; the bar and the
                        // sub-line switch to the join phase.
                        if (gen == _matchmakeGen) _matchmakeJoining = true;
                        var joined = await session.Backend.JoinMatchAsync(mm.offer.matchId, Guid.NewGuid().ToString("N"));

                        if (gen != _matchmakeGen)
                        {
                            // Cancelled while the join was in flight. If it went
                            // through, the stake is committed — the match settles
                            // as an ordinary loss on the no-submission sweep,
                            // same as quitting a run (ADR 0004).
                            if (joined.ok)
                                Debug.LogWarning("[redline] cancelled after joining a match; it will settle as a loss.");
                            return;
                        }

                        if (joined.ok) Arm(joined.matchId, joined.seed, joined.configHash);
                        else Fail(joined.result switch
                        {
                            "unavailable" => "That challenge was taken. Try again.",
                            "insufficient_balance" => "Not enough balance for this stake.",
                            _ => "Could not join that challenge.",
                        });
                        break;

                    case "posted":
                        // The server just staked a challenge for this player —
                        // exactly the old "post a challenge" outcome, reached
                        // without a second tap.
                        Arm(mm.posted.matchId, mm.posted.seed, mm.posted.configHash);
                        break;

                    case "insufficient_balance":
                        Fail("Not enough balance for this stake.");
                        break;

                    default:
                        Fail($"Matchmaking returned '{mm.outcome}'.");
                        break;
                }
            }
            catch (BackendCallException ex)
            {
                if (gen == _matchmakeGen) Fail(ex.Message);
            }
        }

        /// <summary>
        /// A matchmake we no longer want landed with a challenge posted for us —
        /// the stake is already debited. Ask the server to close it and refund
        /// now. The 15-minute sweep is only the backstop if this call fails too.
        /// </summary>
        private async Task WithdrawPostedAsync(string matchId)
        {
            try
            {
                await session.Backend.WithdrawChallengeAsync(matchId, Guid.NewGuid().ToString("N"));
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[redline] withdraw failed; the sweep will refund {matchId}: {ex.Message}");
            }

            if (!AtHome) return;
            await session.RefreshMeAsync();   // pull the refunded balance onto the button
            if (AtHome && !_busy)
                home.SetNotice("Stake returned — no match found. Tap Play to try again.");
        }

        private void Fail(string notice)
        {
            _busy = false;
            _matchmakeJoining = false;
            _connectFill = 0f;
            _connectLabel = _connectSub = null;
            if (!AtHome) return;
            home.SetConnecting(false, null, null, false);   // button back to "PLAY", shine resumes
            home.SetNotice(notice);                          // the reason, in yellow, under it
            home.SetPlayEnabled(true);
        }

        /// <summary>Seed accepted — check the rules match, then go to the instructions.</summary>
        private void Arm(string matchId, ulong seed, string configHash)
        {
            _busy = false;
            _matchmakeJoining = false;
            _connectLabel = _connectSub = null;
            home.SetConnecting(false, null, null, false);

            if (!string.Equals(configHash, session.Config.ConfigHash, StringComparison.Ordinal))
            {
                // The server's config changed between startup and staking.
                // Driving anyway means a run refused at submit after the stake
                // was taken — tell the player to restart, the cheap failure.
                Fail("The game rules changed. Restart the app before playing.");
                return;
            }

            _matchId = matchId;
            _seed = seed;
            _configHash = configHash;
            _pendingOwnScore = null;
            _pendingLostReason = null;
            home.SetNotice(string.Empty);
            EnterInstructions();
        }

        private void EnterInstructions()
        {
            if (runHost != null)
            {
                // Arm the run now — frozen — so the road and car BEHIND the
                // instructions panel render from tick 0. BeginRun raises
                // RunStarted, which clears the previous run's wreck, crash
                // particles and stale hazard meshes; without this the
                // "tap to start" screen shows the last crash. Nothing advances
                // until "GO!".
                runHost.enabled = true;
                runHost.Frozen = true;
                runHost.BeginRun(_seed);
            }

            ShowOnly(instructions.gameObject);
        }

        private void OnInstructionsDismissed()
        {
            _inRun = true;
            SetHud(true);
            if (runExit != null) runExit.SetArmed(true);
            ShowOnly(readyGo.gameObject);
            readyGo.Play();
        }

        private void OnGo()
        {
            if (runHost != null) runHost.Frozen = false;   // the core advances now
        }

        private void OnRunEnded(RunResult result)
        {
            _inRun = false;
            if (runExit != null) runExit.SetArmed(false);

            // Queue the evidence first — the submission window is already
            // running and nothing about the UI should stall it. A double-tap
            // quit lands here too (RunHost.AbortRun -> Finish(Abandoned)); its
            // evidence scores zero and settles in the background just the same.
            if (_matchId != null && submissions != null && session != null)
            {
                var envelope = RedlineSession.Envelope(session.Config.ConfigHash, runHost.Recorded, result);
                var deadline = DateTimeOffset.UtcNow.AddSeconds(SubmitWindowSeconds - DeadlineMarginSeconds);
                submissions.Enqueue(_matchId, envelope, deadline);
            }

            if (_quitting)
            {
                // Double-tapped the chevron: no crash animation, no result
                // screen — straight to the home scene. SubmissionQueue lives on
                // the Online root and keeps delivering the (zero) run from the
                // lobby.
                _quitting = false;
                GoHome();
                return;
            }

            // The run object stays enabled so the crashed car, the blast and the
            // shake keep rendering. Hold the panel back a beat on a crash so the
            // explosion reads before "CRASHED" lands; a bank is immediate.
            SetHud(true);
            bool banked = result.Outcome == RunOutcome.Banked;

            if (_gameOverDelay.isAlive) _gameOverDelay.Stop();
            if (banked) ShowGameOver(true);
            else _gameOverDelay = Tween.Delay(crashPanelHoldSeconds, () => ShowGameOver(false), useUnscaledTime: true);
        }

        private void ShowGameOver(bool banked)
        {
            ShowOnly(gameOver.gameObject);
            gameOver.Show(banked);
        }

        private void OnGameOverDismissed()
        {
            SetHud(false);
            _resultFetched = false;
            ShowOnly(opponentPlaying.gameObject);

            if (_matchId == null)
            {
                opponentPlaying.ShowPractice(_stakeCents, _seed);
                return;
            }

            opponentPlaying.ShowSending(_matchId);

            // The submission may already have been answered while this panel was
            // still behind the game-over screen — replay whatever it said rather
            // than sit on "Sending…".
            if (_pendingOwnScore is { } r)
            {
                opponentPlaying.ShowOwnScore(r.serverScore, IsBanked(r.outcome), r.disagreed);
                _pendingOwnScore = null;
            }
            else if (_pendingLostReason != null)
            {
                opponentPlaying.ShowLost(_pendingLostReason);
                _pendingLostReason = null;
            }

            // Fires again the moment the match settles — no poll.
            _matchSub?.Dispose();
            _matchSub = session.Backend.ObserveMatch(_matchId, OnMatchUpdate);
        }

        private void OnSubmitted(SubmitRunResult r)
        {
            if (_matchId == null) return;
            if (!Waiting)
            {
                // Panel not up yet — OnGameOverDismissed will replay this.
                _pendingOwnScore = r;
                _pendingLostReason = null;
                return;
            }
            opponentPlaying.ShowOwnScore(r.serverScore, IsBanked(r.outcome), r.disagreed);
        }

        // submitRun returns the sim's RunOutcome verbatim — "Banked" / "Crashed"
        // (PascalCase, Backend/sim-core-ts RunOutcome). An `== "banked"` test was
        // silently always false, so the interstitial showed "Your run: 0" for a
        // run that actually banked.
        private static bool IsBanked(string outcome) =>
            string.Equals(outcome, "banked", StringComparison.OrdinalIgnoreCase);

        private void OnAbandoned(SubmissionQueue.Pending pending, string reason)
        {
            if (!Waiting)
            {
                _pendingLostReason = reason;
                _pendingOwnScore = null;
                return;
            }
            opponentPlaying.ShowLost(reason);
        }

        private void OnMatchUpdate(MatchView v)
        {
            if (v.settled && !_resultFetched)
            {
                _resultFetched = true;
                _ = FetchResultAsync();
            }
        }

        private async Task FetchResultAsync()
        {
            try
            {
                var r = await session.Backend.GetResultAsync(_matchId);
                if (Waiting)
                    opponentPlaying.ShowSettled(
                        r.result, r.yourScore, r.opponentScore,
                        r.potCents, r.rakeCents, r.creditedCents, r.netCents,
                        r.ratingBefore, r.ratingAfter, r.ratingDelta);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[redline] result fetch failed: {ex.Message}");
                _resultFetched = false;   // let a later ObserveMatch tick retry
            }
        }

        private void OnContinued() => GoHome();

        // ------------------------------------------------------- exit control

        /// <summary>
        /// The player double-tapped the chevron (or the device back key). Leave
        /// the run now, no result screen, back to the home scene. It is scored
        /// zero: a run that never banked scores zero (ADR 0004), and for a
        /// staked match the evidence is still queued so the books settle in the
        /// background.
        /// </summary>
        private void OnQuitToHome()
        {
            if (!_inRun) return;

            _quitting = true;
            if (runHost != null && !runHost.Outcome.HasValue)
                runHost.AbortRun();   // -> OnRunEnded, which sees _quitting and goes straight home
            else
            {
                _quitting = false;
                GoHome();
            }
        }

        // ------------------------------------------------------------- helpers

        private void ShowOnly(GameObject panel)
        {
            if (auth != null) SetActiveIfNot(auth.gameObject, panel == auth.gameObject);
            SetActiveIfNot(home.gameObject, panel == home.gameObject);
            SetActiveIfNot(instructions.gameObject, panel == instructions.gameObject);
            SetActiveIfNot(readyGo.gameObject, panel == readyGo.gameObject);
            SetActiveIfNot(gameOver.gameObject, panel == gameOver.gameObject);
            SetActiveIfNot(opponentPlaying.gameObject, panel == opponentPlaying.gameObject);
        }

        private void SetHud(bool on)
        {
            if (hudRoot != null && hudRoot.activeSelf != on) hudRoot.SetActive(on);
        }

        private static void SetActiveIfNot(GameObject go, bool on)
        {
            if (go != null && go.activeSelf != on) go.SetActive(on);
        }

        /// <summary>
        /// Mirrors <c>money.noSubmission.windowSeconds</c>. Not fetched — economy
        /// config is server-only (invariant 10); this only bounds client retries,
        /// the server's own deadline decides the match.
        /// </summary>
        private const int SubmitWindowSeconds = 180;
        private const int DeadlineMarginSeconds = 10;
    }
}
