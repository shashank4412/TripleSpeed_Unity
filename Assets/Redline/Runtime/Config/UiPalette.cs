using UnityEngine;

namespace Redline.Client.Config
{
    /// <summary>
    /// The client's UI colour set, as an editable asset. Replaces the colour
    /// constants that lived in the deleted <c>UiFactory</c> (ADR 0016) so a
    /// designer can retint every panel from one place with no recompile.
    ///
    /// Presentation only. Create one via
    /// <c>Assets ▸ Create ▸ Redline ▸ UI Palette</c>.
    /// </summary>
    [CreateAssetMenu(menuName = "Redline/UI Palette", fileName = "UiPalette")]
    public sealed class UiPalette : ScriptableObject
    {
        [Tooltip("Warm off-white — headings and primary readouts.")]
        public Color cream = new Color(1f, 0.93f, 0.62f);

        [Tooltip("Alert yellow — connection and matchmaking notices only.")]
        public Color yellow = new Color(1f, 0.86f, 0.20f);

        [Tooltip("Near-white — body text and button labels.")]
        public Color white = new Color(0.98f, 0.98f, 1f);

        [Tooltip("Muted grey — secondary and disabled text.")]
        public Color grey = new Color(0.62f, 0.62f, 0.66f);

        [Tooltip("Action orange — the primary Play button.")]
        public Color orange = new Color(0.94f, 0.35f, 0.13f);

        [Tooltip("Near-black — opaque panel backgrounds.")]
        public Color ink = new Color(0.05f, 0.05f, 0.07f);

        [Tooltip("Translucent black — dimming scrims over the road.")]
        public Color scrim = new Color(0f, 0f, 0f, 0.55f);

        [Tooltip("Dark slab — raised card / secondary panel backgrounds.")]
        public Color slab = new Color(0.09f, 0.09f, 0.12f, 0.94f);
    }
}
