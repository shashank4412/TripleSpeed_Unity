// Small self-contained post stack for the built-in pipeline: a bright-pass
// bloom plus a finishing grade (contrast, saturation, warm/cool split, vignette).
// Driven by Redline.Client.Rendering.CinematicPostFx. No package dependency —
// the project cannot pull com.unity.postprocessing without a signed-in Hub.
Shader "Hidden/Redline/CinematicPostFx"
{
    Properties
    {
        _MainTex ("Source", 2D) = "white" {}
    }

    CGINCLUDE
    #include "UnityCG.cginc"

    sampler2D _MainTex;
    float4 _MainTex_TexelSize;

    sampler2D _BloomTex;
    float4 _BloomTex_TexelSize;

    float  _Threshold;   // bright-pass cutoff
    float  _Knee;        // soft shoulder around the threshold
    float2 _BlurDir;     // (texelX, 0) or (0, texelY) * radius
    float  _BloomIntensity;

    float  _Contrast;
    float  _Saturation;
    float  _Vignette;    // 0 = off, 1 = strong
    float3 _Warm;        // multiplier pushed into highlights
    float3 _Cool;        // multiplier pushed into shadows

    struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

    v2f vert (appdata_img v)
    {
        v2f o;
        o.pos = UnityObjectToClipPos(v.vertex);
        o.uv = v.texcoord;
        return o;
    }

    // ---- prefilter: keep only what is brighter than the threshold ----
    fixed4 fragPrefilter (v2f i) : SV_Target
    {
        fixed3 c = tex2D(_MainTex, i.uv).rgb;
        float br = max(c.r, max(c.g, c.b));
        float soft = clamp(br - _Threshold + _Knee, 0.0, 2.0 * _Knee);
        soft = soft * soft / (4.0 * _Knee + 1e-4);
        float contrib = max(soft, br - _Threshold) / max(br, 1e-4);
        return fixed4(c * contrib, 1.0);
    }

    // ---- separable blur, 9 taps ----
    fixed4 fragBlur (v2f i) : SV_Target
    {
        float2 d = _BlurDir;
        fixed3 sum = tex2D(_MainTex, i.uv).rgb * 0.227027;
        sum += tex2D(_MainTex, i.uv + d * 1.3846).rgb * 0.316216;
        sum += tex2D(_MainTex, i.uv - d * 1.3846).rgb * 0.316216;
        sum += tex2D(_MainTex, i.uv + d * 3.2308).rgb * 0.070270;
        sum += tex2D(_MainTex, i.uv - d * 3.2308).rgb * 0.070270;
        return fixed4(sum, 1.0);
    }

    // ---- composite + grade ----
    fixed4 fragComposite (v2f i) : SV_Target
    {
        fixed3 c = tex2D(_MainTex, i.uv).rgb;
        fixed3 bloom = tex2D(_BloomTex, i.uv).rgb;
        c += bloom * _BloomIntensity;

        // split tone: warm the highlights, cool the shadows
        float luma = dot(c, float3(0.299, 0.587, 0.114));
        c *= lerp(_Cool, _Warm, saturate(luma * 1.4));

        // contrast around mid grey, then saturation
        c = (c - 0.5) * _Contrast + 0.5;
        float g = dot(c, float3(0.299, 0.587, 0.114));
        c = lerp(float3(g, g, g), c, _Saturation);

        // Gentle highlight rolloff so the bright rainbow lane and the hazy
        // desert do not clip to flat white.
        c = c / (1.0 + max(c - 0.75, 0.0) * 0.85);

        // vignette
        float2 q = i.uv - 0.5;
        float v = 1.0 - dot(q, q) * _Vignette * 2.2;
        c *= saturate(v);

        return fixed4(max(c, 0.0), 1.0);
    }
    ENDCG

    SubShader
    {
        Cull Off ZWrite Off ZTest Always

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragPrefilter
            ENDCG
        }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragBlur
            ENDCG
        }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragComposite
            ENDCG
        }
    }
    Fallback Off
}
