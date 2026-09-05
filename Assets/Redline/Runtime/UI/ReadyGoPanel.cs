using System;
using PrimeTween;
using TMPro;
using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// "READY" then "GO!" over the armed-but-still road.
    ///
    /// A presentation gate only: it delays the moment the run begins ticking —
    /// it fires <see cref="Go"/> as "GO!" appears and <see cref="GameFlowUi"/>
    /// unfreezes the run then. It never pauses a run in motion. Unscaled time.
    /// </summary>
    public sealed class ReadyGoPanel : MonoBehaviour
    {
        [Tooltip("The word shown — cycles READY then GO!. Drag the label TMP_Text here.")]
        [SerializeField] private TMP_Text label;

        [Tooltip("Seconds 'READY' holds before 'GO!'.")]
        [SerializeField] private float readySeconds = 0.8f;

        [Tooltip("Seconds 'GO!' holds before the panel hides.")]
        [SerializeField] private float goSeconds = 0.5f;

        /// <summary>Fires the instant "GO!" appears — the run may start ticking now.</summary>
        public event Action Go;

        private Sequence _seq;

        public void Play()
        {
            gameObject.SetActive(true);
            if (_seq.isAlive) _seq.Stop();

            if (label != null) label.SetText("READY");
            _seq = Sequence.Create(useUnscaledTime: true)
                .ChainDelay(readySeconds)
                .ChainCallback(() =>
                {
                    if (label != null) label.SetText("GO!");
                    Go?.Invoke();
                })
                .ChainDelay(goSeconds)
                .ChainCallback(() => gameObject.SetActive(false));
        }

        private void OnDisable()
        {
            if (_seq.isAlive) _seq.Stop();
        }
    }
}
