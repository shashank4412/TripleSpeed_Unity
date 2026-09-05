using Redline.Client.Pooling;
using Redline.Core;
using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// The scrolling road geometry — divider dashes and an optional surface tile
    /// — served from fixed pools and slid past the car by the simulation's
    /// position.
    ///
    /// A bounded ring of real-length instances (not one stretched ribbon) so it
    /// can carry a real tile mesh (ADR 0015) and keep the instance count fixed
    /// regardless of draw distance — the same approach <see cref="HazardRenderer"/>
    /// uses for everything else on the road.
    ///
    /// Slid by <c>State.Position</c>, never <c>Time</c>: the offset is recomputed
    /// from the simulation position every frame, never integrated from a
    /// per-frame delta, so a dropped frame scrolls exactly the simulated
    /// distance and a long run accumulates no float drift.
    ///
    /// Zero allocation after construction.
    /// </summary>
    public sealed class RoadTreadmill
    {
        private readonly Transform _scroller;
        private readonly float _metresPerUnit;
        private readonly int _positionScale;

        /// <summary>Metres between divider dashes along a lane boundary.</summary>
        public const float DashSpacing = 4f;

        /// <summary>Length of one road surface tile.</summary>
        public const float TileLength = 8f;

        /// <summary>
        /// The scroll period. Every pooled instance is identical and spaced by a
        /// divisor of it (<see cref="DashSpacing"/> divides <see cref="TileLength"/>),
        /// so the modulo wrap lands each instance where its neighbour was — seamless.
        /// </summary>
        private const float Period = TileLength;

        public RoadTreadmill(
            LaneGeometry geometry,
            GameConfig config,
            Transform parent,
            GameObject dashPrototype,
            GameObject tilePrototype,
            float drawAheadMetres,
            float metresPerUnit)
        {
            _metresPerUnit = metresPerUnit;
            _positionScale = config.PositionScale;

            _scroller = new GameObject("RoadTreadmill").transform;
            _scroller.SetParent(parent, worldPositionStays: false);

            if (dashPrototype != null) BuildDashes(geometry, dashPrototype, drawAheadMetres);
            if (tilePrototype != null) BuildTiles(geometry, tilePrototype, drawAheadMetres);
        }

        private void BuildDashes(LaneGeometry geometry, GameObject prototype, float drawAheadMetres)
        {
            // +4: two dash spacings covered by the up-to-one-Period slide before
            // the wrap, one for the ceil, one spare so the far end never blinks.
            int count = Mathf.CeilToInt(drawAheadMetres / DashSpacing) + 4;

            // Interior boundaries only (LaneCount - 1). X comes from LaneGeometry,
            // so a five-lane config produces the right dividers with no scene
            // edit (review test #16).
            for (int b = 0; b < geometry.LaneCount - 1; b++)
            {
                float x = geometry.DividerLeftOf(b + 1);

                // One pool per boundary so an instance can't wander to another
                // line, and the count stays explicit for the Profiler.
                var pool = new TransformPool(prototype, _scroller, count);
                for (int i = 0; i < count; i++)
                {
                    var dash = pool.Acquire();
                    dash.localScale = new Vector3(0.08f, 0.02f, DashSpacing * 0.45f);
                    dash.localPosition = new Vector3(x, 0.01f, i * DashSpacing - DashSpacing);
                }
            }
        }

        private void BuildTiles(LaneGeometry geometry, GameObject prototype, float drawAheadMetres)
        {
            int count = Mathf.CeilToInt(drawAheadMetres / TileLength) + 2;

            var pool = new TransformPool(prototype, _scroller, count);
            for (int i = 0; i < count; i++)
            {
                var tile = pool.Acquire();
                tile.localScale = new Vector3(geometry.RoadWidth, 0.1f, TileLength * 0.98f);
                tile.localPosition = new Vector3(0f, -0.05f, i * TileLength - TileLength);
            }
        }

        /// <summary>
        /// Slides the road to match the simulation's integer position. The metres
        /// conversion is byte-for-byte the one <see cref="RoadRenderer"/> uses for
        /// the car and camera, so nothing on the road disagrees about where it is.
        /// </summary>
        public void Scroll(long position)
        {
            float metres = (float)position / _positionScale * _metresPerUnit;
            _scroller.localPosition = new Vector3(0f, 0f, -Mathf.Repeat(metres, Period));
        }
    }
}
