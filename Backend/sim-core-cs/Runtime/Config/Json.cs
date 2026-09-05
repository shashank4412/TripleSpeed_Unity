using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Redline.Core
{
    /// <summary>
    /// A deliberately small JSON reader, written rather than referenced.
    ///
    /// The config file is the one document the client and the server must agree
    /// on completely — it decides multipliers, speeds, and therefore scores. If
    /// Unity parsed it with JsonUtility and the server parsed it with
    /// System.Text.Json, then the two could disagree about a value and the
    /// disagreement would surface as a score mismatch on a real player's money.
    ///
    /// Compiling the same parser into both places removes that class of bug the
    /// same way compiling the same simulation into both places does.
    ///
    /// Numbers never become float or double. They are parsed as an integer part
    /// plus literal fraction digits, and converted on demand to the caller's
    /// fixed-point scale by string manipulation. "0.55" at scale 1000 is exactly
    /// 550, on every platform, with no rounding mode involved.
    ///
    /// Supported: objects, arrays, strings, integers, decimals, true/false/null.
    /// Not supported: exponent notation, \u escapes beyond the basic set.
    /// Both are rejected loudly rather than silently misread.
    /// </summary>
    public sealed class JsonValue
    {
        public enum Kind { Object, Array, String, Number, Bool, Null }

        public Kind ValueKind { get; }

        private readonly Dictionary<string, JsonValue>? _object;
        private readonly List<JsonValue>? _array;
        private readonly string? _string;
        private readonly bool _bool;

        // Number storage: sign, digits before the point, digits after it.
        private readonly bool _negative;
        private readonly long _integerPart;
        private readonly string _fractionDigits;

        private JsonValue(Kind kind, Dictionary<string, JsonValue>? obj, List<JsonValue>? arr,
                          string? str, bool b, bool negative, long integerPart, string fractionDigits)
        {
            ValueKind = kind;
            _object = obj;
            _array = arr;
            _string = str;
            _bool = b;
            _negative = negative;
            _integerPart = integerPart;
            _fractionDigits = fractionDigits;
        }

        internal static JsonValue NewObject(Dictionary<string, JsonValue> o) =>
            new JsonValue(Kind.Object, o, null, null, false, false, 0, string.Empty);

        internal static JsonValue NewArray(List<JsonValue> a) =>
            new JsonValue(Kind.Array, null, a, null, false, false, 0, string.Empty);

        internal static JsonValue NewString(string s) =>
            new JsonValue(Kind.String, null, null, s, false, false, 0, string.Empty);

        internal static JsonValue NewBool(bool b) =>
            new JsonValue(Kind.Bool, null, null, null, b, false, 0, string.Empty);

        internal static JsonValue NewNull() =>
            new JsonValue(Kind.Null, null, null, null, false, false, 0, string.Empty);

        internal static JsonValue NewNumber(bool negative, long integerPart, string fractionDigits) =>
            new JsonValue(Kind.Number, null, null, null, false, negative, integerPart, fractionDigits);

        // ---- access ---------------------------------------------------------

        public bool Has(string key) => _object != null && _object.ContainsKey(key);

        /// <summary>Child by key. Throws with the key name rather than returning null.</summary>
        public JsonValue this[string key]
        {
            get
            {
                if (_object == null)
                    throw new JsonException($"expected an object when reading '{key}', found {ValueKind}");
                if (!_object.TryGetValue(key, out var v))
                    throw new JsonException($"missing required key '{key}'");
                return v;
            }
        }

        public JsonValue this[int index]
        {
            get
            {
                if (_array == null)
                    throw new JsonException($"expected an array, found {ValueKind}");
                if (index < 0 || index >= _array.Count)
                    throw new JsonException($"index {index} out of range (count {_array.Count})");
                return _array[index];
            }
        }

        public int Count => _array?.Count ?? _object?.Count ?? 0;

        public string AsString() => ValueKind == Kind.String
            ? _string!
            : throw new JsonException($"expected string, found {ValueKind}");

        public bool AsBool() => ValueKind == Kind.Bool
            ? _bool
            : throw new JsonException($"expected bool, found {ValueKind}");

        /// <summary>Whole number. Rejects a value with a non-zero fraction rather than truncating it.</summary>
        public long AsLong()
        {
            if (ValueKind != Kind.Number) throw new JsonException($"expected number, found {ValueKind}");
            foreach (char c in _fractionDigits)
                if (c != '0')
                    throw new JsonException($"expected a whole number, found a fractional value");
            return _negative ? -_integerPart : _integerPart;
        }

        public int AsInt()
        {
            long v = AsLong();
            if (v < int.MinValue || v > int.MaxValue) throw new JsonException($"value {v} does not fit in an int");
            return (int)v;
        }

        /// <summary>
        /// The value in fixed-point, multiplied by <paramref name="scale"/>.
        /// Scale must be a power of ten. "0.55" at scale 1000 gives exactly 550.
        /// Extra digits beyond the scale are truncated, never rounded, so the
        /// result is a pure function of the text.
        /// </summary>
        public long AsScaled(int scale)
        {
            if (ValueKind != Kind.Number) throw new JsonException($"expected number, found {ValueKind}");
            if (scale <= 0) throw new ArgumentOutOfRangeException(nameof(scale));

            int digits = 0;
            for (int s = scale; s > 1; s /= 10)
            {
                if (s % 10 != 0) throw new ArgumentException("scale must be a power of ten", nameof(scale));
                digits++;
            }

            string frac = _fractionDigits.Length >= digits
                ? _fractionDigits.Substring(0, digits)
                : _fractionDigits.PadRight(digits, '0');

            long fracValue = frac.Length == 0 ? 0L : long.Parse(frac, CultureInfo.InvariantCulture);
            long magnitude = checked(_integerPart * scale + fracValue);
            return _negative ? -magnitude : magnitude;
        }

        /// <summary>Enumerates array elements.</summary>
        public IEnumerable<JsonValue> Items()
        {
            if (_array == null) throw new JsonException($"expected array, found {ValueKind}");
            return _array;
        }

        // ---- parsing --------------------------------------------------------

        public static JsonValue Parse(string text)
        {
            int i = 0;
            var v = ParseValue(text, ref i);
            SkipWhitespace(text, ref i);
            if (i != text.Length) throw new JsonException($"trailing content at offset {i}");
            return v;
        }

        private static JsonValue ParseValue(string s, ref int i)
        {
            SkipWhitespace(s, ref i);
            if (i >= s.Length) throw new JsonException("unexpected end of input");

            char c = s[i];
            switch (c)
            {
                case '{': return ParseObject(s, ref i);
                case '[': return ParseArray(s, ref i);
                case '"': return NewString(ParseString(s, ref i));
                case 't': Expect(s, ref i, "true"); return NewBool(true);
                case 'f': Expect(s, ref i, "false"); return NewBool(false);
                case 'n': Expect(s, ref i, "null"); return NewNull();
                default: return ParseNumber(s, ref i);
            }
        }

        private static JsonValue ParseObject(string s, ref int i)
        {
            var map = new Dictionary<string, JsonValue>(StringComparer.Ordinal);
            i++; // '{'
            SkipWhitespace(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return NewObject(map); }

            while (true)
            {
                SkipWhitespace(s, ref i);
                string key = ParseString(s, ref i);
                SkipWhitespace(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new JsonException($"expected ':' after key '{key}'");
                i++;
                map[key] = ParseValue(s, ref i);
                SkipWhitespace(s, ref i);
                if (i >= s.Length) throw new JsonException("unexpected end of object");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return NewObject(map); }
                throw new JsonException($"expected ',' or '}}' at offset {i}");
            }
        }

        private static JsonValue ParseArray(string s, ref int i)
        {
            var list = new List<JsonValue>();
            i++; // '['
            SkipWhitespace(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return NewArray(list); }

            while (true)
            {
                list.Add(ParseValue(s, ref i));
                SkipWhitespace(s, ref i);
                if (i >= s.Length) throw new JsonException("unexpected end of array");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return NewArray(list); }
                throw new JsonException($"expected ',' or ']' at offset {i}");
            }
        }

        private static string ParseString(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') throw new JsonException($"expected '\"' at offset {i}");
            i++;
            var sb = new StringBuilder();
            while (true)
            {
                if (i >= s.Length) throw new JsonException("unterminated string");
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }

                if (i >= s.Length) throw new JsonException("unterminated escape");
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new JsonException("truncated \\u escape");
                        sb.Append((char)ushort.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new JsonException($"unsupported escape '\\{e}'");
                }
            }
        }

        private static JsonValue ParseNumber(string s, ref int i)
        {
            int start = i;
            bool negative = false;
            if (i < s.Length && (s[i] == '-' || s[i] == '+'))
            {
                negative = s[i] == '-';
                i++;
            }

            int intStart = i;
            while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
            if (i == intStart) throw new JsonException($"malformed number at offset {start}");
            string intDigits = s.Substring(intStart, i - intStart);

            string fracDigits = string.Empty;
            if (i < s.Length && s[i] == '.')
            {
                i++;
                int fracStart = i;
                while (i < s.Length && s[i] >= '0' && s[i] <= '9') i++;
                if (i == fracStart) throw new JsonException($"malformed fraction at offset {fracStart}");
                fracDigits = s.Substring(fracStart, i - fracStart);
            }

            if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
                throw new JsonException(
                    "exponent notation is not supported in config; write the number out in full");

            return NewNumber(negative, long.Parse(intDigits, CultureInfo.InvariantCulture), fracDigits);
        }

        private static void Expect(string s, ref int i, string literal)
        {
            if (i + literal.Length > s.Length || string.CompareOrdinal(s, i, literal, 0, literal.Length) != 0)
                throw new JsonException($"expected '{literal}' at offset {i}");
            i += literal.Length;
        }

        private static void SkipWhitespace(string s, ref int i)
        {
            while (i < s.Length)
            {
                char c = s[i];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
                else break;
            }
        }
    }

    public sealed class JsonException : Exception
    {
        public JsonException(string message) : base(message) { }
    }
}
