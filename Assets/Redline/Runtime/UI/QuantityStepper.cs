using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Redline.Client.UI
{
    /// <summary>
    /// A −/value/+ control over a fixed ladder of stake amounts.
    ///
    /// It never invents an amount. The ladder is integer cents supplied by the
    /// caller — the server's <c>stakeCents</c> ladder online, or the practice
    /// ladder offline — and the stepper only moves an index within it. At the
    /// ends the matching arrow is greyed, so a player cannot step past the
    /// ladder the server will accept.
    /// </summary>
    public sealed class QuantityStepper : MonoBehaviour
    {
        [Tooltip("The − button. Greys out at the lowest rung.")]
        [SerializeField] private Button minus;

        [Tooltip("The + button. Greys out at the highest rung.")]
        [SerializeField] private Button plus;

        [Tooltip("The current-stake label between the arrows.")]
        [SerializeField] private TMP_Text valueText;

        private long[] _ladderCents = Array.Empty<long>();
        private int _index;

        /// <summary>Raised with the newly-selected amount, in cents.</summary>
        public event Action<long> Changed;

        public long SelectedCents =>
            _ladderCents.Length == 0 ? 0L : _ladderCents[Mathf.Clamp(_index, 0, _ladderCents.Length - 1)];

        private void Awake()
        {
            if (minus != null) minus.onClick.AddListener(() => Step(-1));
            if (plus != null) plus.onClick.AddListener(() => Step(1));
            Render();
        }

        /// <summary>
        /// Sets the ladder. A genuinely new ladder resets to its lowest rung; an
        /// identical one keeps the current pick, so returning to the home screen
        /// after a run does not silently drop the stake the player chose.
        /// </summary>
        public void SetLadder(long[] ladderCents)
        {
            var next = ladderCents ?? Array.Empty<long>();

            if (SameLadder(_ladderCents, next))
            {
                _index = Mathf.Clamp(_index, 0, Mathf.Max(0, next.Length - 1));
                _ladderCents = next;
                Render();
                return;
            }

            _ladderCents = next;
            _index = 0;
            Render();
            Changed?.Invoke(SelectedCents);
        }

        private static bool SameLadder(long[] a, long[] b)
        {
            if (a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
            return true;
        }

        private void Step(int delta)
        {
            int next = Mathf.Clamp(_index + delta, 0, Mathf.Max(0, _ladderCents.Length - 1));
            if (next == _index) return;

            _index = next;
            Render();
            Changed?.Invoke(SelectedCents);
        }

        private void Render()
        {
            if (valueText != null) valueText.SetText(Money.Short(SelectedCents));
            if (minus != null) minus.interactable = _index > 0;
            if (plus != null) plus.interactable = _index < _ladderCents.Length - 1;
        }
    }
}
