using System;
using Redline.Client.Net;

namespace Redline.Client.UI
{
    /// <summary>
    /// The anonymous-identity sub-flow, lifted out of <see cref="GameFlowUi"/>
    /// (feature 0009). It owns the <see cref="AuthPanel"/> and the sign-in taps;
    /// <see cref="GameFlowUi"/> owns panel visibility and, on
    /// <see cref="ReadyForHome"/>, the move to Home.
    ///
    /// A plain class, not a MonoBehaviour: it has no per-frame work and no
    /// serialized state — <see cref="GameFlowUi"/> constructs it in <c>Awake</c>
    /// from its own wired references and disposes it in <c>OnDestroy</c>.
    /// </summary>
    internal sealed class AuthScreen : IDisposable
    {
        private readonly AuthPanel _panel;
        private readonly RedlineSession _session;

        /// <summary>Raised when the identity screen is done and Home should take over.</summary>
        public event Action ReadyForHome;

        public AuthScreen(AuthPanel panel, RedlineSession session)
        {
            _panel = panel;
            _session = session;

            if (_panel != null)
            {
                _panel.EnterRequested += OnEnterRequested;
                _panel.EnterAnotherRequested += OnEnterAnotherRequested;
            }
        }

        public void Dispose()
        {
            if (_panel != null)
            {
                _panel.EnterRequested -= OnEnterRequested;
                _panel.EnterAnotherRequested -= OnEnterAnotherRequested;
            }
        }

        /// <summary>
        /// Launch. Returns true when the identity screen is the entry point (the
        /// caller should make its panel the only visible one); false when there
        /// is no panel wired — sign-in starts immediately and the caller goes
        /// straight to Home.
        /// </summary>
        public bool Begin()
        {
            if (_panel == null)
            {
                _session?.BeginSignIn();
                return false;
            }

            _panel.Show(
                _session != null ? _session.CachedAccountId : null,
                _session != null && _session.CachedIdActiveOnBackend);
            return true;
        }

        /// <summary>
        /// Handles a <see cref="RedlineSession.Changed"/> tick while the identity
        /// screen is up. Returns true when it consumed the event (the caller
        /// should stop) — raising <see cref="ReadyForHome"/> once the session is
        /// Ready.
        /// </summary>
        public bool OnSessionChanged()
        {
            if (_panel == null || !_panel.gameObject.activeSelf) return false;
            if (_session == null) return true;

            if (_session.Ready)
            {
                ReadyForHome?.Invoke();
                return true;
            }

            // RedlineSession.Start() peeks the cached uid asynchronously and may
            // finish after this panel was first shown (Start() order is undefined,
            // and the device peek truly awaits) — re-render so a returning user
            // gets the "same account" wording once the id is known.
            if (_session.AwaitingSignIn)
            {
                _panel.Show(_session.CachedAccountId, _session.CachedIdActiveOnBackend);
                return true;
            }

            if (!_session.Connecting && !string.IsNullOrEmpty(_session.StartupError))
                _panel.ShowError("Couldn't sign in — check your connection and try again.");
            return true;
        }

        private void OnEnterRequested()
        {
            if (_session == null) return;
            _panel.SetBusy(true);
            _session.BeginSignIn();
        }

        private void OnEnterAnotherRequested()
        {
            if (_session == null) return;
            _panel.SetBusy(true);
            _session.BeginSignIn(asNewIdentity: true);
        }
    }
}
