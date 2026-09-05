using Redline.Core;
using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// Fades the player car toward gold while it is on (or moving to/from) the
    /// 5x lane, back to normal when it leaves. Presentation only — reads the
    /// simulation's lane, drives a <see cref="MaterialPropertyBlock"/> per
    /// renderer, creates no material instance.
    /// </summary>
    [RequireComponent(typeof(RunHost))]
    public sealed class CarTint : MonoBehaviour
    {
        [Tooltip("The visual car whose renderers are tinted gold on the 5x lane. Drag the Car transform here.")]
        [SerializeField] private Transform car;

        [Tooltip("How gold the car goes on the 5x lane. 1 = fully gold.")]
        [Range(0f, 1f)]
        [SerializeField] private float strength = 0.8f;

        [Tooltip("How fast the tint eases in and out.")]
        [SerializeField] private float response = 8f;

        private static readonly Color Gold = new Color(1f, 0.78f, 0.15f);
        private static readonly int ColorId = Shader.PropertyToID("_Color");
        private static readonly int BaseColorId = Shader.PropertyToID("_BaseColor");

        private RunHost _host;
        private int _rainbowLane;

        private Renderer[] _renderers;
        private Color[] _base;
        private MaterialPropertyBlock _block;
        private float _tint;   // 0 = normal, 1 = full gold

        private void Awake()
        {
            _host = GetComponent<RunHost>();
            _rainbowLane = LaneGeometry.HottestScoringLane(_host.Config);
            _host.RunStarted += () => _tint = 0f;   // start each run at the base colour, no leftover gold

            if (car == null) return;

            _renderers = car.GetComponentsInChildren<Renderer>();
            _base = new Color[_renderers.Length];
            _block = new MaterialPropertyBlock();

            for (int i = 0; i < _renderers.Length; i++)
            {
                var mat = _renderers[i].sharedMaterial;
                _base[i] = mat != null && mat.HasProperty(ColorId) ? mat.GetColor(ColorId)
                         : mat != null && mat.HasProperty(BaseColorId) ? mat.GetColor(BaseColorId)
                         : Color.white;
            }
        }

        private void LateUpdate()
        {
            var state = _host.State;
            if (state == null || _renderers == null) return;

            // "On" the rainbow lane also covers a change into or out of it, so
            // the gold starts the instant the swipe is made.
            bool onRainbow = state.Lane == _rainbowLane || state.TargetLane == _rainbowLane;

            _tint = Mathf.Lerp(_tint, onRainbow ? 1f : 0f, 1f - Mathf.Exp(-response * Time.deltaTime));

            float t = _tint * strength;
            for (int i = 0; i < _renderers.Length; i++)
            {
                Color c = Color.Lerp(_base[i], Gold, t);
                _renderers[i].GetPropertyBlock(_block);
                _block.SetColor(ColorId, c);
                _block.SetColor(BaseColorId, c);
                _renderers[i].SetPropertyBlock(_block);
            }
        }
    }
}
