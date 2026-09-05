using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// The in-run exit: a small top-left chevron. One press (button or device
    /// back key) flashes a hint; a second within a short window raises
    /// <see cref="QuitConfirmed"/> — leave now, scored zero.
    ///
    /// No modal, no pause: quitting is only ever a loss (ADR 0004), so the run
    /// keeps advancing under the hint.
    /// </summary>
    public sealed class RunExitControl : MonoBehaviour
    {
        [Tooltip("The top-left chevron button. One press hints, a second within the window quits.")]
        [SerializeField] private Button chevronButton;

        [Tooltip("Root of the 'double-tap to quit' hint. Shown on a single press, hidden after hintSeconds.")]
        [SerializeField] private GameObject hint;

        [Tooltip("A second press within this many seconds counts as the double-tap that quits.")]
        [SerializeField] private float doubleTapWindowSeconds = 1.4f;

        [Tooltip("How long the hint stays up after a single press.")]
        [SerializeField] private float hintSeconds = 2.5f;

        /// <summary>The player double-tapped the chevron (or the device back key). Leave the run.</summary>
        public event Action QuitConfirmed;

        private bool _armed;
        private float _firstPressAt = float.NegativeInfinity;
        private float _hintHideAt;

        private void Awake()
        {
            if (chevronButton != null) chevronButton.onClick.AddListener(Press);
            if (hint != null) hint.SetActive(false);
        }

        /// <summary>On only while a run is in progress; GameFlowUi drives this.</summary>
        public void SetArmed(bool on)
        {
            _armed = on;
            gameObject.SetActive(on);
            if (!on)
            {
                _firstPressAt = float.NegativeInfinity;
                if (hint != null) hint.SetActive(false);
            }
        }

        /// <summary>A press of the chevron or the device back key.</summary>
        public void Press()
        {
            if (!_armed) return;

            float now = Time.unscaledTime;
            if (now - _firstPressAt <= doubleTapWindowSeconds)
            {
                _firstPressAt = float.NegativeInfinity;
                if (hint != null) hint.SetActive(false);
                QuitConfirmed?.Invoke();
                return;
            }

            _firstPressAt = now;
            if (hint != null)
            {
                hint.SetActive(true);
                _hintHideAt = now + hintSeconds;
            }
        }

        private void Update()
        {
            if (hint != null && hint.activeSelf && Time.unscaledTime >= _hintHideAt)
                hint.SetActive(false);
        }
    }
}
