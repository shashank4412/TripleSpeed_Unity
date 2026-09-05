using System;
using System.Collections.Generic;

namespace Redline.Core
{
    /// <summary>
    /// Builds the road from a seed, and cannot build an unwinnable one.
    ///
    /// THE REQUIREMENT
    /// "The road must never be unwinnable. The generator must not produce a
    /// longitudinal position where every lane is blocked such that no legal
    /// sequence of lane changes survives." A money game that kills a player
    /// through no fault of theirs is a refund request and a one-star review.
    ///
    /// WHY THIS REASONS IN TICKS, NOT ROAD DISTANCE
    /// The first version of this generator placed hazards into fixed slices of
    /// road and checked that each slice left a lane open. That was wrong, and
    /// the solvability harness caught it: every road it produced was
    /// unwinnable. Two reasons, both about the gap between space and time.
    ///
    ///   1. Moving traffic does not stay in its slice. The player overtakes it
    ///      at the DIFFERENCE of their speeds, so a car nine units long being
    ///      passed at a tenth of a unit per tick sits alongside the player for
    ///      the better part of a second. It blocks its lane across many slices.
    ///   2. What matters to a player is not whether a lane is clear at a road
    ///      position, but whether it is clear during the ticks they would be
    ///      there. Collision is evaluated per tick, so the safety argument has
    ///      to be made per tick too, or it is arguing about the wrong thing.
    ///
    /// So this generator works forward in ticks. For each hazard it computes the
    /// exact tick window during which that hazard would overlap the player's
    /// hitbox — using the same interval test the scoring loop uses — and keeps a
    /// per-lane record of when each lane is next free. The invariant it enforces
    /// is the one that actually matters: at every encounter, at least one
    /// SCORING lane the player can reach in time is clear for the whole window.
    ///
    /// Note "scoring". Arriving in the cashout lane ends the run, so a lane set
    /// whose only survivor is the cashout lane offers a greedy player no escape
    /// at all — it forces them to bank or die. That is not a survivable road.
    ///
    /// DETERMINISM
    /// The road is a pure function of (seed, config). It never consults player
    /// state, which rules out difficulty that adapts to how the player is doing,
    /// deliberately.
    /// </summary>
    public sealed class RoadGenerator
    {
        // Separate PRNG streams, so that changing the traffic-speed logic does
        // not shift which lanes receive hazards. Without this, an unrelated
        // tuning change silently invalidates every stored test vector.
        private const ulong StreamPlacement = 1UL;
        private const ulong StreamKind = 2UL;
        private const ulong StreamSpeed = 3UL;
        private const ulong StreamCorridor = 4UL;

        private readonly GameConfig _config;
        private readonly PositionTable _positions;
        private readonly List<Hazard> _hazards = new List<Hazard>();
        private readonly long _carLength;
        private readonly int _runwayTicks;

        private Pcg32 _placement;
        private Pcg32 _kind;
        private Pcg32 _speed;
        private Pcg32 _corridor;

        /// <summary>First tick at which each lane is clear again.</summary>
        private readonly int[] _laneFreeFrom;

        /// <summary>
        /// The lane guaranteed clear this encounter. Wanders by at most one
        /// lane per encounter so the player can always follow it.
        /// </summary>
        private int _safeLane;

        private int _nextEncounterTick;

        /// <summary>
        /// Hazards the generator declined to place because doing so would have
        /// closed the last reachable scoring lane. Reported by Tools/Solvability:
        /// a high number means the configured density is fighting the safety
        /// invariant, and the density should come down rather than the
        /// invariant being relaxed.
        /// </summary>
        public int RefusedPlacements { get; private set; }

        /// <summary>Retained for the solvability report.</summary>
        public int RescuedEncounters => RefusedPlacements;

        /// <summary>Encounters where the roll produced no hazard at all.</summary>
        public int EmptyEncounters { get; private set; }

        public IReadOnlyList<Hazard> Hazards => _hazards;

        public RoadGenerator(GameConfig config, ulong seed)
        {
            _config = config ?? throw new ArgumentNullException(nameof(config));
            _positions = new PositionTable(config);
            _carLength = config.CarLengthUnits * config.PositionScale;

            _placement = new Pcg32(seed, StreamPlacement);
            _kind = new Pcg32(seed, StreamKind);
            _speed = new Pcg32(seed, StreamSpeed);
            _corridor = new Pcg32(seed, StreamCorridor);

            _laneFreeFrom = new int[config.LaneCount];
            _safeLane = config.StartLane;

            // The opening runway carries no hazards. Without it the generator
            // can put a car on top of the player before they have touched the
            // screen — the "no fault of their own" death the brief calls a
            // refund request.
            _runwayTicks = TickAtOrAfter(config.StartRunwayUnits * config.PositionScale);
            _nextEncounterTick = _runwayTicks;
        }

        /// <summary>Builds the road far enough ahead to cover <paramref name="tick"/>.</summary>
        public void EnsureGeneratedThrough(int tick, long playerPosition)
        {
            int horizon = tick + _config.EncounterIntervalTicks * 3;
            while (_nextEncounterTick <= horizon)
                GenerateEncounter();
        }

