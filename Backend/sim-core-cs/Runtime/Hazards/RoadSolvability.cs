using System;
using System.Collections.Generic;

namespace Redline.Core
{
    /// <summary>
    /// Proves a road is survivable, independently of the generator that built it.
    ///
    /// This deliberately does NOT reuse <see cref="RoadGenerator"/>'s reachable
    /// set. A checker that asks the generator whether the generator was careful
    /// proves nothing — it would confirm its own assumption and pass even if the
    /// reasoning behind that assumption were wrong. So this walks the real state
    /// machine from <see cref="Simulation"/> against the real hazards, using the
    /// same collision test the scoring loop uses.
    ///
    /// Method: forward breadth-first search over every state the player could
    /// legally occupy at each tick. If that set is ever empty, some earlier
    /// hazard placement killed every possible line and the road is unwinnable.
    ///
    /// The search does not use the input queue. Ignoring it makes the solver
    /// strictly more restrictive than a real player, so a road this proves
    /// survivable is survivable — the error is in the safe direction.
    /// </summary>
    public static class RoadSolvability
    {
        /// <summary>A point in the player's state machine. Mirrors Simulation.State.</summary>
        private readonly struct Node : IEquatable<Node>
        {
            public readonly short Lane;
            public readonly short Target;
            public readonly short Remaining;

            public Node(int lane, int target, int remaining)
            {
                Lane = (short)lane;
                Target = (short)target;
                Remaining = (short)remaining;
            }

            public bool Equals(Node o) => Lane == o.Lane && Target == o.Target && Remaining == o.Remaining;
            public override bool Equals(object? o) => o is Node n && Equals(n);
            public override int GetHashCode() => (Lane << 20) ^ (Target << 10) ^ Remaining;
        }

        public sealed class Report
        {
            public bool IsSolvable { get; }
            public int TicksProven { get; }
            public int FailedAtTick { get; }
            public int RescuedEncounters { get; }

            public Report(bool solvable, int ticksProven, int failedAtTick, int rescuedEncounters)
            {
                IsSolvable = solvable;
                TicksProven = ticksProven;
                FailedAtTick = failedAtTick;
                RescuedEncounters = rescuedEncounters;
            }

            public override string ToString() => IsSolvable
                ? $"solvable through {TicksProven} ticks"
                : $"UNWINNABLE at tick {FailedAtTick}";
        }

        /// <summary>
        /// Searches for any survivable line through <paramref name="ticks"/> ticks
        /// of the road generated from <paramref name="seed"/>.
        /// </summary>
        public static Report Check(GameConfig config, ulong seed, int ticks)
        {
            if (config == null) throw new ArgumentNullException(nameof(config));

            var road = new RoadGenerator(config, seed);
            var near = new List<Hazard>();
            long carLength = config.CarLengthUnits * config.PositionScale;

            var current = new HashSet<Node> { new Node(config.StartLane, config.StartLane, 0) };
            var next = new HashSet<Node>();

            long position = 0;

            for (int tick = 0; tick < ticks; tick++)
            {
                next.Clear();

                // Branch on every legal input, then advance exactly as the
                // simulation would.
                foreach (var node in current)
                {
                    if (node.Remaining == 0)
                    {
                        Advance(config, node, next);                                  // hold
                        if (node.Lane - 1 >= 0)
                            Advance(config, new Node(node.Lane, node.Lane - 1, config.LaneChangeDurationTicks), next);
                        if (node.Lane + 1 < config.LaneCount)
                            Advance(config, new Node(node.Lane, node.Lane + 1, config.LaneChangeDurationTicks), next);
                    }
                    else
                    {
                        Advance(config, node, next);                                  // hold the change

                        // Reversal: swap ends, mirror the timer.
                        int mirrored = config.LaneChangeDurationTicks - node.Remaining;
                        var reversed = mirrored == 0
                            ? new Node(node.Lane, node.Lane, 0)
                            : new Node(node.Target, node.Lane, mirrored);
                        Advance(config, reversed, next);
                    }
                }

                // Move, then discard every state that would be hit this tick.
                int speed = config.SpeedAtTick(tick);
                position += speed;

                road.EnsureGeneratedThrough(tick, position);
                road.CollectNear(tick, position, near);

                current.Clear();
                foreach (var node in next)
                {
                    // The player under test is GREEDY: they decline to bank and
                    // keep driving. Arriving in the cashout lane would end the
                    // run, so those lines are dropped rather than counted as
                    // success.
                    //
                    // This matters. An earlier version of this checker returned
                    // "solvable" the moment any branch reached the cashout lane,
                    // which happens about twelve ticks in from the start lane —
                    // so it proved "the player can bank quickly" and reported a
                    // pass over ten thousand seeds without ever examining the
                    // road. The requirement is that the road never FORCES a
                    // crash on a player who chooses to keep going, and that is
                    // only tested by refusing the exit.
                    //
                    // Transit toward the cashout lane is still explored: a
                    // player may legally move that way and reverse to dodge.
                    // Only full arrival is excluded.
                    if (node.Remaining == 0 && node.Lane == config.CashoutLane) continue;

                    bool hit = false;
                    for (int i = 0; i < near.Count && !hit; i++)
                    {
                        var hazard = near[i];
                        bool occupies = hazard.Lane == node.Lane
                                        || (node.Remaining > 0 && hazard.Lane == node.Target);
                        if (occupies && hazard.OverlapsAt(tick, position, carLength)) hit = true;
                    }

                    if (!hit) current.Add(node);
                }

                if (current.Count == 0)
                    return new Report(false, tick, tick, road.RescuedEncounters);
            }

            return new Report(true, ticks, -1, road.RescuedEncounters);
        }

        /// <summary>Applies one tick of lane-change progress, mirroring the simulation.</summary>
        private static void Advance(GameConfig config, Node node, HashSet<Node> into)
        {
            if (node.Remaining == 0)
            {
                into.Add(new Node(node.Lane, node.Lane, 0));
                return;
            }

            int remaining = node.Remaining - 1;
            into.Add(remaining == 0
                ? new Node(node.Target, node.Target, 0)
                : new Node(node.Lane, node.Target, remaining));
        }
    }
}
