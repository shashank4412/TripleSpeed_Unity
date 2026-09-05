using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// The identity screen, shown once on launch before Home.
    ///
    /// Two states, chosen by <see cref="Show"/>:
    ///   * fresh install (no cached uid) — one button, "Enter as Anonymous";
    ///   * returning (a uid from a previous launch) — the caption
    ///     "Found Anonymous ID:", then a status dot + the uid string coloured
    ///     green when the backend confirmed it or red when it could not, then
    ///     two buttons: "Enter with same account" and "Enter with another
    ///     Anonymous ID".
    ///
    /// Buttons raise <see cref="EnterRequested"/> / <see cref="EnterAnotherRequested"/>
    /// once; <see cref="GameFlowUi"/> starts the sign-in and moves to Home when
    /// the session goes Ready. This panel owns no backend call and no identity —
    /// it only shows what
    /// <see cref="Redline.Client.Net.RedlineSession.CachedAccountId"/> found and
    /// reports the tap.
    /// </summary>
    public sealed class AuthPanel : MonoBehaviour
    {
        [Tooltip("Screen title, e.g. \"AUTHENTICATION\". Static.")]
        [SerializeField] private TMP_Text titleText;

        [Tooltip("Static caption \"Found Anonymous ID:\". Hidden on a fresh install.")]
        [SerializeField] private TMP_Text foundIdCaption;

        [Tooltip("Small dot before the id: green = backend-active, red = inactive/unavailable. Hidden on a fresh install.")]
        [SerializeField] private Image statusDot;

        [Tooltip("The cached uid string, coloured green/red to match the dot. Hidden on a fresh install.")]
        [SerializeField] private TMP_Text idValueText;

        [Tooltip("Primary Enter button — \"Enter with same account\" (returning) or \"Enter as Anonymous\" (fresh).")]
        [SerializeField] private Button enterButton;

        [Tooltip("The primary Enter button's label.")]
        [SerializeField] private TMP_Text enterLabel;

        [Tooltip("Secondary button \"Enter with another Anonymous ID\". Shown only in the returning state.")]
        [SerializeField] private Button enterAnotherButton;

        [Tooltip("The secondary button's label.")]
        [SerializeField] private TMP_Text enterAnotherLabel;

        [Tooltip("One line at the bottom: the \"Signing in…\" state or a sign-in error, in yellow.")]
        [SerializeField] private TMP_Text noticeText;

        private static readonly Color NoticeYellow = new Color(1f, 0.86f, 0.20f);
        private static readonly Color ActiveGreen = new Color(0.30f, 0.85f, 0.42f);
        private static readonly Color InactiveRed = new Color(0.93f, 0.31f, 0.28f);

        /// <summary>Raised once when the player taps the primary Enter button.</summary>
        public event Action EnterRequested;

        /// <summary>Raised once when the player taps "Enter with another Anonymous ID".</summary>
        public event Action EnterAnotherRequested;

        private void Awake()
        {
            if (enterButton != null) enterButton.onClick.AddListener(() => EnterRequested?.Invoke());
            if (enterAnotherButton != null) enterAnotherButton.onClick.AddListener(() => EnterAnotherRequested?.Invoke());
            if (noticeText != null) noticeText.color = NoticeYellow;
        }

        /// <summary>
        /// Render for the given cached identity. <paramref name="cachedId"/>
        /// null/empty means a fresh install (single button, no id row).
        /// <paramref name="backendActive"/> colours the dot and the id string.
        /// Resets the busy and notice state.
        /// </summary>
        public void Show(string cachedId, bool backendActive)
        {
            gameObject.SetActive(true);

            bool returning = !string.IsNullOrEmpty(cachedId);
            Color idColor = backendActive ? ActiveGreen : InactiveRed;

            if (foundIdCaption != null) foundIdCaption.gameObject.SetActive(returning);

            if (statusDot != null)
            {
                statusDot.gameObject.SetActive(returning);
                statusDot.color = idColor;
            }

            if (idValueText != null)
            {
                idValueText.gameObject.SetActive(returning);
                if (returning)
                {
                    idValueText.text = cachedId;
                    idValueText.color = idColor;
                }
            }

            if (enterAnotherButton != null) enterAnotherButton.gameObject.SetActive(returning);

            if (enterLabel != null)
                enterLabel.text = returning ? "Enter with same account" : "Enter as Anonymous";

            SetBusy(false);
            SetNotice(string.Empty);
        }

        /// <summary>Disable both buttons while sign-in is in flight; show "Signing in…".</summary>
        public void SetBusy(bool busy)
        {
            if (enterButton != null) enterButton.interactable = !busy;
            if (enterAnotherButton != null) enterAnotherButton.interactable = !busy;
            if (busy) SetNotice("Signing in…");
        }

        /// <summary>Sign-in failed with nothing to fall back on: re-enable and show why.</summary>
        public void ShowError(string message)
        {
            SetBusy(false);
            SetNotice(string.IsNullOrEmpty(message) ? "Sign-in failed. Try again." : message);
        }

        public void Hide() => gameObject.SetActive(false);

        private void SetNotice(string text)
        {
            if (noticeText != null) noticeText.text = text ?? string.Empty;
        }
    }
}
