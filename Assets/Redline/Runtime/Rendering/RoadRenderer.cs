using Redline.Core;
using TMPro;
using UnityEngine;

namespace Redline.Client.Rendering
{
    /// <summary>
    /// Builds the coloured lane floor from config, frames the camera, and hands
    /// the divider dashes to <see cref="RoadTreadmill"/>.
    ///
    /// The floor is one long quad per lane, built once from <c>config.Lanes</c>
    /// and never recycled — pooling a permanent singleton buys nothing. Anything
    /// that repeats down the road goes through the treadmill's pools (ADR 0015).
    /// The world moves and the car stays roughly fixed on screen so the player
    /// can read the road ahead at speed.
    /// </summary>
    [RequireComponent(typeof(RunHost))]
    public sealed class RoadRenderer : MonoBehaviour
    {
        [Tooltip("Shared lit material for the lane strips, kerbs and ground. Per-lane colour is a property block, not a material.")]
        [SerializeField] private Material laneMaterial;

        [Tooltip("Prototype for one divider dash. Cloned into the treadmill's pool; never authored per lane.")]
        [SerializeField] private GameObject dividerPrototype;

        [Tooltip("The run camera this frames from config. Drag the RunCamera here.")]
        [SerializeField] private Camera runCamera;

        [Tooltip("How far ahead of the car the road is drawn, in metres.")]
        [SerializeField] private float roadLength = 120f;

        private RunHost _host;
        private LaneGeometry _geometry;
        private RoadTreadmill _treadmill;

        /// <summary>
        /// The scene-authored camera pose, captured before anything here touches
        /// it. The framing of record; <see cref="FrameCamera"/> only widens off
        /// it when config carries more lanes than the scene was framed for.
        /// </summary>
        private Vector3 _authoredCameraPosition;
        private Quaternion _authoredCameraRotation;

        /// <summary>Lane count the authored camera pose frames comfortably. Above this, FrameCamera pulls back.</summary>
        private const int AuthoredForLaneCount = 4;

        /// <summary>The 5x lane's animated material + its texture. Owned here; freed in OnDestroy.</summary>
        private Material _rainbow;

        /// <summary>The sandy roadside ground: material + texture owned here, transform scrolled in LateUpdate.</summary>
        private Material _desert;
        private Transform _ground;

        /// <summary>
        /// The repeating "CASHOUT" legend down the cashout lane: real TextMeshPro
        /// words laid flat on the tarmac, parented to a scroller slid by
        /// <c>State.Position</c> in LateUpdate. One shared outline material,
        /// owned here and freed in OnDestroy.
        /// </summary>
        private Transform _cashoutScroller;
        private Material _cashoutFontMat;

        /// <summary>The vivid green line down the inner edge of the cashout lane. Owned here; freed in OnDestroy.</summary>
        private Material _cashoutEdge;

        /// <summary>Metres between one "CASHOUT" and the next. The scroller slides by up to this and wraps.</summary>
        private const float CashoutWordPeriod = 13f;

        /// <summary>Metres per game unit. Position is a game-unit integer; the world is metres.</summary>
        private const float MetresPerUnit = 0.5f;

        /// <summary>
        /// World length of one <see cref="DesertTexture"/> tile. The ground quad
        /// slides by up to this and wraps invisibly (seamless texture); the slide
        /// is recomputed from <c>State.Position</c> every frame, so it stays
        /// locked to the dashes with no float drift.
        /// </summary>
        private const float GroundTilePeriod = 16f;

        private void Awake()
        {
            _host = GetComponent<RunHost>();
            _geometry = new LaneGeometry(_host.Config);

            if (runCamera != null)
            {
                _authoredCameraPosition = runCamera.transform.localPosition;
                _authoredCameraRotation = runCamera.transform.localRotation;
            }

            Build();
        }

