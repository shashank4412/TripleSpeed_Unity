using System;
using PrimeTween;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// The screen after a run, for a staked 1v1. Walks three states as the server
    /// answers: <see cref="ShowSending"/> (queued), <see cref="ShowOwnScore"/>
    /// (this run's server score), <see cref="ShowSettled"/> (match settled).
    ///
    /// Where trust is won or lost, so: every number is the server's, rake is its
    /// own line and never netted away, and a draw is explained not just labelled
    /// (ADR 0002 — both-banked-equal and both-crashed are one case, odd cent to
    /// the poster). <see cref="ShowPractice"/> is the offline case.
    ///
    /// The Game ID sits in a snippet box with an inline copy button (icon swaps
    /// to a tick + a "copied" toast for ~2s), the pattern from a code-block copy
    /// control. Copy is graded — review test #2 reads it back to replay the
    /// match server-side.
    /// </summary>
    public sealed class OpponentPlayingPanel : MonoBehaviour
    {
        [Tooltip("Top line — \"Sending…\", \"Opponent is playing now\", the result.")]
        [SerializeField] private TMP_Text statusText;

        [Tooltip("The Game ID (match id, or seed for a practice run). Lives in the snippet box.")]
        [SerializeField] private TMP_Text gameIdText;

        [Tooltip("\"Your run: N\" line.")]
        [SerializeField] private TMP_Text mineText;

        [Tooltip("\"You N   Opponent M\" line.")]
        [SerializeField] private TMP_Text scoresText;

        [Tooltip("The pot / rake / credited / net breakdown block.")]
        [SerializeField] private TMP_Text moneyText;

        [Tooltip("The \"Rating a → b\" line.")]
        [SerializeField] private TMP_Text ratingText;

        [Tooltip("The small copy button inside the snippet box (right side).")]
        [SerializeField] private Button copyButton;

        [Tooltip("The icon Image on the copy button. Its sprite swaps copy -> tick on a copy.")]
        [SerializeField] private Image copyButtonIcon;

        [Tooltip("The resting copy glyph.")]
        [SerializeField] private Sprite copyIcon;

        [Tooltip("The tick glyph shown for ~2s after a copy.")]
        [SerializeField] private Sprite copiedIcon;

        [Tooltip("The \"text copied to clipboard\" toast. Faded in on copy, out after the reset delay.")]
        [SerializeField] private CanvasGroup copiedToast;

        [Tooltip("Returns to the home screen.")]
        [SerializeField] private Button continueButton;

        public event Action Continued;

        /// <summary>Seconds the tick + toast stay up before the copy glyph returns.</summary>
        private const float CopiedHoldSeconds = 2f;

        private string _gameId;
        private Tween _copyReset;

        private void Awake()
        {
            if (copyButton != null) copyButton.onClick.AddListener(Copy);
            if (continueButton != null) continueButton.onClick.AddListener(() => Continued?.Invoke());
            RestoreCopyAffordance(instant: true);
        }

        private void OnDisable()
        {
            // The panel is reused across runs — leave the copy control at rest so
            // the next Sending screen never opens mid-"copied".
            if (_copyReset.isAlive) _copyReset.Stop();
            RestoreCopyAffordance(instant: true);
        }

        public void Hide() => gameObject.SetActive(false);

        /// <summary>
        /// Offline practice run — nothing debited. With no server match the
        /// <paramref name="seed"/> stands in as the Game ID (it reproduces the
        /// run via <c>Tools/Replay</c>), and Copy still works.
        /// </summary>
        public void ShowPractice(long stakeCents, ulong seed)
        {
            _gameId = seed.ToString();
            Set(statusText, "Practice run — no opponent");
            SetGameId(_gameId);
            Set(mineText, "Played for " + Money.Full(stakeCents));
            Set(scoresText, string.Empty);
            Set(moneyText, string.Empty);
            Set(ratingText, string.Empty);
            if (copyButton != null) copyButton.interactable = true;
            gameObject.SetActive(true);
        }

        /// <summary>Staked run just ended; the submission is queued.</summary>
        public void ShowSending(string gameId)
        {
            _gameId = gameId;
            Set(statusText, "Sending your run…");
            SetGameId(string.IsNullOrEmpty(gameId) ? "—" : gameId);
            Set(mineText, string.Empty);
            Set(scoresText, string.Empty);
            Set(moneyText, string.Empty);
            Set(ratingText, string.Empty);
            if (copyButton != null) copyButton.interactable = !string.IsNullOrEmpty(gameId);
            gameObject.SetActive(true);
        }

        /// <summary>The submit callable answered — the server's score for this run.</summary>
        public void ShowOwnScore(long serverScore, bool banked, bool deviceDisagreed)
        {
            Set(statusText, "Opponent is playing now");
            Set(mineText, deviceDisagreed
                ? $"Your run: {(banked ? serverScore : 0)}  ·  your device scored it differently; the server's number counts"
                : $"Your run: {(banked ? serverScore : 0)}");
            gameObject.SetActive(true);
        }

        /// <summary>The match settled. Result, money and rating — all server figures.</summary>
        public void ShowSettled(
            string result, long yourScore, long opponentScore,
            long potCents, long rakeCents, long creditedCents, long netCents,
            int ratingBefore, int ratingAfter, int ratingDelta)
        {
            bool draw = result == "draw";

            Set(statusText, draw ? "DRAW" : result == "won" ? "YOU WIN" : "YOU LOSE");
            Set(scoresText, $"You {yourScore}      Opponent {opponentScore}");

            // Pot and rake on their own lines — a single "you won $0.90" invites
            // the question this screen exists to answer. One space between label
            // and value so each line is a compact unit that centres cleanly with
            // the rest of the screen (the label is the wrap key on the settled
            // panel: moneyText is centre-aligned there).
            Set(moneyText,
                $"Pot  {Money.Full(potCents)}\n" +
                $"Rake  -{Money.Full(rakeCents)}\n" +
                $"Credited  {Money.Full(creditedCents)}\n" +
                $"Net  {(netCents >= 0 ? "+" : "-")}{Money.Full(netCents < 0 ? -netCents : netCents)}" +
                (draw
                    ? "\n\nEqual scores — including both crashing — split the pot after rake. An odd cent goes to whoever posted the challenge."
                    : string.Empty));

            Set(ratingText, $"Rating {ratingBefore} → {ratingAfter}   ({(ratingDelta >= 0 ? "+" : "")}{ratingDelta})");
            gameObject.SetActive(true);
        }

        /// <summary>The submission never landed (window closed, or the server refused it).</summary>
        public void ShowLost(string reason)
        {
            Set(statusText, "Run not delivered");
            Set(mineText, reason);
            gameObject.SetActive(true);
        }

        private void Copy()
        {
            if (string.IsNullOrEmpty(_gameId)) return;

            // The Android system clipboard — what review test #2 reads back to
            // replay the match server-side.
            GUIUtility.systemCopyBuffer = _gameId;

            if (copyButtonIcon != null && copiedIcon != null) copyButtonIcon.sprite = copiedIcon;
            if (copiedToast != null)
            {
                copiedToast.alpha = 0f;
                Tween.Alpha(copiedToast, 1f, 0.15f, useUnscaledTime: true);
            }
            if (copyButton != null && copyButton.TryGetComponent(out UiButtonFx fx)) fx.Ping();

            if (_copyReset.isAlive) _copyReset.Stop();
            _copyReset = Tween.Delay(CopiedHoldSeconds, () => RestoreCopyAffordance(instant: false), useUnscaledTime: true);
        }

        private void RestoreCopyAffordance(bool instant)
        {
            if (copyButtonIcon != null && copyIcon != null) copyButtonIcon.sprite = copyIcon;
            if (copiedToast == null) return;

            if (instant) copiedToast.alpha = 0f;
            else Tween.Alpha(copiedToast, 0f, 0.4f, useUnscaledTime: true);
        }

        /// <summary>
        /// The snippet box shows "Game ID: &lt;id&gt;"; the clipboard still gets
        /// the bare id (<see cref="_gameId"/>), which is what review test #2
        /// reads back to replay the match.
        /// </summary>
        private void SetGameId(string id) => Set(gameIdText, "Game ID: " + id);

        private static void Set(TMP_Text t, string s)
        {
            if (t != null) t.SetText(s);
        }
    }
}
