using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// The run ended. "CRASHED" is the common case and nothing here softens it —
    /// the zero is the product. A banked run reuses the same panel with a
    /// different headline.
    ///
    /// The background is transparent on purpose: the crash — the stopped car,
    /// the camera shake <see cref="RunEndPresenter"/> is still running — stays
    /// visible behind the text. The whole panel is a tap target; "TAP TO
    /// CONTINUE" moves to the opponent-playing screen.
    /// </summary>
    public sealed class GameOverPanel : MonoBehaviour
    {
        [Tooltip("The headline — \"CRASHED\" or \"BANKED\". Drag the headline TMP_Text here.")]
        [SerializeField] private TMP_Text headline;

        [Tooltip("Full-panel invisible button; a tap anywhere continues. Drag the tap-catcher Button here.")]
        [SerializeField] private Button tapTarget;

        public event Action Dismissed;

        private void Awake()
        {
            if (tapTarget != null) tapTarget.onClick.AddListener(() => Dismissed?.Invoke());
        }

        /// <param name="banked">true if the player reached the cashout lane; false if the run was zeroed.</param>
        public void Show(bool banked)
        {
            if (headline != null) headline.SetText(banked ? "BANKED" : "CRASHED");
            gameObject.SetActive(true);
        }

        public void Hide() => gameObject.SetActive(false);
    }
}
