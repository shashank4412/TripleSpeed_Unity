using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// Runtime-generated UI sprites. The scene is code-built, so nothing here is
    /// dragged in from a .png — a rounded-rectangle fill (9-sliced, so it
    /// stretches to any button without warping the corners) and a soft diagonal
    /// band for the shine sweep. Both are shared singletons; tint via
    /// <c>Image.color</c>.
    /// </summary>
    public static class UiSprites
    {
        private static Sprite _rounded;
        private static Sprite _shine;
        private static Sprite _circle;

        /// <summary>A soft-edged filled disc, for coin / badge icons. Tint via <c>Image.color</c>.</summary>
        public static Sprite Circle()
        {
            if (_circle != null) return _circle;

            const int size = 128;
            const float r = size * 0.5f;

            var tex = new Texture2D(size, size, TextureFormat.RGBA32, mipChain: false)
            {
                name = "UiCircle",
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
            };

            var px = new Color32[size * size];
            for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                float d = Mathf.Sqrt((x - r + 0.5f) * (x - r + 0.5f) + (y - r + 0.5f) * (y - r + 0.5f));
                float a = Mathf.Clamp01(r - 0.5f - d);   // ~1px feathered edge
                px[y * size + x] = new Color(1f, 1f, 1f, a);
            }
            tex.SetPixels32(px);
            tex.Apply(false);

            _circle = Sprite.Create(tex, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f), 100f);
            _circle.name = "UiCircle";
            return _circle;
        }

        public static Sprite RoundedRect()
        {
            if (_rounded != null) return _rounded;

            const int size = 128;
            const float radius = 52f;

            var tex = new Texture2D(size, size, TextureFormat.RGBA32, mipChain: false)
            {
                name = "UiRounded",
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
            };

            var px = new Color32[size * size];
            for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                // Distance from the corner-arc centre, zero everywhere in the
                // straight sections — a proper rounded rectangle.
                float dx = Mathf.Max(radius - x, x - (size - 1 - radius), 0f);
                float dy = Mathf.Max(radius - y, y - (size - 1 - radius), 0f);
                float d = Mathf.Sqrt(dx * dx + dy * dy);
                float a = Mathf.Clamp01(radius + 0.75f - d);   // ~1px feathered edge
                px[y * size + x] = new Color(1f, 1f, 1f, a);
            }
            tex.SetPixels32(px);
            tex.Apply(false);

            _rounded = Sprite.Create(
                tex, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f),
                pixelsPerUnit: 100f, extrude: 0, meshType: SpriteMeshType.FullRect,
                border: new Vector4(radius, radius, radius, radius));
            _rounded.name = "UiRounded";
            return _rounded;
        }

        public static Sprite Shine()
        {
            if (_shine != null) return _shine;

            const int w = 64, h = 8;
            var tex = new Texture2D(w, h, TextureFormat.RGBA32, mipChain: false)
            {
                name = "UiShine",
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
            };

            var px = new Color32[w * h];
            for (int x = 0; x < w; x++)
            {
                float t = x / (float)(w - 1);
                float a = Mathf.Pow(Mathf.Sin(t * Mathf.PI), 2.4f);
                var c = new Color(1f, 1f, 1f, a);
                for (int y = 0; y < h; y++) px[y * w + x] = c;
            }
            tex.SetPixels32(px);
            tex.Apply(false);

            _shine = Sprite.Create(tex, new Rect(0, 0, w, h), new Vector2(0.5f, 0.5f), 100f);
            _shine.name = "UiShine";
            return _shine;
        }
    }
}
