/** Property list parser: XML and binary (bplist00) formats, enough to read an app's Info.plist. */

export type PlistValue = string | number | bigint | boolean | null | Date | Buffer | PlistValue[] | { [key: string]: PlistValue };

export function parsePlist(data: Buffer): PlistValue {
  if (data.toString('ascii', 0, 8) === 'bplist00') return parseBinary(data);
  return parseXml(data.toString('utf8'));
}

function parseBinary(data: Buffer): PlistValue {
  const trailer = data.subarray(data.length - 32);
  const offsetSize = trailer[6] as number;
  const refSize = trailer[7] as number;
  const objectCount = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const tableOffset = Number(trailer.readBigUInt64BE(24));
  const readInt = (offset: number, size: number): number => {
    let value = 0;
    for (let index = 0; index < size; index++) value = value * 256 + (data[offset + index] as number);
    return value;
  };
  const offsets = Array.from({ length: objectCount }, (_, index) => readInt(tableOffset + index * offsetSize, offsetSize));

  const object = (ref: number, depth = 0): PlistValue => {
    if (depth > 64) throw new Error('plist nesting too deep');
    const offset = offsets[ref] as number;
    const marker = data[offset] as number;
    const type = marker >> 4;
    const info = marker & 0x0f;
    const length = (): [number, number] => {
      if (info !== 0x0f) return [info, offset + 1];
      const sizeMarker = data[offset + 1] as number;
      const size = 1 << (sizeMarker & 0x0f);
      return [readInt(offset + 2, size), offset + 2 + size];
    };
    switch (type) {
      case 0x0:
        return info === 0x08 ? false : info === 0x09 ? true : null;
      case 0x1: {
        const size = 1 << info;
        return size === 8 ? data.readBigInt64BE(offset + 1) : readInt(offset + 1, size);
      }
      case 0x2:
        return info === 2 ? data.readFloatBE(offset + 1) : data.readDoubleBE(offset + 1);
      case 0x3:
        return new Date((978307200 + data.readDoubleBE(offset + 1)) * 1000);
      case 0x4: {
        const [count, start] = length();
        return Buffer.from(data.subarray(start, start + count));
      }
      case 0x5: {
        const [count, start] = length();
        return data.toString('latin1', start, start + count);
      }
      case 0x6: {
        const [count, start] = length();
        const chars = Buffer.from(data.subarray(start, start + count * 2));
        chars.swap16();
        return chars.toString('utf16le');
      }
      case 0x8:
        return readInt(offset + 1, info + 1);
      case 0xa: {
        const [count, start] = length();
        return Array.from({ length: count }, (_, index) => object(readInt(start + index * refSize, refSize), depth + 1));
      }
      case 0xd: {
        const [count, start] = length();
        const out: Record<string, PlistValue> = {};
        for (let index = 0; index < count; index++) {
          const key = object(readInt(start + index * refSize, refSize), depth + 1);
          out[String(key)] = object(readInt(start + (count + index) * refSize, refSize), depth + 1);
        }
        return out;
      }
      default:
        throw new Error(`Unsupported binary plist object type 0x${type.toString(16)}`);
    }
  };

  return object(top);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity] ?? match;
  });
}

function parseXml(xml: string): PlistValue {
  const tokens = [...xml.replace(/<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)(\w+)[^>]*?(\/?)>([^<]*)/g)];
  let index = 0;
  const skipPlist = () => {
    while (index < tokens.length && (tokens[index] as RegExpMatchArray)[2] === 'plist') index++;
  };
  const value = (): PlistValue => {
    skipPlist();
    const token = tokens[index++];
    if (!token) throw new Error('Unexpected end of plist');
    const [, closing, tag, selfClosing, text = ''] = token;
    if (closing) throw new Error(`Unexpected </${tag}>`);
    const end = () => {
      index++;
    };
    switch (tag) {
      case 'true':
        if (!selfClosing) end();
        return true;
      case 'false':
        if (!selfClosing) end();
        return false;
      case 'string':
        if (selfClosing) return '';
        end();
        return decode(text);
      case 'integer':
        end();
        return Number(text.trim());
      case 'real':
        end();
        return Number(text.trim());
      case 'date':
        end();
        return new Date(text.trim());
      case 'data':
        end();
        return Buffer.from(text.replace(/\s+/g, ''), 'base64');
      case 'array': {
        const list: PlistValue[] = [];
        if (selfClosing) return list;
        while (tokens[index] && !((tokens[index] as RegExpMatchArray)[1] && (tokens[index] as RegExpMatchArray)[2] === 'array')) list.push(value());
        end();
        return list;
      }
      case 'dict': {
        const map: Record<string, PlistValue> = {};
        if (selfClosing) return map;
        while (tokens[index] && !((tokens[index] as RegExpMatchArray)[1] && (tokens[index] as RegExpMatchArray)[2] === 'dict')) {
          const keyToken = tokens[index++] as RegExpMatchArray;
          if (keyToken[2] !== 'key') throw new Error(`Expected <key>, got <${keyToken[2]}>`);
          index++;
          map[decode(keyToken[4] ?? '')] = value();
        }
        end();
        return map;
      }
      default:
        throw new Error(`Unsupported plist tag <${tag}>`);
    }
  };
  return value();
}
