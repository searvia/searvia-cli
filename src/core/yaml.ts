/**
 * A small YAML subset parser for workflow files, so the CLI keeps zero runtime dependencies. Supports block mappings
 * and sequences, nested structures, plain/single/double-quoted scalars, numbers, booleans, null, `#` comments, flow
 * lists/maps (`[a, b]`, `{a: 1}`) and literal/folded block scalars (`|`, `>`). Anchors, tags and multi-document
 * streams are not supported (use JSON for anything exotic: every JSON file is valid input too).
 */

interface Line {
  number: number;
  raw: string;
  indent: number;
  text: string;
}

export class YamlError extends Error {
  constructor(message: string, line?: number) {
    super(line ? `YAML line ${line}: ${message}` : `YAML: ${message}`);
    this.name = 'YamlError';
  }
}

export function parseYaml(source: string): unknown {
  const trimmed = source.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through: flow-style YAML
    }
  }
  const lines: Line[] = source.split(/\r?\n/).map((raw, index) => {
    if (/^\t/.test(raw)) throw new YamlError('tabs are not allowed for indentation', index + 1);
    const indent = raw.length - raw.trimStart().length;
    return { number: index + 1, raw, indent, text: stripComment(raw.trim()) };
  });
  const parser = new Parser(lines);
  const first = parser.peek();
  if (!first) return null;
  if (first.text === '---') parser.next();
  const start = parser.peek();
  if (!start) return null;
  const value = parser.block(start.indent);
  const rest = parser.peek();
  if (rest && rest.text !== '...') throw new YamlError(`unexpected content "${rest.text}"`, rest.number);
  return value;
}

class Parser {
  private index = 0;

  constructor(private readonly lines: Line[]) {}

  peek(): Line | undefined {
    while (this.index < this.lines.length && (this.lines[this.index] as Line).text === '') this.index++;
    return this.lines[this.index];
  }

  next(): Line {
    const line = this.peek();
    if (!line) throw new YamlError('unexpected end of file');
    this.index++;
    return line;
  }

  block(indent: number): unknown {
    const line = this.peek();
    if (!line) return null;
    return isSequenceItem(line.text) ? this.sequence(indent) : this.mapping(indent);
  }

  sequence(indent: number): unknown[] {
    const items: unknown[] = [];
    for (let line = this.peek(); line && line.indent === indent && isSequenceItem(line.text); line = this.peek()) {
      this.index++;
      const content = line.text === '-' ? '' : line.text.slice(2).trimStart();
      if (content === '') {
        const nested = this.peek();
        items.push(nested && nested.indent > indent ? this.block(nested.indent) : null);
      } else if (isSequenceItem(content) || findColon(content) !== -1) {
        // "- key: value" starts a mapping whose keys line up with "key".
        const offset = line.raw.indexOf(content, line.indent + 1);
        this.lines.splice(this.index, 0, { number: line.number, raw: line.raw, indent: offset, text: content });
        items.push(this.block(offset));
      } else {
        items.push(scalar(content, line.number));
      }
    }
    return items;
  }

  mapping(indent: number): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    for (let line = this.peek(); line && line.indent === indent && !isSequenceItem(line.text); line = this.peek()) {
      this.index++;
      const colon = findColon(line.text);
      if (colon === -1) throw new YamlError(`expected "key: value", got "${line.text}"`, line.number);
      const key = unquote(line.text.slice(0, colon).trim(), line.number);
      const rest = line.text.slice(colon + 1).trim();
      if (rest === '') {
        const nested = this.peek();
        if (nested && nested.indent > indent) map[key] = this.block(nested.indent);
        else if (nested && nested.indent === indent && isSequenceItem(nested.text)) map[key] = this.sequence(indent);
        else map[key] = null;
      } else if (/^[|>][+-]?$/.test(rest)) {
        map[key] = this.blockScalar(indent, rest);
      } else {
        map[key] = scalar(rest, line.number);
      }
    }
    const stray = this.peek();
    if (stray && stray.indent > indent) throw new YamlError(`bad indentation before "${stray.text}"`, stray.number);
    return map;
  }

  blockScalar(parentIndent: number, header: string): string {
    const collected: string[] = [];
    let indent = -1;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index] as Line;
      if (line.raw.trim() === '') {
        collected.push('');
        this.index++;
        continue;
      }
      if (line.indent <= parentIndent) break;
      if (indent === -1) indent = line.indent;
      if (line.indent < indent) break;
      collected.push(line.raw.slice(indent));
      this.index++;
    }
    while (collected.length && collected[collected.length - 1] === '') collected.pop();
    const text = header.startsWith('>') ? fold(collected) : collected.join('\n');
    return header.endsWith('-') ? text : `${text}\n`;
  }
}

