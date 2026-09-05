using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// The home screen: pick a stake, play.
    ///
    /// One mode — the asynchronous 1v1 duel from <c>DevDocs/assignment.md</c>.
    /// <see cref="SetPayoutReadout"/> shows what a win pays; it is filled by
    /// <see cref="GameFlowUi"/> from the server's PreviewAsync, never computed
    /// here. The stake ladder comes from the server too (<see cref="SetLadder"/>);
    /// offline it is the practice ladder.
    /// </summary>
    public sealed class HomePanel : MonoBehaviour
    {
        [Tooltip("The \"WIN\" caption above the payout figure.")]
        [SerializeField] private TMP_Text readoutLabel;

        [Tooltip("The payout figure. Pops (UiValuePunch) when it changes.")]
        [SerializeField] private TMP_Text readoutValue;

        [Tooltip("The gold-bordered balance button: coin icon + amount. Tapping it opens the demo top-up modal. Hidden while connecting or offline.")]
        [SerializeField] private Button balanceButton;

        [Tooltip("The amount label inside the balance button. Blank while connecting or offline.")]
        [SerializeField] private TMP_Text balanceText;

        [Tooltip("The −/value/+ stake control. Drag the QuantityStepper here.")]
        [SerializeField] private QuantityStepper stepper;

        [Tooltip("The Play / cancel button. Drag its Button here.")]
        [SerializeField] private Button playButton;

        [Tooltip("The Play button's own label. One rich-text field: 'PLAY', a sync status, or " +
                 "'Click to cancel' with a smaller countdown line under it. The button never resizes.")]
        [SerializeField] private TMP_Text playLabel;

        [Tooltip("One line under Play, yellow: a connection or matchmaking error.")]
        [SerializeField] private TMP_Text noticeText;

        private static readonly Color NoticeYellow = new Color(1f, 0.86f, 0.20f);

        /// <summary>Point size of the countdown line — the size the main line uses at rest is 48.</summary>
        private const int SubLineSize = 34;

        private UiButtonFx _playFx;
        private bool _connecting;
        private bool _canCancel;
        private string _lastBalance;
        private string _lastNotice;
        private string _lastPlayText;

        /// <summary>Stake in cents (0 offline). Raised by the Play button.</summary>
        public event Action<long> PlayRequested;

        /// <summary>Raised when the stake changes, so the readout can be re-fetched.</summary>
        public event Action SelectionChanged;

        /// <summary>Raised when the balance button is tapped — opens the demo top-up modal.</summary>
        public event Action BalanceTapped;

        public long StakeCents => stepper != null ? stepper.SelectedCents : 0L;

        private UiValuePunch _readoutPunch;
        private string _lastReadoutValue;

        private void Awake()
        {
            if (playButton != null)
            {
                playButton.onClick.AddListener(() => PlayRequested?.Invoke(StakeCents));
                playButton.TryGetComponent(out _playFx);
            }
            if (stepper != null) stepper.Changed += _ => SelectionChanged?.Invoke();
            if (readoutValue != null) readoutValue.TryGetComponent(out _readoutPunch);
            if (noticeText != null) noticeText.color = NoticeYellow;
            if (balanceButton != null) balanceButton.onClick.AddListener(() => BalanceTapped?.Invoke());
        }

        public void SetLadder(long[] ladderCents) => stepper?.SetLadder(ladderCents);

        /// <summary>The server balance. Empty hides the whole button (connecting / offline / no account yet).</summary>
        public void SetBalance(string text)
        {
            text ??= string.Empty;
            if (balanceButton != null && balanceButton.gameObject.activeSelf != (text.Length > 0))
                balanceButton.gameObject.SetActive(text.Length > 0);
            if (balanceText == null || text == _lastBalance) return;
            _lastBalance = text;
            balanceText.SetText(text);
        }

        /// <summary>
        /// Put the Play button into its connecting look — fills left-to-right as
        /// a slider, shine off. <paramref name="label"/> replaces "PLAY"; a
        /// non-empty <paramref name="subLabel"/> stacks under it as a smaller
        /// countdown line in the same rich-text field, so the button keeps its
        /// size. <paramref name="canCancel"/> keeps it tappable to cancel.
        /// </summary>
        public void SetConnecting(bool connecting, string label, string subLabel, bool canCancel)
        {
            _connecting = connecting;
            _canCancel = canCancel;
            _playFx?.SetConnecting(connecting);

            bool twoLine = connecting && !string.IsNullOrEmpty(subLabel);

            string text = !connecting ? "PLAY"
                : twoLine ? $"{label}\n<size={SubLineSize}>{subLabel}</size>"
                : label;

            if (playLabel != null && text != _lastPlayText)
            {
                _lastPlayText = text;
                playLabel.lineSpacing = twoLine ? -10f : 0f;   // pull the two lines together to fit the same button
                playLabel.SetText(text);
            }

            if (playButton != null)
                playButton.interactable = !connecting || canCancel;
        }

        /// <summary>0..1 fill for the connecting slider.</summary>
        public void SetConnectProgress(float t01) => _playFx?.SetProgress(t01);

        public void SetPayoutReadout(string label, string value)
        {
            if (readoutLabel != null) readoutLabel.SetText(label);
            if (readoutValue == null) return;

            readoutValue.SetText(value);

            // Pop the figure only when it actually changes — not on the first
            // fill, and not when the server re-answers with the same number.
            if (value != _lastReadoutValue && _lastReadoutValue != null)
                _readoutPunch?.Play();
            _lastReadoutValue = value;
        }

        public void SetPlayEnabled(bool enabled)
        {
            // While connecting, only the cancel case may keep it tappable.
            if (playButton != null) playButton.interactable = _connecting ? _canCancel : enabled;
        }

        /// <summary>The yellow error line under Play. Empty string clears it.</summary>
        public void SetNotice(string notice)
        {
            notice ??= string.Empty;
            if (noticeText == null || notice == _lastNotice) return;
            _lastNotice = notice;
            noticeText.SetText(notice);
        }

        public void Show() => gameObject.SetActive(true);
        public void Hide() => gameObject.SetActive(false);
    }
}
