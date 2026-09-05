using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// Keeps its RectTransform clear of a punch-hole camera, a notch or the
    /// rounded corners. The game itself is drawn by the run camera, not this
    /// canvas, so it is untouched — only the HUD overlay is pulled in.
    ///
    /// It takes the tighter of two readings, because <see cref="Screen.safeArea"/>
    /// alone is not enough on every device — Xiaomi / HyperOS in particular
    /// often reports the full screen even with a top punch-hole:
    ///   1. <see cref="Screen.safeArea"/> — the OS's own inset;
    ///   2. <see cref="Screen.cutouts"/> — the actual cutout rectangles; any
    ///      that touch the top edge push the HUD's top down past them.
    ///
    /// Anchor-driven, so children keep their own fractional anchors (top-left
    /// chevron, top-centre score) and simply resolve against the resulting box.
    /// Re-applied on any resolution / orientation change; on a device with no
    /// cutout this is a no-op.
    /// </summary>
    [RequireComponent(typeof(RectTransform))]
    [DisallowMultipleComponent]
    public sealed class SafeAreaPanel : MonoBehaviour
    {
        private RectTransform _rt;
        private Rect _appliedSafe;
        private ScreenOrientation _orientation;
        private Vector2Int _resolution;

        private void Awake() => _rt = (RectTransform)transform;

        private void OnEnable() => Apply();

        private void Update()
        {
            if (Screen.safeArea != _appliedSafe
                || Screen.orientation != _orientation
                || Screen.width != _resolution.x
                || Screen.height != _resolution.y)
                Apply();
        }

        private void Apply()
        {
            if (_rt == null) _rt = (RectTransform)transform;

            int w = Screen.width, h = Screen.height;
            if (w <= 0 || h <= 0) return;

            _appliedSafe = Screen.safeArea;
            _orientation = Screen.orientation;
            _resolution = new Vector2Int(w, h);

            // --- reading 1: Screen.safeArea ---
            Rect safe = Screen.safeArea;
            float left = safe.xMin;
            float right = w - safe.xMax;
            float bottom = safe.yMin;
            float top = h - safe.yMax;   // safeArea.y is from the bottom

            // --- reading 2: Screen.cutouts (px, y from the bottom) ---
            // A cutout that reaches the top edge only costs us its height; one
            // that hugs a side edge costs its width. Ignore anything in the
            // middle of the screen (not a bezel intrusion).
            foreach (Rect c in Screen.cutouts)
            {
                if (c.width <= 0f || c.height <= 0f) continue;

                if (c.yMax >= h - 1f)          top    = Mathf.Max(top, h - c.yMin);
                if (c.yMin <= 1f)              bottom = Mathf.Max(bottom, c.yMax);
                if (c.xMin <= 1f)              left   = Mathf.Max(left, c.xMax);
                if (c.xMax >= w - 1f)          right  = Mathf.Max(right, w - c.xMin);
            }

            left = Mathf.Clamp(left, 0f, w * 0.25f);
            right = Mathf.Clamp(right, 0f, w * 0.25f);
            top = Mathf.Clamp(top, 0f, h * 0.25f);
            bottom = Mathf.Clamp(bottom, 0f, h * 0.25f);

            Vector2 anchorMin = new Vector2(left / w, bottom / h);
            Vector2 anchorMax = new Vector2(1f - right / w, 1f - top / h);

            _rt.anchorMin = anchorMin;
            _rt.anchorMax = anchorMax;
            _rt.offsetMin = Vector2.zero;
            _rt.offsetMax = Vector2.zero;

#if DEVELOPMENT_BUILD || UNITY_EDITOR
            var cuts = "";
            foreach (Rect c in Screen.cutouts) cuts += $"[{c}]";
            Debug.Log($"[safearea] screen={w}x{h} safeArea={Screen.safeArea} cutouts={(cuts.Length == 0 ? "none" : cuts)} " +
                      $"-> insets L{left:0} R{right:0} T{top:0} B{bottom:0}  anchorMax.y={anchorMax.y:0.###}");
#endif
        }
    }
}
