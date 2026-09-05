using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// The hue ramp for the flowing 5&#215; lane strip (<see cref="RoadRenderer"/>).
    ///
    /// A 1&#215;N vertical gradient through the full hue circle, wrap = Repeat so
    /// scrolling its offset never shows a seam. The caller owns the returned
    /// texture and frees it. (The on-screen corner glow is procedural — see
    /// <see cref="Redline.Client.UI.RainbowVignette"/> — and uses no texture.)
    /// </summary>
    public static class RainbowTexture
    {
        public static Texture2D Create(int height = 96, float saturation = 0.85f, float value = 1f)
        {
            var ramp = new Texture2D(1, height, TextureFormat.RGBA32, mipChain: false)
            {
                name = "RainbowRamp",
                wrapMode = TextureWrapMode.Repeat,
                filterMode = FilterMode.Bilinear,
            };

            var pixels = new Color32[height];
            for (int i = 0; i < height; i++)
                pixels[i] = Color.HSVToRGB(i / (float)height, saturation, value);

            ramp.SetPixels32(pixels);
            ramp.Apply(updateMipmaps: false);
            return ramp;
        }
    }
}
