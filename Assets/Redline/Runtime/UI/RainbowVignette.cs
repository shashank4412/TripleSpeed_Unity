using UnityEngine;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// A soft rainbow glow pooled into the four screen corners — strong at each
    /// corner, gone along the mid-edges (top/bottom/left/right centres) and the
    /// screen centre, so it never reads as a hard border.
    ///
    /// Fully procedural, no texture: a subdivided full-screen quad whose
    /// per-vertex colour is a rotating hue wheel and whose per-vertex alpha is a
    /// corner mask, <c>(|x|·|y|)^cornerPower</c> in centre-normalised
    /// coordinates — 1 at a corner, 0 on either centre axis. The grid's vertex
    /// interpolation is what makes it blurry. <see cref="Phase"/> is spun by
    /// <see cref="ScreenRainbow"/> to make the colours flow.
    /// </summary>
    public sealed class RainbowVignette : MaskableGraphic
    {
        [SerializeField, Range(4, 48)] private int resolution = 24;

        [Tooltip("Higher = the glow hugs the corners more tightly.")]
        [SerializeField] private float cornerPower = 2.6f;

        [Tooltip("Peak opacity at the very corner (before the CanvasGroup fade).")]
        [SerializeField, Range(0f, 1f)] private float intensity = 0.8f;

        [SerializeField, Range(0f, 1f)] private float saturation = 0.9f;

        [Tooltip("Extra hue spread from centre out to the corner.")]
        [SerializeField] private float radialHue = 0.3f;

        /// <summary>Animated hue offset in turns. Set every frame by <see cref="ScreenRainbow"/>.</summary>
        public float Phase { get; set; }

        protected override void OnPopulateMesh(VertexHelper vh)
        {
            vh.Clear();

            Rect r = rectTransform.rect;
            int n = Mathf.Clamp(resolution, 4, 48);

            for (int j = 0; j <= n; j++)
            for (int i = 0; i <= n; i++)
            {
                float u = i / (float)n;
                float v = j / (float)n;
                float x = u * 2f - 1f;   // centre-normalised, -1..1
                float y = v * 2f - 1f;

                // 0 on the whole vertical centre line and the whole horizontal
                // centre line; rises into each quadrant, peaking at the corner.
                float corner = Mathf.Pow(Mathf.Clamp01(Mathf.Abs(x) * Mathf.Abs(y)), cornerPower);

                float dist = Mathf.Clamp01(Mathf.Sqrt(x * x + y * y) * 0.70710678f);
                float hue = Mathf.Repeat(Mathf.Atan2(y, x) / (Mathf.PI * 2f) + dist * radialHue + Phase, 1f);

                Color c = Color.HSVToRGB(hue, saturation, 1f);
                c.a = corner * intensity;

                vh.AddVert(new Vector3(r.xMin + u * r.width, r.yMin + v * r.height), c, Vector2.zero);
            }

            int stride = n + 1;
            for (int j = 0; j < n; j++)
            for (int i = 0; i < n; i++)
            {
                int a = j * stride + i;
                vh.AddTriangle(a, a + stride, a + stride + 1);
                vh.AddTriangle(a, a + stride + 1, a + 1);
            }
        }
    }
}
