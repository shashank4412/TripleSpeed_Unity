using TMPro;
using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// Formats the run HUD numbers — score, effective multiplier, speed — into a
    /// screen-space TMP canvas. Computes nothing: <see cref="RunHud"/> hands it
    /// finished values from the core (review test #5).
    ///
    /// No allocation once running: each field caches its last value and calls
    /// <see cref="TMP_Text.SetText(string, float)"/> (no managed string) only
    /// when the number changed.
    /// </summary>
    public sealed class RunHudView : MonoBehaviour
    {
        [Tooltip("The large score readout.")]
        [SerializeField] private TMP_Text scoreText;

        [Tooltip("The multiplier readout (e.g. \"5X\").")]
        [SerializeField] private TMP_Text multiplierText;

        [Tooltip("The small speed readout.")]
        [SerializeField] private TMP_Text speedText;

        // long.MinValue rather than 0: a real first frame of 0 must still push
        // once so the text is not left on its authoring placeholder.
        private long _score = long.MinValue;
        private long _multiplier = long.MinValue;
        private long _speed = long.MinValue;

        /// <summary>What the player would bank if they cashed out now. Clamped at 0.</summary>
        public void SetScore(long value)
        {
            if (value == _score) return;
            _score = value;

            if (scoreText != null) scoreText.SetText("{0:0}", value < 0 ? 0 : value);
        }

        /// <summary>Effective multiplier from the core. The trailing "X" is a label.</summary>
        public void SetMultiplier(long value)
        {
            if (value == _multiplier) return;
            _multiplier = value;

            if (multiplierText != null) multiplierText.SetText("{0:0}X", value);
        }

        /// <summary>Whole units per second at the current tick.</summary>
        public void SetSpeed(long value)
        {
            if (value == _speed) return;
            _speed = value;

            if (speedText != null) speedText.SetText("{0:0}", value);
        }
    }
}
