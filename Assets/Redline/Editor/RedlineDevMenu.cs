#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace Redline.EditorTools
{
    /// <summary>
    /// Editor-only utilities for exercising the anonymous-identity screen
    /// (feature 0008) between Play sessions. Lifted verbatim from the retired
    /// <c>AuthUiBuilder</c> one-shot scene aid (feature 0009).
    ///
    /// The keys match <see cref="Redline.Client.Net.EditorLoopbackBackend"/>'s
    /// PlayerPrefs — the Editor fake mints a uid on the first "Enter" and stores
    /// an active/inactive flag; these menu items reset or flip that state so the
    /// fresh-install / returning / backend-down paths can all be seen without a
    /// device.
    /// </summary>
    internal static class RedlineDevMenu
    {
        private const string CachedUidKey = "redline.editor.anonUid";
        private const string CachedUidActiveKey = "redline.editor.anonActive";

        [MenuItem("Redline/Clear Local Anonymous Id")]
        public static void ClearLocalAnonymousId()
        {
            PlayerPrefs.DeleteKey(CachedUidKey);
            PlayerPrefs.DeleteKey(CachedUidActiveKey);
            PlayerPrefs.Save();
            Debug.Log("[Redline] Cleared the local anonymous id — the Auth screen shows the fresh state next Play.");
        }

        [MenuItem("Redline/Toggle Local Anonymous Id Backend State")]
        public static void ToggleLocalAnonymousIdBackendState()
        {
            if (!PlayerPrefs.HasKey(CachedUidKey))
            {
                Debug.LogWarning("[Redline] No local anonymous id yet — Enter once in Play mode first.");
                return;
            }
            int next = PlayerPrefs.GetInt(CachedUidActiveKey, 1) == 1 ? 0 : 1;
            PlayerPrefs.SetInt(CachedUidActiveKey, next);
            PlayerPrefs.Save();
            Debug.Log($"[Redline] Local anonymous id backend state -> {(next == 1 ? "ACTIVE (green)" : "INACTIVE (red)")}. Re-enter Play mode to see it.");
        }
    }
}
#endif