        /// <summary>
        /// Built once at Awake from parsed config — no prefab literals, so the
        /// lane count changes with config and a restart, no scene edit.
        /// </summary>
        private void Build()
        {
            var floor = new GameObject("RoadFloor").transform;
            floor.SetParent(transform, worldPositionStays: false);

            // A wide ground plane running well past the outer lanes and the drawn
            // road length, so panning to follow the car only reveals more desert,
            // never the clear colour. Scrolled in LateUpdate with the road.
            var ground = NewCube("Ground", laneMaterial);
            _ground = ground.transform;
            _ground.SetParent(floor, worldPositionStays: false);
            // Runs far past the drawn road length so it fills to the horizon
            // rather than ending in a hard black band at the top of the frame.
            _ground.localScale = new Vector3((_geometry.RoadWidth + 80f) * 2, 0.08f, roadLength * 5f);
            _ground.localPosition = new Vector3(0f, -0.12f, roadLength * 2f);
            ground.GetComponent<Renderer>().sharedMaterial = DesertMaterial();

            // The most dangerous scoring lane (highest multiplier) gets the
            // flowing-rainbow treatment; the rest keep the flat danger colour.
            // Derived from config, never a literal index (review test #16).
            int rainbowLane = LaneGeometry.HottestScoringLane(_host.Config);

            // One strip per lane, positioned from config — this loop is why the
            // lane count is a config value and not a scene literal (review #16).
            for (int lane = 0; lane < _geometry.LaneCount; lane++)
            {
                var strip = NewCube($"Lane{lane}", laneMaterial);
                strip.transform.SetParent(floor, worldPositionStays: false);
                strip.transform.localScale = new Vector3(LaneGeometry.LaneWidth, 0.1f, roadLength * 2f);
                strip.transform.localPosition = new Vector3(_geometry.CentreOf(lane), -0.05f, roadLength * 0.5f);

                var renderer = strip.GetComponent<Renderer>();

                if (lane == rainbowLane)
                {
                    renderer.sharedMaterial = RainbowMaterial();
                    strip.AddComponent<ScrollingLane>().Bind(_rainbow);
                    continue;
                }

                // One property block per lane at build time, not per frame:
                // assigning renderer.material would clone the material and leak
                // one instance per lane per run.
                var block = new MaterialPropertyBlock();

                if (_host.Config.Lanes[lane].Role == LaneRole.Cashout)
                {
                    // Plain tarmac, signalled by the painted legend and a green
                    // line down its inner edge. Nothing hardcodes this index.
                    block.SetColor(LaneGeometry.ColorProperty, LaneGeometry.RoadNeutral);
                    renderer.SetPropertyBlock(block);
                    BuildCashoutLegend(floor, lane);
                    BuildCashoutEdge(floor, lane);
                    continue;
                }

                block.SetColor(LaneGeometry.ColorProperty, LaneGeometry.DangerColour(_host.Config, lane));
                renderer.SetPropertyBlock(block);
            }

            // A low lit kerb down each outer edge so the road reads as bounded,
            // not bleeding into the sand. Inner face on the road edge, which is
            // config-derived — a five-lane road gets kerbs right with no edit.
            const float kerbWidth = 0.32f;
            const float kerbHeight = 0.34f;
            float edge = _geometry.RoadWidth * 0.5f;
            foreach (float side in new[] { -1f, 1f })
            {
                var kerb = NewCube(side < 0f ? "KerbLeft" : "KerbRight", laneMaterial);
                kerb.transform.SetParent(floor, worldPositionStays: false);
                kerb.transform.localScale = new Vector3(kerbWidth, kerbHeight, roadLength * 2f);
                kerb.transform.localPosition = new Vector3(
                    side * (edge + kerbWidth * 0.5f), kerbHeight * 0.5f - 0.05f, roadLength * 0.5f);

                var kb = new MaterialPropertyBlock();
                kb.SetColor(LaneGeometry.ColorProperty, new Color(0.56f, 0.55f, 0.52f));
                kerb.GetComponent<Renderer>().SetPropertyBlock(kb);
            }

            // No tile pool: the coloured floor above is the surface. Pass a
            // prototype here if a real tiled road mesh is added later.
            _treadmill = new RoadTreadmill(
                _geometry, _host.Config, transform,
                dashPrototype: dividerPrototype, tilePrototype: null,
                drawAheadMetres: roadLength, metresPerUnit: MetresPerUnit);

            FrameCamera();
        }

        /// <summary>
        /// A collider-less cube, built without <see cref="GameObject.CreatePrimitive"/>
        /// (which forces a <see cref="BoxCollider"/> and pulls the Physics module
        /// into a stripped IL2CPP build). Collision is the deterministic core's,
        /// never Unity physics. The floor is the last cube standing (ADR 0015).
        /// </summary>
        private static GameObject NewCube(string name, Material material)
        {
            var go = new GameObject(name, typeof(MeshFilter), typeof(MeshRenderer));
            go.GetComponent<MeshFilter>().sharedMesh = Resources.GetBuiltinResource<Mesh>("Cube.fbx");
            go.GetComponent<MeshRenderer>().sharedMaterial = material;
            return go;
        }

