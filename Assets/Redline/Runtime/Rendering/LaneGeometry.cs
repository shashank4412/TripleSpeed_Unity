using Redline.Core;
using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// Where a lane is in world space. Everything derives from
    /// <see cref="GameConfig.LaneCount"/> — road width, camera framing, divider
    /// count — so review requirement #16 (change lane count in config and re-run)
    /// needs no scene or prefab edit. A no-alloc struct; renderers ask it for a
    /// position every frame.
    /// </summary>
    public readonly struct LaneGeometry
    {
        /// <summary>
        /// The shader colour property — <c>_Color</c> on the built-in pipeline
        /// (URP: <c>_BaseColor</c>). Named once so a pipeline change is one edit.
        /// </summary>
        public static readonly int ColorProperty = Shader.PropertyToID("_Color");

        /// <summary>Metres between lane centres. The one tuning number; everything else follows.</summary>
        public const float LaneWidth = 2.2f;

        private readonly int _laneCount;

        public LaneGeometry(GameConfig config) => _laneCount = config.LaneCount;

        public int LaneCount => _laneCount;

        public float RoadWidth => _laneCount * LaneWidth;

        /// <summary>
        /// World X of a lane centre, with the road centred on the origin. Lane 0
        /// is leftmost, matching the config array and the swipe directions.
        /// </summary>
        public float CentreOf(int lane) => (lane - (_laneCount - 1) * 0.5f) * LaneWidth;

        /// <summary>
        /// World X of the divider to the left of a lane. There are LaneCount - 1
        /// interior dividers; the outer edges are the road's own edges.
        /// </summary>
        public float DividerLeftOf(int lane) => CentreOf(lane) - LaneWidth * 0.5f;

        /// <summary>
        /// Camera height that frames every lane with a margin, for a vertical
        /// field of view. Derived, so five lanes frame with no scene edit.
        /// </summary>
        public float CameraHeightFor(float verticalFovDegrees, float aspect, float margin = 1.25f)
        {
            float halfWidth = RoadWidth * 0.5f * margin;
            float horizontalHalfFov = Mathf.Atan(Mathf.Tan(verticalFovDegrees * 0.5f * Mathf.Deg2Rad) * aspect);

            return halfWidth / Mathf.Max(0.0001f, Mathf.Tan(horizontalHalfFov));
        }

        /// <summary>
        /// A lane's colour, from its multiplier not its index — so lane 0 reads
        /// dangerous and cashout safe before the player is told why, and a
        /// reordered or reweighted config still reads correctly.
        /// </summary>
        public static Color DangerColour(GameConfig config, int lane)
        {
            if (config.Lanes[lane].Role == LaneRole.Cashout) return SafeColour;

            int highest = 1;
            for (int i = 0; i < config.LaneCount; i++)
                if (config.Lanes[i].Multiplier > highest) highest = config.Lanes[i].Multiplier;

            float danger = Mathf.InverseLerp(1f, highest, config.Lanes[lane].Multiplier);

            return Color.Lerp(NeutralColour, HotColour, danger);
        }

        /// <summary>
        /// Index of the highest-multiplier scoring lane (never cashout) — the
        /// "5x" lane that gets the rainbow. From config, so a reordered array
        /// still points at the right one (review test #16).
        /// </summary>
        public static int HottestScoringLane(GameConfig config)
        {
            int best = 0;
            int bestMultiplier = int.MinValue;
            for (int i = 0; i < config.LaneCount; i++)
            {
                if (config.Lanes[i].Role == LaneRole.Cashout) continue;
                if (config.Lanes[i].Multiplier > bestMultiplier)
                {
                    bestMultiplier = config.Lanes[i].Multiplier;
                    best = i;
                }
            }
            return best;
        }

        /// <summary>
        /// Plain road-surface grey. The cashout lane uses this, not
        /// <see cref="SafeColour"/> — normal tarmac with a painted "CASHOUT"
        /// legend, not a coloured strip.
        /// </summary>
        public static Color RoadNeutral => NeutralColour;

        private static readonly Color SafeColour = new Color(0.20f, 0.55f, 0.38f);
        private static readonly Color NeutralColour = new Color(0.22f, 0.23f, 0.27f);
        private static readonly Color HotColour = new Color(0.62f, 0.13f, 0.14f);
    }
}
