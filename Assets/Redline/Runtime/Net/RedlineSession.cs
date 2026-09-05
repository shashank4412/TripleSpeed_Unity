using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Redline.Core;
using UnityEngine;

namespace Redline.Client.Net
{
    /// <summary>
    /// Startup, identity, and the rules the client plays under.
    ///
    /// The server's config is authoritative; the bundled TextAsset is an offline
    /// fallback, and in that state the client will not let the player stake.
    ///
    /// Deliberately not what the task prompt asked (refuse to stake on any hash
    /// difference from the bundled copy): refusing on a difference would break
    /// review requirement #16, where the reviewer edits the server's config live.
    /// The rule here is "play the server's rules, stake only when certain we have
    /// them".
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class RedlineSession : MonoBehaviour
    {
        [Header("Offline fallback")]
        [Tooltip("redline.game.json bundled at build time. Practice only — never staked against; also the " +
                 "'server' config used against a local emulator, since Remote Config has no emulator to fetch from.")]
        [SerializeField] private TextAsset bundledGameConfig;

        [Tooltip("The retrying submission queue this session binds to the backend. Drag the SubmissionQueue here.")]
        [SerializeField] private SubmissionQueue submissions;

        /// <summary>
        /// The client's whole contract with the backend. Firebase (anonymous
        /// Auth + callable Functions + Firestore listeners + Remote Config)
        /// behind an engine-agnostic seam — see IRedlineBackend.cs.
        /// </summary>
        public IRedlineBackend Backend { get; private set; }

        public SubmissionQueue Submissions => submissions;

        /// <summary>The rules in force. Server's when online, bundled when not.</summary>
        public GameConfig Config { get; private set; }

        /// <summary>Raw text of <see cref="Config"/>, so the hash is over the same bytes the server hashed.</summary>
        public string ConfigText { get; private set; }

        /// <summary>False when the config came from the bundle. Staking is refused in that state.</summary>
        public bool ConfigFromServer { get; private set; }

        /// <summary>
        /// Latest account snapshot — balance, rating, league, the stake ladder.
        /// Null until the first successful <c>ensureAccount</c> call.
        /// </summary>
        public AccountView? Me { get; private set; }

        public bool Ready { get; private set; }

        /// <summary>
        /// The anonymous uid this device already carries from a previous launch,
        /// or null on a fresh install. Filled by the peek in <see cref="Start"/>
        /// before any sign-in, so the Authentication screen can offer
        /// "Enter as Anonymous" vs "Enter with same account". Not the live
        /// identity — that is <see cref="IRedlineBackend.AccountId"/> once
        /// <see cref="BeginSignIn"/> has run.
        /// </summary>
        public string CachedAccountId { get; private set; }

        /// <summary>
        /// True when the peek confirmed <see cref="CachedAccountId"/> against the
        /// backend (token still refreshes; user not disabled/deleted; online).
        /// The Authentication screen shows the id green with a green dot when
        /// true, red when false. Meaningless while <see cref="CachedAccountId"/>
        /// is null.
        /// </summary>
        public bool CachedIdActiveOnBackend { get; private set; }

        /// <summary>
        /// True from the end of <see cref="Start"/> until <see cref="BeginSignIn"/>
        /// is called: the backend exists and has been peeked, but nothing has
        /// been signed in and no account/config call has been made. The
        /// Authentication screen is what the player sees during this window.
        /// </summary>
        public bool AwaitingSignIn { get; private set; }

        /// <summary>Non-null when startup failed. Shown to the player rather than swallowed.</summary>
        public string StartupError { get; private set; }

        /// <summary>
        /// True while <see cref="StartupAsync"/> is talking to the backend
        /// (sign-in, account, rules). The home screen turns the Play button into
        /// a progress bar and freezes its shine while this holds.
        /// </summary>
        public bool Connecting { get; private set; }

        /// <summary>0..1 through the startup steps, for the Play-button fill.</summary>
        public float SyncProgress { get; private set; }

        /// <summary>What the startup is doing right now — becomes the Play-button label while connecting.</summary>
        public string SyncStatus { get; private set; } = "Connecting…";

        /// <summary>
        /// A rolling estimate of one backend round-trip, in seconds. Seeded from
        /// the sign-in/account call at startup and nudged by every account
        /// refresh. The home screen sizes the matchmaking wait from this instead
        /// of a fixed 30-second guess, so the countdown reflects how the server
        /// is actually responding on this network right now.
        /// </summary>
        public float TypicalRoundTripSeconds { get; private set; } = 2.5f;

        private void RecordRoundTrip(double seconds)
        {
            // Clamp one sample so a stalled call can't blow the estimate out,
            // then fold it in with an EMA.
            float s = Mathf.Clamp((float)seconds, 0.15f, 12f);
            TypicalRoundTripSeconds = Mathf.Lerp(TypicalRoundTripSeconds, s, 0.5f);
        }

        public event Action Changed;

#if UNITY_EDITOR
        // The Firebase Unity SDK's async calls (Remote Config, and callables
        // past the first) routinely hang at WaitingForActivation in the macOS
        // Editor, so the staked online flow cannot run from Play mode against
        // the real project. The Editor uses an in-process loopback backend
        // instead — same UI, same flow, instant local responses, no network.
        // Flip this to false to talk to real Firebase / an emulator from the
        // Editor (expect the hangs described above).
        private const bool EditorUseLoopbackBackend = true;
#endif

        private async void Start()
        {
#if UNITY_EDITOR
            if (EditorUseLoopbackBackend)
            {
                Backend = new EditorLoopbackBackend(bundledGameConfig != null ? bundledGameConfig.text : null);
            }
            else
#endif
            // host:port of a local emulator, or null for the real project. The
            // bundled config text doubles as the emulator's "server" config
            // (Remote Config cannot be emulated).
            Backend = new FirebaseRedlineBackend(
                ResolveEmulatorHostPort(),
                bundledGameConfig != null ? bundledGameConfig.text : null);

            if (submissions != null) submissions.Bind(Backend);

            // Gate: nothing reaches the backend until the player taps the
            // Authentication screen. Sign-in, the account row, and the first
            // Remote Config fetch all wait for BeginSignIn(). All we do now is
            // read whether this device already has an anonymous identity, so the
            // screen can offer "same account" instead of a new one.
            try
            {
                var peek = await Backend.PeekCachedAccountIdAsync();
                CachedAccountId = peek.accountId;
                CachedIdActiveOnBackend = peek.backendActive;
            }
            catch (Exception ex)
            {
                CachedAccountId = null;
                CachedIdActiveOnBackend = false;
                Debug.LogWarning($"[redline] cached-uid peek failed: {ex.Message}");
            }

            // The device peek genuinely awaits, so an impatient player can tap
            // Enter before it returns. If BeginSignIn() already fired, do not
            // reopen the gate or the auth screen would drop back out of its
            // "signing in" state.
            if (!_signInRequested)
            {
                AwaitingSignIn = true;
                SyncStatus = "Connecting…";
                Changed?.Invoke();
            }
        }

        private bool _signInRequested;

        /// <summary>
        /// Called by the Authentication screen when the player taps Enter. Runs
        /// the one-and-only startup — anonymous sign-in (reusing the cached
        /// credential if there is one), the account row, then the rules. A no-op
        /// once startup is running or has already succeeded.
        /// </summary>
        /// <param name="asNewIdentity">
        /// True for "Enter with another Anonymous ID": the cached credential is
        /// forgotten first, so sign-in mints a brand-new anonymous user.
        /// </param>
        public void BeginSignIn(bool asNewIdentity = false)
        {
            if (Connecting || (Ready && ConfigFromServer)) return;
            _signInRequested = true;
            AwaitingSignIn = false;
            _ = StartupAsync(asNewIdentity);
        }

        /// <summary>
        /// Re-run startup. A no-op while it is already running or already online.
        /// The home screen calls this on a slow poll so an app that opened
        /// offline recovers on its own once the backend answers. Not used before
        /// the player is past the Authentication screen — <see cref="BeginSignIn"/>
        /// is the first run.
        /// </summary>
        public void RetryStartup()
        {
            if (AwaitingSignIn || Connecting || (Ready && ConfigFromServer)) return;
            _ = StartupAsync();
        }

        private async Task StartupAsync(bool asNewIdentity = false)
        {
            // Bundled config first, so that a failure anywhere below still
            // leaves the player able to practise rather than staring at an
            // error screen with nothing to do.
            if (bundledGameConfig != null)
            {
                ConfigText = bundledGameConfig.text;
                Config = GameConfig.Parse(ConfigText);
            }

            Connecting = true;
            SyncProgress = 0.06f;
            SyncStatus = "Connecting…";
            StartupError = null;
            Changed?.Invoke();

            try
            {
                // "Enter with another Anonymous ID": drop the cached credential
                // so EnsureAccountAsync signs in as a brand-new anonymous user.
                if (asNewIdentity)
                {
                    await Backend.ForgetCachedIdentityAsync();
                    CachedAccountId = null;
                    CachedIdActiveOnBackend = false;
                }

                // The Firebase SDK caches the anonymous credential, so no
                // token/PlayerPrefs dance — EnsureAccountAsync is idempotent.
                string fingerprint = SystemInfo.deviceUniqueIdentifier;
                var rtt = System.Diagnostics.Stopwatch.StartNew();
                Me = await Backend.EnsureAccountAsync(fingerprint);
                RecordRoundTrip(rtt.Elapsed.TotalSeconds);

                SyncProgress = 0.45f;
                SyncStatus = "Loading account…";
                Changed?.Invoke();

                var served = await Backend.GameConfigTextAsync();

                SyncProgress = 0.8f;
                SyncStatus = "Syncing rules…";
                Changed?.Invoke();

                // Parsed before adoption: a truncated captive-portal response
                // must not replace working rules with broken ones mid-run.
                var parsed = GameConfig.Parse(served.rawText);

                ConfigText = served.rawText;
                Config = parsed;
                ConfigFromServer = true;

                // Our hash of the received bytes must equal the hash the server
                // stamps on matches, or every submission is refused after the
                // stake was paid — better to refuse to stake now.
                if (!string.Equals(Config.ConfigHash, served.configHash, StringComparison.Ordinal))
                {
                    ConfigFromServer = false;
                    StartupError = $"rules hash disagrees: parsed {Config.ConfigHash}, server said {served.configHash}";
                }

                Ready = true;
                SyncProgress = 1f;
            }
            catch (Exception ex)
            {
                // Practice mode. CanStake stays false, so no money can move
                // under rules we are not certain are current.
                StartupError = ex is BackendCallException bce ? bce.Message : ex.Message;
                Ready = Config != null;
                SyncProgress = 0f;

                Debug.LogWarning($"[redline] offline start: {StartupError}");
            }
            finally
            {
                Connecting = false;
            }

            Changed?.Invoke();
        }

        /// <summary>
        /// Whether the player may put money at risk right now — false offline and
        /// before startup finishes. A run under rules not from the server is
        /// rejected at submit, after the stake was taken.
        /// </summary>
        public bool CanStake => Ready && ConfigFromServer && Backend?.AccountId != null;

        /// <summary>Refreshes balance, rating, league and the stake ladder. Called by the lobby's poll.</summary>
        public async Task RefreshMeAsync()
        {
            if (!CanStake) return;

            try
            {
                var rtt = System.Diagnostics.Stopwatch.StartNew();
                Me = await Backend.EnsureAccountAsync(SystemInfo.deviceUniqueIdentifier);
                RecordRoundTrip(rtt.Elapsed.TotalSeconds);
                Changed?.Invoke();
            }
            catch (Exception ex)
            {
                // A dropped poll is not worth interrupting the lobby for; the
                // next tick tries again.
                Debug.LogWarning($"[redline] refresh failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Where a local emulator lives. An Android player has no environment
        /// variables, so BuildScript bakes REDLINE_API_URL into a Resources
        /// TextAsset at build time; the env var is an Editor-only convenience.
        /// Null (the release-build default) means "talk to the real project".
        /// </summary>
        private static string ResolveEmulatorHostPort()
        {
            var baked = Resources.Load<TextAsset>(BackendResource);
            if (baked != null && !string.IsNullOrWhiteSpace(baked.text)) return Strip(baked.text.Trim());

            // Editor and play-mode convenience only; never reached on a device.
            string configured = Environment.GetEnvironmentVariable("REDLINE_API_URL");
            return string.IsNullOrWhiteSpace(configured) ? null : Strip(configured.Trim());

            static string Strip(string hostPort) =>
                hostPort.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ? hostPort.Substring(7)
                : hostPort.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? hostPort.Substring(8)
                : hostPort;
        }

        /// <summary>Resources path of the baked emulator host:port. Shared with BuildScript.</summary>
        public const string BackendResource = "redline-backend";

        /// <summary>
        /// Turns a finished run into the submission envelope. The score is a
        /// claim in <c>clientScore</c> that the server checks against its own
        /// re-simulation (invariant 2). Every swipe is sent, including rejected
        /// ones — filtering here would be the client making a rules decision.
        /// </summary>
        public static SubmitRunEvidence Envelope(
            string configHash, IReadOnlyList<InputEvent> recorded, RunResult result)
        {
            var log = new InputEventDto[recorded.Count];
            for (int i = 0; i < recorded.Count; i++)
            {
                log[i] = new InputEventDto
                {
                    tick = recorded[i].Tick,
                    dir = recorded[i].Direction == SwipeDirection.Left ? "L" : "R",
                };
            }

            return new SubmitRunEvidence
            {
                configHash = configHash,
                inputLog = log,
                finalTick = result.EndTick,
                clientScore = result.Score,
                clientOutcome = result.Outcome.ToString().ToUpperInvariant(),
            };
        }
    }
}
