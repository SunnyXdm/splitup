/**
 * Best-effort parse of a JSON document that is still streaming in. Returns
 * everything that is already complete and leaves out anything that isn't:
 * a string or number at the very end could still grow ("Chaa" → "Chaayos",
 * "66" → "660"), so it is dropped rather than shown. Objects and arrays that
 * aren't closed yet are returned with their finished members.
 */
export function parsePartialJson(text: string): unknown {
  let pos = 0;
  const INCOMPLETE = Symbol('incomplete');
  type Out = unknown | typeof INCOMPLETE;

  const ws = () => {
    while (pos < text.length && /\s/.test(text[pos]!)) pos += 1;
  };

  const parseString = (): string | typeof INCOMPLETE => {
    // Assumes text[pos] === '"'.
    let out = '';
    pos += 1;
    while (pos < text.length) {
      const ch = text[pos]!;
      if (ch === '"') {
        pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = text[pos + 1];
        if (next === undefined) return INCOMPLETE;
        if (next === 'u') {
          const hex = text.slice(pos + 2, pos + 6);
          if (hex.length < 4) return INCOMPLETE;
          out += String.fromCharCode(Number.parseInt(hex, 16));
          pos += 6;
          continue;
        }
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
        out += map[next] ?? next;
        pos += 2;
        continue;
      }
      out += ch;
      pos += 1;
    }
    return INCOMPLETE;
  };

  const parseValue = (): Out => {
    ws();
    if (pos >= text.length) return INCOMPLETE;
    const ch = text[pos]!;
    if (ch === '{') return parseObject();
    if (ch === '[') return parseArray();
    if (ch === '"') return parseString();
    const lit = /^(?:true|false|null)/.exec(text.slice(pos));
    if (lit) {
      pos += lit[0].length;
      return lit[0] === 'null' ? null : lit[0] === 'true';
    }
    if (/^(?:t|tr|tru|f|fa|fal|fals|n|nu|nul)$/.test(text.slice(pos))) return INCOMPLETE;
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos));
    if (num) {
      pos += num[0].length;
      // A number that runs to the end of the buffer may not be finished.
      if (pos >= text.length) return INCOMPLETE;
      return Number(num[0]);
    }
    if (/^-?\d*\.?$/.test(text.slice(pos))) return INCOMPLETE;
    throw new SyntaxError(`unexpected ${JSON.stringify(ch)} at ${pos}`);
  };

  const parseObject = (): Out => {
    pos += 1;
    const obj: Record<string, unknown> = {};
    for (;;) {
      ws();
      if (pos >= text.length) return obj;
      if (text[pos] === '}') {
        pos += 1;
        return obj;
      }
      if (text[pos] === ',') {
        pos += 1;
        continue;
      }
      if (text[pos] !== '"') throw new SyntaxError(`expected key at ${pos}`);
      const key = parseString();
      if (key === INCOMPLETE) return obj;
      ws();
      if (pos >= text.length) return obj;
      if (text[pos] !== ':') throw new SyntaxError(`expected ':' at ${pos}`);
      pos += 1;
      const value = parseValue();
      if (value === INCOMPLETE) {
        // Keep a partially streamed container (its finished members count).
        return obj;
      }
      obj[key] = value;
    }
  };

  const parseArray = (): Out => {
    pos += 1;
    const arr: unknown[] = [];
    for (;;) {
      ws();
      if (pos >= text.length) return arr;
      if (text[pos] === ']') {
        pos += 1;
        return arr;
      }
      if (text[pos] === ',') {
        pos += 1;
        continue;
      }
      const start = pos;
      const value = parseValue();
      if (value === INCOMPLETE) return arr;
      // An element that is itself an unclosed container is still streaming:
      // mark it so callers can tell a finished line item from a growing one.
      if (pos >= text.length && (text[start] === '{' || text[start] === '[')) {
        if (value !== null && typeof value === 'object') {
          Object.defineProperty(value, PARTIAL, { value: true, enumerable: false });
        }
      }
      arr.push(value);
    }
  };

  const out = parseValue();
  return out === INCOMPLETE ? undefined : out;
}

/** Non-enumerable marker on an array element whose closing bracket hasn't arrived. */
export const PARTIAL = Symbol.for('splitup.partial');

export function isPartial(v: unknown): boolean {
  return v !== null && typeof v === 'object' && (v as Record<symbol, unknown>)[PARTIAL] === true;
}
