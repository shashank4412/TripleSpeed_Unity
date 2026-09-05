using System.Collections.Generic;
using Redline.Client.Pooling;
using Redline.Core;
using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// Draws the hazards the core generated — and never generates one: a hazard
    /// the client invented would be one the server does not know about, a crash
    /// into nothing as far as the score of record is concerned.
    ///
    /// Zero allocation per frame after warm-up: pooled transforms, reused hazard
    /// list, reused dictionaries, indexed loops.
    /// </summary>
    [RequireComponent(typeof(RunHost))]
    public sealed class HazardRenderer : MonoBehaviour
    {
        [Tooltip("The hurdle mesh prefab, cloned into the obstacle pool. Never authored per lane.")]
        [SerializeField] private GameObject obstaclePrototype;

        [Tooltip("The enemy-car mesh prefab, cloned into the traffic pool. Never authored per lane.")]
        [SerializeField] private GameObject trafficPrototype;

        [Tooltip("Instances per kind. Sized above the worst case the road generator can produce on screen.")]
        [SerializeField] private int poolSize = 48;

        private RunHost _host;
        private LaneGeometry _geometry;
        private TransformPool _obstacles;
        private TransformPool _traffic;

        /// <summary>A hazard currently on screen, and the frame it was last seen on.</summary>
        private readonly struct Live
        {
            public Live(Transform instance, int frame)
            {
                Instance = instance;
                Frame = frame;
            }

            public readonly Transform Instance;
            public readonly int Frame;
        }

        // Which pooled transform is showing which hazard. Keyed by the hazard's
        // spawn tick and lane, which together identify it for the life of a run.
        private readonly Dictionary<int, Live> _live = new Dictionary<int, Live>(128);
        private readonly Dictionary<int, int> _unseenFrames = new Dictionary<int, int>(64);
        private readonly List<int> _retired = new List<int>(64);
        private int _frame;

        private const float MetresPerUnit = 0.5f;
        private const int GraceFrames = 120;

        private void Awake()
        {
            _host = GetComponent<RunHost>();
            _geometry = new LaneGeometry(_host.Config);

            var root = new GameObject("Hazards").transform;
            root.SetParent(transform, worldPositionStays: false);

            _obstacles = new TransformPool(obstaclePrototype, root, poolSize);
            _traffic = new TransformPool(trafficPrototype, root, poolSize);

            _host.RunStarted += ReleaseAll;
        }

        private void OnDestroy()
        {
            if (_host != null) _host.RunStarted -= ReleaseAll;
        }

        /// <summary>
        /// A fresh run: hand every showing hazard back to its pool and forget it.
        /// The next run's hazards have different keys, so without this the last
        /// run's meshes would sit on the road for <see cref="GraceFrames"/>
        /// frames — long enough to be seen on the "tap to start" screen.
        /// </summary>
        private void ReleaseAll()
        {
            foreach (var pair in _live)
            {
                var pool = IsObstacleKey(pair.Key) ? _obstacles : _traffic;
                pool.Release(pair.Value.Instance);
            }

            _live.Clear();
            _unseenFrames.Clear();
            _retired.Clear();
        }

        private void LateUpdate()
        {
            var state = _host.State;
            if (state == null) return;

            // The same list the simulation filled this tick. Not a copy: a copy
            // would allocate, and there is nothing to protect it from — the
            // renderer only reads.
            var near = _host.VisibleHazards;

            _retired.Clear();
            _frame++;

            for (int i = 0; i < near.Count; i++)
            {
                var hazard = near[i];
                int key = Key(hazard);

                if (!_live.TryGetValue(key, out var live))
                {
                    var pool = hazard.Kind == HazardKind.Obstacle ? _obstacles : _traffic;
                    var acquired = pool.Acquire();

                    // Pool exhausted: the hazard is not drawn but is still real
                    // to the simulation. Better a missing mesh than a frame spike.
                    if (acquired == null) continue;

                    // No rescale — the prototypes are authored mesh prefabs
                    // (ADR 0015), already game-sized. Visual size has no bearing
                    // on collision (the core's length interval in lane-space).
                    live = new Live(acquired, _frame);
                }

                _unseenFrames.Remove(key);

                // Stamp with this frame so the sweep below knows it is still
                // near — O(near), not the O(live x near) a retired-list scan cost.
                _live[key] = new Live(live.Instance, _frame);

                // Relative to the player: the world scrolls, the car stays put.
                float ahead = (hazard.PositionAt(state.Tick) - state.Position)
                              / (float)_host.Config.PositionScale * MetresPerUnit;

                // y = 0: the prefabs sit on the road by their own pivot.
                live.Instance.localPosition = new Vector3(_geometry.CentreOf(hazard.Lane), 0f, ahead);
            }

            // Hazards not stamped this frame are fading. Give them a grace period
            // so they don't vanish abruptly behind the camera.
            foreach (var pair in _live)
            {
                if (pair.Value.Frame == _frame) continue;

                _unseenFrames.TryGetValue(pair.Key, out int unseen);
                _unseenFrames[pair.Key] = ++unseen;
                if (unseen >= GraceFrames) _retired.Add(pair.Key);
            }

            for (int i = 0; i < _retired.Count; i++)
            {
                int key = _retired[i];
                var pool = IsObstacleKey(key) ? _obstacles : _traffic;

                pool.Release(_live[key].Instance);
                _live.Remove(key);
                _unseenFrames.Remove(key);
            }
        }

        /// <summary>
        /// Identifies a hazard for the life of a run — spawn tick and lane are
        /// fixed at generation and unique together, so no alloc, no string. The
        /// kind rides in the sign bit so a released instance returns to its pool.
        /// </summary>
        private static int Key(in Hazard hazard)
        {
            int key = (hazard.SpawnTick << 4) | (hazard.Lane & 0xF);
            return hazard.Kind == HazardKind.Obstacle ? key : -key - 1;
        }

        private static bool IsObstacleKey(int key) => key >= 0;
    }
}
