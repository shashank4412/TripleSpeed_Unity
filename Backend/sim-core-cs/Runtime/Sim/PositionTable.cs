using System.Collections.Generic;

namespace Redline.Core
{
    /// <summary>
    /// Player road position at any tick, cached.
    ///
    /// Position is a pure function of the tick — speed depends only on the tick
    /// index, never on lane, score, or anything the player did — so this table
    /// is shared by the road generator and the solvability checker without
    /// either of them consulting player state. That property is exactly what
    /// makes "both players drive the same road" true.
    ///
    /// Cached because the generator and solver both need P(t) repeatedly;
    /// recomputing it by summing speeds each time would make road generation
    /// quadratic in run length.
    /// </summary>
    public sealed class PositionTable
    {
        private readonly GameConfig _config;
        private readonly List<long> _cumulative = new List<long> { 0L };

        public PositionTable(GameConfig config) => _config = config;

        /// <summary>Road position, in position units, after <paramref name="tick"/> ticks of travel.</summary>
        public long At(int tick)
        {
            while (_cumulative.Count <= tick)
            {
                int t = _cumulative.Count - 1;
                _cumulative.Add(_cumulative[t] + _config.SpeedAtTick(t));
            }
            return _cumulative[tick];
        }
    }
}
