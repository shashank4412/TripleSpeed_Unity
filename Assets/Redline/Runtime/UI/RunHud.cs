using Redline.Core;
using UnityEngine;

namespace Redline.Client.UI
{
    /// <summary>
    /// The run HUD: score, effective multiplier, speed. Reads
    /// <see cref="Simulation.State"/>, never writes it. The multiplier comes from
    /// <see cref="Simulation.EffectiveMultiplier"/> — the same function that
    /// scores the run — so the HUD is not a second implementation of the rule
    /// review test #5 probes. Formatting and value-caching are
    /// <see cref="RunHudView"/>'s; nothing here allocates after Awake.
    /// </summary>
    [RequireComponent(typeof(RunHost))]
    public sealed class RunHud : MonoBehaviour
    {
        [Tooltip("The view that formats these numbers. Drag the RunHudView here.")]
        [SerializeField] private RunHudView view;

        private RunHost _host;

        private void Awake()
        {
            _host = GetComponent<RunHost>();
        }

        private void LateUpdate()
        {
            var state = _host.State;
            if (state == null || view == null) return;

            // What the player would bank if they cashed out now — the whole
            // tension. Zero on a crash, the instant it happens.
            view.SetScore(state.ScoreUnits / _host.Config.PositionScale);

            // Effective multiplier: mid-change this is the lower of origin and
            // destination, so hovering the 0/1 boundary shows 2x not 5x. From the
            // core, never recomputed here.
            view.SetMultiplier(Simulation.EffectiveMultiplier(_host.Config, state));

            view.SetSpeed(_host.Config.SpeedAtTick(state.Tick) / Units.MilliScale);
        }
    }
}
