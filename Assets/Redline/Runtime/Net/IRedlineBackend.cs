using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Redline.Client.Net
{
    // The client's whole contract with the backend, after the move to Firebase.
    // Nothing Firebase-typed leaks through this interface — RedlineSession and
    // the UI depend only on these plain shapes, so the Firebase SDK can be
    // swapped for the emulator, a fake, or a future transport without touching
    // gameplay code.
    //
    // The two rules from the old RedlineApi still hold:
    //   * the client never sends a score as an input (SubmitRun carries it as a
    //     labelled CLAIM; the server re-simulates and its answer pays);
    //   * an idempotencyKey belongs to an operation, not an attempt — the caller
    //     generates it once and reuses it on every retry.

    public interface IRedlineBackend
    {
        /// <summary>Anonymous sign-in has already happened; this is the local uid.</summary>
        string AccountId { get; }

        /// <summary>
        /// The anonymous identity this device already has from a previous launch.
        /// Reads local credential state (and, when it can, checks the token
        /// against the backend) — it must NOT create a new anonymous user, and
        /// it must not throw. A fresh install or an unreadable credential comes
        /// back as <see cref="CachedIdentity.accountId"/> null.
        ///
        /// The Authentication screen calls this before any sign-in to choose
        /// between "Enter as Anonymous" (no id) and "Enter with same account" /
        /// "Enter with another Anonymous ID" (id present), and to colour the id
        /// green when <see cref="CachedIdentity.backendActive"/> is true, red
        /// when the backend could not confirm it (offline, disabled, deleted).
        /// On device the id is <c>FirebaseAuth.CurrentUser?.UserId</c>; in the
        /// Editor loopback it is a locally simulated value.
        /// </summary>
        Task<CachedIdentity> PeekCachedAccountIdAsync();

        /// <summary>
        /// Forget the cached anonymous credential so the next
        /// <see cref="EnsureAccountAsync"/> mints a brand-new anonymous user.
        /// Backs the "Enter with another Anonymous ID" button. Local only — it
        /// does not delete the old user on the backend, it just stops this
        /// device reusing it. Must not throw.
        /// </summary>
        Task ForgetCachedIdentityAsync();

        /// <summary>Sign in anonymously (if needed) and create/read the account doc.</summary>
        Task<AccountView> EnsureAccountAsync(string deviceFingerprint);

        /// <summary>The game rules as raw text from Remote Config, plus the hash the server will check.</summary>
        Task<GameConfigText> GameConfigTextAsync();

        Task<PayoutPreviewView> PreviewAsync(long stakeCents);

        Task<CreateMatchResult> CreateMatchAsync(long stakeCents, string idempotencyKey);

        /// <summary>
        /// Finds an open challenge at this stake, or — if the pool is empty
        /// even at the widened rating-band cap — posts one on the caller's
        /// behalf, atomically, inside this same call (decision #11: never a
        /// bot; the arriving player becomes the poster instead). Because the
        /// fallback can stake money, <paramref name="idempotencyKey"/> is
        /// required like any other money-moving call, even though most calls
        /// (outcome "matched" or a genuine "post_own_challenge" the caller
        /// declines to act on immediately) never spend it.
        /// </summary>
        Task<MatchmakeResult> MatchmakeAsync(long stakeCents, string idempotencyKey);

        Task<JoinMatchResult> JoinMatchAsync(string matchId, string idempotencyKey);

        /// <summary>
        /// Close an unanswered challenge this player posted and return the stake
        /// now — the client calls this when a slow <see cref="MatchmakeAsync"/>
        /// posted a challenge the player did not go on to play (they cancelled,
        /// or the wait was abandoned). Refunds only while the challenge is still
        /// unanswered; once an opponent has staked it is a real match and this
        /// is a no-op (ADR 0004). Idempotent and safe to race with the server's
        /// 15-minute sweep — the stake comes back exactly once. Money-moving, so
        /// <paramref name="idempotencyKey"/> is required like any staking call.
        /// </summary>
        Task<WithdrawChallengeResult> WithdrawChallengeAsync(string matchId, string idempotencyKey);

        Task<SubmitRunResult> SubmitRunAsync(string matchId, SubmitRunEvidence evidence, string idempotencyKey);

        /// <summary>
        /// Demo-only, in-game currency top-up. Raises the balance by one
        /// stake-ladder rung, server-capped. There is no real-money deposit
        /// path — this exists so the game can be demonstrated without a real
        /// settlement clearing first (server: handlers/addBalance.ts,
        /// DevDocs/decisions/0017-demo-balance-topup.md). Money-moving, so the
        /// <paramref name="idempotencyKey"/> is required like any staking call.
        /// </summary>
        Task<AddBalanceResult> AddBalanceAsync(long amountCents, string idempotencyKey);

        /// <summary>Live account snapshot (balance, rating). Returns an unsubscribe handle.</summary>
        IDisposable ObserveAccount(Action<AccountView> onChange);

        /// <summary>Live list of the caller's matches for the lobby. Returns an unsubscribe handle.</summary>
        IDisposable ObserveMyMatches(Action<IReadOnlyList<MatchView>> onChange);

        /// <summary>Live state of one match. Fires again when it settles.</summary>
        IDisposable ObserveMatch(string matchId, Action<MatchView> onChange);

        /// <summary>The per-side result — readable only once the match is settled (rules-enforced).</summary>
        Task<ResultView> GetResultAsync(string matchId);
    }

    // ---- plain views (no Firebase types) ----

    /// <summary>
    /// What the Authentication screen needs before sign-in: the cached
    /// anonymous uid (null = fresh install), and whether the backend could
    /// confirm it right now (drives the green/red dot).
    /// </summary>
    public struct CachedIdentity
    {
        public string accountId;
        public bool backendActive;
    }

    [Serializable]
    public struct AccountView
    {
        public string accountId;
        public string displayName;
        public int rating;
        public int ratedMatches;
        public bool provisional;
        public int league;
        public int leagueCount;
        public long balanceCents;
        public long[] stakesCents;
    }

    public struct GameConfigText
    {
        public string configHash;
        public string rawText;
    }

    public struct PayoutPreviewView
    {
        public long stakeCents, potCents, rakeCents, winCents, tiePosterCents, tieChallengerCents;
    }

    /// <summary>Result of a demo top-up. <see cref="capped"/> is true when the cap clipped the credit.</summary>
    public struct AddBalanceResult
    {
        public bool ok;
        public long creditedCents;      // what actually landed (0 if already at the cap)
        public long balanceCents;       // balance after
        public bool capped;             // creditedCents < the requested amount
        public long maxBalanceCents;    // the server cap, for the "capped at $X" line
    }

    public struct CreateMatchResult
    {
        public bool ok;
        public string result;          // "ok" | "insufficient_balance"
        public string matchId;
        public long stakeCents;
        public ulong seed;
        public string configHash;
        public long balanceCents;
        public long requiredCents;      // set when result == insufficient_balance
    }

    public struct MatchmakeOfferView
    {
        public string matchId;
        public long stakeCents;
        public bool targetHidden;
        public long targetScore;        // meaningless when targetHidden
        public int creatorRating;
        public bool creatorProvisional;
    }

    public struct MatchmakeResult
    {
        public string outcome;          // "matched" | "posted" | "insufficient_balance"
        public bool hasOffer;
        public MatchmakeOfferView offer;
        public int considered;

        /// <summary>Set only when outcome == "posted": the challenge the server just created for the caller.</summary>
        public bool hasPosted;
        public CreateMatchResult posted;
    }

    public struct JoinMatchResult
    {
        public bool ok;
        public string result;           // "ok" | "unavailable" | "insufficient_balance" | "not_found"
        public string matchId;
        public long stakeCents;
        public ulong seed;
        public string configHash;
        public long balanceCents;
    }

    /// <summary>
    /// Result of asking the server to close an unanswered challenge the caller
    /// posted and return the stake now, instead of waiting out the 15-minute
    /// sweep (feature 0010). <see cref="balanceCents"/> is the balance after —
    /// it already includes the refund on "withdrawn" and already reflects it on
    /// "already_expired". Every non-error <see cref="result"/> counts as
    /// <see cref="ok"/>: each one means no stake is stuck.
    /// </summary>
    public struct WithdrawChallengeResult
    {
        public bool ok;
        public string result;           // "withdrawn" | "already_answered" | "already_expired" | "already_settled" | "not_found" | "forbidden"
        public long balanceCents;
    }

    /// <summary>
    /// [Serializable] is load-bearing, not decorative: SubmissionQueue writes a
    /// pending run to disk with JsonUtility so it survives the app being killed
    /// before the submission lands (ADR 0004), and JsonUtility silently
    /// no-ops on a plain struct that lacks this attribute — the run would
    /// serialise to an empty object and the crash-survival guarantee would be
    /// gone with no error anywhere.
    /// </summary>
    [Serializable]
    public struct SubmitRunEvidence
    {
        public string configHash;
        public InputEventDto[] inputLog;
        public int finalTick;
        public long clientScore;        // a CLAIM
        public string clientOutcome;    // a CLAIM
    }

    public struct SubmitRunResult
    {
        public bool ok;
        public string result;           // "ok" | "refused" | "not_found"
        public string role;
        public long serverScore;
        public string outcome;
        public int endTick;
        public long distance;
        public int finalLane;
        public int rejectedInputs;
        public string configHash;
        public bool disagreed;
        public string matchState;
    }

    public struct SideView2
    {
        public bool submitted;
        public long score;              // -1 until settled
        public string outcome;
    }

    public struct MatchView
    {
        public string matchId;
        public long stakeCents;
        public string state;            // created | open | answered | settled | expired | rolledBack
        public string role;             // poster | challenger
        public string waiting;          // your_run | opponent_playing | settling | settled | ...
        public SideView2 you;
        public SideView2 opponent;
        public bool settled;
    }

    public struct ResultView
    {
        public long yourScore, opponentScore;
        public string result;           // won | lost | draw
        public long potCents, rakeCents, creditedCents, netCents;
        public int ratingBefore, ratingAfter, ratingDelta;
    }
}
