using System;
using System.Collections.Generic;

namespace Redline.Core
{
    /// <summary>A swipe. One swipe moves one lane; there is no free steering.</summary>
    public enum SwipeDirection
    {
        Left = -1,
        Right = 1,
    }

    /// <summary>
    /// How a run ended. Exhaustive, per the brief.
    /// </summary>
    public enum RunOutcome
    {
        /// <summary>Reached the cashout lane. Score is final and paid.</summary>
        Banked,

        /// <summary>Hit a hazard. Score is zero. No revives, no continues.</summary>
        Crashed,

        /// <summary>Staked, seeded, never submitted. Scores zero and settles as a loss.</summary>
        Abandoned,

        /// <summary>The challenge expired with no opponent. Refunded, no rating change.</summary>
        Expired,
    }

    /// <summary>
    /// One recorded swipe. The tick is what makes a run reconstructible: the
    /// server replays inputs against the same seed and the same config, and the
    /// score it computes is the score of record.
    /// </summary>
    public readonly struct InputEvent : IEquatable<InputEvent>
    {
        public int Tick { get; }
        public SwipeDirection Direction { get; }

        public InputEvent(int tick, SwipeDirection direction)
        {
            if (tick < 0) throw new ArgumentOutOfRangeException(nameof(tick));
            Tick = tick;
            Direction = direction;
        }

        public bool Equals(InputEvent other) => Tick == other.Tick && Direction == other.Direction;
        public override bool Equals(object? obj) => obj is InputEvent e && Equals(e);
        public override int GetHashCode() => unchecked(Tick * 397 ^ (int)Direction);
        public override string ToString() => $"{Tick}:{(Direction == SwipeDirection.Left ? 'L' : 'R')}";
    }

    /// <summary>
    /// Everything needed to reproduce a run, and nothing else.
    ///
    /// Note what is absent: a score. The client never submits one. It submits
    /// the seed it was issued and the swipes the player made; the server
    /// re-simulates and its answer is authoritative. If the client also sends a
    /// score, that value is treated as a claim to be checked and logged when it
    /// disagrees, never as an input.
    ///
    /// Swipes that the rules will reject — swiping left in lane 0, or a third
    /// swipe while one is in flight and one queued — are still recorded here.
    /// What the player did is not the same as what the game accepted, and the
    /// record should reflect the former.
    /// </summary>
    public sealed class RunInput
    {
        public ulong Seed { get; }

        /// <summary>Swipes in tick order. At most one per tick.</summary>
        public IReadOnlyList<InputEvent> Events { get; }

        /// <summary>
        /// Hard stop for the replay, so a malformed or hostile submission cannot
        /// make the server simulate forever. A run that reaches it without
        /// banking or crashing is <see cref="RunOutcome.Abandoned"/>.
        /// </summary>
        public int MaxTicks { get; }

        public RunInput(ulong seed, IReadOnlyList<InputEvent> events, int maxTicks)
        {
            if (events == null) throw new ArgumentNullException(nameof(events));
            if (maxTicks <= 0) throw new ArgumentOutOfRangeException(nameof(maxTicks));

            for (int i = 1; i < events.Count; i++)
            {
                if (events[i].Tick < events[i - 1].Tick)
                    throw new ArgumentException($"input events must be in tick order; event {i} goes backwards", nameof(events));
                if (events[i].Tick == events[i - 1].Tick)
                    throw new ArgumentException($"two input events share tick {events[i].Tick}; a swipe is discrete", nameof(events));
            }

            Seed = seed;
            Events = events;
            MaxTicks = maxTicks;
        }
    }

    /// <summary>The authoritative result of simulating a <see cref="RunInput"/>.</summary>
    public sealed class RunResult
    {
        public RunOutcome Outcome { get; }

        /// <summary>Whole-number score shown to the player. Zero unless banked.</summary>
        public long Score { get; }

        /// <summary>Internal fixed-point score before the final divide. Kept for test vectors.</summary>
        public long ScoreUnits { get; }

        /// <summary>Tick on which the run ended.</summary>
        public int EndTick { get; }

        /// <summary>Distance travelled, in whole game units.</summary>
        public long Distance { get; }

        /// <summary>Lane occupied when the run ended.</summary>
        public int FinalLane { get; }

        /// <summary>Swipes the rules rejected — out of bounds, or over the queue limit.</summary>
        public int RejectedInputs { get; }

        /// <summary>Config the run was scored under. A mismatch invalidates comparison.</summary>
        public string ConfigHash { get; }

        public RunResult(RunOutcome outcome, long score, long scoreUnits, int endTick,
                         long distance, int finalLane, int rejectedInputs, string configHash)
        {
            Outcome = outcome;
            Score = score;
            ScoreUnits = scoreUnits;
            EndTick = endTick;
            Distance = distance;
            FinalLane = finalLane;
            RejectedInputs = rejectedInputs;
            ConfigHash = configHash;
        }

        public override string ToString() =>
            $"{Outcome}(score={Score}, tick={EndTick}, lane={FinalLane}, dist={Distance})";
    }
}
