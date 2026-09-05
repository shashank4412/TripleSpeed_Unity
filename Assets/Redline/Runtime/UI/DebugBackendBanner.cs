#if REDLINE_DEBUG_BUILD
using Redline.Client.Net;
using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// A permanent on-screen strip naming the backend this build talks to, so a
    /// debug APK can never be mistaken for the shipped one.
    ///
    /// The whole file is behind <c>REDLINE_DEBUG_BUILD</c> (set only by
    /// <c>BuildScript.BuildAndroidDebug</c>), so a release player has no flag to
    /// leave switched on. It self-installs rather than living in the scene — a
    /// scene ref would be missing in release and break the wiring test.
    /// </summary>
    public sealed class DebugBackendBanner : MonoBehaviour
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Install()
        {
            // Last resort by design: a scene object would need a wired reference
            // that is absent in a release build (this type is not compiled there).
            var go = new GameObject("Debug Backend Banner");
            go.AddComponent<DebugBackendBanner>();
            DontDestroyOnLoad(go);
        }

        private string _backend;
        private GUIStyle _style;

        private void Awake()
        {
            // Read from the same baked asset the session reads, so the banner
            // cannot disagree with where requests actually go.
            var baked = Resources.Load<TextAsset>(RedlineSession.BackendResource);
            _backend = baked != null ? baked.text.Trim() : "(no backend baked)";
        }

        private void OnGUI()
        {
            _style ??= new GUIStyle(GUI.skin.label)
            {
                alignment = TextAnchor.MiddleCenter,
                fontSize = 16,
                normal = { textColor = Color.black },
            };

            // Drawn last and across the top, where it overlaps the least and is
            // impossible not to notice.
            var rect = new Rect(0, 0, Screen.width, 28);

            GUI.color = new Color(1f, 0.75f, 0f, 0.92f);
            GUI.DrawTexture(rect, Texture2D.whiteTexture);
            GUI.color = Color.white;

            GUI.Label(rect, $"DEBUG BUILD — {_backend}", _style);
        }
    }
}
#endif
