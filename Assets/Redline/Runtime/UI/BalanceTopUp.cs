using System;
using System.Threading.Tasks;
using Redline.Client.Net;

namespace Redline.Client.UI
{
    /// <summary>
    /// The demo in-game balance top-up sub-flow, lifted out of
    /// <see cref="GameFlowUi"/> (feature 0009). Opened from the home screen's
    /// balance button; commits through <c>Backend/handlers/addBalance.ts</c>
    /// (in-game currency only — no real money moves). It owns no money figure;
    /// every amount comes from the server.
    ///
    /// A plain class, not a MonoBehaviour: <see cref="GameFlowUi"/> constructs it
    /// in <c>Awake</c> and disposes it in <c>OnDestroy</c>, and calls
    /// <see cref="Reset"/> from <c>GoHome</c> so the modal never lingers.
    /// </summary>
    internal sealed class BalanceTopUp : IDisposable
    {
        private readonly HomePanel _home;
        private readonly AddBalancePanel _panel;
        private readonly RedlineSession _session;
        private readonly long[] _fallbackLadder;

        public BalanceTopUp(HomePanel home, AddBalancePanel panel, RedlineSession session, long[] fallbackLadder)
        {
            _home = home;
            _panel = panel;
            _session = session;
            _fallbackLadder = fallbackLadder;

            if (_panel != null)
            {
                _home.BalanceTapped += OnBalanceTapped;
                _panel.AddRequested += OnAddRequested;
                _panel.Closed += OnClosed;
            }
        }

        public void Dispose()
        {
            if (_panel != null)
            {
                _home.BalanceTapped -= OnBalanceTapped;
                _panel.AddRequested -= OnAddRequested;
                _panel.Closed -= OnClosed;
            }
        }

        /// <summary>Hide the modal — called when the flow returns Home.</summary>
        public void Reset()
        {
            if (_panel != null) _panel.Hide();
        }

        /// <summary>
        /// Home balance button tapped: open the top-up modal seeded with the
        /// current balance and the server stake ladder. Ignored offline — there
        /// is nothing to top up without an account.
        /// </summary>
        private void OnBalanceTapped()
        {
            if (_panel == null || _session == null || !_session.CanStake || !_session.Me.HasValue) return;

            long[] ladder = _session.Me.Value.stakesCents;
            _panel.SetLadder(ladder != null && ladder.Length > 0 ? ladder : _fallbackLadder);
            _panel.SetBalance(Money.Full(_session.Me.Value.balanceCents));
            _panel.SetNotice(string.Empty);
            _panel.SetBusy(false);
            _panel.Show();
        }

        private void OnClosed()
        {
            if (_panel != null) _panel.Hide();
        }

        private void OnAddRequested(long amountCents)
        {
            if (_panel == null || _session == null || !_session.CanStake) return;
            _panel.SetBusy(true);
            _panel.SetNotice(string.Empty);
            _ = AddBalanceAsync(amountCents);
        }

        /// <summary>
        /// Demo in-game currency only — no real money moves (server:
        /// handlers/addBalance.ts). On success the balance repaints from the
        /// RefreshMeAsync -> Changed path; a server cap keeps the modal open
        /// with a notice instead of closing.
        /// </summary>
        private async Task AddBalanceAsync(long amountCents)
        {
            try
            {
                var r = await _session.Backend.AddBalanceAsync(amountCents, Guid.NewGuid().ToString("N"));
                await _session.RefreshMeAsync();

                if (_panel == null) return;
                _panel.SetBusy(false);

                if (r.capped)
                {
                    _panel.SetBalance(Money.Full(r.balanceCents));
                    _panel.SetNotice($"Balance is capped at {Money.Short(r.maxBalanceCents)}.");
                }
                else
                {
                    _panel.Hide();
                }
            }
            catch (BackendCallException ex)
            {
                if (_panel != null)
                {
                    _panel.SetBusy(false);
                    _panel.SetNotice(ex.Message);
                }
            }
        }
    }
}
