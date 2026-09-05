using System.IO;
using UnityEditor;
using UnityEngine;

namespace Redline.EditorTools
{
    /// <summary>
    /// Re-copies Backend/config/redline.game.json into the client's Settings folder.
    ///
    /// Unity cannot load a TextAsset from outside Assets/, so the client ships a
    /// copy. ClientConfigCopyTests fails the build if the two drift; this is the
    /// one-click fix, so the correct response to that failure is never to edit
    /// the copy by hand.
    /// </summary>
    public static class SyncGameConfig
    {
        private const string CopyPath = "Assets/Redline/Settings/redline.game.json.txt";

        [MenuItem("Redline/Sync Game Config")]
        public static void Sync()
        {
            string root = Directory.GetParent(Application.dataPath)!.FullName;
            string source = Path.Combine(root, "Backend", "config", "redline.game.json");

            if (!File.Exists(source))
            {
                Debug.LogError($"Redline: no config at {source}");
                return;
            }

            File.Copy(source, Path.Combine(root, CopyPath), overwrite: true);
            AssetDatabase.Refresh();

            Debug.Log($"Redline: synced {CopyPath} from Backend/config/redline.game.json");
        }
    }
}
