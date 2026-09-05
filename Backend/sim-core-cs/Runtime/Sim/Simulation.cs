using System;
using System.Collections.Generic;

namespace Redline.Core
{
    /// <summary>
    /// The deterministic simulation. This is the score of record.
    ///
    /// The same compiled assembly runs on the phone (as a renderer's data
    /// source) and on the server (as the authority). The client never submits a
    /// score; it submits the seed it was issued and the swipes the player made,
    /// and the server runs this and publishes the answer.
    ///
    /// Determinism rests on three properties, all checkable by reading this file:
    ///   1. No floating point. Position and score are long, advanced by integer
    ///      addition only — see <see cref="Units"/> for why the per-tick delta
    ///      is a whole number by construction.
    ///   2. No wall clock and no engine time. The loop is driven by a tick
    ///      counter; render framerate cannot influence the result.
    ///   3. No ambient randomness. Every hazard comes from a seeded PCG32.
    ///
    /// A phone dropping frames therefore produces the identical score, to the
    /// point, as the server. Not within a point.
    /// </summary>
    public static class Simulation
    {
        /// <summary>
        /// Live state of a run. Exposed so the Unity client can render from the
        /// same state the server scores from, rather than keeping a parallel
        /// copy that could disagree.
        /// </summary>
        public sealed class State
        {
            public int Tick;

            /// <summary>Lane the car is in, or moving out of while changing.</summary>
            public int Lane;

            /// <summary>Lane being moved to. Equals <see cref="Lane"/> when settled.</summary>
            public int TargetLane;

            /// <summary>Ticks left in the current lane change. Zero when settled.</summary>
            public int ChangeTicksRemaining;

            /// <summary>Buffered swipe, or null. At most one, per the rules.</summary>
            public SwipeDirection? Queued;

            /// <summary>Road position, in position units.</summary>
            public long Position;

            /// <summary>Score accumulator, in position units. Divided once, at the end.</summary>
            public long ScoreUnits;

            public int RejectedInputs;

            public bool IsChangingLanes => ChangeTicksRemaining > 0;

            /// <summary>
            /// Progress through the current lane change, in thousandths. The
            /// renderer uses this to place the car between lanes; the
            /// simulation never does, because visual position has no bearing on
            /// score or collision.
            /// </summary>
            public int ChangeProgressMilli(GameConfig config) =>
                ChangeTicksRemaining == 0
                    ? Units.MilliScale
                    : (int)((long)(config.LaneChangeDurationTicks - ChangeTicksRemaining)
                            * Units.MilliScale / config.LaneChangeDurationTicks);
        }

        /// <summary>How one tick ended.</summary>
        public enum TickOutcome
        {
            /// <summary>The run continues. <see cref="State.Tick"/> has advanced.</summary>
            Running,

            /// <summary>Full arrival in the cashout lane. The score is banked.</summary>
            Banked,

            /// <summary>Hit a hazard. The score is zero.</summary>
            Crashed,
        }

        /// <summary>
        /// Runs a submission to completion and returns the authoritative result.
        /// </summary>
        public static RunResult Run(GameConfig config, RunInput input)
        {
            if (config == null) throw new ArgumentNullException(nameof(config));
            if (input == null) throw new ArgumentNullException(nameof(input));

            var state = NewState(config);
            var road = new RoadGenerator(config, input.Seed);
            var near = new List<Hazard>();
            int nextEvent = 0;

            while (state.Tick < input.MaxTicks)
            {
                // RunInput guarantees at most one event per tick — a swipe is
                // discrete — so a single nullable is the whole of the input for
                // this tick.
                SwipeDirection? swipe = null;
                if (nextEvent < input.Events.Count && input.Events[nextEvent].Tick == state.Tick)
                {
                    swipe = input.Events[nextEvent].Direction;
                    nextEvent++;
                }

                switch (Advance(config, state, road, near, swipe))
                {
                    case TickOutcome.Banked: return Finish(config, state, RunOutcome.Banked);
                    case TickOutcome.Crashed: return Finish(config, state, RunOutcome.Crashed);
                }
            }

            // Ran out of ticks without banking or crashing. The submission is
            // incomplete, so it scores nothing and settles as a loss.
            return Finish(config, state, RunOutcome.Abandoned);
        }

