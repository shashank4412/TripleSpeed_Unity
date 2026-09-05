using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using Redline.Client;
using Redline.Client.Net;
using Redline.Client.UI;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Redline.Tests.EditMode
{
    /// <summary>
    /// <c>main.unity</c> is a hand-authored scene (ADR 0016). A scene fails
    /// silently: a <c>SerializeField</c> nobody assigned is null, and null is a
    /// <c>NullReferenceException</c> on the first frame of a run rather than an
    /// error at build time. This test looks.
    ///
    /// It reflects over the fields rather than naming them, so a component that
    /// grows a new reference is covered the day it is added.
    /// </summary>
    public sealed class SceneWiringTests
    {
        private const string ScenePath = "Assets/Redline/Scenes/main.unity";

        [Test]
        public void TheSceneContainsEveryComponentTheGameNeeds()
        {
            OpenScene();

            // The run loop and the online layer. Split in the message rather
            // than the assertion because "which half is missing" is the first
            // thing you want to know.
            AssertPresent<RunHost>();
            AssertPresent<RedlineSession>();
            AssertPresent<SubmissionQueue>();
            AssertPresent<Redline.Client.Rendering.CameraFollow>();
            AssertPresent<Redline.Client.Rendering.CarTint>();
            AssertPresent<Redline.Client.Rendering.CrashFx>();
            AssertPresent<ScreenRainbow>();

            // The uGUI front-end (feature 0005). GameFlowUi coordinates; the
            // panels are the screens it drives.
            AssertPresent<GameFlowUi>();
            AssertPresent<AuthPanel>();
            AssertPresent<HomePanel>();
            AssertPresent<InstructionsPanel>();
            AssertPresent<ReadyGoPanel>();
            AssertPresent<GameOverPanel>();
            AssertPresent<OpponentPlayingPanel>();
            AssertPresent<RunExitControl>();
            AssertPresent<AddBalancePanel>();
        }

        /// <summary>
        /// Every serialized object reference on those components must be
        /// assigned.
        ///
        /// Only object references are checked. A serialized int left at zero may
        /// be deliberate; a serialized reference left null never is — nothing in
        /// this client treats a missing collaborator as optional.
        /// </summary>
        [Test]
        public void EverySerializedReferenceIsAssigned()
        {
            OpenScene();

            var unassigned = new List<string>();

            foreach (var component in Components())
            {
                var serialized = new SerializedObject(component);
                var property = serialized.GetIterator();

                // enterChildren on the first step only: descending into every
                // child would walk into Unity's own nested serialization, where
                // a null is routine and means nothing.
                bool enterChildren = true;

                while (property.NextVisible(enterChildren))
                {
                    enterChildren = false;

                    if (property.propertyType != SerializedPropertyType.ObjectReference) continue;
                    if (property.objectReferenceValue != null) continue;

                    // Graphic.m_Material null is not a wiring mistake: the
                    // getter falls back to the built-in UI material at runtime.
                    // The Redline Graphic subclass is RainbowVignette (the on-5x
                    // screen glow).
                    if (property.name == "m_Material") continue;

                    unassigned.Add($"{component.GetType().Name}.{property.name}");
                }
            }

            Assert.IsEmpty(unassigned,
                "these serialized references are null and will throw on the first frame: " +
                string.Join(", ", unassigned) +
                "  — open Assets/Redline/Scenes/main.unity and assign them");
        }

        private static void OpenScene() => EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);

        private static void AssertPresent<T>() where T : Component
        {
            Assert.IsNotNull(
                Object.FindAnyObjectByType<T>(FindObjectsInactive.Include),
                $"{typeof(T).Name} is not in {ScenePath} — add it in the Editor and save the scene");
        }

        /// <summary>
        /// Every Redline component in the scene, including inactive ones — the
        /// result screen starts disabled, and a wire missing there is exactly as
        /// fatal as one on an active object.
        /// </summary>
        private static IEnumerable<Component> Components() =>
            Object.FindObjectsByType<MonoBehaviour>(FindObjectsInactive.Include, FindObjectsSortMode.None)
                .Where(m => m != null && m.GetType().Namespace != null
                            && m.GetType().Namespace.StartsWith("Redline.Client"))
                .Cast<Component>();
    }
}
