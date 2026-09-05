using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// The demo top-up modal, opened from the home screen's balance button.
    ///
    /// In-game currency only — there is no real-money deposit path (server:
    /// <c>handlers/addBalance.ts</c>, <c>DevDocs/decisions/0017-demo-balance-topup.md</c>).
    /// Pick a stake-ladder amount on the stepper, press Add Balance;
    /// <see cref="GameFlowUi"/> calls the backend and refreshes the balance.
    /// The server caps the balance — a hit cap shows a notice here instead of
    /// closing. It owns no money figure; every amount comes from the server.
    /// </summary>
    public sealed class AddBalancePanel : MonoBehaviour
    {
        [Tooltip("Current balance, shown at the top of the card.")]
        [SerializeField] private TMP_Text balanceText;

        [Tooltip("The −/amount/+ control. Its ladder is the server stake ladder.")]
        [SerializeField] private QuantityStepper stepper;

        [Tooltip("Commits the top-up for the amount currently on the stepper.")]
        [SerializeField] private Button addButton;

        [Tooltip("Backdrop / close. Tapping it dismisses the modal with no change.")]
        [SerializeField] private Button closeButton;

        [Tooltip("One line under the button: the server cap message, or an error. Yellow.")]
        [SerializeField] private TMP_Text noticeText;

        private static readonly Color NoticeYellow = new Color(1f, 0.86f, 0.20f);

        /// <summary>Raised with the chosen amount in cents when Add Balance is pressed.</summary>
        public event Action<long> AddRequested;

        /// <summary>Raised when the modal should close (backdrop tap).</summary>
        public event Action Closed;

        public long AmountCents => stepper != null ? stepper.SelectedCents : 0L;

        private void Awake()
        {
            if (addButton != null) addButton.onClick.AddListener(() => AddRequested?.Invoke(AmountCents));
            if (closeButton != null) closeButton.onClick.AddListener(() => Closed?.Invoke());
            if (noticeText != null) noticeText.color = NoticeYellow;
        }

        public void SetLadder(long[] ladderCents) => stepper?.SetLadder(ladderCents);

        public void SetBalance(string text)
        {
            if (balanceText != null) balanceText.SetText(text ?? string.Empty);
        }

        public void SetNotice(string text)
        {
            if (noticeText != null) noticeText.SetText(text ?? string.Empty);
        }

        /// <summary>Greys the Add button while a top-up call is in flight.</summary>
        public void SetBusy(bool busy)
        {
            if (addButton != null) addButton.interactable = !busy;
        }

        public void Show() => gameObject.SetActive(true);
        public void Hide() => gameObject.SetActive(false);
    }
}
