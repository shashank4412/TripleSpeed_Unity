using System;

namespace Redline.Client.Net
{
    // The REST wire shapes that used to live here were superseded by the structs
    // alongside IRedlineBackend when the client was repointed at Firebase.
    // InputEventDto stays: one recorded swipe on the wire, referenced from
    // SubmitRunEvidence, and needs JsonUtility's [Serializable].

    [Serializable]
    public sealed class InputEventDto
    {
        public int tick;
        public string dir;
    }
}
