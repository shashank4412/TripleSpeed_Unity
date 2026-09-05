using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// Pans the run camera sideways to keep the car centred through a lane change,
    /// so the world sweeps past the frame instead of the car sliding across it.
    ///
    /// Presentation only. Runs after <see cref="CarVisual"/> (late execution
    /// order) and smooths with <see cref="Mathf.SmoothDamp"/> so a 200 ms lane
    /// change does not whip the camera.
    /// </summary>
    [DefaultExecutionOrder(100)]
    public sealed class CameraFollow : MonoBehaviour
    {
        [Tooltip("Drag the run camera here.")]
        [SerializeField] private Camera runCamera;

        [Tooltip("Drag the visual car transform here.")]
        [SerializeField] private Transform car;

        [Tooltip("0 = camera never follows; 1 = the car is always dead centre.")]
        [Range(0f, 1f)]
        [SerializeField] private float follow = 0.85f;

        [Tooltip("Seconds for the camera to catch up to the car's lane. Lower is snappier.")]
        [SerializeField] private float smoothTime = 0.16f;

        private float _baseX;
        private float _velocity;

        private void Awake()
        {
            // After RoadRenderer.FrameCamera has placed the camera (default
            // execution order runs before this component's +100).
            if (runCamera != null) _baseX = runCamera.transform.position.x;
        }

        private void LateUpdate()
        {
            if (runCamera == null || car == null) return;

            float targetX = _baseX + (car.position.x - _baseX) * follow;

            var p = runCamera.transform.position;
            p.x = Mathf.SmoothDamp(p.x, targetX, ref _velocity, smoothTime);
            runCamera.transform.position = p;
        }
    }
}
