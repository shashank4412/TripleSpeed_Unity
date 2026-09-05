using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Redline.Core
{
    /// <summary>Role a lane plays. Derived from config, never hardcoded.</summary>
    public enum LaneRole
    {
        Scoring,
        Cashout,
    }

    /// <summary>One lane's immutable rules.</summary>
    public sealed class LaneConfig
    {
        public int Index { get; }

        /// <summary>Score multiplier. The cashout lane is 0 — it scores nothing.</summary>
        public int Multiplier { get; }

        public LaneRole Role { get; }

        /// <summary>Relative hazard density, in thousandths (0.55 -> 550).</summary>
        public int HazardWeight { get; }

        public LaneConfig(int index, int multiplier, LaneRole role, int hazardWeight)
        {
            Index = index;
            Multiplier = multiplier;
            Role = role;
            HazardWeight = hazardWeight;
        }
    }

    /// <summary>
    /// The rules of the game, loaded from Backend/config/redline.game.json.
    ///
    /// Nothing in the simulation hardcodes a lane count: it is
    /// <see cref="LaneCount"/>, taken from the length of the lanes array.
    /// Review requirement #16 is to change four lanes to five live, so any new
    /// lane-dependent logic must be written against this object.
    ///
    /// <see cref="ConfigHash"/> is computed over the raw file bytes. The server
    /// stamps it on every run; a client whose config hashes differently is
    /// rejected rather than being quietly scored against different rules.
    /// </summary>
    public sealed class GameConfig
    {
        public int ConfigVersion { get; }

        public IReadOnlyList<LaneConfig> Lanes { get; }
        public int LaneCount => Lanes.Count;
        public int StartLane { get; }

        /// <summary>Index of the lane that banks the run on full arrival.</summary>
        public int CashoutLane { get; }

        public int TicksPerSecond { get; }

        /// <summary>
        /// Hard stop for a run, in ticks. A run reaching it without banking or
        /// crashing is <see cref="RunOutcome.Abandoned"/>.
        ///
        /// Shared rather than server-only because it decides an outcome, and an
        /// outcome both sides must agree on. Two copies of this number disagreed
        /// once already; being inside the hashed config means a client holding a
        /// different one is rejected rather than quietly scored.
        /// </summary>
        public int MaxRunTicks { get; }

        public int SpeedStartMilli { get; }
        public int SpeedRampMilli { get; }
        public int SpeedRampIntervalTicks { get; }
        public int SpeedMaxMilli { get; }

        public int LaneChangeDurationTicks { get; }
        public int MaxQueuedInputs { get; }

        public long CarLengthUnits { get; }

        public int TrafficSpeedFactorMinMilli { get; }
        public int TrafficSpeedFactorMaxMilli { get; }
        public long MinLongitudinalGapUnits { get; }
        public long StartRunwayUnits { get; }
        public long SpawnLeadUnits { get; }
        public int EncounterIntervalTicks { get; }
        public int MaxEncounterWindowTicks { get; }
        public long ObstacleLengthUnits { get; }
        public long TrafficLengthUnits { get; }
        public int SpawnChancePerSliceMilli { get; }
        public int TrafficShareMilli { get; }

        /// <summary>Derived: position units per game unit. See <see cref="Units"/>.</summary>
        public int PositionScale { get; }

        public string ConfigHash { get; }

        private GameConfig(JsonValue root, string rawText)
        {
            ConfigVersion = root["configVersion"].AsInt();

            var lanes = new List<LaneConfig>();
            int cashout = -1;
            foreach (var laneJson in root["lanes"].Items())
            {
                int index = laneJson["index"].AsInt();
                if (index != lanes.Count)
                    throw new JsonException(
                        $"lane at position {lanes.Count} declares index {index}; lanes must be listed in order from 0");

                string roleText = laneJson["role"].AsString();
                LaneRole role = roleText switch
                {
                    "scoring" => LaneRole.Scoring,
                    "cashout" => LaneRole.Cashout,
                    _ => throw new JsonException($"unknown lane role '{roleText}'"),
                };

                if (role == LaneRole.Cashout)
                {
                    if (cashout >= 0)
                        throw new JsonException("more than one cashout lane; exactly one is required");
                    cashout = index;
                }

                lanes.Add(new LaneConfig(
                    index,
                    laneJson["multiplier"].AsInt(),
                    role,
                    (int)laneJson["hazardWeight"].AsScaled(Units.WeightScale)));
            }

            if (lanes.Count < 2)
                throw new JsonException("at least two lanes are required (one scoring, one cashout)");
            if (cashout < 0)
                throw new JsonException("no cashout lane declared; exactly one lane must have role 'cashout'");

            Lanes = lanes;
            CashoutLane = cashout;

            StartLane = root["startLane"].AsInt();
            if (StartLane < 0 || StartLane >= lanes.Count)
                throw new JsonException($"startLane {StartLane} is outside the {lanes.Count} configured lanes");
            if (lanes[StartLane].Role == LaneRole.Cashout)
                throw new JsonException("startLane cannot be the cashout lane; the run would bank instantly");

            var time = root["time"];
            TicksPerSecond = time["ticksPerSecond"].AsInt();
            if (TicksPerSecond <= 0) throw new JsonException("ticksPerSecond must be positive");

            MaxRunTicks = time["maxRunTicks"].AsInt();
            if (MaxRunTicks <= 0) throw new JsonException("maxRunTicks must be positive");

            var speed = root["speed"];
            SpeedStartMilli = speed["startMilliUnitsPerSec"].AsInt();
            SpeedRampMilli = speed["rampMilliUnitsPerSec"].AsInt();
            SpeedRampIntervalTicks = speed["rampIntervalTicks"].AsInt();
            SpeedMaxMilli = speed["maxMilliUnitsPerSec"].AsInt();
            if (SpeedStartMilli <= 0) throw new JsonException("startMilliUnitsPerSec must be positive");
            if (SpeedRampIntervalTicks <= 0) throw new JsonException("rampIntervalTicks must be positive");
            if (SpeedMaxMilli < SpeedStartMilli) throw new JsonException("maxMilliUnitsPerSec is below the start speed");

            var laneChange = root["laneChange"];
            LaneChangeDurationTicks = laneChange["durationTicks"].AsInt();
            MaxQueuedInputs = laneChange["maxQueuedInputs"].AsInt();
            if (LaneChangeDurationTicks <= 0) throw new JsonException("laneChange.durationTicks must be positive");
            if (MaxQueuedInputs < 0) throw new JsonException("laneChange.maxQueuedInputs cannot be negative");

            CarLengthUnits = root["player"]["carLengthUnits"].AsLong();
            if (CarLengthUnits <= 0) throw new JsonException("player.carLengthUnits must be positive");

            var hazards = root["hazards"];
            TrafficSpeedFactorMinMilli = (int)hazards["trafficSpeedFactorMin"].AsScaled(Units.MilliScale);
            TrafficSpeedFactorMaxMilli = (int)hazards["trafficSpeedFactorMax"].AsScaled(Units.MilliScale);
            if (TrafficSpeedFactorMinMilli <= 0 || TrafficSpeedFactorMaxMilli >= Units.MilliScale)
                throw new JsonException("traffic speed factors must sit strictly between 0 and 1; traffic must be slower than the player");
            if (TrafficSpeedFactorMaxMilli < TrafficSpeedFactorMinMilli)
                throw new JsonException("trafficSpeedFactorMax is below trafficSpeedFactorMin");

            MinLongitudinalGapUnits = hazards["minLongitudinalGapUnits"].AsLong();
            if (MinLongitudinalGapUnits <= 0) throw new JsonException("minLongitudinalGapUnits must be positive");

            SpawnLeadUnits = hazards["spawnLeadUnits"].AsLong();
            if (SpawnLeadUnits <= 0) throw new JsonException("spawnLeadUnits must be positive; a hazard on top of the player is unavoidable by construction");

            EncounterIntervalTicks = hazards["encounterIntervalTicks"].AsInt();
            MaxEncounterWindowTicks = hazards["maxEncounterWindowTicks"].AsInt();
            if (EncounterIntervalTicks <= 0) throw new JsonException("encounterIntervalTicks must be positive");
            if (MaxEncounterWindowTicks <= EncounterIntervalTicks)
                throw new JsonException("maxEncounterWindowTicks must exceed encounterIntervalTicks");

            StartRunwayUnits = hazards["startRunwayUnits"].AsLong();
            if (StartRunwayUnits < 0) throw new JsonException("startRunwayUnits cannot be negative");

            ObstacleLengthUnits = hazards["obstacleLengthUnits"].AsLong();
            TrafficLengthUnits = hazards["trafficLengthUnits"].AsLong();
            if (ObstacleLengthUnits <= 0 || TrafficLengthUnits <= 0)
                throw new JsonException("hazard lengths must be positive");
            if (ObstacleLengthUnits >= MinLongitudinalGapUnits || TrafficLengthUnits >= MinLongitudinalGapUnits)
                throw new JsonException("a hazard must be shorter than the slice gap, or slices would overlap");

            SpawnChancePerSliceMilli = (int)hazards["spawnChancePerSlice"].AsScaled(Units.WeightScale);
            TrafficShareMilli = (int)hazards["trafficShare"].AsScaled(Units.WeightScale);
            if (SpawnChancePerSliceMilli < 0 || SpawnChancePerSliceMilli > Units.WeightScale)
                throw new JsonException("spawnChancePerSlice must be between 0 and 1");
            if (TrafficShareMilli < 0 || TrafficShareMilli > Units.WeightScale)
                throw new JsonException("trafficShare must be between 0 and 1");

            PositionScale = Units.PositionScale(TicksPerSecond);
            ConfigHash = ComputeHash(rawText);
        }

        public static GameConfig Parse(string jsonText)
        {
            if (jsonText == null) throw new ArgumentNullException(nameof(jsonText));
            return new GameConfig(JsonValue.Parse(jsonText), jsonText);
        }

        /// <summary>Multiplier for a lane index.</summary>
        public int MultiplierOf(int lane) => Lanes[lane].Multiplier;

        /// <summary>
        /// The effective multiplier while occupying <paramref name="from"/> and
        /// moving toward <paramref name="to"/>: the LOWER of the two.
        ///
        /// This is mandatory, and it exists to close one specific exploit —
        /// without it a player sits on the boundary between lane 1 and lane 0,
        /// claims 5x, and keeps most of the car in the safer lane. It is
        /// explicitly probed during review (test #5).
        /// </summary>
        public int EffectiveMultiplier(int from, int to)
        {
            int a = Lanes[from].Multiplier;
            int b = Lanes[to].Multiplier;
            return a < b ? a : b;
        }

        /// <summary>
        /// Forward speed in milli-units/second at a tick. A pure function of the
        /// tick index: it does not depend on lane, score, or anything the player
        /// did, which is what lets the server recompute it from the tick count
        /// alone.
        /// </summary>
        public int SpeedAtTick(int tick)
        {
            if (tick < 0) throw new ArgumentOutOfRangeException(nameof(tick));
            long steps = tick / SpeedRampIntervalTicks;
            long speed = SpeedStartMilli + steps * SpeedRampMilli;
            return speed >= SpeedMaxMilli ? SpeedMaxMilli : (int)speed;
        }

        /// <summary>
        /// FNV-1a over the raw config text, with line endings normalised so a
        /// Windows checkout and a macOS checkout of the same file agree.
        ///
        /// FNV rather than SHA because the core takes no dependency on
        /// System.Security.Cryptography, which is not uniformly available across
        /// Unity's scripting backends. This hash guards against accidental
        /// divergence — a stale config on a device — and is not a security
        /// control: an attacker who can edit the config can also edit the hash.
        /// The defence against a forged config is that the SERVER's config is
        /// the one that scores the run.
        /// </summary>
        public static string ComputeHash(string text)
        {
            var normalised = new StringBuilder(text.Length);
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r')
                {
                    if (i + 1 < text.Length && text[i + 1] == '\n') continue;
                    normalised.Append('\n');
                }
                else normalised.Append(c);
            }

            const ulong offsetBasis = 14695981039346656037UL;
            const ulong prime = 1099511628211UL;

            ulong hash = offsetBasis;
            byte[] bytes = Encoding.UTF8.GetBytes(normalised.ToString());
            foreach (byte b in bytes)
            {
                hash ^= b;
                hash = unchecked(hash * prime);
            }
            return hash.ToString("x16", CultureInfo.InvariantCulture);
        }
    }
}