        /// <summary>
        /// The flowing-rainbow material for the 5x lane — <see cref="RainbowTexture"/>
        /// tiled along the strip, scrolled by <see cref="ScrollingLane"/>. Unlit
        /// to stay vivid; falls back to the lane shader if Unlit was stripped.
        /// </summary>
        private Material RainbowMaterial()
        {
            if (_rainbow != null) return _rainbow;

            var shader = Shader.Find("Unlit/Texture");
            if (shader == null) shader = laneMaterial.shader;

            _rainbow = new Material(shader)
            {
                name = "RainbowLane",
                mainTexture = RainbowTexture.Create(),
                mainTextureScale = new Vector2(1f, 6f),
            };
            return _rainbow;
        }

        /// <summary>
        /// The dust-and-stone material for the roadside ground. Lit (legacy
        /// Diffuse) so sun, ambient and haze reach it — that is most of what
        /// makes the desert read as hot open country. Tiled to
        /// <see cref="GroundTilePeriod"/> metres; falls back to unlit then the
        /// lane shader if the legacy shader was stripped.
        /// </summary>
        private Material DesertMaterial()
        {
            if (_desert != null) return _desert;

            var shader = Shader.Find("Legacy Shaders/Diffuse")
                         ?? Shader.Find("Unlit/Texture")
                         ?? laneMaterial.shader;

            float width = _geometry.RoadWidth + 80f;
            _desert = new Material(shader)
            {
                name = "DesertGround",
                mainTexture = DesertTexture.Create(),
                mainTextureScale = new Vector2(width / GroundTilePeriod, roadLength * 5f / GroundTilePeriod),
            };
            return _desert;
        }

        /// <summary>
        /// The repeating "CASHOUT" legend down the cashout lane — bold TMP text
        /// laid flat on the tarmac, a fixed ring of words one
        /// <see cref="CashoutWordPeriod"/> apart on a scroller slid by
        /// <c>State.Position</c>; the modulo wrap keeps a fixed object count.
        /// </summary>
        private void BuildCashoutLegend(Transform floor, int lane)
        {
            _cashoutScroller = new GameObject("CashoutLegend").transform;
            _cashoutScroller.SetParent(floor, worldPositionStays: false);

            var font = TMP_Settings.defaultFontAsset;

            // One shared bold, dark-edged material for every word so the green
            // reads on grey tarmac — instanced once, not cloned per TextMeshPro.
            _cashoutFontMat = new Material(font.material) { name = "CashoutLegendFont" };
            _cashoutFontMat.EnableKeyword(ShaderUtilities.Keyword_Outline);
            _cashoutFontMat.SetFloat(ShaderUtilities.ID_FaceDilate, 0.18f);
            _cashoutFontMat.SetFloat(ShaderUtilities.ID_OutlineWidth, 0.20f);
            _cashoutFontMat.SetColor(ShaderUtilities.ID_OutlineColor, new Color(0.04f, 0.20f, 0.08f));

            var green = new Color(0.16f, 0.82f, 0.24f);
            float x = _geometry.CentreOf(lane);
            int count = Mathf.CeilToInt(roadLength / CashoutWordPeriod) + 3;

            for (int i = 0; i < count; i++)
            {
                var go = new GameObject("CashoutWord");
                go.transform.SetParent(_cashoutScroller, worldPositionStays: false);

                var tmp = go.AddComponent<TextMeshPro>();
                tmp.font = font;
                tmp.fontSharedMaterial = _cashoutFontMat;
                tmp.text = "CASHOUT";
                tmp.fontStyle = FontStyles.Bold;
                tmp.fontSize = 10f;
                tmp.color = green;
                tmp.alignment = TextAlignmentOptions.Center;
                tmp.enableWordWrapping = false;
                tmp.rectTransform.sizeDelta = new Vector2(16f, 4f);
                tmp.raycastTarget = false;

                // Flat on the road, turned so the legend reads with the view
                // rotated sideways (letter tops toward the road interior).
                go.transform.localRotation = Quaternion.Euler(90f, 270f, 0f);
                go.transform.localPosition = new Vector3(x, 0.02f, i * CashoutWordPeriod - CashoutWordPeriod);
            }
        }

