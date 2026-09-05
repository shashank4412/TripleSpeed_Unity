using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// The four-point sparkle sprite trailed behind the car on the 5&#215; lane
    /// (<see cref="RainbowSparkle"/>). Four sharp spikes on the axes that taper
    /// to points, thin at the waist, with a bright round core — the "&#10024;"
    /// twinkle, not a rounded flower. Built once in code, additive; the caller
    /// owns the texture and frees it.
    /// </summary>
    public static class SparkleTexture
    {
        public static Texture2D Create(int size = 64)
        {
            var tex = new Texture2D(size, size, TextureFormat.RGBA32, mipChain: true)
            {
                name = "Sparkle",
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
            };

            var px = new Color32[size * size];
            float c = (size - 1) * 0.5f;

            for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                float dx = (x - c) / c;
                float dy = (y - c) / c;
                float ax = Mathf.Abs(dx);
                float ay = Mathf.Abs(dy);
                float r = Mathf.Sqrt(dx * dx + dy * dy);

                // Horizontal spike: extent falls off to a point at |x| = 1, and
                // the half-thickness shrinks with it so the tip is sharp.
                float hx = Mathf.Clamp01(1f - ax);
                float hHalf = 0.16f * hx * hx + 0.006f;
                float spikeH = Mathf.Clamp01(1f - ay / hHalf) * hx;

                // Vertical spike, same construction.
                float vy = Mathf.Clamp01(1f - ay);
                float vHalf = 0.16f * vy * vy + 0.006f;
                float spikeV = Mathf.Clamp01(1f - ax / vHalf) * vy;

                // Small bright core so a distant sparkle still registers.
                float core = Mathf.SmoothStep(1f, 0f, r / 0.16f);

                float a = Mathf.Clamp01(Mathf.Max(Mathf.Max(spikeH, spikeV), core));
                // A touch of gamma to keep the spikes crisp rather than hazy.
                a = Mathf.Pow(a, 1.3f);

                px[y * size + x] = new Color(1f, 1f, 1f, a);
            }

            tex.SetPixels32(px);
            tex.Apply(updateMipmaps: true);
            return tex;
        }
    }
}
