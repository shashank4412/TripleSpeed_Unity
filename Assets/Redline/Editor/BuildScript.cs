using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace Redline.Editor
{
    /// <summary>
    /// Headless Android build entry point. Invoked by Tools/unity-build via
    /// Unity's -executeMethod, so producing the submission APK is a scripted,
    /// reproducible step rather than a sequence of clicks in the Build window.
    ///
    /// Everything that varies between a developer build and the shipped one —
    /// the backend URL, the signing keystore — comes from the environment. None
    /// of it is committed: the keystore is excluded by .gitignore, and a
    /// backend URL baked into a scene file is a URL somebody edits by hand
    /// before every build and eventually forgets.
    /// </summary>
    public static class BuildScript
    {
        private const string OutputDir = "artifacts";

        // Also exposed as menu items, not only as -executeMethod targets.
        // Headless batchmode needs its own Unity licence and this machine has
        // none persisted — the Hub supplies a token to the interactive Editor
        // and nothing to batchmode, so platform extensions fail to load with
        // "Native extension for Android target not found". Running the same
        // method from the licensed Editor is the working path, and a menu item
        // is how a human reaches it.


        /// <summary>
        /// The shipped APK. Signed, IL2CPP, https-only, no debugging.
        /// </summary>
        [MenuItem("Redline/Build Android (Release)")]
        public static void BuildAndroid() => Build(debug: false);

        /// <summary>
        /// A build that can reach a laptop on the local network, for the step
        /// that has to happen before a deployed backend exists.
        ///
        /// It differs from the release build in four ways, and every one of them
        /// exists so this cannot be mistaken for — or shipped as — the real
        /// thing: a `.debug` application id so both can be installed side by
        /// side and neither overwrites the other, cleartext permitted only to a
        /// private address, a development player, and an on-screen banner
        /// naming the backend.
        /// </summary>
        [MenuItem("Redline/Build Android (Debug)")]
        public static void BuildAndroidDebug() => Build(debug: true);

        private static void Build(bool debug)
        {
            var scenes = EditorBuildSettings.scenes
                .Where(s => s.enabled)
                .Select(s => s.path)
                .ToArray();

            if (scenes.Length == 0)
            {
                // Fall back to every scene under Assets/Redline/Scenes so an
                // un-configured Build Settings list can't silently ship an
                // empty player.
                scenes = AssetDatabase.FindAssets("t:Scene", new[] { "Assets/Redline/Scenes" })
                    .Select(AssetDatabase.GUIDToAssetPath)
                    .ToArray();
            }

            if (scenes.Length == 0)
                throw new BuildFailedException("No scenes to build.");

            ConfigureRelease();
            ConfigureVariant(debug);

            // URL before keystore, deliberately: both are guards, but a build
            // pointing at the wrong backend is the more common mistake and the
            // one whose error message is worth seeing first. A missing keystore
            // is obvious the moment you read it; a wrong URL is not.
            BakeBackendUrl(debug);

            // The release path keeps every guard it had. Only the debug path
            // relaxes anything, and only after proving the target is private.
            if (!debug)
            {
                ConfigureSigning();
            }
            else
            {
                // Explicitly OFF, not merely "not configured". useCustomKeystore
                // is persisted in ProjectSettings, so leaving it alone means the
                // debug build inherits whatever the last Editor session set and
                // then fails in batchmode with "No keystore passwords were found"
                // — Unity never serialises the passwords. A debug APK is for a
                // local device and the debug key is the correct signer for it.
                PlayerSettings.Android.useCustomKeystore = false;

                // BlueStacks advertises Vulkan support but its Vulkan layer
                // segfaults on the very first debug-object-name call (SetVkDebugObjectName),
                // and Unity's "Auto Graphics API" picks Vulkan first whenever a device
                // claims to support it. Force GLES3-only for a debug/emulator build so
                // the app is actually launchable on the reviewer's or our own emulator.
                // GraphicsDeviceType.OpenGLES3 == 11 (NOT 8 — that's OpenGLES2, which
                // this Unity version rejects for Android and silently resets the whole
                // list back to the Vulkan-first default, which is what happened before).
                PlayerSettings.SetGraphicsAPIs(
                    BuildTarget.Android,
                    new[] { UnityEngine.Rendering.GraphicsDeviceType.OpenGLES3 });
                PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android, false);
            }

            Directory.CreateDirectory(OutputDir);
            var outputPath = Path.Combine(OutputDir, debug ? "redline-debug.apk" : "redline.apk");

            var options = new BuildPlayerOptions
            {
                scenes = scenes,
                locationPathName = outputPath,
                target = BuildTarget.Android,

                // No development flag on release, no autoconnected profiler. A
                // development build reports a frame rate that is not the shipped
                // one, and the README quotes a measured number.
                options = debug
                    ? BuildOptions.Development | BuildOptions.AllowDebugging
                    : BuildOptions.None,
            };

            var report = BuildPipeline.BuildPlayer(options);
            var summary = report.summary;

            Debug.Log($"[BuildScript] {(debug ? "DEBUG" : "RELEASE")} {summary.result} " +
                      $"size={summary.totalSize} bytes " +
                      $"time={summary.totalTime} " +
                      $"scenes={scenes.Length}");

            if (summary.result != BuildResult.Succeeded)
                throw new BuildFailedException($"Android build failed: {summary.result}");
        }

        /// <summary>
        /// Release configuration: IL2CPP, ARM64 only, engine code stripped.
        ///
        /// IL2CPP rather than Mono because ARM64 requires it and because the
        /// simulation core has to produce identical results under it — that is
        /// the determinism claim, and building the shipped APK any other way
        /// would mean the claim was never tested on what ships.
        /// </summary>
        private static void ConfigureRelease()
        {
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);

            // ARM64 only. ARMv7 is below the mid-range device the brief targets
            // and doubles IL2CPP build time for a slice of hardware nobody will
            // review on.
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;

            PlayerSettings.SetManagedStrippingLevel(NamedBuildTarget.Android, ManagedStrippingLevel.Low);

            // Release, not debug: a debug IL2CPP build carries symbols and
            // bounds-checking that change the frame rate the README quotes.
            EditorUserBuildSettings.androidCreateSymbols = AndroidCreateSymbols.Disabled;
            EditorUserBuildSettings.buildAppBundle = false;
        }

        /// <summary>
        /// Signs the APK from a keystore supplied by the environment.
        ///
        /// An unsigned build cannot be installed by a reviewer, so a missing
        /// keystore fails the build loudly rather than producing an artefact
        /// that looks finished and cannot be used. The four variables are named
        /// in the README; none of them appears in this repository.
        /// </summary>
        private static void ConfigureSigning()
        {
            string keystore = Environment.GetEnvironmentVariable("REDLINE_KEYSTORE");

            if (string.IsNullOrWhiteSpace(keystore))
            {
                throw new BuildFailedException(
                    "REDLINE_KEYSTORE is not set. A release APK must be signed or it cannot be installed. " +
                    "Set REDLINE_KEYSTORE, REDLINE_KEYSTORE_PASS, REDLINE_KEY_ALIAS and REDLINE_KEY_PASS.");
            }

            if (!File.Exists(keystore))
                throw new BuildFailedException($"Keystore not found at {keystore}.");

            PlayerSettings.Android.useCustomKeystore = true;
            PlayerSettings.Android.keystoreName = keystore;
            PlayerSettings.Android.keystorePass = Require("REDLINE_KEYSTORE_PASS");
            PlayerSettings.Android.keyaliasName = Require("REDLINE_KEY_ALIAS");
            PlayerSettings.Android.keyaliasPass = Require("REDLINE_KEY_PASS");
        }

        /// <summary>
        /// Writes REDLINE_API_URL into a Resources TextAsset so the player can
        /// read it on a device.
        ///
        /// An Android build has no environment, so the URL cannot be read at
        /// runtime the way it is in the Editor — it has to be a file inside the
        /// APK. Refusing to build without it is deliberate: an APK pointing at
        /// localhost installs and launches perfectly and then fails every
        /// request, which is a far more expensive way to discover the problem
        /// than a failed build.
        /// </summary>
        /// <summary>
        /// What separates a debug build from a shippable one, in the player
        /// settings themselves rather than in a convention someone remembers.
        ///
        /// The application id changes so the two APKs coexist on one handset and
        /// neither silently replaces the other — installing a debug build over a
        /// reviewer's release build would be the worst version of this mistake.
        ///
        /// Cleartext uses Unity's <c>DevelopmentOnly</c> option rather than a
        /// hand-written network security config. It is one line instead of a
        /// generated manifest plus an XML resource plus manifest merging, and it
        /// is a **stronger** guarantee: the permission is bound to the
        /// development flag, so a release player cannot carry it even if someone
        /// edits the baked URL afterwards. A host-scoped file would still be
        /// present in a release APK; this cannot be.
        /// </summary>
        private static void ConfigureVariant(bool debug)
        {
            // ONE Firebase Android app across both variants (com.DefaultCompany.Test).
            // The debug build is no longer a separate application id — it is
            // registered against the same google-services.json, so a `.debug`
            // suffix would break Firebase auth. The two builds still differ by
            // the development player, the cleartext option and the on-screen
            // banner below; that is enough to keep them from being confused.
            string id = PlayerSettings.GetApplicationIdentifier(NamedBuildTarget.Android);
            if (id.EndsWith(DebugIdSuffix, StringComparison.Ordinal))
                PlayerSettings.SetApplicationIdentifier(
                    NamedBuildTarget.Android, id.Substring(0, id.Length - DebugIdSuffix.Length));

            PlayerSettings.insecureHttpOption =
                debug ? InsecureHttpOption.DevelopmentOnly : InsecureHttpOption.NotAllowed;

            // Firebase transport is compiled in for both variants; the stub in
            // FirebaseRedlineBackend is what would otherwise be built, and it
            // throws. The debug banner is additive on top.
            var defines = PlayerSettings.GetScriptingDefineSymbols(NamedBuildTarget.Android)
                .Split(';').Where(d => d.Length > 0 && d != DebugDefine).ToList();
            if (!defines.Contains(FirebaseDefine)) defines.Add(FirebaseDefine);
            if (debug) defines.Add(DebugDefine);

            PlayerSettings.SetScriptingDefineSymbols(NamedBuildTarget.Android, string.Join(";", defines));
        }

        private const string DebugIdSuffix = ".debug";
        private const string DebugDefine = "REDLINE_DEBUG_BUILD";
        private const string FirebaseDefine = "REDLINE_FIREBASE";

        private static void BakeBackendUrl(bool debug)
        {
            // With Firebase the endpoint comes from google-services.json + the
            // functions region, not a baked URL. REDLINE_API_URL is now OPTIONAL
            // and only used by a debug build that wants to point the Functions
            // SDK at a local emulator (host:port). A release build ignores it.
            string url = Environment.GetEnvironmentVariable("REDLINE_API_URL");

            // Any redline-backend.txt already on disk overrides everything: it is
            // an emulator host:port and RedlineSession points the whole Firebase
            // SDK at it. A stale one — left by an earlier `--debug` build, or
            // committed by accident — is exactly how a RELEASE APK ends up
            // talking cleartext to a dead LAN address and silently falling back
            // to offline Practice. So the file is only ever allowed to exist
            // when THIS build explicitly bakes it, and every other path removes
            // it first.
            if (string.IsNullOrWhiteSpace(url) || !debug)
            {
                ClearBakedBackend();
                Debug.Log(string.IsNullOrWhiteSpace(url)
                    ? "[BuildScript] REDLINE_API_URL not set — using the Firebase project from google-services.json."
                    : "[BuildScript] REDLINE_API_URL is set but ignored for a release build (Firebase only).");
                return;
            }

            // Past here: a debug build with REDLINE_API_URL explicitly set. It
            // may use cleartext, but only to a machine on the local network —
            // allowing any host would make this a general-purpose way to ship an
            // app that talks to the internet in the clear.
            bool https = url.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
            if (!https && !IsPrivateAddress(url))
            {
                throw new BuildFailedException(
                    $"A debug build may use http:// only to a private address (10.x, 172.16-31.x, 192.168.x, localhost). Got '{url}'.");
            }

            Directory.CreateDirectory(ResourcesDir);
            File.WriteAllText(Path.Combine(ResourcesDir, "redline-backend.txt"), url.Trim());

            // Imported before the build reads it; a file written straight to
            // disk is invisible to Resources.Load until the database sees it.
            AssetDatabase.Refresh();

            Debug.Log($"[BuildScript] backend baked as {url}");
        }

        /// <summary>
        /// Removes any redline-backend.txt (and its .meta) from Resources.
        ///
        /// Called on every build that is not a debug build explicitly baking an
        /// emulator URL. The file makes RedlineSession point the Firebase SDK at
        /// a host:port instead of the real project; a stale copy is how a
        /// release APK silently runs offline. Belt and braces: the file is also
        /// gitignored so it cannot be committed again.
        /// </summary>
        private static void ClearBakedBackend()
        {
            string path = Path.Combine(ResourcesDir, "redline-backend.txt");
            bool removed = false;
            foreach (var p in new[] { path, path + ".meta" })
                if (File.Exists(p)) { File.Delete(p); removed = true; }

            if (removed)
            {
                AssetDatabase.Refresh();
                Debug.Log("[BuildScript] removed a stale redline-backend.txt — this build talks to the real Firebase project.");
            }
        }

        /// <summary>
        /// True for an address on the local network.
        ///
        /// Parsed rather than pattern-matched on the string, so that
        /// `http://192.168.1.5.evil.com` — which starts with a private-looking
        /// prefix and resolves anywhere — is not mistaken for one.
        /// </summary>
        private static bool IsPrivateAddress(string url)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;

            string host = uri.Host;

            if (host == "localhost" || host == "127.0.0.1") return true;

            if (!System.Net.IPAddress.TryParse(host, out var ip)) return false;

            byte[] bytes = ip.GetAddressBytes();
            if (bytes.Length != 4) return false;

            // RFC 1918.
            if (bytes[0] == 10) return true;
            if (bytes[0] == 192 && bytes[1] == 168) return true;
            if (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) return true;

            return false;
        }

        private const string ResourcesDir = "Assets/Redline/Resources";

        private static string Require(string variable)
        {
            string value = Environment.GetEnvironmentVariable(variable);

            if (string.IsNullOrWhiteSpace(value))
                throw new BuildFailedException($"{variable} is not set; the release APK cannot be signed without it.");

            return value;
        }
    }
}
