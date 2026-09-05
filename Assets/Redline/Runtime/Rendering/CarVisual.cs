using Redline.Core;
using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// Places the car between lanes and gives it weight.
    ///
    /// Presentation only: the simulation has already decided the lanes, the
    /// multiplier and any collision; this reads
    /// <see cref="Simulation.State.ChangeProgressMilli"/> and moves a transform.
    /// No Rigidbody, no physics — position is derived, never simulated.
    ///
    /// For feel, a reversal must visibly reverse from where the car actually is.
    /// The core swaps the lane ends and mirrors the timer, so progress runs
    /// backwards from where it got to; everything here reads that progress, so a
    /// reversal is followed for free.
    /// </summary>
    [RequireComponent(typeof(RunHost))]
    public sealed class CarVisual : MonoBehaviour
    {
        [Tooltip("The visual car this steers and slides. Drag the Car transform here.")]
        [SerializeField] private Transform car;

        [Tooltip("Degrees the car yaws toward the lane it is moving to — the steering read. " +
                 "The reference footage holds a hard diagonal for most of a change, so this is large.")]
        [SerializeField] private float maxSteerDegrees = 40f;

        [Tooltip("How quickly the yaw tracks its target. High, so the nose stays locked to the progress curve.")]
        [SerializeField] private float steerResponse = 24f;

        [Tooltip("Seconds the nose takes to unwind from its arrival angle once the change completes.")]
        [SerializeField] private float recoverSeconds = 0.18f;

        [Tooltip("Degrees of body roll at full steer. A fraction of the yaw — the car banks into the turn.")]
        [SerializeField] private float maxTiltDegrees = 12f;

        [Tooltip("How quickly the roll catches up. Lower is heavier.")]
        [SerializeField] private float tiltResponse = 12f;

        [Tooltip("Smooths frame-rate stutter in the sideways slide only. Kept tiny, and hard-clamped " +
                 "by maxPositionLag below, so the rendered car can never trail the simulation by more " +
                 "than a few centimetres — it only takes the edge off the steps when a frame advances >1 tick.")]
        [SerializeField] private float positionSmoothTime = 0.035f;

        [Tooltip("Hard cap on how far the rendered slide may lag the simulation position, in metres. " +
                 "Guarantees a reversal still reverses from essentially where the car actually is.")]
        [SerializeField] private float maxPositionLag = 0.3f;

        private RunHost _host;
        private LaneGeometry _geometry;

        private float _steer;
        private float _tilt;
        private float _recover;
        private float _lastDir;

        private float _renderX;
        private float _renderXVelocity;
        private bool _haveRenderX;

        // Crash: the exact pose the car was in when the collision triggered.
        // Held verbatim from then on — no lunge, no nudge into the other object.
        private bool _crashHeld;
        private Vector3 _crashPos;
        private Quaternion _crashRot;

        private void Awake()
        {
            _host = GetComponent<RunHost>();
            _geometry = new LaneGeometry(_host.Config);
            _host.RunStarted += OnRunStarted;
        }

        private void OnDestroy()
        {
            if (_host != null) _host.RunStarted -= OnRunStarted;
        }

        /// <summary>A fresh run: drop the held wreck pose and snap to the start lane rather than gliding in from the crash.</summary>
        private void OnRunStarted()
        {
            _steer = _tilt = _recover = 0f;
            _haveRenderX = false;
            _crashHeld = false;
        }

        private void LateUpdate()
        {
            var state = _host.State;
            if (state == null || car == null) return;

            // Crashed: freeze the car exactly where the collision was detected —
            // the pose is not touched again, so nothing is pushed into anything.
            if (_host.Outcome == RunOutcome.Crashed)
            {
                if (!_crashHeld)
                {
                    _crashHeld = true;
                    _crashPos = car.localPosition;
                    _crashRot = car.localRotation;
                }

                car.localPosition = _crashPos;
                car.localRotation = _crashRot;
                return;
            }

            float simX = LateralPosition(state);

            // Seed the rendered position on the first frame so it does not glide
            // in from wherever the transform happened to start.
            if (!_haveRenderX) { _renderX = simX; _haveRenderX = true; }

            // Chases the progress-derived position — removes visible stepping
            // when a frame advances >1 tick, clamped to a few cm of lag so the
            // car still arrives on the tick the rules say and a reversal still
            // reverses from where it is.
            _renderX = Mathf.SmoothDamp(_renderX, simX, ref _renderXVelocity, positionSmoothTime);
            _renderX = Mathf.Clamp(_renderX, simX - maxPositionLag, simX + maxPositionLag);

            float steerTarget = SteerTarget(state);
            _steer = Mathf.Lerp(_steer, steerTarget, 1f - Mathf.Exp(-steerResponse * Time.deltaTime));

            // Roll is a fraction of the yaw, opposite sign, so the body leans
            // into the change and settles out of it with the nose.
            float tiltTarget = -(_steer / Mathf.Max(1f, maxSteerDegrees)) * maxTiltDegrees;
            _tilt = Mathf.Lerp(_tilt, tiltTarget, 1f - Mathf.Exp(-tiltResponse * Time.deltaTime));

            car.localPosition = new Vector3(_renderX, car.localPosition.y, car.localPosition.z);
            car.localRotation = Quaternion.Euler(0f, _steer, _tilt);
        }

        /// <summary>
        /// The nose angle, locked to lane-change progress (not a
        /// finite-differenced velocity, which lagged and straightened too early).
        /// Ramps in fast, holds through the crossing, still turned on arrival,
        /// then unwinds.
        /// </summary>
        private float SteerTarget(Simulation.State state)
        {
            if (state.IsChangingLanes)
            {
                float t = state.ChangeProgressMilli(_host.Config) / (float)Units.MilliScale;
                float dir = Mathf.Sign(_geometry.CentreOf(state.TargetLane) - _geometry.CentreOf(state.Lane));

                // Fast ramp-in (done by t≈0.28), held flat across the middle,
                // easing off only past t≈0.80 so the car is still angled ~0.6 of
                // full when it settles into the new lane.
                float pose = Ramp(0f, 0.28f, t) * (1f - Ramp(0.80f, 1.30f, t));

                _recover = recoverSeconds;
                _lastDir = dir;
                return dir * pose * maxSteerDegrees;
            }

            if (_recover > 0f)
            {
                _recover -= Time.deltaTime;
                return _lastDir * Mathf.Clamp01(_recover / recoverSeconds) * maxSteerDegrees * 0.6f;
            }

            return 0f;
        }

        /// <summary>
        /// GLSL-style smoothstep — remaps <paramref name="x"/> from
        /// [<paramref name="edge0"/>, <paramref name="edge1"/>] to [0, 1], eased
        /// at both ends. (Unity's <c>Mathf.SmoothStep</c> is a different thing.)
        /// </summary>
        private static float Ramp(float edge0, float edge1, float x)
        {
            float u = Mathf.Clamp01((x - edge0) / (edge1 - edge0));
            return u * u * (3f - 2f * u);
        }

        /// <summary>
        /// Where the car is across the road, in metres. Smoothstepped on the
        /// simulation's progress value, not wall time, so the car arrives exactly
        /// when the rules say and a dropped frame cannot leave it short.
        /// </summary>
        private float LateralPosition(Simulation.State state)
        {
            float from = _geometry.CentreOf(state.Lane);

            if (!state.IsChangingLanes) return from;

            float to = _geometry.CentreOf(state.TargetLane);
            float t = state.ChangeProgressMilli(_host.Config) / (float)Units.MilliScale;

            return Mathf.Lerp(from, to, t * t * (3f - 2f * t));
        }
    }
}
