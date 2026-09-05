/**
 * A deliberately small JSON reader, ported verbatim from
 * Backend/sim-core-cs/Runtime/Config/Json.cs.
 *
 * The config file is the one document the client and the server must agree on
 * completely -- it decides multipliers, speeds, and therefore scores. If the
 * client parsed it one way and the server another, the two could disagree about
 * a value and the disagreement would surface as a score mismatch on a real
 * player's money.
 *
 * Compiling the same parser into both places removes that class of bug the same
 * way compiling the same simulation into both places does. This TypeScript copy
 * is that parser again, kept behaviourally identical to the C# one on purpose:
 * `JSON.parse` would turn "0.55" into a float and `* 1000` could then land on
 * 549 or 551 on some input, which is exactly what this avoids.
 *
 * Numbers never become float. They are parsed as an integer part plus literal
 * fraction digits, and converted on demand to the caller's fixed-point scale by
 * string manipulation. "0.55" at scale 1000 is exactly 550.
 *
 * Supported: objects, arrays, strings, integers, decimals, true/false/null.
 * Not supported: exponent notation, \u escapes beyond the basic set. Both are
 * rejected loudly rather than silently misread.
 */

export class JsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonError';
  }
}

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'bool' | 'null';

export class JsonValue {
  readonly kind: JsonKind;

  private readonly obj: Map<string, JsonValue> | null;
  private readonly arr: JsonValue[] | null;
  private readonly str: string | null;
  private readonly boolean: boolean;

  // Number storage: sign, digits before the point, digits after it.
  private readonly negative: boolean;
  private readonly integerPart: bigint;
  private readonly fractionDigits: string;

  private constructor(
    kind: JsonKind,
    obj: Map<string, JsonValue> | null,
    arr: JsonValue[] | null,
    str: string | null,
    boolean: boolean,
    negative: boolean,
    integerPart: bigint,
    fractionDigits: string,
  ) {
    this.kind = kind;
    this.obj = obj;
    this.arr = arr;
    this.str = str;
    this.boolean = boolean;
    this.negative = negative;
    this.integerPart = integerPart;
    this.fractionDigits = fractionDigits;
  }

  private static newObject(o: Map<string, JsonValue>): JsonValue {
    return new JsonValue('object', o, null, null, false, false, 0n, '');
  }
  private static newArray(a: JsonValue[]): JsonValue {
    return new JsonValue('array', null, a, null, false, false, 0n, '');
  }
  private static newString(s: string): JsonValue {
    return new JsonValue('string', null, null, s, false, false, 0n, '');
  }
  private static newBool(b: boolean): JsonValue {
    return new JsonValue('bool', null, null, null, b, false, 0n, '');
  }
  private static newNull(): JsonValue {
    return new JsonValue('null', null, null, null, false, false, 0n, '');
  }
  private static newNumber(negative: boolean, integerPart: bigint, fractionDigits: string): JsonValue {
    return new JsonValue('number', null, null, null, false, negative, integerPart, fractionDigits);
  }

  // ---- access ------------------------------------------------------------

  has(key: string): boolean {
    return this.obj !== null && this.obj.has(key);
  }

  /** Child by key. Throws with the key name rather than returning undefined. */
  get(key: string): JsonValue {
    if (this.obj === null) {
      throw new JsonError(`expected an object when reading '${key}', found ${this.kind}`);
    }
    const v = this.obj.get(key);
    if (v === undefined) throw new JsonError(`missing required key '${key}'`);
    return v;
  }

  at(index: number): JsonValue {
    if (this.arr === null) throw new JsonError(`expected an array, found ${this.kind}`);
    if (index < 0 || index >= this.arr.length) {
      throw new JsonError(`index ${index} out of range (count ${this.arr.length})`);
    }
    return this.arr[index]!;
  }

  get count(): number {
    return this.arr?.length ?? this.obj?.size ?? 0;
  }

  asString(): string {
    if (this.kind !== 'string') throw new JsonError(`expected string, found ${this.kind}`);
    return this.str!;
  }

  asBool(): boolean {
    if (this.kind !== 'bool') throw new JsonError(`expected bool, found ${this.kind}`);
    return this.boolean;
  }

  /** Whole number. Rejects a value with a non-zero fraction rather than truncating it. */
  asLong(): bigint {
    if (this.kind !== 'number') throw new JsonError(`expected number, found ${this.kind}`);
    for (const c of this.fractionDigits) {
      if (c !== '0') throw new JsonError('expected a whole number, found a fractional value');
    }
    return this.negative ? -this.integerPart : this.integerPart;
  }

  asInt(): number {
    const v = this.asLong();
    if (v < -2147483648n || v > 2147483647n) throw new JsonError(`value ${v} does not fit in an int`);
    return Number(v);
  }

  /**
   * The value in fixed-point, multiplied by `scale`. Scale must be a power of
   * ten. "0.55" at scale 1000 gives exactly 550. Extra digits beyond the scale
   * are truncated, never rounded, so the result is a pure function of the text.
   */
  asScaled(scale: number): number {
    if (this.kind !== 'number') throw new JsonError(`expected number, found ${this.kind}`);
    if (scale <= 0) throw new RangeError(`scale must be positive, got ${scale}`);

    let digits = 0;
    for (let s = scale; s > 1; s = Math.floor(s / 10)) {
      if (s % 10 !== 0) throw new Error('scale must be a power of ten');
      digits++;
    }

    const frac =
      this.fractionDigits.length >= digits
        ? this.fractionDigits.substring(0, digits)
        : this.fractionDigits.padEnd(digits, '0');

    const fracValue = frac.length === 0 ? 0n : BigInt(frac);
    const magnitude = this.integerPart * BigInt(scale) + fracValue;
    const signed = this.negative ? -magnitude : magnitude;
    return Number(signed);
  }

