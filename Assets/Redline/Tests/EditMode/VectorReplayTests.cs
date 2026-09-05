using System.Collections.Generic;
using System.Globalization;
using System.IO;
using NUnit.Framework;
using Redline.Core;
using UnityEngine;

namespace Redline.Tests.EditMode
{
    /// <summary>
    /// Replays every published test vector through the **Unity-compiled** core.
    ///
    /// This is the test that turns "client and server agree" from a claim into a
    /// fact. `tests/Redline.Core.Tests/TestVectorTests.cs` replays the same file
    /// under .NET; this replays it under Unity's toolchain, against the same
    /// sources compiled by the asmdef. The point is not that two test suites
    /// exist — it is that **the same file passes under both**, so a divergence
    /// between IL2CPP and CoreCLR would fail here rather than silently pay the
    /// wrong player.
    ///
    /// The vectors are committed DATA. A test that recomputed its expectations
    /// would prove only that the code agrees with itself today.
    /// </summary>
    public sealed class VectorReplayTests
    {
        private static GameConfig Config => GameConfig.Parse(File.ReadAllText(
            Path.Combine(Application.dataPath, "Redline", "Settings", "redline.game.json.txt")));

        // The single shared vector file. sim-core-ts replays the same one under
        // Node (Backend/sim-core-ts/test/vectors.test.ts) — that is the
        // cross-toolchain determinism gate.
        private static string VectorPath =>
            Path.Combine(Directory.GetParent(Application.dataPath).FullName, "Backend", "testvectors", "vectors.tsv");

        private static IEnumerable<string> Vectors()
        {
            foreach (string line in File.ReadAllLines(VectorPath))
                if (line.Length > 0 && line[0] != '#')
                    yield return line;
        }

        [Test]
        [TestCaseSource(nameof(Vectors))]
        public void RecordedRunReproducesExactly(string line)
        {
            var config = Config;
            string[] f = line.Split('\t');

            var input = new RunInput(
                ulong.Parse(f[0], CultureInfo.InvariantCulture),
                ParseEvents(f[2]),
                int.Parse(f[1], CultureInfo.InvariantCulture));

            var result = Simulation.Run(config, input);

            // Exact on every field. Not close — one point decides who takes the
            // pot, so "within a point" is a failure.
            Assert.AreEqual(f[3], result.Outcome.ToString(), "outcome");
            Assert.AreEqual(long.Parse(f[4], CultureInfo.InvariantCulture), result.Score, "score");
            Assert.AreEqual(long.Parse(f[5], CultureInfo.InvariantCulture), result.ScoreUnits, "scoreUnits");
            Assert.AreEqual(int.Parse(f[6], CultureInfo.InvariantCulture), result.EndTick, "endTick");
            Assert.AreEqual(long.Parse(f[7], CultureInfo.InvariantCulture), result.Distance, "distance");
            Assert.AreEqual(int.Parse(f[8], CultureInfo.InvariantCulture), result.FinalLane, "finalLane");
            Assert.AreEqual(int.Parse(f[9], CultureInfo.InvariantCulture), result.RejectedInputs, "rejectedInputs");
        }

        [Test]
        public void VectorFileMatchesTheCurrentConfig()
        {
            // A vector set recorded under different rules cannot prove anything
            // about these rules. Fail as a stale vector file rather than as
            // twenty-four mysterious score mismatches.
            var config = Config;

            foreach (string line in File.ReadAllLines(VectorPath))
            {
                if (!line.StartsWith("# configHash:")) continue;

                string recorded = line.Substring("# configHash:".Length).Trim();

                Assert.AreEqual(config.ConfigHash, recorded,
                    "vectors were recorded under a different config. Run `redline vectors` and review the diff.");
                return;
            }

            Assert.Fail("vector file carries no configHash header");
        }

        [Test]
        public void TheVectorSetIsWorthReplaying()
        {
            int total = 0, banked = 0, crashed = 0;

            foreach (string line in Vectors())
            {
                total++;
                string outcome = line.Split('\t')[3];
                if (outcome == nameof(RunOutcome.Banked)) banked++;
                if (outcome == nameof(RunOutcome.Crashed)) crashed++;
            }

            Assert.GreaterOrEqual(total, 20, "the brief asks for at least 20 published vectors");
            Assert.Greater(banked, 0, "no banked run among the vectors");
            Assert.Greater(crashed, 0, "no crashed run among the vectors");
        }

        /// <summary>
        /// "12:L,40:R" — tick and direction. Mirrors the .NET parser exactly;
        /// the format is the file's, not either suite's.
        /// </summary>
        private static IReadOnlyList<InputEvent> ParseEvents(string field)
        {
            if (field == "-" || field.Length == 0) return System.Array.Empty<InputEvent>();

            string[] parts = field.Split(',');
            var events = new InputEvent[parts.Length];

            for (int i = 0; i < parts.Length; i++)
            {
                // "90R" — the tick, then a trailing L or R. This split on ':'
                // for a "90:R" that the generator has never written, so every
                // vector with a swipe threw a FormatException. It went unnoticed
                // because the EditMode suite cannot run headless while the
                // Editor is open, and the Editor has been open throughout.
                // InputEvent.ToString() and redline vectors both use this shape;
                // matching it here keeps one format rather than two.
                string token = parts[i];
                char direction = token[token.Length - 1];

                events[i] = new InputEvent(
                    int.Parse(token.Substring(0, token.Length - 1), CultureInfo.InvariantCulture),
                    direction == 'L' ? SwipeDirection.Left : SwipeDirection.Right);
            }

            return events;
        }
    }
}
