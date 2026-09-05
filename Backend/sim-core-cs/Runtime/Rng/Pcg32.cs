using System;

namespace Redline.Core
{
    /// <summary>
    /// PCG-XSH-RR 64/32 — O'Neill's permuted congruential generator.
    ///
    /// Every hazard in a run comes from here. Two players given the same seed
    /// must drive an identical road, and a replay months later must reproduce
    /// it exactly, so this generator has to be bit-identical on a phone and on
    /// the server, forever.
    ///
    /// Why it is safe to make that claim:
    ///   * State is <see cref="ulong"/> and output is <see cref="uint"/>. Both
    ///     are exactly specified by ECMA-335 on every platform, unlike float.
    ///   * Every operation below is +, *, ^, and shifts on unsigned integers.
    ///     All of them wrap modulo 2^64 by definition, so there is no
    ///     platform-dependent overflow behaviour to worry about.
    ///   * There is no branching on data, no table lookup, and no library call.
    ///
    /// The struct is mutable by design and passed by ref. It is deliberately
    /// NOT thread-safe: a run is a single sequential simulation.
    /// </summary>
    public struct Pcg32
    {
        // Multiplier from the reference implementation. Chosen by O'Neill for
        // full period and good spectral properties; not a magic number we made up.
        private const ulong Multiplier = 6364136223846793005UL;

        private ulong _state;
        private readonly ulong _increment; // must be odd; that is what selects the stream

        /// <summary>
        /// Seeds the generator. <paramref name="sequence"/> selects one of 2^63
        /// distinct streams, letting one run seed drive several independent
        /// generators (hazard lanes, traffic speeds) without correlating them.
        /// </summary>
        public Pcg32(ulong seed, ulong sequence = 0UL)
        {
            _state = 0UL;
            _increment = (sequence << 1) | 1UL; // force odd
            NextUInt();                          // advance past the raw seed
            _state += seed;
            NextUInt();
        }

        /// <summary>Uniform in [0, 2^32).</summary>
        public uint NextUInt()
        {
            ulong old = _state;
            _state = unchecked(old * Multiplier + _increment);

            // Output permutation: xorshift then a random rotation. The rotation
            // amount comes from the high bits, which is what gives PCG its
            // quality over a plain LCG.
            uint xorshifted = (uint)(((old >> 18) ^ old) >> 27);
            int rot = (int)(old >> 59);
            return (xorshifted >> rot) | (xorshifted << ((-rot) & 31));
        }

        /// <summary>
        /// Uniform in [0, bound). Uses rejection sampling, so the result is
        /// exactly uniform rather than modulo-biased — with hazard weights this
        /// close together, modulo bias would be visible as lane favouritism.
        /// </summary>
        public uint NextUInt(uint bound)
        {
            if (bound == 0u) throw new ArgumentOutOfRangeException(nameof(bound));

            // Discard the tail that would wrap unevenly.
            uint threshold = (uint)(-(int)bound) % bound;
            while (true)
            {
                uint r = NextUInt();
                if (r >= threshold) return r % bound;
            }
        }

        /// <summary>Uniform integer in [min, max]. Inclusive both ends.</summary>
        public int NextInt(int min, int max)
        {
            if (max < min) throw new ArgumentOutOfRangeException(nameof(max));
            uint range = (uint)((long)max - min + 1L);
            return min + (int)NextUInt(range);
        }

        /// <summary>
        /// Uniform in [0, 1) expressed in the caller's fixed-point scale — e.g.
        /// scale 1000 yields 0..999 thousandths.
        ///
        /// The core has no float anywhere; probabilities are integers with a
        /// stated denominator. This is the only "fraction" primitive.
        /// </summary>
        public int NextFraction(int scale)
        {
            if (scale <= 0) throw new ArgumentOutOfRangeException(nameof(scale));
            return (int)NextUInt((uint)scale);
        }
    }
}