  /** Enumerates array elements. */
  items(): JsonValue[] {
    if (this.arr === null) throw new JsonError(`expected array, found ${this.kind}`);
    return this.arr;
  }

  // ---- parsing ---------------------------------------------------------

  static parse(text: string): JsonValue {
    const p = new Parser(text);
    const v = p.parseValue();
    p.skipWhitespace();
    if (!p.atEnd()) throw new JsonError(`trailing content at offset ${p.pos}`);
    return v;
  }

  /** @internal used by the parser */
  static _mkObject = JsonValue.newObject;
  static _mkArray = JsonValue.newArray;
  static _mkString = JsonValue.newString;
  static _mkBool = JsonValue.newBool;
  static _mkNull = JsonValue.newNull;
  static _mkNumber = JsonValue.newNumber;
}

class Parser {
  pos = 0;
  constructor(private readonly s: string) {}

  atEnd(): boolean {
    return this.pos >= this.s.length;
  }

  parseValue(): JsonValue {
    this.skipWhitespace();
    if (this.atEnd()) throw new JsonError('unexpected end of input');

    const c = this.s[this.pos]!;
    switch (c) {
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case '"':
        return JsonValue._mkString(this.parseString());
      case 't':
        this.expect('true');
        return JsonValue._mkBool(true);
      case 'f':
        this.expect('false');
        return JsonValue._mkBool(false);
      case 'n':
        this.expect('null');
        return JsonValue._mkNull();
      default:
        return this.parseNumber();
    }
  }

  private parseObject(): JsonValue {
    const map = new Map<string, JsonValue>();
    this.pos++; // '{'
    this.skipWhitespace();
    if (!this.atEnd() && this.s[this.pos] === '}') {
      this.pos++;
      return JsonValue._mkObject(map);
    }

    for (;;) {
      this.skipWhitespace();
      const key = this.parseString();
      this.skipWhitespace();
      if (this.atEnd() || this.s[this.pos] !== ':') {
        throw new JsonError(`expected ':' after key '${key}'`);
      }
      this.pos++;
      map.set(key, this.parseValue());
      this.skipWhitespace();
      if (this.atEnd()) throw new JsonError('unexpected end of object');
      if (this.s[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.s[this.pos] === '}') {
        this.pos++;
        return JsonValue._mkObject(map);
      }
      throw new JsonError(`expected ',' or '}' at offset ${this.pos}`);
    }
  }

  private parseArray(): JsonValue {
    const list: JsonValue[] = [];
    this.pos++; // '['
    this.skipWhitespace();
    if (!this.atEnd() && this.s[this.pos] === ']') {
      this.pos++;
      return JsonValue._mkArray(list);
    }

    for (;;) {
      list.push(this.parseValue());
      this.skipWhitespace();
      if (this.atEnd()) throw new JsonError('unexpected end of array');
      if (this.s[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.s[this.pos] === ']') {
        this.pos++;
        return JsonValue._mkArray(list);
      }
      throw new JsonError(`expected ',' or ']' at offset ${this.pos}`);
    }
  }

  private parseString(): string {
    if (this.atEnd() || this.s[this.pos] !== '"') {
      throw new JsonError(`expected '"' at offset ${this.pos}`);
    }
    this.pos++;
    let out = '';
    for (;;) {
      if (this.atEnd()) throw new JsonError('unterminated string');
      const c = this.s[this.pos++]!;
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      if (this.atEnd()) throw new JsonError('unterminated escape');
      const e = this.s[this.pos++]!;
      switch (e) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          if (this.pos + 4 > this.s.length) throw new JsonError('truncated \\u escape');
          const hex = this.s.substring(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JsonError('malformed \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        default:
          throw new JsonError(`unsupported escape '\\${e}'`);
      }
    }
  }

  private parseNumber(): JsonValue {
    const start = this.pos;
    let negative = false;
    if (!this.atEnd() && (this.s[this.pos] === '-' || this.s[this.pos] === '+')) {
      negative = this.s[this.pos] === '-';
      this.pos++;
    }

    const intStart = this.pos;
    while (!this.atEnd() && this.s[this.pos]! >= '0' && this.s[this.pos]! <= '9') this.pos++;
    if (this.pos === intStart) throw new JsonError(`malformed number at offset ${start}`);
    const intDigits = this.s.substring(intStart, this.pos);

    let fracDigits = '';
    if (!this.atEnd() && this.s[this.pos] === '.') {
      this.pos++;
      const fracStart = this.pos;
      while (!this.atEnd() && this.s[this.pos]! >= '0' && this.s[this.pos]! <= '9') this.pos++;
      if (this.pos === fracStart) throw new JsonError(`malformed fraction at offset ${fracStart}`);
      fracDigits = this.s.substring(fracStart, this.pos);
    }

    if (!this.atEnd() && (this.s[this.pos] === 'e' || this.s[this.pos] === 'E')) {
      throw new JsonError('exponent notation is not supported in config; write the number out in full');
    }

    return JsonValue._mkNumber(negative, BigInt(intDigits), fracDigits);
  }

  expect(literal: string): void {
    if (this.s.substr(this.pos, literal.length) !== literal) {
      throw new JsonError(`expected '${literal}' at offset ${this.pos}`);
    }
    this.pos += literal.length;
  }

  skipWhitespace(): void {
    while (!this.atEnd()) {
      const c = this.s[this.pos]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.pos++;
      else break;
    }
  }
}
