namespace Redline.Client.UI
{
    /// <summary>
    /// Integer cents to a display string. No float, no decimal, no currency
    /// library — the server decided every figure in integer cents and this only
    /// formats it, in integer arithmetic, the way the money invariant requires.
    /// </summary>
    public static class Money
    {
        /// <summary>Always two decimals: <c>$1.20</c>, <c>-$0.05</c>.</summary>
        public static string Full(long cents)
        {
            bool negative = cents < 0;
            long abs = negative ? -cents : cents;
            long whole = abs / 100;
            long rem = abs % 100;
            return (negative ? "-$" : "$") + whole + "." + (rem < 10 ? "0" : "") + rem;
        }

        /// <summary>Whole-dollar amounts trim to <c>$5</c>; otherwise as <see cref="Full"/>.</summary>
        public static string Short(long cents)
        {
            if (cents % 100 != 0) return Full(cents);
            bool negative = cents < 0;
            long abs = negative ? -cents : cents;
            return (negative ? "-$" : "$") + (abs / 100);
        }
    }
}
