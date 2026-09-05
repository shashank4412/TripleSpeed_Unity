using Redline.Core;
using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// A trail of four-point rainbow sparkles behind the car, on while it is in
    /// (or moving to) the 5&#215; lane and off otherwise — the same gate
    /// <see cref="CarTint"/> and the screen vignette use, from
    /// <see cref="LaneGeometry.HottestScoringLane"/> so a reordered lane config
    /// still points at the right one.
    ///
    /// Presentation only: it reads <see cref="Simulation.State"/> and emits
    /// particles, nothing more. Built in code (additive, one generated sprite),
    /// world-space so each sparkle is left behind as the car holds station and
    /// the road scrolls past.
    /// </summary>
    [RequireComponent(typeof(RunHost))]
    public sealed class RainbowSparkle : MonoBehaviour
    {
        [Tooltip("The visual car the sparkle trail streams off. Drag the Car transform here.")]
        [SerializeField] private Transform car;

        [Tooltip("Sparkles per second while the 5x lane is active.")]
        [SerializeField] private float emitRate = 36f;

        private RunHost _host;
        private int _rainbowLane;
        private ParticleSystem _system;
        private ParticleSystem.EmissionModule _emission;
        private Material _material;
        private Texture2D _sprite;

        private void Awake()
        {
            _host = GetComponent<RunHost>();
            _rainbowLane = LaneGeometry.HottestScoringLane(_host.Config);

            _sprite = SparkleTexture.Create();

            var shader = Shader.Find("Legacy Shaders/Particles/Additive")
                         ?? Shader.Find("Particles/Standard Unlit")
                         ?? Shader.Find("Sprites/Default");
            _material = new Material(shader) { name = "RainbowSparkle", mainTexture = _sprite };

            Build();
        }

        private void OnDestroy()
        {
            if (_material != null) Destroy(_material);
            if (_sprite != null) Destroy(_sprite);
        }

        // Built here, not authored as a prefab: the material wraps a procedural
        // sprite (SparkleTexture) generated at Awake, so the system cannot exist
        // without this code — and the config reads as one method.
        private void Build()
        {
            var go = new GameObject("RainbowSparkle");
            go.transform.SetParent(transform, worldPositionStays: false);

            _system = go.AddComponent<ParticleSystem>();

            var main = _system.main;
            main.playOnAwake = false;
            main.loop = true;
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            main.maxParticles = 90;
            main.startLifetime = new ParticleSystem.MinMaxCurve(0.4f, 0.9f);    // twinkle out fast
            main.startSpeed = new ParticleSystem.MinMaxCurve(1.6f, 3.2f);       // stream off the tail
            main.startSize = new ParticleSystem.MinMaxCurve(0.18f, 0.5f);       // small — a trail, not a pile
            main.startRotation = new ParticleSystem.MinMaxCurve(-0.35f, 0.35f); // near-upright, so it reads as a 4-point star
            main.gravityModifier = 0.03f;   // settle like glitter

            // Each sparkle a random point on the hue wheel — it is the rainbow lane.
            var rainbow = new Gradient();
            rainbow.SetKeys(
                new[]
                {
                    new GradientColorKey(new Color(1f, 0.25f, 0.3f), 0f),
                    new GradientColorKey(new Color(1f, 0.8f, 0.2f), 0.2f),
                    new GradientColorKey(new Color(0.35f, 1f, 0.35f), 0.4f),
                    new GradientColorKey(new Color(0.2f, 0.85f, 1f), 0.6f),
                    new GradientColorKey(new Color(0.5f, 0.4f, 1f), 0.8f),
                    new GradientColorKey(new Color(1f, 0.4f, 0.95f), 1f),
                },
                new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, 1f) });
            main.startColor = new ParticleSystem.MinMaxGradient(rainbow) { mode = ParticleSystemGradientMode.RandomColor };

            _emission = _system.emission;
            _emission.enabled = false;             // gated in LateUpdate
            _emission.rateOverTime = emitRate;

            // A narrow cone, spraying back toward the camera (the emitter itself
            // is turned to face -Z in LateUpdate) so the sparkles form a tail
            // rather than a cloud around the car.
            var shape = _system.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Cone;
            shape.angle = 16f;
            shape.radius = 0.18f;

            // Decelerate quickly so each sparkle streaks off the tail then hangs
            // and twinkles out where it lands.
            var limit = _system.limitVelocityOverLifetime;
            limit.enabled = true;
            limit.dampen = 0.35f;
            limit.limit = new ParticleSystem.MinMaxCurve(1.2f);

            // Sharp pop in, brief hold, out — a twinkle.
            var size = _system.sizeOverLifetime;
            size.enabled = true;
            size.size = new ParticleSystem.MinMaxCurve(1f, new AnimationCurve(
                new Keyframe(0f, 0.15f), new Keyframe(0.18f, 1.2f), new Keyframe(0.5f, 0.85f), new Keyframe(1f, 0f)));

            // Fade in fast, out fast.
            var col = _system.colorOverLifetime;
            col.enabled = true;
            var fade = new Gradient();
            fade.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(1f, 0.2f), new GradientAlphaKey(0.9f, 0.55f), new GradientAlphaKey(0f, 1f) });
            col.color = new ParticleSystem.MinMaxGradient(fade);

            // Only the faintest drift of rotation — a 4-point star that spins
            // fast reads as a pinwheel, not a twinkle.
            var rot = _system.rotationOverLifetime;
            rot.enabled = true;
            rot.z = new ParticleSystem.MinMaxCurve(-0.5f, 0.5f);

            var renderer = go.GetComponent<ParticleSystemRenderer>();
            renderer.material = _material;
            renderer.renderMode = ParticleSystemRenderMode.Billboard;
            renderer.sortMode = ParticleSystemSortMode.Distance;
            renderer.sortingOrder = 20;   // over the road, under the car and the crash FX
            renderer.minParticleSize = 0f;
            renderer.maxParticleSize = 0.5f;

            _system.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
        }

        private void LateUpdate()
        {
            var state = _host.State;
            bool on = state != null
                      && !_host.Outcome.HasValue
                      && (state.Lane == _rainbowLane || state.TargetLane == _rainbowLane);

            if (_emission.enabled != on) _emission.enabled = on;

            if (!on)
            {
                if (_system.isPlaying) _system.Stop(false, ParticleSystemStopBehavior.StopEmitting);
                return;
            }

            if (car != null)
            {
                // Just off the rear bumper, low. Turned to face the camera (-Z)
                // and tipped up a touch so the cone sprays back and slightly up.
                _system.transform.SetPositionAndRotation(
                    car.position + Vector3.back * 0.7f + Vector3.up * 0.12f,
                    Quaternion.Euler(-18f, 180f, 0f));
            }

            if (!_system.isPlaying) _system.Play();
        }
    }
}
