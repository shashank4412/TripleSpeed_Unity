using System;

namespace Redline.Client.Net
{
    /// <summary>
    /// A backend call that failed before returning an answer — a transport-level
    /// failure (no network, a deadline, the server erroring).
    ///
    /// A logical refusal is not this: "challenge no longer available" is an
    /// answer, returned as <c>ok == false</c> on the result struct and read
    /// directly, not caught. Kept engine- and SDK-agnostic so
    /// <see cref="SubmissionQueue"/>'s retry policy needs only
    /// <see cref="Retryable"/>; <see cref="FirebaseRedlineBackend"/> is the only
    /// constructor, translating at the one <c>Call</c> seam.
    /// </summary>
    public sealed class BackendCallException : Exception
    {
        public BackendCallException(string message, bool retryable, Exception inner = null)
            : base(message, inner)
        {
            Retryable = retryable;
        }

        /// <summary>True when sending the identical request again could succeed.</summary>
        public bool Retryable { get; }
    }
}
