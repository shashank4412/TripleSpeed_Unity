#if DEVELOPMENT_BUILD || UNITY_EDITOR
using System.Collections.Generic;
using UnityEngine;

namespace Redline.Client
{
    /// <summary>
    /// Development-build-only frame-rate readout. There is no shippable fps
    /// counter in this game, and `adb dumpsys gfxinfo` / SurfaceFlinger report
    /// nothing for a Unity SurfaceView, so the device frame-rate number the
    /// submission needs (§4) had nowhere to come from. This samples
    /// <see cref="Time.unscaledDeltaTime"/> every frame, and every
    /// <see cref="ReportSeconds"/> logs the window's mean fps and its 1%-low
    /// (the mean of the slowest 1% of frames — the honest "worst it stutters"
    /// number, not a single outlier). It also paints a small overlay so a
    /// screenshot or a Loom frame carries the number.
    ///
    /// Excluded from the release build by the compile guard; spawned with no
    /// scene wiring so it cannot affect SceneWiringTests.
    /// </summary>
    internal sealed class DevFpsMeter : MonoBehaviour
    {
        private const float ReportSeconds = 5f;
        private const int MaxSamples = 4096;   // ~68s at 60fps; ring-buffered

        private readonly List<float> _dt = new List<float>(MaxSamples);
        private float _sinceReport;
        private float _lastMean = 0f;
        private float _lastLow = 0f;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Spawn()
        {
            var go = new GameObject("~DevFpsMeter");
            go.hideFlags = HideFlags.HideAndDontSave;
            DontDestroyOnLoad(go);
            go.AddComponent<DevFpsMeter>();
        }

        private void Update()
        {
            float dt = Time.unscaledDeltaTime;
            if (dt <= 0f) return;

            if (_dt.Count >= MaxSamples) _dt.RemoveAt(0);
            _dt.Add(dt);

            _sinceReport += dt;
            if (_sinceReport < ReportSeconds || _dt.Count < 10) return;
            _sinceReport = 0f;

            // mean fps over the window
            float sum = 0f;
            foreach (var x in _dt) sum += x;
            _lastMean = _dt.Count / sum;

            // 1%-low: mean fps of the slowest 1% of frames (largest dt)
            var sorted = new List<float>(_dt);
            sorted.Sort();                                  // ascending dt
            int n = Mathf.Max(1, Mathf.RoundToInt(sorted.Count * 0.01f));
            float slowSum = 0f;
            for (int i = sorted.Count - n; i < sorted.Count; i++) slowSum += sorted[i];
            _lastLow = n / slowSum;

            Debug.Log($"[fps] mean={_lastMean:0.0}  1%low={_lastLow:0.0}  " +
                      $"frames={_dt.Count}  worstMs={sorted[sorted.Count - 1] * 1000f:0.0}  " +
                      $"target={Application.targetFrameRate}  screen={Screen.currentResolution.refreshRateRatio.value:0}Hz");
        }

        private GUIStyle _style;

        private void OnGUI()
        {
            if (_lastMean <= 0f) return;
            if (_style == null)
                _style = new GUIStyle(GUI.skin.label)
                {
                    fontSize = Mathf.RoundToInt(Screen.height * 0.018f),
                    normal = { textColor = Color.green },
                    alignment = TextAnchor.UpperLeft,
                };
            GUI.Label(new Rect(12, 12, 400, 80),
                $"fps {_lastMean:0.0}  (1%low {_lastLow:0.0})", _style);
        }
    }
}
#endif
