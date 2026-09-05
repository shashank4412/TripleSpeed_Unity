using PrimeTween;
using Redline.Client.Rendering;
using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// Fades a rainbow corner-glow (<see cref="RainbowVignette"/>) in while the
    /// car is on — or moving to / from — the 5x lane, and out when it leaves. It
    /// only eases a <see cref="CanvasGroup"/> and spins the vignette's hue;
    /// the shape is all in the graphic. Presentation only.
    /// </summary>
    [RequireComponent(typeof(CanvasGroup))]
    public sealed class ScreenRainbow : MonoBehaviour
    {
        [Tooltip("The run host, read for the current lane. Drag the Run object here.")]
        [SerializeField] private RunHost host;

        [Tooltip("The corner-glow graphic whose hue this spins. Drag the RainbowVignette here.")]
        [SerializeField] private RainbowVignette vignette;

        [Tooltip("Seconds for the wash to fade in when the 5x lane is entered, and out when it is left.")]
        [SerializeField] private float fadeSeconds = 0.28f;

        [Tooltip("Hue rotations per second — how fast the corner colours flow.")]
        [SerializeField] private float flowSpeed = 0.12f;

        [Tooltip("Breathing pulse of the wash while it is showing, in Hz.")]
        [SerializeField] private float pulseHz = 0.7f;

        private CanvasGroup _group;
        private int _rainbowLane;
        private float _phase;
        private bool _on;
        private Tween _fade;
        private Tween _pulse;

        private void Awake()
        {
            _group = GetComponent<CanvasGroup>();
            _group.alpha = 0f;
            _group.blocksRaycasts = false;
            _group.interactable = false;

            if (host != null && host.Config != null)
                _rainbowLane = LaneGeometry.HottestScoringLane(host.Config);
        }

        private void Update()
        {
            var state = host != null ? host.State : null;
            bool on = state != null && (state.Lane == _rainbowLane || state.TargetLane == _rainbowLane);
            if (on != _on) SetOn(on);

            // Hue flow is a scroll, not an ease — a plain accumulator, the same
            // shape RoadTreadmill uses for the road.
            _phase = Mathf.Repeat(_phase + flowSpeed * Time.deltaTime, 1f);

            if (vignette != null && _group.alpha > 0.002f)
            {
                vignette.Phase = _phase;
                vignette.SetVerticesDirty();
            }
        }

        private void SetOn(bool on)
        {
            _on = on;
            if (_fade.isAlive) _fade.Stop();
            if (_pulse.isAlive) _pulse.Stop();

            if (!on)
            {
                _fade = Tween.Alpha(_group, 0f, fadeSeconds, Ease.OutSine);
                return;
            }

            // Fade in, then hand the same alpha to a breathing yoyo. An infinite
            // tween can't live inside a Sequence, so it starts on completion.
            _fade = Tween.Alpha(_group, 0.9f, fadeSeconds, Ease.OutSine)
                .OnComplete(this, self =>
                {
                    if (!self._on) return;
                    self._pulse = Tween.Alpha(self._group, 0.85f, 1f,
                        0.5f / Mathf.Max(0.01f, self.pulseHz),
                        Ease.InOutSine, cycles: -1, cycleMode: CycleMode.Yoyo);
                });
        }

        private void OnDisable()
        {
            if (_fade.isAlive) _fade.Stop();
            if (_pulse.isAlive) _pulse.Stop();
        }
    }
}
