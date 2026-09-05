using UnityEngine;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// Gives this <see cref="Image"/> one of the shared runtime-generated
    /// <see cref="UiSprites"/> shapes in <c>Awake</c>. The scene is authored
    /// (ADR 0016) but nothing here is dragged in from a .png — this is
    /// self-contained cosmetic decoration built in <c>Awake</c>, the same
    /// pattern as <see cref="UiButtonFx"/>'s child graphics. Tint via
    /// <c>Image.color</c>.
    /// </summary>
    [RequireComponent(typeof(Image))]
    public sealed class UiShapeSprite : MonoBehaviour
    {
        public enum Shape { RoundedRect, Circle }

        [Tooltip("Which generated shape to apply. RoundedRect is 9-sliced so the corner radius holds at any size.")]
        [SerializeField] private Shape shape = Shape.RoundedRect;

        private void Awake()
        {
            var image = GetComponent<Image>();

            if (shape == Shape.Circle)
            {
                image.sprite = UiSprites.Circle();
                image.type = Image.Type.Simple;
                image.preserveAspect = true;
                return;
            }

            image.sprite = UiSprites.RoundedRect();
            image.type = Image.Type.Sliced;
            image.pixelsPerUnitMultiplier = 2.4f;
        }
    }
}
