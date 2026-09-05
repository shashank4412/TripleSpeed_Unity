using System.Collections.Generic;
using UnityEngine;

namespace Redline.Client.Pooling
{
    /// <summary>
    /// A fixed pool of transforms, filled at load and never grown in the run
    /// loop — so the steady state allocates nothing per frame (AC-8), unlike
    /// Instantiate-on-spawn / Destroy-on-leave. A plain class over a Stack: one
    /// kind of thing to pool, one policy.
    /// </summary>
    public sealed class TransformPool
    {
        private readonly Stack<Transform> _idle;
        private readonly Transform _parent;

        public TransformPool(GameObject prototype, Transform parent, int capacity)
        {
            _parent = parent;
            _idle = new Stack<Transform>(capacity);

            for (int i = 0; i < capacity; i++)
            {
                var instance = Object.Instantiate(prototype, parent);
                instance.SetActive(false);
                _idle.Push(instance.transform);
            }

            Capacity = capacity;
        }

        public int Capacity { get; }

        /// <summary>Idle instances remaining. Zero means the pool was sized too small.</summary>
        public int Available => _idle.Count;

        /// <summary>
        /// Takes an instance, or null when exhausted. Null rather than growing:
        /// growing allocates when the scene is busiest. An exhausted pool is a
        /// sizing bug for the Profiler, not something to paper over at runtime.
        /// </summary>
        public Transform Acquire()
        {
            if (_idle.Count == 0) return null;

            var instance = _idle.Pop();
            instance.gameObject.SetActive(true);
            return instance;
        }

        public void Release(Transform instance)
        {
            instance.gameObject.SetActive(false);
            instance.SetParent(_parent, worldPositionStays: false);
            _idle.Push(instance);
        }
    }
}
