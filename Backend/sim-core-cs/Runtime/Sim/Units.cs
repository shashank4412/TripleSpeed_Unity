namespace Redline.Core
{
    /// <summary>
    /// The unit system, and why it is built this way.
    ///
    /// THE PROBLEM
    /// Speed is configured in milli-units per second (20000 = 20.0 u/s) and the
    /// simulation runs at 60 ticks per second. The naive per-tick distance is
    ///
    ///     delta = speedMilli / ticksPerSecond          // 20000 / 60 = 333.333...
    ///
    /// which is not a whole number. Any implementation that evaluates that
    /// division once per tick either uses floating point — which is allowed to
    /// differ between a phone's Mono/IL2CPP runtime and the server's CoreCLR —
    /// or truncates, throwing away a third of a milli-unit sixty times a second.
    /// Over a three minute run that is thousands of units of drift. One point
    /// decides who takes the pot, so neither is acceptable.
    ///
    /// THE FIX
    /// Never perform that division. Choose the position unit so the per-tick
    /// delta is already a whole number:
    ///
    ///     PositionScale = MilliScale * ticksPerSecond          (1000 * 60 = 60000)
    ///
    /// One game unit is 60000 position units. A speed of S milli-units/second is
    /// S * 60 position units per second, which over one tick (1/60 s) is exactly
    ///
    ///     delta = S position units
    ///
    /// So the hot loop is `position += speedMilli`. Not approximately — exactly.
    /// There is no division, no rounding, and no accumulated error, and the
    /// result is a pure function of integer addition, which every platform
    /// implements identically. Score works the same way:
    ///
    ///     score += speedMilli * laneMultiplier
    ///
    /// and is divided by <see cref="PositionScale"/> exactly once, at the end,
    /// to produce the whole number shown to the player.
    ///
    /// OVERFLOW
    /// The worst case per tick is maxSpeed * maxMultiplier = 55000 * 5 = 275,000.
    /// A one hour run is 216,000 ticks, so under 6e10 — eleven digits against
    /// long.MaxValue's nineteen. A run would have to last roughly a million
    /// years to overflow, and the abandonment window closes after three minutes.
    /// </summary>
    public static class Units
    {
        /// <summary>Config decimals are fixed-point thousandths. 20.5 u/s is stored as 20500.</summary>
        public const int MilliScale = 1000;

        /// <summary>
        /// Probabilities and weights are integers over this denominator. A lane
        /// hazard weight of 0.55 is stored as 550.
        /// </summary>
        public const int WeightScale = 1000;

        /// <summary>
        /// Position units per game unit, derived from the tick rate so that the
        /// per-tick delta is integral. See the class remarks — this is the whole
        /// reason the determinism claim holds.
        /// </summary>
        public static int PositionScale(int ticksPerSecond) => MilliScale * ticksPerSecond;

        /// <summary>Converts an internal position/score to the whole number shown to a player.</summary>
        public static long ToDisplay(long positionUnits, int ticksPerSecond) =>
            positionUnits / PositionScale(ticksPerSecond);

        /// <summary>Converts whole game units to internal position units.</summary>
        public static long FromGameUnits(long gameUnits, int ticksPerSecond) =>
            gameUnits * PositionScale(ticksPerSecond);
    }
}
