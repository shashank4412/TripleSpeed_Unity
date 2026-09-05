using PrimeTween;
using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// Fades and settles a panel in every time it becomes active — the screen
    /// transition for <see cref="GameFlowUi"/>'s panels, which it shows by
    /// toggling <c>SetActive</c>. Unscaled time. Presentation only.
    /// </summary>
    [RequireComponent(typeof(RectTransform))]
    public sealed class UiAppear : MonoBehaviour
    {
        [Tooltip("Seconds for the panel to fade, rise and settle in.")]
        [SerializeField] private float duration = 0.24f;

        [Tooltip("How far below its resting position the panel starts, in anchored-position units.")]
        [SerializeField] private float rise = 30f;

        [Tooltip("Scale the panel starts at and settles inward from (1.04 = +4%), so a solid panel never reveals an edge.")]
        [SerializeField] private float fromScale = 1.04f;

        private RectTransform _rt;
        private CanvasGroup _group;
        private Vector2 _basePos;
        private Sequence _seq;

        private void Awake()
        {
            _rt = (RectTransform)transform;
            _basePos = _rt.anchoredPosition;
            // Last resort: the panel needs a CanvasGroup to fade and the scene
            // does not always carry one. Cheap, once, in Awake — not per frame.
            if (!TryGetComponent(out _group)) _group = gameObject.AddComponent<CanvasGroup>();
        }

        private void OnEnable()
        {
            _group.alpha = 0f;
            _rt.anchoredPosition = _basePos + new Vector2(0f, rise);
            _rt.localScale = fromScale * Vector3.one;

            // Unscaled time is declared on the Sequence, not its children.
            _seq = Sequence.Create(useUnscaledTime: true)
                .Group(Tween.Alpha(_group, 0f, 1f, duration, Ease.OutCubic))
                .Group(Tween.UIAnchoredPosition(_rt, _basePos + new Vector2(0f, rise), _basePos, duration, Ease.OutCubic))
                .Group(Tween.Scale(_rt, fromScale * Vector3.one, Vector3.one, duration, Ease.OutCubic));
        }

        private void OnDisable()
        {
            // Leave it clean so a panel shown without this component running
            // (edit mode) is not stuck faded or offset.
            if (_seq.isAlive) _seq.Stop();
            if (_group != null) _group.alpha = 1f;
            if (_rt != null)
            {
                _rt.anchoredPosition = _basePos;
                _rt.localScale = Vector3.one;
            }
        }
    }
}