function fold(lines: string[]): string {
  let out = '';
  lines.forEach((line, index) => {
    if (index === 0) out = line;
    else if (line === '' || lines[index - 1] === '') out += `\n${line}`;
    else out += ` ${line}`;
  });
  return out;
}

function isSequenceItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

/** Index of the key/value colon outside quotes and flow brackets ("a: b", "a:"), or -1. */
function findColon(text: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
    else if (char === ':' && depth === 0 && (index === text.length - 1 || text[index + 1] === ' ')) return index;
  }
  return -1;
}

function stripComment(text: string): string {
  if (text.startsWith('#')) return '';
  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#' && /\s/.test(text[index - 1] ?? '')) return text.slice(0, index).trimEnd();
  }
  return text;
}

function unquote(text: string, line: number): string {
  if (text.startsWith('"') || text.startsWith("'")) {
    const value = scalar(text, line);
    return String(value);
  }
  return text;
}

function scalar(text: string, line: number): unknown {
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new YamlError('unterminated double-quoted string', line);
    try {
      return JSON.parse(text);
    } catch {
      throw new YamlError(`bad escape in ${text}`, line);
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new YamlError('unterminated single-quoted string', line);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('[') || text.startsWith('{')) return flow(text, line);
  if (/^(null|~|Null|NULL)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?(\d+|\d*\.\d+)([eE][-+]?\d+)?$/.test(text) && !/^0\d/.test(text)) return Number(text);
  return text;
}

function flow(text: string, line: number): unknown {
  let index = 0;
  const skip = () => {
    while (/\s/.test(text[index] ?? '')) index++;
  };
  const value = (): unknown => {
    skip();
    const char = text[index];
    if (char === '[') {
      index++;
      const list: unknown[] = [];
      skip();
      if (text[index] === ']') {
        index++;
        return list;
      }
      for (;;) {
        list.push(value());
        skip();
        if (text[index] === ',') index++;
        else if (text[index] === ']') {
          index++;
          return list;
        } else throw new YamlError(`bad flow list ${text}`, line);
      }
    }
    if (char === '{') {
      index++;
      const map: Record<string, unknown> = {};
      skip();
      if (text[index] === '}') {
        index++;
        return map;
      }
      for (;;) {
        skip();
        const start = index;
        while (index < text.length && text[index] !== ':') index++;
        const key = unquote(text.slice(start, index).trim(), line);
        index++;
        map[key] = value();
        skip();
        if (text[index] === ',') index++;
        else if (text[index] === '}') {
          index++;
          return map;
        } else throw new YamlError(`bad flow map ${text}`, line);
      }
    }
    const start = index;
    if (char === '"' || char === "'") {
      index++;
      while (index < text.length && text[index] !== char) index += text[index] === '\\' && char === '"' ? 2 : 1;
      index++;
    } else {
      while (index < text.length && !/[,\]}]/.test(text[index] as string)) index++;
    }
    return scalar(text.slice(start, index).trim(), line);
  };
  const result = value();
  skip();
  if (index < text.length) throw new YamlError(`unexpected "${text.slice(index)}"`, line);
  return result;
}
