using System;
using System.IO;
using System.Threading.Tasks;
using UnityEngine;

namespace Redline.Client.Net
{
    /// <summary>
    /// Holds a finished run until the server has acknowledged it.
    ///
    /// ADR 0004: a staked player who does not submit inside the 180 s window
    /// scores zero and loses the stake, so a submission lost to a tunnel or a
    /// force-quit costs the match. The run is written to disk the moment it ends,
    /// before any network call, and retried until it lands or the window closes.
    ///
    /// The idempotency key is generated once here and persisted with the run, so
    /// every retry — including one after a restart — sends the same key. A fresh
    /// key per attempt would silently double-settle (T-303).
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class SubmissionQueue : MonoBehaviour
    {
        [Tooltip("Seconds between retries. Backs off up to MaxBackoffSeconds.")]
        [SerializeField] private float firstRetrySeconds = 1f;

        /// <summary>Raised when the server has accepted the run. Carries the score of record.</summary>
        public event Action<SubmitRunResult> Submitted;

        /// <summary>Raised when the run could not be submitted before its window closed.</summary>
        public event Action<Pending, string> Abandoned;

        /// <summary>True while a run is waiting to be acknowledged.</summary>
        public bool HasPending => _pending != null;

        private IRedlineBackend _backend;
        private Pending _pending;
        private bool _sending;
        private float _nextAttemptAt;
        private float _backoff;

        /// <summary>
        /// Bumped whenever an in-flight attempt must be disowned — a new run is
        /// enqueued, the window closed, or we came back from background onto a
        /// call whose Task will never resume. <see cref="AttemptAsync"/> captures
        /// it on entry and, after every await, drops its result if the value has
        /// moved on. Object identity on <see cref="_pending"/> is not enough: a
        /// retry reuses the same <see cref="Pending"/> instance.
        /// </summary>
        private int _attemptGen;

        /// <summary>
        /// One run waiting to be acknowledged, as persisted. Serialised whole,
        /// not rebuilt from a RunResult, so a retry after a restart sends
        /// byte-for-byte what the first attempt sent — rebuilding would
        /// re-simulate under config that may since have refreshed.
        /// </summary>
        [Serializable]
        public sealed class Pending
        {
            public string matchId;
            public string idempotencyKey;
            public SubmitRunEvidence run;

            /// <summary>Unix seconds. Absolute, so it survives the app being killed and relaunched.</summary>
            public long deadlineUnix;
        }

        public void Bind(IRedlineBackend backend) => _backend = backend;

        private void Awake() => _pending = Load();

        /// <summary>
        /// Persists the run and begins trying to submit it. Called from the
        /// run-end path, never during a run — nothing touches the wire per tick.
        /// </summary>
        public void Enqueue(string matchId, SubmitRunEvidence run, DateTimeOffset deadline)
        {
            _pending = new Pending
            {
                matchId = matchId,
                run = run,

                // Once, then reused by every retry (this process or a later one)
                // because it is written to disk with the run.
                idempotencyKey = Guid.NewGuid().ToString("N"),
                deadlineUnix = deadline.ToUnixTimeSeconds(),
            };

            // Before the first send: if the app dies now, the run is still on
            // disk and still submittable.
            Save(_pending);

            _attemptGen++;   // any attempt still in flight for a previous run is now stale
            _sending = false;
            _backoff = firstRetrySeconds;
            _nextAttemptAt = 0f;
        }

        private void Update()
        {
            if (_pending == null || _backend == null) return;

            // Deadline FIRST — before the _sending guard, deliberately. A send
            // whose Task never completes (the app was stopped mid-call, so the
            // Firebase SDK's main-thread pump halted and the callable's
            // completion callback was orphaned) would otherwise hold
            // _sending == true forever and this method would early-return every
            // frame: "Sending your run…" with no end. The server settles a
            // no-show as ABANDONED at zero regardless of what the client does,
            // so say so here rather than spin.
            if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() > _pending.deadlineUnix)
            {
                var lost = _pending;
                Clear();
                _attemptGen++;      // disown any in-flight attempt
                _sending = false;   // its finally may never run
                Abandoned?.Invoke(lost, "The submission window closed before this run could be sent.");
                return;
            }

            if (_sending) return;
            if (Time.unscaledTime < _nextAttemptAt) return;

            _ = AttemptAsync();
        }

