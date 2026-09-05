using PrimeTween;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// Polish for a uGUI <see cref="Button"/>: a rounded-corner fill, a drop
    /// shadow, a periodic shine sweep, and a springy press. It sits next to the
    /// Button and needs no wiring — it finds its own <see cref="Image"/> and
    /// builds its child graphics in <c>Awake</c>. Presentation only; it never
    /// touches the Button's <c>onClick</c> or <c>interactable</c>.
    /// </summary>
    [RequireComponent(typeof(RectTransform))]
    public sealed class UiButtonFx : MonoBehaviour, IPointerDownHandler, IPointerUpHandler, IPointerExitHandler
    {
        [Tooltip("Scale while held down (0.94 = shrink to 94%).")]
        [SerializeField] private float pressedScale = 0.94f;

        [Tooltip("Seconds to sink to the pressed scale.")]
        [SerializeField] private float pressSeconds = 0.06f;

        [Tooltip("Seconds to spring back to rest after release.")]
        [SerializeField] private float releaseSeconds = 0.18f;

        [Tooltip("Length of the one-shot Ping() acknowledgement pop.")]
        [SerializeField] private float pingSeconds = 0.28f;

        [Tooltip("Whether the periodic diagonal shine sweep plays.")]
        [SerializeField] private bool shine = true;

        [Tooltip("Seconds one shine sweep takes to cross the button.")]
        [SerializeField] private float shineSweepSeconds = 0.55f;

        [Tooltip("Random idle gap between shine sweeps, seconds (min, max).")]
        [SerializeField] private Vector2 shineGapSeconds = new Vector2(2.6f, 5.2f);

        /// <summary>Set before the component's first frame to turn the shine sweep off (small utility buttons).</summary>
        public void SetShine(bool on) => shine = on;

        private RectTransform _rt;
        private Button _button;
        private Image _image;
        private RectTransform _shine;
        private Image _shineImage;

        private RectTransform _progressClip;   // RectMask2D — its right padding hides the unfilled part
        private RectMask2D _progressMask;
        private Image _progressFill;           // sliced copy of the button, so the reveal keeps the button's corners
        private float _progressT;
        private bool _connecting;
        private Color _baseColor = Color.white;   // the button's authored colour — the filled part shows it at full strength

        private Vector3 _baseScale;
        private Tween _scaleTween;
        private Sequence _pingSeq;
        private Tween _shineDelay;
        private Sequence _shineSweep;

        private void Awake()
        {
            _rt = (RectTransform)transform;
            _baseScale = _rt.localScale;
            _button = GetComponent<Button>();
            _image = GetComponent<Image>();

            if (_image != null)
            {
                _baseColor = _image.color;               // captured before any tint state touches it
                _image.sprite = UiSprites.RoundedRect();
                _image.type = Image.Type.Sliced;
                _image.pixelsPerUnitMultiplier = 2.4f;
            }

            BuildShadow();
            if (shine)
            {
                BuildShine();
                ScheduleShine(Random.Range(0.6f, 2.4f));   // a shorter first wait
            }
        }

        /// <summary>
        /// Puts the button into (or out of) its "connecting" look: a fill that
        /// grows the WHOLE button left-to-right as a progress slider, the label
        /// left to the caller to repurpose, and the shine sweep frozen. Off, the
        /// shine resumes on its own. Built lazily so only the buttons that use
        /// it pay for the extra graphic.
        /// </summary>
        public void SetConnecting(bool connecting)
        {
            _connecting = connecting;

            if (connecting && _progressClip == null) BuildProgress();
            if (_progressClip != null)
            {
                _progressClip.gameObject.SetActive(connecting);
                if (connecting) ApplyProgress();
            }

            if (connecting)
            {
                if (_shineDelay.isAlive) _shineDelay.Stop();
                if (_shineSweep.isAlive) _shineSweep.Stop();
                if (_shineImage != null) _shineImage.color = new Color(1f, 1f, 1f, 0f);
            }
            else if (shine && _shine != null)
            {
                ScheduleShine(Random.Range(shineGapSeconds.x, shineGapSeconds.y));
            }
        }

        /// <summary>0..1 fill for the connecting slider. Ignored unless connecting.</summary>
        public void SetProgress(float t01)
        {
            _progressT = Mathf.Clamp01(t01);
            ApplyProgress();
        }

        public void OnPointerDown(PointerEventData e)
        {
            if (_button != null && !_button.interactable) return;
            ScaleTo(_baseScale * pressedScale, pressSeconds, Ease.OutQuad);
        }

        public void OnPointerUp(PointerEventData e) => ScaleTo(_baseScale, releaseSeconds, Ease.OutBack);
        public void OnPointerExit(PointerEventData e) => ScaleTo(_baseScale, releaseSeconds, Ease.OutBack);

        /// <summary>A one-shot pop — for "Copied!"-style acknowledgement.</summary>
        public void Ping()
        {
            if (_scaleTween.isAlive) _scaleTween.Stop();
            if (_pingSeq.isAlive) _pingSeq.Stop();
            _pingSeq = Sequence.Create(useUnscaledTime: true)
                .Chain(Tween.Scale(_rt, _baseScale, _baseScale * 1.16f, pingSeconds * 0.4f, Ease.OutQuad))
                .Chain(Tween.Scale(_rt, _baseScale * 1.16f, _baseScale, pingSeconds * 0.6f, Ease.OutBack));
        }

        private void ScaleTo(Vector3 target, float seconds, Ease ease)
        {
            if (_pingSeq.isAlive) _pingSeq.Stop();
            if (_scaleTween.isAlive) _scaleTween.Stop();
            _scaleTween = Tween.Scale(_rt, target, seconds, ease, useUnscaledTime: true);
        }

        private void ScheduleShine(float delaySeconds)
        {
            if (!shine || _shine == null || _connecting) return;
            if (_shineDelay.isAlive) _shineDelay.Stop();
            _shineDelay = Tween.Delay(delaySeconds, PlayShine, useUnscaledTime: true);
        }

        private void PlayShine()
        {
            if (!shine || _shine == null || _connecting) return;

            float w = Mathf.Max(1f, _rt.rect.width);
            _shine.anchoredPosition = new Vector2(-w * 0.2f, 0f);
            _shineImage.color = new Color(1f, 1f, 1f, 0f);

            _shineSweep = Sequence.Create(useUnscaledTime: true)
                .Group(Tween.UIAnchoredPosition(_shine, new Vector2(-w * 0.2f, 0f), new Vector2(w * 1.2f, 0f),
                    shineSweepSeconds, Ease.InOutSine))
                .Group(Tween.Alpha(_shineImage, 0f, 0.5f, shineSweepSeconds * 0.5f,
                    Ease.InOutSine, cycles: 2, cycleMode: CycleMode.Yoyo))
                .ChainCallback(() => ScheduleShine(Random.Range(shineGapSeconds.x, shineGapSeconds.y)));
        }

        private void OnDisable()
        {
            if (_scaleTween.isAlive) _scaleTween.Stop();
            if (_pingSeq.isAlive) _pingSeq.Stop();
            if (_shineDelay.isAlive) _shineDelay.Stop();
            if (_shineSweep.isAlive) _shineSweep.Stop();
            if (_rt != null) _rt.localScale = _baseScale;
        }

        // ---- child graphics (built once; feature 0006 Phase C moves these to a prefab) ----

        /// <summary>
        /// A left-to-right reveal, done with a rectangular <see cref="RectMask2D"/>
        /// whose RIGHT padding hides the unfilled part. The revealed graphic is a
        /// sliced copy of the button itself, so the filled portion carries the
        /// button's own rounded corners on the left and a clean straight edge on
        /// the right — no capsule, and nothing outside the button rect.
        /// </summary>
        private void BuildProgress()
        {
            var clipGo = new GameObject("ProgressClip", typeof(RectTransform), typeof(RectMask2D));
            _progressClip = (RectTransform)clipGo.transform;
            _progressClip.SetParent(_rt, false);
            _progressClip.anchorMin = Vector2.zero;
            _progressClip.anchorMax = Vector2.one;
            _progressClip.offsetMin = Vector2.zero;
            _progressClip.offsetMax = Vector2.zero;
            _progressMask = clipGo.GetComponent<RectMask2D>();

            var fillGo = new GameObject("ProgressFill", typeof(RectTransform), typeof(Image));
            var frt = (RectTransform)fillGo.transform;
            frt.SetParent(_progressClip, false);
            frt.anchorMin = Vector2.zero;
            frt.anchorMax = Vector2.one;
            frt.offsetMin = Vector2.zero;
            frt.offsetMax = Vector2.zero;

            _progressFill = fillGo.GetComponent<Image>();
            _progressFill.sprite = UiSprites.RoundedRect();
            _progressFill.type = Image.Type.Sliced;
            _progressFill.pixelsPerUnitMultiplier = 2.4f;
            _progressFill.color = new Color(_baseColor.r, _baseColor.g, _baseColor.b, 1f);   // the done portion: full-strength button colour, flat
            _progressFill.raycastTarget = false;

            // Under the "Label" child so the status text stays readable; slot in
            // just before it (the label is the last child on the button prefab).
            var label = _rt.Find("Label");
            _progressClip.SetSiblingIndex(label != null ? label.GetSiblingIndex() : _rt.childCount - 1);

            _progressT = 0f;
            ApplyProgress();
            _progressClip.gameObject.SetActive(false);
        }

        private void ApplyProgress()
        {
            if (_progressMask == null) return;
            float w = _rt.rect.width;
            _progressMask.padding = new Vector4(0f, 0f, w * (1f - _progressT), 0f);
        }

        private void BuildShadow()
        {
            var go = new GameObject("Shadow", typeof(RectTransform), typeof(Image));
            var rt = (RectTransform)go.transform;
            rt.SetParent(_rt, false);
            rt.SetAsFirstSibling();                       // behind the fill
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = new Vector2(-5f, -18f);        // wider + dropped down
            rt.offsetMax = new Vector2(5f, -6f);

            var img = go.GetComponent<Image>();
            img.sprite = UiSprites.RoundedRect();
            img.type = Image.Type.Sliced;
            img.pixelsPerUnitMultiplier = 2.4f;
            img.color = new Color(0f, 0f, 0f, 0.32f);
            img.raycastTarget = false;
        }

        private void BuildShine()
        {
            var clip = new GameObject("ShineClip", typeof(RectTransform), typeof(RectMask2D));
            var clipRt = (RectTransform)clip.transform;
            clipRt.SetParent(_rt, false);
            clipRt.anchorMin = Vector2.zero;
            clipRt.anchorMax = Vector2.one;
            clipRt.offsetMin = Vector2.zero;
            clipRt.offsetMax = Vector2.zero;

            var go = new GameObject("Shine", typeof(RectTransform), typeof(Image));
            _shine = (RectTransform)go.transform;
            _shine.SetParent(clipRt, false);
            _shine.anchorMin = new Vector2(0f, 0f);
            _shine.anchorMax = new Vector2(0f, 1f);
            _shine.pivot = new Vector2(0.5f, 0.5f);
            _shine.sizeDelta = new Vector2(90f, 40f);     // height stretches with the anchors; width fixed
            _shine.localRotation = Quaternion.Euler(0f, 0f, 16f);

            _shineImage = go.GetComponent<Image>();
            _shineImage.sprite = UiSprites.Shine();
            _shineImage.raycastTarget = false;
            _shineImage.color = new Color(1f, 1f, 1f, 0f);
        }
    }
}
