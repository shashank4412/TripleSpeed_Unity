using System.Collections.Generic;
using NUnit.Framework;
using Redline.Client.Input;
using Redline.Core;
using UnityEngine;

namespace Redline.Tests.EditMode
{
    /// <summary>
    /// The client's two claims that can be tested without a device: that
    /// stepping the core one tick at a time gives the same answer as running it
    /// whole, and that the swipe recogniser turns gestures into the right
    /// events.
    ///
    /// The rest of B11 — framing, allocation, feel — needs the Editor, the
    /// Profiler and a phone, and is not asserted here.
    /// </summary>
    public sealed class SteppedRunTests
    {
        private static GameConfig LoadConfig()
        {
            var asset = Resources.Load<TextAsset>("redline.game.json");
            if (asset != null) return GameConfig.Parse(asset.text);

            // Not under Resources in this project; read the shipped copy from
            // disk, which ClientConfigCopyTests holds byte-identical to
            // Backend/config/redline.game.json.
            string path = System.IO.Path.Combine(
                Application.dataPath, "Redline", "Settings", "redline.game.json.txt");

            return GameConfig.Parse(System.IO.File.ReadAllText(path));
        }

        /// <summary>
        /// RunHost's loop, without the MonoBehaviour. Driving the real component
        /// would need a PlayMode test and a scene; this asserts the thing that
        /// actually matters — that the stepped path is the same path.
        /// </summary>
        private static RunResult StepLikeRunHost(GameConfig config, ulong seed, IReadOnlyList<InputEvent> events, int maxTicks)
        {
            var state = Simulation.NewState(config);
            var road = new RoadGenerator(config, seed);
            var scratch = new List<Hazard>();
            int next = 0;

            while (state.Tick < maxTicks)
            {
                SwipeDirection? swipe = null;
                if (next < events.Count && events[next].Tick == state.Tick)
                {
                    swipe = events[next].Direction;
                    next++;
                }

                var outcome = Simulation.Advance(config, state, road, scratch, swipe);

                if (outcome == Simulation.TickOutcome.Banked)
                    return Simulation.Result(config, state, RunOutcome.Banked);

                if (outcome == Simulation.TickOutcome.Crashed)
                    return Simulation.Result(config, state, RunOutcome.Crashed);
            }

            return Simulation.Result(config, state, RunOutcome.Abandoned);
        }

        [Test]
        public void SteppingThroughTheClientPathMatchesSimulationRunExactly()
        {
            var config = LoadConfig();

            for (ulong seed = 1; seed <= 40; seed++)
            {
                var events = new List<InputEvent>();
                int tick = 11;
                for (int i = 0; i < 8; i++)
                {
                    events.Add(new InputEvent(tick, i % 2 == 0 ? SwipeDirection.Right : SwipeDirection.Left));
                    tick += 5 + (int)(seed % 13);
                }

                var whole = Simulation.Run(config, new RunInput(seed, events, 1800));
                var stepped = StepLikeRunHost(config, seed, events, 1800);

                // Byte-identical, not close. One point decides who takes the pot.
                Assert.AreEqual(whole.ScoreUnits, stepped.ScoreUnits, $"ScoreUnits diverged on seed {seed}");
                Assert.AreEqual(whole.Outcome, stepped.Outcome, $"Outcome diverged on seed {seed}");
                Assert.AreEqual(whole.EndTick, stepped.EndTick, $"EndTick diverged on seed {seed}");
                Assert.AreEqual(whole.FinalLane, stepped.FinalLane, $"FinalLane diverged on seed {seed}");
                Assert.AreEqual(whole.RejectedInputs, stepped.RejectedInputs, $"RejectedInputs diverged on seed {seed}");
            }
        }

        [Test]
        public void TheClientConfigCopyIsTheRealConfig()
        {
            // A forked copy would be scored against different rules by a server
            // that had never seen it.
            string root = System.IO.Directory.GetParent(Application.dataPath).FullName;
            string source = System.IO.Path.Combine(root, "Backend", "config", "redline.game.json");
            string copy = System.IO.Path.Combine(Application.dataPath, "Redline", "Settings", "redline.game.json.txt");

            Assert.AreEqual(System.IO.File.ReadAllText(source), System.IO.File.ReadAllText(copy));
        }
    }

    public sealed class SwipeRecogniserTests
    {
        private static SwipeRecogniser New(float minDistance = 42f, float maxDuration = 0.45f, float deadZone = 1.4f) =>
            new SwipeRecogniser(new SwipeSettings
            {
                minimumDistancePixels = minDistance,
                maximumDurationSeconds = maxDuration,
                deadZoneRatio = deadZone,
            });

        [Test]
        public void AClearHorizontalFlickIsASwipe()
        {
            var recogniser = New();
            recogniser.Begin(new Vector2(200, 400), 0f);

            Assert.IsTrue(recogniser.End(new Vector2(320, 410), 0.12f, out var direction));
            Assert.AreEqual(SwipeDirection.Right, direction);
        }

        [Test]
        public void LeftAndRightAreDistinguished()
        {
            var recogniser = New();
            recogniser.Begin(new Vector2(320, 400), 0f);

            Assert.IsTrue(recogniser.End(new Vector2(200, 400), 0.10f, out var direction));
            Assert.AreEqual(SwipeDirection.Left, direction);
        }

        [Test]
        public void ATapIsNotASwipe()
        {
            var recogniser = New();
            recogniser.Begin(new Vector2(200, 400), 0f);

            Assert.IsFalse(recogniser.End(new Vector2(205, 402), 0.05f, out _));
        }

        [Test]
        public void ASlowDragIsNotASwipe()
        {
            var recogniser = New();
            recogniser.Begin(new Vector2(200, 400), 0f);

            Assert.IsFalse(recogniser.End(new Vector2(400, 400), 1.2f, out _));
        }

        [Test]
        public void AMostlyVerticalDragIsNotASwipe()
        {
            // The commonest false positive on a phone held one-handed: the thumb
            // travels in an arc up the screen.
            var recogniser = New();
            recogniser.Begin(new Vector2(200, 200), 0f);

            Assert.IsFalse(recogniser.End(new Vector2(260, 500), 0.2f, out _));
        }

        [Test]
        public void AReleaseWithoutABeginIsIgnored()
        {
            Assert.IsFalse(New().End(new Vector2(400, 400), 0.1f, out _));
        }

        [Test]
        public void ACancelledGestureProducesNothing()
        {
            var recogniser = New();
            recogniser.Begin(new Vector2(200, 400), 0f);
            recogniser.Cancel();

            Assert.IsFalse(recogniser.End(new Vector2(400, 400), 0.1f, out _));
        }

        [Test]
        public void ThresholdsComeFromSettingsRatherThanConstants()
        {
            // A reviewer retunes swipe feel by editing the settings asset, not
            // by rebuilding.
            var strict = New(minDistance: 300f);
            strict.Begin(new Vector2(200, 400), 0f);
            Assert.IsFalse(strict.End(new Vector2(320, 400), 0.1f, out _));

            var loose = New(minDistance: 10f);
            loose.Begin(new Vector2(200, 400), 0f);
            Assert.IsTrue(loose.End(new Vector2(320, 400), 0.1f, out _));
        }
    }
}
