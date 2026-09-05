using PrimeTween;
using TMPro;
using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// A gentle looping pulse — scale, and text alpha if it is on a
    /// <see cref="TMP_Text"/> — for call-to-action lines like "TAP TO CONTINUE",
    /// "TAP TO START" and "GO!". Unscaled time. Presentation only.
    /// </summary>
    [RequireComponent(typeof(RectTransform))]
    public sealed class UiPulse : MonoBehaviour
    {
        [Tooltip("Pulses per second.")]
        [SerializeField] private float hz = 1.05f;

        [Tooltip("Peak scale swing either side of rest (0.045 = ±4.5%).")]
        [SerializeField] private float scaleAmplitude = 0.045f;

        [Tooltip("Text alpha at the dim end of the pulse, as a fraction of its authored alpha.")]
        [SerializeField] private float alphaMin = 0.55f;

        private RectTransform _rt;
        private Vector3 _baseScale;
        private TMP_Text _text;
        private float _baseAlpha = 1f;

        private Tween _scale;
        private Tween _alpha;

        private void Awake()
        {
            _rt = (RectTransform)transform;
            _baseScale = _rt.localScale;
            _text = GetComponent<TMP_Text>();
            if (_text != null) _baseAlpha = _text.color.a;
        }

        private void OnEnable()
        {
            float half = 0.5f / Mathf.Max(0.01f, hz);

            _scale = Tween.Scale(_rt, _baseScale * (1f - scaleAmplitude), _baseScale * (1f + scaleAmplitude),
                half, Ease.InOutSine, cycles: -1, cycleMode: CycleMode.Yoyo, useUnscaledTime: true);

            if (_text != null)
                _alpha = Tween.Alpha(_text, _baseAlpha * alphaMin, _baseAlpha,
                    half, Ease.InOutSine, cycles: -1, cycleMode: CycleMode.Yoyo, useUnscaledTime: true);
        }

        private void OnDisable()
        {
            if (_scale.isAlive) _scale.Stop();
            if (_alpha.isAlive) _alpha.Stop();

            _rt.localScale = _baseScale;
            if (_text != null)
            {
                var c = _text.color;
                c.a = _baseAlpha;
                _text.color = c;
            }
        }
    }
}
