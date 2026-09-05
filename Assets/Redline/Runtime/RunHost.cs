using System;
using System.Collections.Generic;
using Redline.Core;
using UnityEngine;

namespace Redline.Client
{
    /// <summary>
    /// Owns one run and drives the simulation core at a fixed tick rate.
    ///
    /// It contains no rules: every tick is one call to
    /// <see cref="Simulation.Advance"/>, the same method
    /// <see cref="Simulation.Run"/> loops over on the server. A second tick loop
    /// here would silently break the client/server agreement the product rests on.
    /// Renderers read <see cref="State"/> and never write it — the visual car
    /// position bears on neither score nor collision.
    /// </summary>
    // Awakes first: RoadRenderer, HazardRenderer, CarVisual and RunHud each build
    // a LaneGeometry from Config in their own Awake, and Unity does not order
    // Awake between components on one GameObject — without this they can read a
    // null Config and disable themselves on the NRE.
    [DefaultExecutionOrder(-100)]
    [DisallowMultipleComponent]
    public sealed class RunHost : MonoBehaviour
    {
        [Header("Config")]
        [Tooltip("redline.game.json, copied verbatim from Backend/config/. Never edit this copy — edit the source.")]
        [SerializeField] private TextAsset gameConfigJson;


        /// <summary>The rules, parsed once. Lane count and everything else comes from here.</summary>
        public GameConfig Config { get; private set; }

        /// <summary>
        /// Live simulation state. Read-only by convention — wrapping it would
        /// cost an allocation per access in the render path.
        /// </summary>
        public Simulation.State State { get; private set; }

        /// <summary>Hazards near the player this tick. Reused; do not retain.</summary>
        public List<Hazard> VisibleHazards => _near;

        /// <summary>Null while the run is in progress.</summary>
        public RunOutcome? Outcome { get; private set; }

        /// <summary>
        /// Held by the pre-run ready/go sequence: the run is armed (state exists,
        /// road and HUD render) but the tick loop does not advance. Cleared on "GO!".
        ///
        /// Gates the START only — never a run in motion. Once the core is
        /// advancing, tick count is a function of elapsed time alone; pausing
        /// here while the server's replay does not would be the client/server
        /// disagreement this class exists to prevent. While frozen the
        /// accumulator is not fed, so unfreezing carries no catch-up debt.
        /// </summary>
        public bool Frozen { get; set; }

        /// <summary>Every swipe the player made, with the tick it landed on. This becomes the submission evidence.</summary>
        public IReadOnlyList<InputEvent> Recorded => _recorded;

        public ulong Seed { get; private set; }

        public event Action<RunResult> RunEnded;

        /// <summary>
        /// Fired at the end of <see cref="BeginRun"/>, before the first tick.
        /// The renderers use it to clear anything left over from the previous
        /// run — the wreck pose, the crash particles, the stale hazard meshes —
        /// so a replay does not start on the last run's debris.
        /// </summary>
        public event Action RunStarted;

        private RoadGenerator _road;
        private readonly List<Hazard> _near = new List<Hazard>(64);
        private readonly List<InputEvent> _recorded = new List<InputEvent>(128);

        private double _accumulator;
        private double _secondsPerTick;
        private SwipeDirection? _pending;

        private void Awake()
        {
            if (gameConfigJson == null)
                throw new InvalidOperationException("RunHost has no game config assigned; assign Settings/redline.game.json.txt");

            Config = GameConfig.Parse(gameConfigJson.text);

            // Tick rate is config, not a constant: client and server read the
            // same file, so changing ticksPerSecond changes both.
            _secondsPerTick = 1.0 / Config.TicksPerSecond;
        }

        /// <summary>Starts a run on a server-issued seed. Any run in progress is discarded.</summary>
        public void BeginRun(ulong seed)
        {
            Seed = seed;
            State = Simulation.NewState(Config);
            _road = new RoadGenerator(Config, seed);
            _near.Clear();
            _recorded.Clear();
            _accumulator = 0;
            _pending = null;
            Outcome = null;

            RunStarted?.Invoke();
        }

        /// <summary>
        /// Ends a run in progress now — the double-tap "quit" from the in-run
        /// exit control. No-op if no run is running.
        ///
        /// Finishes as <see cref="RunOutcome.Abandoned"/>, so the normal
        /// <see cref="RunEnded"/> path submits the evidence so far and the server
        /// scores it: a run that never banked scores 0 and settles as an ordinary
        /// loss (ADR 0004). Quitting is never better than playing on, so the exit
        /// prompt is not an exploit.
        /// </summary>
        public void AbortRun()
        {
            if (State == null || Outcome.HasValue) return;
            Finish(RunOutcome.Abandoned);
        }

        /// <summary>
        /// Records a swipe to apply on the next tick.
        ///
        /// Recorded whether or not the rules accept it — swiping left in lane 0
        /// is a no-op that still happened, and the submission must say so. At
        /// most one swipe per tick reaches the core (RunInput forbids two); a
        /// second within the same tick replaces the first.
        /// </summary>
        public void Swipe(SwipeDirection direction)
        {
            if (Outcome.HasValue) return;

            _pending = direction;
        }

        private void Update()
        {
            // Frozen: armed but held on the ready/go screen. Return before the
            // accumulator is fed so no catch-up debt builds while "READY" shows.
            if (Outcome.HasValue || State == null || Frozen) return;

            // Real time in, whole ticks out — never a partial tick, or it is not
            // the simulation the server runs.
            _accumulator += Time.deltaTime;

            // Bounded so a long hitch (GC pause, app resume) can't fast-forward
            // through unseen hazards: the run falls behind the wall clock
            // instead, which is honest — score is a function of ticks.
            if (_accumulator > MaxCatchUpSeconds) _accumulator = MaxCatchUpSeconds;

            while (_accumulator >= _secondsPerTick)
            {
                _accumulator -= _secondsPerTick;

                if (!StepOnce()) return;
            }
        }

        /// <summary>Returns false when the run has ended.</summary>
        private bool StepOnce()
        {
            SwipeDirection? swipe = _pending;
            if (swipe.HasValue)
            {
                _recorded.Add(new InputEvent(State.Tick, swipe.Value));
                _pending = null;
            }

            var tick = Simulation.Advance(Config, State, _road, _near, swipe);

            if (tick == Simulation.TickOutcome.Running)
            {
                // From shared config, never a local number: a serialized field
                // defaulting to 1800 while the server bounded replay at 10800
                // once had the client call ABANDONED where the server recorded
                // CRASHED for the same swipes.
                if (State.Tick < Config.MaxRunTicks) return true;

                // Out of ticks without banking or crashing — the server calls
                // this ABANDONED and settles it as a loss (ADR 0004).
                Finish(RunOutcome.Abandoned);
                return false;
            }

            Finish(tick == Simulation.TickOutcome.Banked ? RunOutcome.Banked : RunOutcome.Crashed);
            return false;
        }

        private void Finish(RunOutcome outcome)
        {
            Outcome = outcome;

            // A preview only: the server re-simulates the seed and swipes and
            // its number is the one that pays. This is what to show while waiting.
            RunEnded?.Invoke(Simulation.Result(Config, State, outcome));
        }

        /// <summary>
        /// How far behind the wall clock a run may fall before it stops catching
        /// up. ~15 ticks: enough to ride out a frame spike, short enough that the
        /// player never watches hazards fly past at 10x.
        /// </summary>
        private const double MaxCatchUpSeconds = 0.25;
    }
}