        private void GenerateEncounter()
        {
            int tick = _nextEncounterTick;
            int interval = _config.EncounterIntervalTicks;

            // ---- the safe corridor -----------------------------------------
            //
            // The generator carries one designated SAFE LANE that is guaranteed
            // clear, and lets it wander by at most one lane per encounter. A
            // player who simply follows the corridor is never hit, so a
            // survivable line provably exists for as long as the road runs.
            //
            // Why a corridor rather than "leave any one lane open": a lane
            // change puts the hitbox in BOTH lanes for its whole duration. An
            // open lane two steps away, or one whose neighbour closes mid-move,
            // is not an escape — it is a trap that looks like an escape. Two
            // earlier attempts here failed the solvability harness for exactly
            // that reason: they reasoned about where the player could END UP and
            // ignored what they had to survive on the way. The corridor makes
            // the transit itself the thing being protected.
            //
            // Both the lane being left and the lane being entered are protected
            // across the move, which is what makes the two-lane hitbox safe.
            int corridorFrom = _safeLane;
            int corridorTo = _safeLane;

            if (tick >= _runwayTicks)
            {
                int drift = _corridor.NextInt(-1, 1);
                int candidate = _safeLane + drift;
                if (drift != 0
                    && candidate >= 0
                    && candidate < _config.LaneCount
                    && _config.Lanes[candidate].Role != LaneRole.Cashout
                    && _laneFreeFrom[candidate] <= tick)
                {
                    corridorTo = candidate;
                }
            }

            // ---- roll and place --------------------------------------------
            bool emittedAny = false;

            for (int lane = 0; lane < _config.LaneCount; lane++)
            {
                int chance = (int)((long)_config.SpawnChancePerSliceMilli
                                   * _config.Lanes[lane].HazardWeight / Units.WeightScale);

                // Draw unconditionally, so that a lane which happens to be
                // protected or occupied does not desynchronise the streams for
                // the other lanes. Without this, tuning the corridor would
                // reshuffle every hazard on every seed.
                bool roll = _placement.NextFraction(Units.WeightScale) < chance;
                bool isTraffic = _kind.NextFraction(Units.WeightScale) < _config.TrafficShareMilli;
                int factor = _speed.NextInt(_config.TrafficSpeedFactorMinMilli, _config.TrafficSpeedFactorMaxMilli);

                if (tick < _runwayTicks) continue;              // opening runway is clear
                if (lane == corridorFrom || lane == corridorTo)  // the guaranteed escape
                {
                    if (roll) RefusedPlacements++;
                    continue;
                }
                if (!roll) continue;
                if (_laneFreeFrom[lane] > tick) continue;       // an earlier hazard still occupies it

                var hazard = Build(lane, tick, isTraffic, factor);
                _hazards.Add(hazard);
                _laneFreeFrom[lane] = LastBlockedTick(hazard) + 1;
                emittedAny = true;
            }

            if (!emittedAny) EmptyEncounters++;

            _safeLane = corridorTo;
            _nextEncounterTick = tick + interval;
        }

        private Hazard Build(int lane, int tick, bool isTraffic, int factor)
        {
            long length = (isTraffic ? _config.TrafficLengthUnits : _config.ObstacleLengthUnits)
                          * _config.PositionScale;

            // Place it AHEAD of the player, never on top of them. A hazard
            // spawned at the player's own position is an unavoidable hit with no
            // warning; the player cannot react to something that appears inside
            // their hitbox. The lead distance is what turns a hazard into a
            // decision rather than a dice roll.
            long start = _positions.At(tick) + _config.SpawnLeadUnits * _config.PositionScale;
            int speed = isTraffic
                ? (int)((long)_config.SpeedAtTick(tick) * factor / Units.MilliScale)
                : 0;

            return new Hazard(
                isTraffic ? HazardKind.Traffic : HazardKind.Obstacle,
                lane, start, length, speed, tick);
        }

        /// <summary>
        /// Last tick at which a hazard still overlaps the player's hitbox.
        /// Stepped rather than solved: the speed ramp makes the closing rate
        /// piecewise, and stepping is exact where a closed form would need care.
        /// Bounded by the encounter horizon so a pathological config cannot hang.
        /// </summary>
        private int LastBlockedTick(Hazard hazard)
        {
            int limit = hazard.SpawnTick + _config.MaxEncounterWindowTicks;
            int last = hazard.SpawnTick;
            bool seenOverlap = false;

            // The hazard now spawns ahead of the player, so the overlap starts
            // some ticks after the spawn rather than immediately. Scan until the
            // overlap has been seen and then ended; the closing rate is
            // monotonic because the player is always faster than traffic, so the
            // blocked window is contiguous and this terminates.
            for (int t = hazard.SpawnTick; t <= limit; t++)
            {
                if (hazard.OverlapsAt(t, _positions.At(t), _carLength))
                {
                    seenOverlap = true;
                    last = t;
                }
                else if (seenOverlap) break;
            }
            return seenOverlap ? last : limit;
        }



        private static bool Any(bool[] set)
        {
            for (int i = 0; i < set.Length; i++) if (set[i]) return true;
            return false;
        }

        private int TickAtOrAfter(long position)
        {
            int tick = 0;
            while (_positions.At(tick) < position) tick++;
            return tick;
        }

        private static int Encode(bool isTraffic, int factor) => (isTraffic ? 1 << 24 : 0) | factor;

        private static void Decode(int packed, out bool isTraffic, out int factor)
        {
            isTraffic = (packed & (1 << 24)) != 0;
            factor = packed & 0xFFFFFF;
        }

        /// <summary>
        /// Hazards that could touch the player at a tick. Walks backwards from
        /// the newest and stops once hazards are far enough behind, so replay
        /// cost stays linear in run length rather than quadratic.
        /// </summary>
        public void CollectNear(int tick, long playerPosition, List<Hazard> into)
        {
            into.Clear();
            for (int i = _hazards.Count - 1; i >= 0; i--)
            {
                var h = _hazards[i];
                if (h.SpawnTick > tick + _config.MaxEncounterWindowTicks) continue;
                if (h.SpawnTick + _config.MaxEncounterWindowTicks < tick) break;
                into.Add(h);
            }
        }
    }
}