        /// <summary>A run's starting state. The client and <see cref="Run"/> must not disagree about it.</summary>
        public static State NewState(GameConfig config)
        {
            if (config == null) throw new ArgumentNullException(nameof(config));

            return new State
            {
                Lane = config.StartLane,
                TargetLane = config.StartLane,
            };
        }

        /// <summary>
        /// Advances exactly one tick. **This is the only implementation of the
        /// rules.**
        ///
        /// It exists because <see cref="Run"/> is right for the server and wrong
        /// for a client: the server wants a whole run in one call, the phone has
        /// to render between ticks. Without this the client would grow a second
        /// tick loop, the two would drift on the first edit anybody made to
        /// either, and the client/server agreement this product rests on would
        /// quietly stop being true. <see cref="Run"/> is a loop around this
        /// method precisely so there is nothing to drift.
        ///
        /// Allocation-free: the caller owns <paramref name="scratch"/> and
        /// reuses it for the lifetime of the run, and <paramref name="swipe"/>
        /// is a nullable struct. A phone calls this sixty times a second.
        /// </summary>
        /// <param name="scratch">Reused hazard buffer. Contents are not preserved between calls.</param>
        /// <param name="swipe">The swipe made on this tick, or null. At most one; a swipe is discrete.</param>
        public static TickOutcome Advance(
            GameConfig config, State state, RoadGenerator road, List<Hazard> scratch, SwipeDirection? swipe)
        {
            // ---- 1. input ------------------------------------------------
            // Applied before movement so a swipe takes effect on the tick it
            // was made, which is what makes reversal feel immediate rather
            // than mushy.
            if (swipe.HasValue) ApplySwipe(config, state, swipe.Value);

            // ---- 2. advance the lane change -----------------------------
            bool arrived = false;
            if (state.ChangeTicksRemaining > 0)
            {
                state.ChangeTicksRemaining--;
                if (state.ChangeTicksRemaining == 0)
                {
                    state.Lane = state.TargetLane;
                    arrived = true;
                }
            }

            // A queued swipe starts only once the car has settled. This is
            // what "at most one queued input" means mechanically.
            if (state.ChangeTicksRemaining == 0 && state.Queued.HasValue)
            {
                var queued = state.Queued.Value;
                state.Queued = null;
                StartChange(config, state, queued);
            }

            // ---- 3. banking ---------------------------------------------
            // Only on FULL arrival in the cashout lane. Not on the swipe.
            // A player at 5x needs three successive changes to bank and can
            // die on any of them with the whole score on the line; that is
            // the best moment in the game and it must not be softened.
            //
            // Returns without advancing the tick, so EndTick is the tick the
            // run ended ON rather than the one after it.
            if (arrived && state.Lane == config.CashoutLane) return TickOutcome.Banked;

            // ---- 4. movement and score ----------------------------------
            // Exact integer addition. See Units for why no division appears.
            int speedMilli = config.SpeedAtTick(state.Tick);
            state.Position += speedMilli;
            state.ScoreUnits += (long)speedMilli * EffectiveMultiplier(config, state);

            // ---- 5. collision -------------------------------------------
            road.EnsureGeneratedThrough(state.Tick, state.Position);
            road.CollectNear(state.Tick, state.Position, scratch);

            for (int i = 0; i < scratch.Count; i++)
            {
                var hazard = scratch[i];
                if (!OccupiesLane(state, hazard.Lane)) continue;
                if (!hazard.OverlapsAt(state.Tick, state.Position, config.CarLengthUnits * config.PositionScale))
                    continue;

                return TickOutcome.Crashed;
            }

            state.Tick++;
            return TickOutcome.Running;
        }

