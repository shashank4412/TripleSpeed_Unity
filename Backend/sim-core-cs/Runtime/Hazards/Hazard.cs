using System;

namespace Redline.Core
{
    public enum HazardKind
    {
        /// <summary>Barrier or cone. Fixed to the road.</summary>
        Obstacle,

        /// <summary>A slower vehicle the player overtakes.</summary>
        Traffic,
    }

    /// <summary>
    /// One hazard, expressed entirely in integers.
    ///
    /// Position is in the same units as the player's — see <see cref="Units"/> —
    /// which is what lets collision be an exact interval overlap with no
    /// floating point and no tolerance value.
    ///
    /// Moving traffic reuses the player's trick: because one tick is 1/60 s and
    /// a position unit is 1/60000 of a game unit, a speed of V milli-units per
    /// second advances a hazard by exactly V position units per tick. Traffic
    /// motion is therefore integer addition too, not a velocity integration
    /// that could drift.
    /// </summary>
    public readonly struct Hazard
    {
        public HazardKind Kind { get; }
        public int Lane { get; }

        /// <summary>Road position of the hazard's trailing edge at <see cref="SpawnTick"/>.</summary>
        public long StartPosition { get; }

        /// <summary>Length along the road, in position units.</summary>
        public long Length { get; }

        /// <summary>Milli-units per second, which is also position units per tick. Zero for obstacles.</summary>
        public int SpeedMilli { get; }

        public int SpawnTick { get; }

        public Hazard(HazardKind kind, int lane, long startPosition, long length, int speedMilli, int spawnTick)
        {
            Kind = kind;
            Lane = lane;
            StartPosition = startPosition;
            Length = length;
            SpeedMilli = speedMilli;
            SpawnTick = spawnTick;
        }

        /// <summary>
        /// Trailing edge at a given tick. Exact integer arithmetic.
        ///
        /// Only meaningful from <see cref="SpawnTick"/> onward. A hazard does
        /// not exist before it spawns — see <see cref="OverlapsAt"/>, which
        /// enforces that. Extrapolating a hazard backwards along the road puts
        /// it in front of the player before it has been created, which silently
        /// blocks a lane for tens of ticks before its spawn tick and defeats any
        /// safety reasoning done at spawn time.
        /// </summary>
        public long PositionAt(int tick) =>
            StartPosition + (long)SpeedMilli * (tick - SpawnTick);

        /// <summary>
        /// Whether this hazard overlaps the interval
        /// [<paramref name="playerStart"/>, <paramref name="playerStart"/> + <paramref name="playerLength"/>)
        /// at <paramref name="tick"/>.
        ///
        /// Half-open on both sides, so two intervals that merely touch — one
        /// ending exactly where the other begins — do not collide. That makes
        /// the boundary case a decision rather than an accident, and it is the
        /// difference between a near miss reading as skill and reading as a bug.
        /// </summary>
        public bool OverlapsAt(int tick, long playerStart, long playerLength)
        {
            // A hazard cannot hit anyone before it exists.
            if (tick < SpawnTick) return false;

            long hazardStart = PositionAt(tick);
            long hazardEnd = hazardStart + Length;
            long playerEnd = playerStart + playerLength;
            return playerStart < hazardEnd && hazardStart < playerEnd;
        }

        public override string ToString() =>
            $"{Kind} lane={Lane} pos={StartPosition} len={Length} v={SpeedMilli}";
    }
}