        private void OnApplicationPause(bool paused)
        {
            // Returning from background. If a send was in flight when the OS
            // stopped us, its callable Task's completion was delivered into a
            // halted main loop and is not coming back — the await in
            // AttemptAsync will never resume. Drop the in-flight state so the
            // next Update() starts a fresh attempt; it reuses the persisted
            // idempotency key, so the server dedups and returns the original
            // result rather than settling twice.
            if (paused || _pending == null) return;
            _attemptGen++;   // the in-flight attempt's await will not resume; disown it
            _sending = false;
            _backoff = firstRetrySeconds;
            _nextAttemptAt = 0f;
        }

        private async Task AttemptAsync()
        {
            int gen = ++_attemptGen;
            _sending = true;
            Pending attempt = _pending;

            try
            {
                var response = await _backend.SubmitRunAsync(attempt.matchId, attempt.run, attempt.idempotencyKey);

                // A newer attempt has taken over, or Update()'s deadline path
                // abandoned this run, while we were awaiting a call that
                // eventually returned. Either way this answer is stale — drop it
                // rather than fire a second Submitted/Abandoned.
                if (gen != _attemptGen || _pending == null) return;

                if (response.ok)
                {
                    Clear();
                    Submitted?.Invoke(response);
                }
                else
                {
                    // The server understood and refused (duplicate, closed
                    // window, stale config, gone match). An answer, not a
                    // dropped call — resending cannot change it.
                    var refused = _pending;
                    Clear();
                    Abandoned?.Invoke(refused, response.result ?? "The server refused this submission.");
                }
            }
            catch (BackendCallException bce) when (bce.Retryable)
            {
                if (gen != _attemptGen || _pending == null) return;

                // Doubling, capped — a phone leaving a tunnel gains nothing from
                // being hammered, and the window gives minutes of room. A
                // stalled call that Call() timed out lands here too, so a send
                // orphaned by a background/stop is retried on its own.
                _backoff = Mathf.Min(_backoff * 2f, MaxBackoffSeconds);
                _nextAttemptAt = Time.unscaledTime + _backoff;
            }
            catch (BackendCallException bce)
            {
                if (gen != _attemptGen || _pending == null) return;

                // Non-retryable (invalid argument, denied, unauthenticated):
                // retrying sends the same bytes into the same refusal.
                var refused = _pending;
                Clear();
                Abandoned?.Invoke(refused, bce.Message);
            }
            finally
            {
                // Only release the flag if we are still the current attempt; a
                // newer one owns _sending now.
                if (gen == _attemptGen) _sending = false;
            }
        }

        private void Clear()
        {
            _pending = null;

            // Deleted only after the server answered — until then the file is
            // all that stands between a backgrounded app and a forfeited stake.
            if (File.Exists(Path)) File.Delete(Path);
        }

        private static string Path =>
            System.IO.Path.Combine(Application.persistentDataPath, "pending-submission.json");

        private static void Save(Pending pending)
        {
            try
            {
                File.WriteAllText(Path, JsonUtility.ToJson(pending));
            }
            catch (Exception ex)
            {
                // No writable storage still submits — it just loses the
                // crash-survival guarantee. Failing here would lose the stake.
                Debug.LogWarning($"could not persist pending submission: {ex.Message}");
            }
        }

        private static Pending Load()
        {
            try
            {
                return File.Exists(Path) ? JsonUtility.FromJson<Pending>(File.ReadAllText(Path)) : null;
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"could not read pending submission: {ex.Message}");
                return null;
            }
        }

        private const float MaxBackoffSeconds = 15f;
    }
}
