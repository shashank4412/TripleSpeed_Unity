using Redline.Core;
using UnityEngine;

namespace Redline.Client.Input
{
    /// <summary>
    /// Feeds swipes to the run — it does not interpret them.
    /// <see cref="Simulation.Advance"/> (the server's code) decides what a swipe
    /// does. Every swipe is reported on its tick, including ones the rules will
    /// refuse, because the submission must record what the player did.
    /// </summary>
    [RequireComponent(typeof(RunHost))]
    public sealed class SwipeInput : MonoBehaviour
    {
        [Tooltip("Settings/redline.input.json.txt — swipe dead-zone and timing. Client-only; never affects a score.")]
        [SerializeField] private TextAsset swipeSettingsJson;

        private RunHost _host;
        private SwipeRecogniser _recogniser;

        private void Awake()
        {
            _host = GetComponent<RunHost>();

            var settings = swipeSettingsJson != null
                ? SwipeSettings.Parse(swipeSettingsJson.text)
                : new SwipeSettings();

            _recogniser = new SwipeRecogniser(settings);
        }

        private void Update()
        {
            // Editor keyboard shortcut.
            if (UnityEngine.Input.GetKeyDown(KeyCode.LeftArrow))
                _host.Swipe(SwipeDirection.Left);
            else if (UnityEngine.Input.GetKeyDown(KeyCode.RightArrow))
                _host.Swipe(SwipeDirection.Right);

            // Touch first, mouse as the Editor fallback. GetTouch(0) does not
            // allocate; Input.touches would.
            if (UnityEngine.Input.touchCount > 0)
            {
                Touch touch = UnityEngine.Input.GetTouch(0);

                switch (touch.phase)
                {
                    case TouchPhase.Began:
                        _recogniser.Begin(touch.position, Time.unscaledTime);
                        break;

                    case TouchPhase.Ended:
                        Resolve(touch.position);
                        break;

                    case TouchPhase.Canceled:
                        _recogniser.Cancel();
                        break;
                }

                return;
            }

            if (UnityEngine.Input.GetMouseButtonDown(0))
                _recogniser.Begin(UnityEngine.Input.mousePosition, Time.unscaledTime);
            else if (UnityEngine.Input.GetMouseButtonUp(0))
                Resolve(UnityEngine.Input.mousePosition);
        }

        private void Resolve(Vector2 position)
        {
            if (_recogniser.End(position, Time.unscaledTime, out var direction))
                _host.Swipe(direction);
        }
    }
}
