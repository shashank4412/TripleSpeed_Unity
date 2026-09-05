using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// A small post-processing pass on the run camera: bloom off the bright
    /// highlights (the rainbow lane, the sparkles, the crash blast) plus a
    /// finishing grade — a little contrast and saturation, a warm/cool split,
    /// and a soft vignette.
    ///
    /// Hand-rolled rather than <c>com.unity.postprocessing</c>: that package
    /// needs a signed-in Unity Hub to install, which this machine does not have.
    /// Presentation only, and it degrades to a plain copy if the shader is
    /// missing or unsupported.
    /// </summary>
    [RequireComponent(typeof(Camera))]
    public sealed class CinematicPostFx : MonoBehaviour
    {
        [Header("Bloom")]
        [Tooltip("Brightness above which a pixel blooms.")]
        [SerializeField, Range(0f, 2f)] private float threshold = 0.95f;
        [Tooltip("Soft shoulder around the threshold.")]
        [SerializeField, Range(0.05f, 1f)] private float knee = 0.15f;
        [Tooltip("Strength of the added glow.")]
        [SerializeField, Range(0f, 3f)] private float intensity = 0.28f;
        [Tooltip("Blur passes at half resolution — more = wider, softer glow.")]
        [SerializeField, Range(1, 5)] private int iterations = 2;

        [Header("Grade")]
        [Tooltip("Contrast multiplier applied after bloom.")]
        [SerializeField, Range(0.5f, 1.6f)] private float contrast = 1.06f;
        [Tooltip("Saturation multiplier.")]
        [SerializeField, Range(0f, 2f)] private float saturation = 1.12f;
        [Tooltip("Corner darkening amount.")]
        [SerializeField, Range(0f, 1f)] private float vignette = 0.36f;
        [Tooltip("Tint multiplied into the highlights.")]
        [SerializeField] private Color warmHighlights = new Color(1.00f, 0.99f, 0.955f);
        [Tooltip("Tint multiplied into the shadows.")]
        [SerializeField] private Color coolShadows = new Color(0.975f, 0.99f, 1.03f);

        private Material _mat;

        private static readonly int IdThreshold = Shader.PropertyToID("_Threshold");
        private static readonly int IdKnee = Shader.PropertyToID("_Knee");
        private static readonly int IdBlurDir = Shader.PropertyToID("_BlurDir");
        private static readonly int IdBloomTex = Shader.PropertyToID("_BloomTex");
        private static readonly int IdBloomIntensity = Shader.PropertyToID("_BloomIntensity");
        private static readonly int IdContrast = Shader.PropertyToID("_Contrast");
        private static readonly int IdSaturation = Shader.PropertyToID("_Saturation");
        private static readonly int IdVignette = Shader.PropertyToID("_Vignette");
        private static readonly int IdWarm = Shader.PropertyToID("_Warm");
        private static readonly int IdCool = Shader.PropertyToID("_Cool");

        private void OnEnable()
        {
            var shader = Shader.Find("Hidden/Redline/CinematicPostFx");
            if (shader == null || !shader.isSupported)
            {
                enabled = false;
                return;
            }
            _mat = new Material(shader) { hideFlags = HideFlags.HideAndDontSave };
        }

        private void OnDisable()
        {
            if (_mat != null) DestroyImmediate(_mat);
            _mat = null;
        }

        private void OnRenderImage(RenderTexture src, RenderTexture dst)
        {
            if (_mat == null)
            {
                Graphics.Blit(src, dst);
                return;
            }

            _mat.SetFloat(IdThreshold, threshold);
            _mat.SetFloat(IdKnee, knee);
            _mat.SetFloat(IdBloomIntensity, intensity);
            _mat.SetFloat(IdContrast, contrast);
            _mat.SetFloat(IdSaturation, saturation);
            _mat.SetFloat(IdVignette, vignette);
            _mat.SetColor(IdWarm, warmHighlights);
            _mat.SetColor(IdCool, coolShadows);

            int w = Mathf.Max(1, src.width >> 1);
            int h = Mathf.Max(1, src.height >> 1);
            var format = src.format;

            var prefilter = RenderTexture.GetTemporary(w, h, 0, format);
            Graphics.Blit(src, prefilter, _mat, 0);

            var blur = prefilter;
            for (int it = 0; it < iterations; it++)
            {
                var horizontal = RenderTexture.GetTemporary(w, h, 0, format);
                _mat.SetVector(IdBlurDir, new Vector4(1f / w, 0f, 0f, 0f));
                Graphics.Blit(blur, horizontal, _mat, 1);
                if (blur != prefilter) RenderTexture.ReleaseTemporary(blur);

                var vertical = RenderTexture.GetTemporary(w, h, 0, format);
                _mat.SetVector(IdBlurDir, new Vector4(0f, 1f / h, 0f, 0f));
                Graphics.Blit(horizontal, vertical, _mat, 1);
                RenderTexture.ReleaseTemporary(horizontal);

                blur = vertical;
            }

            _mat.SetTexture(IdBloomTex, blur);
            Graphics.Blit(src, dst, _mat, 2);

            if (blur != prefilter) RenderTexture.ReleaseTemporary(blur);
            RenderTexture.ReleaseTemporary(prefilter);
        }
    }
}
