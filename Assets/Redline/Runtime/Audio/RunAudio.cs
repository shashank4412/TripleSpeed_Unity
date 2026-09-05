using Redline.Core;
using UnityEngine;

namespace Redline.Client.Audio
{
    /// <summary>
    /// Sound and haptics for a run.
    ///
    /// **It observes.** It reads <see cref="Simulation.State"/> and never writes
    /// to it, and nothing here is on the path that decides a score. The
    /// escalating tone is the point: the brief says a tone tied to the
    /// multiplier is worth more to the greed loop than a texture, because it
    /// tells the player how exposed they are without asking them to look away
    /// from the road.
    ///
    /// Clips are generated at Awake rather than shipped as assets — there are
    /// no audio files in this repo, and a sine is exactly as good for a tension
    /// tone as a recording would be. Generating them also means the pitch
    /// mapping is code a reviewer can read instead of a property on an asset.
    /// </summary>
    [RequireComponent(typeof(RunHost))]
    public sealed class RunAudio : MonoBehaviour
    {
        public const string AudioEnabledKey = "redline.audio";
        public const string HapticsEnabledKey = "redline.haptics";

        [Tooltip("Looping source for the escalating tension tone.")]
        [SerializeField] private AudioSource toneSource;

        [Tooltip("One-shot source for the crash / bank stings.")]
        [SerializeField] private AudioSource oneShotSource;

        [Tooltip("Hz at the lowest multiplier. The floor of the tension range.")]
        [SerializeField] private float baseFrequency = 180f;

        [Tooltip("How much the tone rises per multiplier step, as a pitch ratio.")]
        [SerializeField] private float pitchPerStep = 0.22f;

        private RunHost _host;
        private AudioClip _tone;
        private AudioClip _crash;
        private AudioClip _bank;

        private int _lastMultiplier = -1;
        private int _lastLane = -1;

        /// <summary>Both persist, so a player who turns sound off finds it off tomorrow.</summary>
        public static bool AudioEnabled
        {
            get => PlayerPrefs.GetInt(AudioEnabledKey, 1) == 1;
            set { PlayerPrefs.SetInt(AudioEnabledKey, value ? 1 : 0); PlayerPrefs.Save(); }
        }

        public static bool HapticsEnabled
        {
            get => PlayerPrefs.GetInt(HapticsEnabledKey, 1) == 1;
            set { PlayerPrefs.SetInt(HapticsEnabledKey, value ? 1 : 0); PlayerPrefs.Save(); }
        }

        private void Awake()
        {
            _host = GetComponent<RunHost>();
            _host.RunEnded += OnRunEnded;

            _tone = Tone("tone", 440f, 1.0f, decay: 0f);
            _crash = Tone("crash", 90f, 0.5f, decay: 6f);
            _bank = Tone("bank", 660f, 0.5f, decay: 3f);

            if (toneSource != null)
            {
                toneSource.clip = _tone;
                toneSource.loop = true;
                toneSource.volume = 0.18f;
            }
        }

        private void OnDestroy()
        {
            if (_host != null) _host.RunEnded -= OnRunEnded;
        }

        private void LateUpdate()
        {
            var state = _host.State;
            if (state == null || toneSource == null) return;

            if (!AudioEnabled)
            {
                if (toneSource.isPlaying) toneSource.Stop();
                return;
            }

            if (!toneSource.isPlaying) toneSource.Play();

            // The same effective multiplier the HUD shows and the scoring uses,
            // so the tone drops the instant a lane change puts the player on the
            // lower of the two — the ear learns the rule before the player is
            // told it.
            int multiplier = Simulation.EffectiveMultiplier(_host.Config, state);

            if (multiplier != _lastMultiplier)
            {
                _lastMultiplier = multiplier;
                toneSource.pitch = 1f + (multiplier - 1) * pitchPerStep;
            }

            // A lane change is worth feeling. Fired on the lane the simulation
            // reports, so it lands when the car actually arrives.
            if (state.Lane != _lastLane)
            {
                if (_lastLane >= 0) Vibrate();
                _lastLane = state.Lane;
            }
        }

        private void OnRunEnded(RunResult result)
        {
            if (toneSource != null) toneSource.Stop();

            bool banked = result.Outcome == RunOutcome.Banked;

            if (AudioEnabled && oneShotSource != null)
                oneShotSource.PlayOneShot(banked ? _bank : _crash);

            Vibrate();
        }

        /// <summary>
        /// Handheld.Vibrate is all the haptics Unity offers without a package.
        /// It is one buzz with no intensity control, so a crash and a lane
        /// change feel the same — a real limitation, recorded rather than
        /// papered over.
        /// </summary>
        private static void Vibrate()
        {
            if (!HapticsEnabled) return;

#if UNITY_ANDROID || UNITY_IOS
            Handheld.Vibrate();
#endif
        }

        /// <summary>
        /// A sine, generated once. `decay` above zero gives a percussive
        /// envelope for the one-shots; zero leaves a flat tone to loop.
        /// </summary>
        private static AudioClip Tone(string name, float frequency, float seconds, float decay)
        {
            const int SampleRate = 44100;
            int samples = Mathf.CeilToInt(SampleRate * seconds);
            var data = new float[samples];

            for (int i = 0; i < samples; i++)
            {
                float t = i / (float)SampleRate;
                float envelope = decay > 0f ? Mathf.Exp(-decay * t) : 1f;

                data[i] = Mathf.Sin(2f * Mathf.PI * frequency * t) * envelope;
            }

            var clip = AudioClip.Create(name, samples, 1, SampleRate, stream: false);
            clip.SetData(data, 0);

            return clip;
        }
    }
}