        /// <summary>
        /// The result a run in progress would produce if it ended now. The
        /// client uses it to show a live score; the server's answer is still
        /// the one that counts.
        /// </summary>
        public static RunResult Result(GameConfig config, State state, RunOutcome outcome) =>
            Finish(config, state, outcome);

        /// <summary>
        /// The multiplier in force this tick: while changing lanes it is the
        /// LOWER of origin and destination.
        ///
        /// Mandatory, and it exists to close one exploit. Without it a player
        /// parks on the boundary between lane 1 and lane 0 and claims 5x while
        /// keeping most of the car in the safer lane. Review test #5 probes this
        /// directly by hovering on a boundary.
        /// </summary>
        /// <remarks>
        /// Public because the HUD must show this number and must not compute
        /// its own. A player hovering the 0/1 boundary has to see 2x, and
        /// review test #5 probes exactly that — a second implementation in the
        /// client would be a second chance to get it wrong, and the one that
        /// disagreed would be the one on screen.
        /// </remarks>
        public static int EffectiveMultiplier(GameConfig config, State state) =>
            state.IsChangingLanes
                ? config.EffectiveMultiplier(state.Lane, state.TargetLane)
                : config.MultiplierOf(state.Lane);

        /// <summary>
        /// Whether the car's hitbox covers a lane this tick. While changing, it
        /// covers BOTH origin and destination — crossing traffic is the risk,
        /// and that risk has to be real.
        /// </summary>
        private static bool OccupiesLane(State state, int lane) =>
            lane == state.Lane || (state.IsChangingLanes && lane == state.TargetLane);

        private static void ApplySwipe(GameConfig config, State state, SwipeDirection direction)
        {
            if (!state.IsChangingLanes)
            {
                StartChange(config, state, direction);
                return;
            }

            // Reversal is always legal and is never queued behind the move in
            // flight. A player mid-change from lane 2 to lane 1 who swipes right
            // must abort back to lane 2 immediately.
            int inFlight = Math.Sign(state.TargetLane - state.Lane);
            if (inFlight == -(int)direction)
            {
                // Swap ends and mirror the timer: having travelled
                // (duration - remaining) toward the target, the car is exactly
                // that far from the origin it is now returning to.
                (state.Lane, state.TargetLane) = (state.TargetLane, state.Lane);
                state.ChangeTicksRemaining = config.LaneChangeDurationTicks - state.ChangeTicksRemaining;

                // The reversal supersedes anything buffered; the player has
                // clearly changed their mind.
                state.Queued = null;

                if (state.ChangeTicksRemaining == 0) state.Lane = state.TargetLane;
                return;
            }

            // Same direction as the move in flight: buffer it, up to the limit.
            if (state.Queued.HasValue || config.MaxQueuedInputs == 0)
            {
                // A third swipe while one is in flight and one is queued is
                // discarded. Deterministic and documented, rather than
                // "it depends on timing".
                state.RejectedInputs++;
                return;
            }

            state.Queued = direction;
        }

        private static void StartChange(GameConfig config, State state, SwipeDirection direction)
        {
            int target = state.Lane + (int)direction;

            // Swiping left in lane 0 or right in the last lane is a no-op, but
            // it still HAPPENED. It is counted here and recorded in the
            // submission, because what the player did is not the same as what
            // the game accepted.
            if (target < 0 || target >= config.LaneCount)
            {
                state.RejectedInputs++;
                return;
            }

            state.TargetLane = target;
            state.ChangeTicksRemaining = config.LaneChangeDurationTicks;
        }

        private static RunResult Finish(GameConfig config, State state, RunOutcome outcome)
        {
            // A crash zeroes the score. No revives, no continues, no second
            // chances. The zero is the product.
            long scoreUnits = outcome == RunOutcome.Banked ? state.ScoreUnits : 0L;

            return new RunResult(
                outcome,
                scoreUnits / config.PositionScale,
                scoreUnits,
                state.Tick,
                state.Position / config.PositionScale,
                state.Lane,
                state.RejectedInputs,
                config.ConfigHash);
        }
    }
}