        /// <summary>
        /// The green line just inside the cashout lane — the border the player
        /// crosses to reach the safe lane. Inset from the divider so the white
        /// dashes stay visible; the side is derived from which way the lane
        /// faces the road centre, so it is right for a cashout lane at either end.
        /// </summary>
        private void BuildCashoutEdge(Transform floor, int lane)
        {
            const float edgeWidth = 0.16f;
            const float edgeHeight = 0.08f;
            // Clear of the divider dash (RoadTreadmill draws it 0.08 wide at the
            // boundary): far enough in that the white line reads unbroken beside
            // the green one.
            const float insetFromDivider = 0.22f;

            float centre = _geometry.CentreOf(lane);
            float inwardSign = centre >= 0f ? -1f : 1f;                            // toward x = 0 = toward the inner boundary
            float dividerX = centre + inwardSign * (LaneGeometry.LaneWidth * 0.5f);
            float edgeX = dividerX - inwardSign * insetFromDivider;               // step back into the lane, off the dash

            var edge = NewCube("CashoutEdge", laneMaterial);
            edge.transform.SetParent(floor, worldPositionStays: false);
            edge.transform.localScale = new Vector3(edgeWidth, edgeHeight, roadLength * 2f);
            // Top face just proud of the road surface (the lane strips' top sits at y = 0).
            edge.transform.localPosition = new Vector3(edgeX, edgeHeight * 0.5f - 0.035f, roadLength * 0.5f);
            edge.GetComponent<Renderer>().sharedMaterial = CashoutEdgeMaterial();
        }

        /// <summary>
        /// A vivid unlit green for the cashout boundary line — unlit so the
        /// directional light does not warm it down; falls back through legacy lit
        /// shaders if Unlit/Color was stripped.
        /// </summary>
        private Material CashoutEdgeMaterial()
        {
            if (_cashoutEdge != null) return _cashoutEdge;

            var shader = Shader.Find("Unlit/Color")
                         ?? Shader.Find("Legacy Shaders/Diffuse")
                         ?? laneMaterial.shader;

            _cashoutEdge = new Material(shader)
            {
                name = "CashoutEdge",
                color = new Color(0.13f, 0.85f, 0.20f),
            };
            return _cashoutEdge;
        }

        /// <summary>
        /// Applies the framing: the scene-authored pose verbatim for the lane
        /// count it was tuned for; more lanes pull the camera back proportionally
        /// (keeping pitch), so review test #16 (4→5 live) still fits on screen.
        /// </summary>
        private void FrameCamera()
        {
            if (runCamera == null) return;

            runCamera.transform.localRotation = _authoredCameraRotation;

            float widthRatio = _geometry.RoadWidth / (AuthoredForLaneCount * LaneGeometry.LaneWidth);
            runCamera.transform.localPosition = widthRatio > 1f
                ? _authoredCameraPosition * widthRatio
                : _authoredCameraPosition;
        }

        private void LateUpdate()
        {
            var state = _host.State;
            if (state == null) return;

            // Scrolls by simulation position, not elapsed time: a dropped frame
            // moves the world exactly as far as the simulated ticks.
            _treadmill.Scroll(state.Position);

            // Ground and cashout legend scroll off the same metres value, so
            // stones and lettering drift at exactly the dash rate; each wraps
            // within one seamless texture tile.
            float metres = (float)state.Position / _host.Config.PositionScale * MetresPerUnit;

            if (_ground != null)
            {
                var p = _ground.localPosition;
                p.z = roadLength * 2f - Mathf.Repeat(metres, GroundTilePeriod);
                _ground.localPosition = p;
            }

            if (_cashoutScroller != null)
                _cashoutScroller.localPosition = new Vector3(0f, 0f, -Mathf.Repeat(metres, CashoutWordPeriod));
        }

        private void OnDestroy()
        {
            DestroyMaterialAndTexture(_rainbow);
            DestroyMaterialAndTexture(_desert);
            if (_cashoutFontMat != null) Destroy(_cashoutFontMat);
            if (_cashoutEdge != null) Destroy(_cashoutEdge);
        }

        private static void DestroyMaterialAndTexture(Material material)
        {
            if (material == null) return;
            if (material.mainTexture != null) Destroy(material.mainTexture);
            Destroy(material);
        }
    }
}
