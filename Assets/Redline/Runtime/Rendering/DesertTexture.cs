using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// The sandy ground that runs alongside and beyond the road (<see cref="RoadRenderer"/>).
    ///
    /// A tileable dust-and-stone texture built in code, same approach as
    /// <see cref="RainbowTexture"/>: warm sand base, broad lighter/darker
    /// patches, a scatter of dark pebbles and fine grain. Everything is periodic
    /// — the mottle from integer-frequency sines, the stones and flecks drawn
    /// with wraparound — so the texture repeats seamlessly as the ground scrolls
    /// past. The caller owns the returned texture and frees it.
    /// </summary>
    public static class DesertTexture
    {
        // A fixed seed: the ground must look identical between two replays of the
        // same run (invariant 8 — no ambient randomness in anything reproducible).
        private const int Seed = 0x5A4D;

        public static Texture2D Create(int size = 512)
        {
            var tex = new Texture2D(size, size, TextureFormat.RGBA32, mipChain: true)
            {
                name = "DesertGround",
                wrapMode = TextureWrapMode.Repeat,
                filterMode = FilterMode.Bilinear,
                anisoLevel = 2,
            };

            var px = new Color32[size * size];

            // Warm sand, and the two directions the mottle pushes it. Muted —
            // the reference ground is a soft beige, not a saturated orange.
            var baseCol = new Vector3(0.79f, 0.735f, 0.61f);
            var lighten = new Vector3(0.90f, 0.855f, 0.75f);
            var darken = new Vector3(0.635f, 0.585f, 0.485f);

            float k = 2f * Mathf.PI / size;   // one period across the texture

            for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                // Broad patches (low frequency) + finer grain (higher), all at
                // integer frequencies so the pattern wraps.
                float broad =
                    0.60f * Mathf.Sin(x * k * 1f + 0.7f) * Mathf.Cos(y * k * 1f - 0.3f) +
                    0.30f * Mathf.Sin(x * k * 2f + y * k * 1f) +
                    0.10f * Mathf.Cos(y * k * 3f - x * k * 1f);

                float fine =
                    0.5f * Mathf.Sin(x * k * 7f + y * k * 5f) +
                    0.5f * Mathf.Cos(x * k * 11f - y * k * 9f);

                float n = Mathf.Clamp01(0.5f + 0.30f * broad + 0.06f * fine);

                Vector3 c = n < 0.5f
                    ? Vector3.Lerp(darken, baseCol, n * 2f)
                    : Vector3.Lerp(baseCol, lighten, (n - 0.5f) * 2f);

                // Per-pixel grain so it never looks like a gradient.
                float grain = (Hash(x * 73856093 ^ y * 19349663) - 0.5f) * 0.05f;
                c += new Vector3(grain, grain, grain * 0.8f);

                px[y * size + x] = ToColor32(c);
            }

            ScatterStones(px, size);
            ScatterFlecks(px, size);

            tex.SetPixels32(px);
            tex.Apply(updateMipmaps: true);
            return tex;
        }

        /// <summary>Dark pebbles — most small, a few chunky — drawn with wraparound so they tile.</summary>
        private static void ScatterStones(Color32[] px, int size)
        {
            var rng = new System.Random(Seed);
            int count = Mathf.RoundToInt(size * size / 2400f);

            for (int i = 0; i < count; i++)
            {
                float cx = (float)rng.NextDouble() * size;
                float cy = (float)rng.NextDouble() * size;

                // Mostly gravel; only rarely a bigger stone, so the tile's
                // repeat is not given away by a distinctive large blob.
                float roll = (float)rng.NextDouble();
                float radius = roll > 0.96f
                    ? Mathf.Lerp(3.5f, 6.0f, (float)rng.NextDouble())
                    : Mathf.Lerp(0.9f, 2.6f, (float)rng.NextDouble());

                // Stone colour: brown-grey, a shade or two under the sand rather
                // than near-black — subtle, like the reference gravel.
                float warm = (float)rng.NextDouble();
                var stone = new Vector3(
                    Mathf.Lerp(0.35f, 0.47f, warm),
                    Mathf.Lerp(0.32f, 0.39f, warm),
                    Mathf.Lerp(0.31f, 0.31f, warm));
                var lip = stone + new Vector3(0.14f, 0.13f, 0.10f);   // sun-catch edge

                int r = Mathf.CeilToInt(radius) + 1;
                for (int dy = -r; dy <= r; dy++)
                for (int dx = -r; dx <= r; dx++)
                {
                    float d = Mathf.Sqrt(dx * dx + dy * dy);
                    if (d > radius + 1f) continue;

                    int sx = Wrap((int)cx + dx, size);
                    int sy = Wrap((int)cy + dy, size);
                    int idx = sy * size + sx;

                    var cur = ToVec(px[idx]);
                    if (d <= radius - 1f)
                        px[idx] = ToColor32(Vector3.Lerp(cur, stone, 0.9f));
                    else if (d <= radius)
                        px[idx] = ToColor32(Vector3.Lerp(cur, Vector3.Lerp(stone, lip, 0.5f), 0.8f));
                    else
                        px[idx] = ToColor32(Vector3.Lerp(cur, stone, radius + 1f - d)); // soft edge
                }
            }
        }

        /// <summary>Single-pixel light and dark grains — sand sparkle and tiny grit.</summary>
        private static void ScatterFlecks(Color32[] px, int size)
        {
            var rng = new System.Random(Seed ^ 0x1234);
            int count = size * size / 400;

            for (int i = 0; i < count; i++)
            {
                int x = rng.Next(size);
                int y = rng.Next(size);
                int idx = y * size + x;
                var c = ToVec(px[idx]);

                float f = (float)rng.NextDouble();
                c += f > 0.5f ? new Vector3(0.07f, 0.065f, 0.05f) : new Vector3(-0.07f, -0.07f, -0.06f);
                px[idx] = ToColor32(c);
            }
        }

        private static int Wrap(int v, int n) => ((v % n) + n) % n;

        private static float Hash(int v)
        {
            v = (v ^ 61) ^ (v >> 16);
            v += v << 3;
            v ^= v >> 4;
            v *= 0x27d4eb2d;
            v ^= v >> 15;
            return (v & 0xFFFFFF) / (float)0xFFFFFF;
        }

        private static Vector3 ToVec(Color32 c) => new Vector3(c.r / 255f, c.g / 255f, c.b / 255f);

        private static Color32 ToColor32(Vector3 c) => new Color32(
            (byte)(Mathf.Clamp01(c.x) * 255f),
            (byte)(Mathf.Clamp01(c.y) * 255f),
            (byte)(Mathf.Clamp01(c.z) * 255f),
            255);
    }
}
