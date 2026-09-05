using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// The cartoon crash, played once at the collision point when a run ends
    /// CRASHED (never on a bank). A short staged sequence, all built in code
    /// from generated sprites (a soft puff, a spiky starburst, a shock ring,
    /// a chunky ember and a comic "BOOM!" word):
    ///
    ///   0.00s  white starburst flash + a red comic "BOOM!" + radial sparks
    ///   0.05s  orange fireball + an expanding ring shockwave punching outward
    ///   0.12s  chunky blocky orange fire, some of it thrown clear as debris
    ///   0.20s  a dark billowing smoke column rising + a wide low grey spread
    ///
    /// Matched to the reference screenshots: the blast reads as a comic-book
    /// explosion sitting on the two wrecked cars, not a realistic fireball.
    ///
    /// Presentation only. <see cref="Redline.Client.UI.RunEndPresenter"/> calls
    /// <see cref="Play"/> and does the camera shake alongside it; nothing here
    /// is deterministic or scored.
    /// </summary>
    public sealed class CrashFx : MonoBehaviour
    {
        [Tooltip("The wrecked car the blast plays on. Drag the Car transform here.")]
        [SerializeField] private Transform car;

        private ParticleSystem[] _systems;
        private ParticleSystem _boom;   // needs its own lift so it clears the fire

        private Material _puffMat;       // alpha-blended — smoke
        private Material _chunkMat;      // alpha-blended — blocky fire + debris
        private Material _glowMat;       // additive, starburst — flash, sparks
        private Material _glowDiscMat;   // additive, round — fireball, ember glow
        private Material _ringMat;       // additive — shock ring
        private Material _boomMat;       // alpha-blended — the "BOOM!" word

        private Texture2D _disc;         // soft round puff
        private Texture2D _star;         // spiky starburst
        private Texture2D _chunk;        // rounded square — cartoon fire chunk
        private Texture2D _ring;         // thin annulus — shockwave
        private Texture2D _word;         // "BOOM!" comic lettering

        private void Awake()
        {
            _disc = SoftDisc();
            _star = Starburst();
            _chunk = Chunk();
            _ring = Ring();
            _word = BoomWord();

            _puffMat = new Material(Shader.Find("Sprites/Default")) { name = "CrashFxPuff", mainTexture = _disc };
            _chunkMat = new Material(Shader.Find("Sprites/Default")) { name = "CrashFxChunk", mainTexture = _chunk };
            _boomMat = new Material(Shader.Find("Sprites/Default")) { name = "CrashFxBoom", mainTexture = _word };

            var addShader = Shader.Find("Legacy Shaders/Particles/Additive")
                            ?? Shader.Find("Particles/Standard Unlit")
                            ?? Shader.Find("Sprites/Default");
            _glowMat = new Material(addShader) { name = "CrashFxGlow", mainTexture = _star };
            _glowDiscMat = new Material(addShader) { name = "CrashFxGlowDisc", mainTexture = _disc };
            _ringMat = new Material(addShader) { name = "CrashFxRing", mainTexture = _ring };

            _boom = BuildBoom();

            _systems = new[]
            {
                BuildFlash(),
                _boom,
                BuildShockRing(),
                BuildFireball(),
                BuildSparks(),
                BuildDebris(),
                BuildFire(),
                BuildEmberGlow(),
                BuildSmokePlume(),
                BuildSmokeGround(),
            };
        }

        private void OnDestroy()
        {
            foreach (var m in new[] { _puffMat, _chunkMat, _glowMat, _glowDiscMat, _ringMat, _boomMat })
                if (m != null) Destroy(m);
            foreach (var t in new[] { _disc, _star, _chunk, _ring, _word })
                if (t != null) Destroy(t);
        }

        /// <summary>Fires the whole sequence on the wrecked car.</summary>
        public void Play()
        {
            // On the car, lifted clear of the road — direction-agnostic, because
            // a crash can be a rear-end, a side-swipe or crossing traffic and
            // the blast must not imply one of those over the others.
            Vector3 carPos = car != null ? car.position : transform.position;
            Vector3 at = carPos + Vector3.up * 0.45f;

            foreach (var ps in _systems)
            {
                if (ps == null) continue;
                // The word floats above the fire so it stays readable.
                ps.transform.position = ps == _boom ? at + Vector3.up * 1.3f : at;
                ps.Clear();
                ps.Play();
            }
        }

        /// <summary>
        /// Stops and clears every system now. Called when a fresh run arms
        /// (RunEndPresenter, off RunHost.RunStarted) so a quick replay does not
        /// open on the last wreck's smoke column.
        /// </summary>
        public void ClearAll()
        {
            if (_systems == null) return;

            foreach (var ps in _systems)
            {
                if (ps == null) continue;
                ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
                ps.Clear(true);
            }
        }

        // ---- systems ----------------------------------------------------

        private ParticleSystem BuildFlash()
        {
            var ps = NewSystem("Flash", _glowMat, sort: 60);
            var m = ps.main;
            m.duration = 0.3f;
            m.startLifetime = 0.26f;
            m.startSpeed = 0f;
            m.startSize = new ParticleSystem.MinMaxCurve(16f, 26f);
            m.startRotation = new ParticleSystem.MinMaxCurve(0f, Mathf.PI * 2f);
            m.startColor = new Color(1f, 0.99f, 0.92f, 1f);
            ps.emission.SetBursts(new[] { new ParticleSystem.Burst(0f, 3) });
            Grow(ps, 0.3f, 1f, 1.15f, 0f);
            FadeOut(ps);
            return ps;
        }

        private ParticleSystem BuildBoom()
        {
            var ps = NewSystem("Boom", _boomMat, sort: 64);
            var m = ps.main;
            m.duration = 0.8f;
            m.startLifetime = 0.75f;
            m.startSpeed = 0f;
            m.startSize = new ParticleSystem.MinMaxCurve(11.5f, 11.5f);
            m.startRotation = new ParticleSystem.MinMaxCurve(-0.14f, 0.14f);
            m.startColor = Color.white;   // the texture carries the comic colours
            ps.emission.SetBursts(new[] { new ParticleSystem.Burst(0f, 1) });

            // Punch in with an overshoot, then hold — it must not shrink away,
            // just pop and fade, the way a comic caption does.
            var s = ps.sizeOverLifetime;
            s.enabled = true;
            s.size = new ParticleSystem.MinMaxCurve(1f, new AnimationCurve(
                new Keyframe(0f, 0.1f), new Keyframe(0.16f, 1.22f),
                new Keyframe(0.32f, 1f), new Keyframe(1f, 1.02f)));

            HoldFade(ps, 0.62f);
            return ps;
        }

        private ParticleSystem BuildShockRing()
        {
            var ps = NewSystem("ShockRing", _ringMat, sort: 59);
            var m = ps.main;
            m.duration = 0.4f;
            m.startDelay = 0.03f;
            m.startLifetime = 0.34f;
            m.startSpeed = 0f;
            m.startSize = new ParticleSystem.MinMaxCurve(3f, 3f);
            m.startColor = new Color(1f, 0.82f, 0.4f, 1f);
            ps.emission.SetBursts(new[] { new ParticleSystem.Burst(0f, 1) });
            Grow(ps, 0.25f, 1.6f, 3.4f, 4.2f);   // a thin ring racing outward
            FadeOut(ps);
            return ps;
        }

        private ParticleSystem BuildFireball()
        {
            var ps = NewSystem("Fireball", _glowDiscMat, sort: 58);
            var m = ps.main;
            m.duration = 0.5f;
            m.startDelay = 0.09f;   // the white flash + BOOM get a clear beat first
            m.startLifetime = 0.36f;
            m.startSpeed = 0f;
            m.startSize = new ParticleSystem.MinMaxCurve(5f, 9f);
            m.startColor = new ParticleSystem.MinMaxGradient(new Color(1f, 0.92f, 0.6f), new Color(1f, 0.42f, 0.1f));
            ps.emission.SetBursts(new[]
            {
                new ParticleSystem.Burst(0f, 4),
                new ParticleSystem.Burst(0.12f, 3),
            });
            Grow(ps, 0.3f, 1f, 2.6f, 3.2f);
            FadeOut(ps);
            return ps;
        }

        private ParticleSystem BuildSparks()
        {
            var ps = NewSystem("Sparks", _glowMat, sort: 62);
            var m = ps.main;
            m.duration = 0.3f;
            m.startLifetime = new ParticleSystem.MinMaxCurve(0.22f, 0.5f);
            m.startSpeed = new ParticleSystem.MinMaxCurve(14f, 30f);
            m.startSize = new ParticleSystem.MinMaxCurve(0.25f, 0.6f);
            m.gravityModifier = 0.6f;
            m.startColor = new ParticleSystem.MinMaxGradient(new Color(1f, 0.95f, 0.7f), new Color(1f, 0.6f, 0.2f));

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Sphere;
            shape.radius = 0.2f;

            ps.emission.SetBursts(new[] { new ParticleSystem.Burst(0f, 30) });

            var r = ps.GetComponent<ParticleSystemRenderer>();
            r.renderMode = ParticleSystemRenderMode.Stretch;
            r.lengthScale = 2.5f;
            r.velocityScale = 0.12f;

            FadeOut(ps);
            return ps;
        }

        private ParticleSystem BuildDebris()
        {
            var ps = NewSystem("Debris", _chunkMat, sort: 55);
            var m = ps.main;
            m.duration = 0.4f;
            m.startLifetime = new ParticleSystem.MinMaxCurve(0.6f, 1.3f);
            m.startSpeed = new ParticleSystem.MinMaxCurve(6f, 16f);
            m.startSize = new ParticleSystem.MinMaxCurve(0.35f, 0.9f);
            m.gravityModifier = 1.4f;   // car bits arc out and fall
            m.startColor = new ParticleSystem.MinMaxGradient(new Color(0.12f, 0.1f, 0.09f), new Color(0.3f, 0.22f, 0.15f));
            m.startRotation = new ParticleSystem.MinMaxCurve(0f, Mathf.PI * 2f);

            var rot = ps.rotationOverLifetime;
            rot.enabled = true;
            rot.z = new ParticleSystem.MinMaxCurve(-6f, 6f);

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Sphere;
            shape.radius = 0.25f;

            ps.emission.SetBursts(new[] { new ParticleSystem.Burst(0f, 16) });
            FadeOut(ps);
            return ps;
        }

        private ParticleSystem BuildFire()
        {
            var ps = NewSystem("Fire", _chunkMat, sort: 56);
            var m = ps.main;
            m.duration = 0.6f;
            m.startDelay = 0.1f;   // ignites just after the flash, like the reference
            m.startLifetime = new ParticleSystem.MinMaxCurve(0.45f, 0.95f);   // burns out before the smoke pile takes over
            m.startSpeed = new ParticleSystem.MinMaxCurve(1.5f, 6f);   // stays at the wreck
            m.startSize = new ParticleSystem.MinMaxCurve(2.2f, 5.5f);
            m.gravityModifier = 0.05f;
            m.startRotation = new ParticleSystem.MinMaxCurve(0f, Mathf.PI * 2f);
            m.startColor = new ParticleSystem.MinMaxGradient(new Color(1f, 0.88f, 0.35f), new Color(1f, 0.3f, 0.05f));

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Sphere;
            shape.radius = 0.55f;

            ps.emission.SetBursts(new[]
            {
                new ParticleSystem.Burst(0f, 36),
                new ParticleSystem.Burst(0.16f, 16),
            });

            var col = ps.colorOverLifetime;
            col.enabled = true;
            var g = new Gradient();
            g.SetKeys(
                new[]
                {
                    new GradientColorKey(new Color(1f, 0.95f, 0.65f), 0f),
                    new GradientColorKey(new Color(1f, 0.5f, 0.12f), 0.4f),
                    new GradientColorKey(new Color(0.5f, 0.2f, 0.08f), 0.75f),
                    new GradientColorKey(new Color(0.2f, 0.12f, 0.1f), 1f),
                },
                // Fully gone by 0.85 of life, so it doesn't linger as brown boxes.
                new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, 0.45f), new GradientAlphaKey(0.35f, 0.7f), new GradientAlphaKey(0f, 0.85f) });
            col.color = new ParticleSystem.MinMaxGradient(g);

            Noise(ps, 1.2f, 0.7f);
            Grow(ps, 0.6f, 1f, 1.25f, 0.9f);
            return ps;
        }

        /// <summary>A low orange glow that lingers at the wreck through the smoke phase —
        /// the reference keeps fire burning at the base long after the blast.</summary>
        private ParticleSystem BuildEmberGlow()
        {
            var ps = NewSystem("EmberGlow", _glowDiscMat, sort: 52);
            var m = ps.main;
            m.duration = 1.4f;
            m.startDelay = 0.2f;
            m.startLifetime = new ParticleSystem.MinMaxCurve(1.4f, 2.6f);
            m.startSpeed = new ParticleSystem.MinMaxCurve(0.2f, 1.2f);
            m.startSize = new ParticleSystem.MinMaxCurve(2.6f, 4.6f);
            m.gravityModifier = -0.02f;
            m.startColor = new ParticleSystem.MinMaxGradient(new Color(1f, 0.55f, 0.12f), new Color(1f, 0.3f, 0.04f));

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Sphere;
            shape.radius = 0.5f;

            ps.emission.SetBursts(new[]
            {
                new ParticleSystem.Burst(0f, 5),
                new ParticleSystem.Burst(0.5f, 4),
                new ParticleSystem.Burst(1.0f, 3),
            });

            Noise(ps, 0.8f, 0.6f);
            SmokeFade(ps, 0.9f);   // ease in, hold, ease out — no hard pop
            Grow(ps, 0.5f, 1f, 1.1f, 0.7f);
            return ps;
        }

        private ParticleSystem BuildSmokePlume()
        {
            var ps = NewSystem("SmokePlume", _puffMat, sort: 50);
            var m = ps.main;
            m.maxParticles = 160;
            m.duration = 1.3f;
            m.startDelay = 0.1f;
            m.startLifetime = new ParticleSystem.MinMaxCurve(2.4f, 4f);
            m.startSpeed = new ParticleSystem.MinMaxCurve(1.6f, 3.8f);   // rises as a column, not a blob that floats off
            m.startSize = new ParticleSystem.MinMaxCurve(2.6f, 5.2f);
            m.gravityModifier = -0.14f;
            m.startColor = new ParticleSystem.MinMaxGradient(new Color(0.06f, 0.05f, 0.05f), new Color(0.19f, 0.16f, 0.15f));

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Cone;
            shape.angle = 17f;
            shape.radius = 0.6f;

            ps.emission.SetBursts(new[]
            {
                new ParticleSystem.Burst(0f, 30),
                new ParticleSystem.Burst(0.15f, 22),
                new ParticleSystem.Burst(0.35f, 16),
                new ParticleSystem.Burst(0.6f, 12),
                new ParticleSystem.Burst(0.95f, 8),
            });

            Noise(ps, 1.1f, 0.4f);
            SmokeFade(ps, 0.94f);
            Grow(ps, 0.5f, 1f, 2.2f, 2.9f);
            return ps;
        }

        private ParticleSystem BuildSmokeGround()
        {
            var ps = NewSystem("SmokeGround", _puffMat, sort: 48);
            var m = ps.main;
            m.maxParticles = 128;
            m.duration = 1.2f;
            m.startDelay = 0.06f;
            m.startLifetime = new ParticleSystem.MinMaxCurve(1.6f, 2.8f);
            m.startSpeed = new ParticleSystem.MinMaxCurve(1.5f, 4f);
            m.startSize = new ParticleSystem.MinMaxCurve(2.6f, 5f);
            m.gravityModifier = 0f;
            m.startColor = new ParticleSystem.MinMaxGradient(new Color(0.4f, 0.38f, 0.37f), new Color(0.6f, 0.58f, 0.56f));

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Hemisphere;
            shape.radius = 0.5f;
            ps.transform.localScale = new Vector3(1f, 0.3f, 1f);   // low, wide spread

            ps.emission.SetBursts(new[]
            {
                new ParticleSystem.Burst(0f, 24),
                new ParticleSystem.Burst(0.2f, 14),
            });

            Noise(ps, 1.1f, 0.4f);
            SmokeFade(ps, 0.6f);
            Grow(ps, 0.6f, 1f, 2f, 1.6f);
            return ps;
        }

        // ---- helpers --------------------------------------------------

        // The ten systems are built here rather than authored as a prefab
        // deliberately: their materials wrap procedural textures generated below
        // (SoftDisc, Starburst, Chunk, Ring, BoomWord), so the rig cannot exist
        // without this code running anyway, and the staged sequence reads better
        // as one method than as ten Inspector panels a diff cannot show.
        private ParticleSystem NewSystem(string name, Material mat, int sort)
        {
            var go = new GameObject(name);
            go.transform.SetParent(transform, worldPositionStays: false);

            var ps = go.AddComponent<ParticleSystem>();

            var m = ps.main;
            m.playOnAwake = false;
            m.loop = false;
            m.simulationSpace = ParticleSystemSimulationSpace.World;
            m.maxParticles = 96;

            var e = ps.emission;
            e.enabled = true;
            e.rateOverTime = 0f;   // bursts only

            var r = go.GetComponent<ParticleSystemRenderer>();
            r.material = mat;
            r.renderMode = ParticleSystemRenderMode.Billboard;
            r.sortMode = ParticleSystemSortMode.Distance;
            r.sortingOrder = sort;

            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            return ps;
        }

        /// <summary>Turbulence, so fire flickers and smoke billows instead of drifting in a straight line.</summary>
        private static void Noise(ParticleSystem ps, float strength, float frequency)
        {
            var n = ps.noise;
            n.enabled = true;
            n.strength = strength;
            n.frequency = frequency;
            n.scrollSpeed = 0.5f;
            n.damping = true;
        }

        /// <summary>Size-over-lifetime: 4 keys, so a burst can pop then settle or keep growing.</summary>
        private static void Grow(ParticleSystem ps, float a, float b, float c, float d)
        {
            var s = ps.sizeOverLifetime;
            s.enabled = true;
            s.size = new ParticleSystem.MinMaxCurve(1f, new AnimationCurve(
                new Keyframe(0f, a), new Keyframe(0.2f, b), new Keyframe(0.6f, c), new Keyframe(1f, d)));
        }

        private static void FadeOut(ParticleSystem ps)
        {
            var col = ps.colorOverLifetime;
            col.enabled = true;
            var g = new Gradient();
            g.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, 0.3f), new GradientAlphaKey(0f, 1f) });
            col.color = new ParticleSystem.MinMaxGradient(g);
        }

        /// <summary>Full alpha until <paramref name="holdUntil"/> of life, then a quick fade. For the caption.</summary>
        private static void HoldFade(ParticleSystem ps, float holdUntil)
        {
            var col = ps.colorOverLifetime;
            col.enabled = true;
            var g = new Gradient();
            g.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, holdUntil), new GradientAlphaKey(0f, 1f) });
            col.color = new ParticleSystem.MinMaxGradient(g);
        }

        private static void SmokeFade(ParticleSystem ps, float peak)
        {
            var col = ps.colorOverLifetime;
            col.enabled = true;
            var g = new Gradient();
            g.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(peak, 0.15f), new GradientAlphaKey(peak * 0.7f, 0.5f), new GradientAlphaKey(0f, 1f) });
            col.color = new ParticleSystem.MinMaxGradient(g);
        }

        private static Texture2D SoftDisc()
        {
            const int n = 64;
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, mipChain: false) { name = "CrashPuff", wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[n * n];
            float c = (n - 1) * 0.5f;
            for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                float d = Mathf.Sqrt((x - c) * (x - c) + (y - c) * (y - c)) / c;
                // Opaque core out to ~62% of the radius, then a soft shoulder —
                // so overlapping puffs build into a solid cloud, not a haze.
                float a = Mathf.SmoothStep(1f, 0f, Mathf.InverseLerp(0.62f, 1f, d));
                px[y * n + x] = new Color(1f, 1f, 1f, a);
            }
            tex.SetPixels32(px);
            tex.Apply(false);
            return tex;
        }

        private static Texture2D Starburst()
        {
            const int n = 96;
            const int spikes = 9;
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, mipChain: false) { name = "CrashStar", wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[n * n];
            float c = (n - 1) * 0.5f;
            for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                float dx = (x - c) / c;
                float dy = (y - c) / c;
                float r = Mathf.Sqrt(dx * dx + dy * dy);
                float ang = Mathf.Atan2(dy, dx);
                // spiky radial limit: alternates long/short with angle
                float limit = Mathf.Lerp(0.35f, 1f, Mathf.Pow(0.5f + 0.5f * Mathf.Cos(ang * spikes), 1.6f));
                float a = Mathf.Clamp01((limit - r) / 0.22f);
                px[y * n + x] = new Color(1f, 1f, 1f, a * a);
            }
            tex.SetPixels32(px);
            tex.Apply(false);
            return tex;
        }

        /// <summary>A rounded square — cartoon fire and debris are chunky, not round.</summary>
        private static Texture2D Chunk()
        {
            const int n = 48;
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, mipChain: false) { name = "CrashChunk", wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[n * n];
            float c = (n - 1) * 0.5f;
            for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                float dx = Mathf.Abs((x - c) / c);
                float dy = Mathf.Abs((y - c) / c);
                float box = Mathf.Max(dx, dy);
                float round = Mathf.Sqrt(dx * dx + dy * dy);
                float d = Mathf.Lerp(box, round, 0.5f);   // chunky but with the corners rounded off
                float a = Mathf.SmoothStep(0.95f, 0.7f, d);
                px[y * n + x] = new Color(1f, 1f, 1f, a);
            }
            tex.SetPixels32(px);
            tex.Apply(false);
            return tex;
        }

        /// <summary>A thin soft annulus — the shockwave ring that races out of the blast.</summary>
        private static Texture2D Ring()
        {
            const int n = 128;
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, mipChain: false) { name = "CrashRing", wrapMode = TextureWrapMode.Clamp };
            var px = new Color32[n * n];
            float c = (n - 1) * 0.5f;
            for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                float d = Mathf.Sqrt((x - c) * (x - c) + (y - c) * (y - c)) / c;
                // peak at r = 0.78, ~0.16 wide either side
                float a = Mathf.Clamp01(1f - Mathf.Abs(d - 0.78f) / 0.16f);
                px[y * n + x] = new Color(1f, 1f, 1f, a * a);
            }
            tex.SetPixels32(px);
            tex.Apply(false);
            return tex;
        }

        // A 5x7 block font, just the glyphs "BOOM!" needs. Rows top-to-bottom.
        private static readonly string[][] Glyphs =
        {
            new[] { "11110", "10001", "10001", "11110", "10001", "10001", "11110" }, // B
            new[] { "01110", "10001", "10001", "10001", "10001", "10001", "01110" }, // O
            new[] { "01110", "10001", "10001", "10001", "10001", "10001", "01110" }, // O
            new[] { "10001", "11011", "10101", "10101", "10001", "10001", "10001" }, // M
            new[] { "00100", "00100", "00100", "00100", "00100", "00000", "00100" }, // !
        };

        /// <summary>Draws "BOOM!" as chunky comic lettering: black outline, red-to-orange fill.</summary>
        private static Texture2D BoomWord()
        {
            const int sx = 9, sy = 15;     // pixels per font bit
            const int gap = 1;             // bits of space between glyphs
            const int outline = 4;         // outline thickness in pixels
            const int margin = 10;

            int blockW = Glyphs.Length * 5 * sx + (Glyphs.Length - 1) * gap * sx;
            int blockH = 7 * sy;

            // Square canvas: a billboard particle renders a square quad, so the
            // word is centred in a square with transparent margins and keeps its
            // aspect ratio instead of being squashed narrow.
            int side = Mathf.Max(blockW, blockH) + 2 * (margin + outline);
            int w = side, h = side;

            var on = new bool[w * h];
            int ox = (w - blockW) / 2;
            int oyTop = (h - blockH) / 2;

            for (int gi = 0; gi < Glyphs.Length; gi++)
            {
                var glyph = Glyphs[gi];
                int gx = ox + gi * (5 + gap) * sx;
                for (int r = 0; r < 7; r++)
                for (int c = 0; c < 5; c++)
                {
                    if (glyph[r][c] != '1') continue;
                    for (int yy = 0; yy < sy; yy++)
                    for (int xx = 0; xx < sx; xx++)
                    {
                        int px = gx + c * sx + xx;
                        int pyTop = oyTop + r * sy + yy;
                        int py = h - 1 - pyTop;   // texture y is bottom-up
                        if ((uint)px < w && (uint)py < h) on[py * w + px] = true;
                    }
                }
            }

            var pixels = new Color32[w * h];
            var fillTop = new Color32(240, 28, 20, 255);      // comic red
            var fillBottom = new Color32(255, 110, 20, 255);  // to orange at the base
            var outlineCol = new Color32(12, 6, 4, 255);
            int o2 = outline * outline;

            for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                int i = y * w + x;
                if (on[i])
                {
                    float t = 1f - y / (float)(h - 1);   // top of the word -> t near 0
                    pixels[i] = Color32.Lerp(fillTop, fillBottom, Mathf.Clamp01(t));
                    continue;
                }

                // Outline: any transparent pixel within `outline` of a filled one.
                bool edge = false;
                for (int dy = -outline; dy <= outline && !edge; dy++)
                for (int dx = -outline; dx <= outline; dx++)
                {
                    if (dx * dx + dy * dy > o2) continue;
                    int nx = x + dx, ny = y + dy;
                    if ((uint)nx >= w || (uint)ny >= h) continue;
                    if (on[ny * w + nx]) { edge = true; break; }
                }
                pixels[i] = edge ? outlineCol : new Color32(0, 0, 0, 0);
            }

            var tex = new Texture2D(w, h, TextureFormat.RGBA32, mipChain: false) { name = "CrashBoomWord", wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };
            tex.SetPixels32(pixels);
            tex.Apply(false);
            return tex;
        }
    }
}
