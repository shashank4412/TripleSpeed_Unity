using PrimeTween;
using TMPro;
using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// A one-shot "the number changed" flourish on a <see cref="TMP_Text"/>: a
    /// quick scale pop, a small vertical nudge, and a warm colour flash. The
    /// owner calls <see cref="Play"/> when it sets a new value. Unscaled time.
    /// Presentation only.
    /// </summary>
    [RequireComponent(typeof(RectTransform))]
    public sealed class UiValuePunch : MonoBehaviour
    {
        [Tooltip("Total length of the pop, out and back, in seconds.")]
        [SerializeField] private float duration = 0.24f;

        [Tooltip("Peak extra scale at the top of the pop (0.2 = +20%).")]
        [SerializeField] private float scalePop = 0.20f;

        [Tooltip("Peak upward nudge, in anchored-position units.")]
        [SerializeField] private float rise = 12f;

        [Tooltip("Colour the text flashes to at the peak, then eases back from.")]
        [SerializeField] private Color flash = new Color(1f, 0.74f, 0.28f);

        private RectTransform _rt;
        private TMP_Text _text;
        private Vector3 _baseScale;
        private Vector2 _basePos;
        private Color _baseColor;
        private Sequence _running;

        private void Awake()
        {
            _rt = (RectTransform)transform;
            _baseScale = _rt.localScale;
            _basePos = _rt.anchoredPosition;
            _text = GetComponent<TMP_Text>();
            if (_text != null) _baseColor = _text.color;
        }

        public void Play()
        {
            if (!isActiveAndEnabled) return;

            if (_running.isAlive) _running.Stop();
            _rt.localScale = _baseScale;
            _rt.anchoredPosition = _basePos;
            if (_text != null) _text.color = _baseColor;

            float half = Mathf.Max(0.01f, duration) * 0.5f;

            // cycles:2 + Yoyo = out then back to exactly the base value.
            // Unscaled time is declared on the Sequence, not its children.
            var seq = Sequence.Create(useUnscaledTime: true)
                .Group(Tween.Scale(_rt, _baseScale, _baseScale * (1f + scalePop), half,
                    Ease.OutQuad, cycles: 2, cycleMode: CycleMode.Yoyo))
                .Group(Tween.UIAnchoredPosition(_rt, _basePos, _basePos + new Vector2(0f, rise), half,
                    Ease.OutQuad, cycles: 2, cycleMode: CycleMode.Yoyo));
            if (_text != null)
                seq.Group(Tween.Color(_text, _baseColor, flash, half,
                    Ease.OutQuad, cycles: 2, cycleMode: CycleMode.Yoyo));

            _running = seq;
        }

        private void OnDisable()
        {
            if (_running.isAlive) _running.Stop();
            _rt.localScale = _baseScale;
            _rt.anchoredPosition = _basePos;
            if (_text != null) _text.color = _baseColor;
        }
    }
}
