using PrimeTween;
using Redline.Core;
using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// The two ways a run ends, and they must not feel alike. A crash is a hard
    /// stop and a visible zero — nothing here softens it. A bank is relief. Both
    /// hand back in a few hundred milliseconds.
    ///
    /// Observes only: subscribes to <see cref="RunHost.RunEnded"/> and reads the
    /// result. Nothing here can change what happened.
    /// </summary>
    [RequireComponent(typeof(RunHost))]
    public sealed class RunEndPresenter : MonoBehaviour
    {
        [Tooltip("The camera transform the crash shake moves. Drag the run camera here.")]
        [SerializeField] private Transform shakeTarget;

        [Tooltip("The HUD view whose score collapses to 0 on a crash. Drag RunHudView here.")]
        [SerializeField] private RunHudView scoreDisplay;

        [Tooltip("The crash FX rig. Drag the CrashFx component here.")]
        [SerializeField] private Redline.Client.Rendering.CrashFx crashFx;

        [Tooltip("Seconds the crash shake lasts. Short: this is a punch, not a cutscene.")]
        [SerializeField] private float shakeSeconds = 0.5f;

        [Tooltip("Peak camera displacement of the crash shake, in metres.")]
        [SerializeField] private float shakeMetres = 0.5f;

        [Tooltip("Shake oscillation frequency, in Hz.")]
        [SerializeField] private float shakeFrequency = 10f;

        [Tooltip("Seconds before handing back to the lobby. Deliberately brief.")]
        [SerializeField] private float returnDelaySeconds = 1.2f;

        private RunHost _host;
        private Vector3 _restPosition;
        private Tween _shake;
        private Tween _return;
        private RunResult _result;

        /// <summary>Raised when the presentation is done and the lobby should take over.</summary>
        public event System.Action<RunResult> ReadyToReturn;

        private void Awake()
        {
            _host = GetComponent<RunHost>();
            _host.RunEnded += OnRunEnded;
            _host.RunStarted += OnRunStarted;
        }

        private void Start()
        {
            // In Start, not Awake: RoadRenderer frames the camera in its own
            // Awake and the order between two Awakes is undefined. Here it is
            // the framed position, so the shake resets to that, not to (0,0,0).
            if (shakeTarget != null) _restPosition = shakeTarget.localPosition;
        }

        private void OnDestroy()
        {
            if (_shake.isAlive) _shake.Stop();
            if (_return.isAlive) _return.Stop();
            if (_host != null)
            {
                _host.RunEnded -= OnRunEnded;
                _host.RunStarted -= OnRunStarted;
            }
        }

        /// <summary>
        /// A fresh run is arming: undo everything the last crash left running —
        /// shake, pending hand-back, collapsed score, crash particles — so a
        /// quick replay does not open on the previous wreck.
        /// </summary>
        private void OnRunStarted()
        {
            if (_shake.isAlive) _shake.Stop();
            if (_return.isAlive) _return.Stop();
            if (shakeTarget != null) shakeTarget.localPosition = _restPosition;
            if (scoreDisplay != null) scoreDisplay.SetScore(0);
            if (crashFx != null) crashFx.ClearAll();
        }

        private void OnRunEnded(RunResult result)
        {
            _result = result;

            if (result.Outcome == RunOutcome.Banked)
            {
                // The core only reports Banked on full arrival in the cashout
                // lane, so this cannot fire on a swipe.
                if (scoreDisplay != null) scoreDisplay.SetScore(result.Score);
            }
            else
            {
                // The zero has to be seen collapsing, not drifted to.
                if (scoreDisplay != null) scoreDisplay.SetScore(0);

                // Falloff shake — hardest at the crash, gone by shakeSeconds.
                // PrimeTween's shake uses System.Random, never UnityEngine.Random
                // (invariant 8: nothing perturbs the sim's PRNG state).
                if (shakeTarget != null)
                    _shake = Tween.ShakeLocalPosition(shakeTarget,
                        new Vector3(shakeMetres, shakeMetres, 0f), shakeSeconds,
                        frequency: shakeFrequency, useUnscaledTime: true);

                // Cartoon blast at the wreck, over the road — GameFlowUi holds
                // the clear-backed "CRASHED" panel back a beat.
                if (crashFx != null) crashFx.Play();
            }

            if (_return.isAlive) _return.Stop();
            _return = Tween.Delay(returnDelaySeconds, () => ReadyToReturn?.Invoke(_result),
                useUnscaledTime: true);
        }
    }
}
