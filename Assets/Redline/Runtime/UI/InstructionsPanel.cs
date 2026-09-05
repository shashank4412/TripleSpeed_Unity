using System;
using UnityEngine;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// Shown once before a run: swipe to change lanes, use the cashout lane to
    /// keep your score. The whole panel is a tap target; "TAP TO START" dismisses
    /// it and the ready/go sequence takes over. Sits over the static road, so it
    /// may allocate freely.
    /// </summary>
    public sealed class InstructionsPanel : MonoBehaviour
    {
        [Tooltip("Full-panel invisible button; a tap anywhere starts the run. Drag the tap-catcher Button here.")]
        [SerializeField] private Button tapTarget;

        public event Action Dismissed;

        private void Awake()
        {
            if (tapTarget != null) tapTarget.onClick.AddListener(() => Dismissed?.Invoke());
        }

        public void Show() => gameObject.SetActive(true);
        public void Hide() => gameObject.SetActive(false);
    }
}
