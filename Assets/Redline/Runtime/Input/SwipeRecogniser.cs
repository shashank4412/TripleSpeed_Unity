using System;
using UnityEngine;

namespace Redline.Client.Input
{
    /// <summary>
    /// Swipe recogniser tuning, from Settings/redline.input.json.txt. Client-only
    /// and deliberately not in redline.game.json — that file is hashed on every
    /// submission, so retuning swipe feel would invalidate old runs. Nothing here
    /// can change a score.
    /// </summary>
    [Serializable]
    public sealed class SwipeSettings
    {
        public float minimumDistancePixels = 42f;
        public float maximumDurationSeconds = 0.45f;
        public float deadZoneRatio = 1.4f;
        public bool allowHoldRepeat;

        public static SwipeSettings Parse(string json) => JsonUtility.FromJson<SwipeSettings>(json);
    }

    /// <summary>
    /// Turns a drag into at most one swipe. Fed positions and timestamps, so an
    /// EditMode test can drive synthetic gestures without a touchscreen — the
    /// reason it is not inside the MonoBehaviour. Resolves on release, not on
    /// crossing the threshold mid-drag, so releasing back where you started does
    /// nothing.
    /// </summary>
    public sealed class SwipeRecogniser
    {
        private readonly SwipeSettings _settings;

        private bool _tracking;
        private Vector2 _origin;
        private float _startedAt;

        public SwipeRecogniser(SwipeSettings settings) => _settings = settings;

        public void Begin(Vector2 position, float time)
        {
            _tracking = true;
            _origin = position;
            _startedAt = time;
        }

        /// <summary>
        /// Ends a gesture and reports the swipe it was, if any. False for a tap,
        /// a slow drag, a mostly-vertical move, or a release with no begin.
        /// </summary>
        public bool End(Vector2 position, float time, out Core.SwipeDirection direction)
        {
            direction = default;

            if (!_tracking) return false;
            _tracking = false;

            if (time - _startedAt > _settings.maximumDurationSeconds) return false;

            Vector2 travel = position - _origin;
            float horizontal = Mathf.Abs(travel.x);

            if (horizontal < _settings.minimumDistancePixels) return false;

            // Horizontal has to clearly beat vertical. A one-handed thumb
            // travels in an arc, so a lane change is always partly vertical and
            // the test cannot be "more horizontal than vertical".
            if (horizontal < Mathf.Abs(travel.y) * _settings.deadZoneRatio) return false;

            direction = travel.x > 0 ? Core.SwipeDirection.Right : Core.SwipeDirection.Left;
            return true;
        }

        public void Cancel() => _tracking = false;
    }
}
