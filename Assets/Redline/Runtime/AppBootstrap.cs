using PrimeTween;
using UnityEngine;

namespace Redline.Client
{
    /// <summary>
    /// Process-wide runtime defaults, applied once before the first scene loads.
    ///
    /// Frame-rate target: on Android Unity leaves
    /// <see cref="Application.targetFrameRate"/> at -1, which the OS resolves to
    /// 30 to save battery — a device test measured 29.9 fps on a Snapdragon 4
    /// Gen 2 for exactly this reason, not a GPU limit. A hard 60 (not
    /// <c>vSyncCount = 1</c>, which a 90/120 Hz panel would overshoot) keeps
    /// visible motion aligned with the 60 Hz tick rate the server re-simulates at.
    ///
    /// PrimeTween capacity is pre-sized so the UI's tweens never trigger a
    /// runtime pool grow (which allocates and logs a warning). The whole client
    /// runs a handful at once — button spring + shine, a panel appear, a value
    /// punch, the screen-rainbow wash.
    /// </summary>
    internal static class AppBootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void Configure()
        {
            Application.targetFrameRate = 60;
            PrimeTweenConfig.SetTweensCapacity(64);
        }
    }
}
