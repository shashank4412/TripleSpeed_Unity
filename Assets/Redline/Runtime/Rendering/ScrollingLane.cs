using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// Scrolls a material's main-texture offset along the road so the 5&#215;
    /// lane reads as a flowing rainbow. Presentation only.
    ///
    /// It moves a material handed to it by <see cref="RoadRenderer"/>, which owns
    /// that instance and its texture — this component allocates and frees
    /// nothing.
    /// </summary>
    public sealed class ScrollingLane : MonoBehaviour
    {
        [Tooltip("Texture-units per second along the road. Negative flows toward the player.")]
        [SerializeField] private float scrollSpeed = -0.5f;

        private Material _material;

        /// <summary>The material whose offset is animated. Owned by the caller.</summary>
        public void Bind(Material material) => _material = material;

        private void Update()
        {
            if (_material == null) return;

            var offset = _material.mainTextureOffset;
            offset.y = Mathf.Repeat(offset.y + scrollSpeed * Time.deltaTime, 1f);
            _material.mainTextureOffset = offset;
        }
    }
}
