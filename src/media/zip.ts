import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

function read(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/**
 * Minimal ZIP reader (central directory + stored/deflate, ZIP64 aware) to pull Info.plist out of an .ipa without
 * unpacking hundreds of megabytes.
 */
export class ZipFile {
  private constructor(
    private readonly fd: number,
    readonly entries: Entry[],
  ) {}

  static open(path: string): ZipFile {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const tailLength = Math.min(size, 65_557);
      const tail = read(fd, size - tailLength, tailLength);
      const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      if (eocd === -1) throw new Error('Not a ZIP archive.');
      let count = tail.readUInt16LE(eocd + 10);
      let cdSize = tail.readUInt32LE(eocd + 12);
      let cdOffset = tail.readUInt32LE(eocd + 16);

      if (cdOffset === 0xffffffff || count === 0xffff) {
        const locator = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
        if (locator === -1) throw new Error('Broken ZIP64 archive.');
        const zip64Offset = Number(tail.readBigUInt64LE(locator + 8));
        const record = read(fd, zip64Offset, 56);
        count = Number(record.readBigUInt64LE(32));
        cdSize = Number(record.readBigUInt64LE(40));
        cdOffset = Number(record.readBigUInt64LE(48));
      }

      const cd = read(fd, cdOffset, cdSize);
      const entries: Entry[] = [];
      let offset = 0;
      for (let index = 0; index < count && offset + 46 <= cd.length; index++) {
        if (cd.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
        const method = cd.readUInt16LE(offset + 10);
        let compressedSize = cd.readUInt32LE(offset + 20);
        let size = cd.readUInt32LE(offset + 24);
        const nameLength = cd.readUInt16LE(offset + 28);
        const extraLength = cd.readUInt16LE(offset + 30);
        const commentLength = cd.readUInt16LE(offset + 32);
        let localHeaderOffset = cd.readUInt32LE(offset + 42);
        const name = cd.toString('utf8', offset + 46, offset + 46 + nameLength);
        let extra = offset + 46 + nameLength;
        const extraEnd = extra + extraLength;
        while (extra + 4 <= extraEnd) {
          const id = cd.readUInt16LE(extra);
          const length = cd.readUInt16LE(extra + 2);
          if (id === 0x0001) {
            let field = extra + 4;
            if (size === 0xffffffff) {
              size = Number(cd.readBigUInt64LE(field));
              field += 8;
            }
            if (compressedSize === 0xffffffff) {
              compressedSize = Number(cd.readBigUInt64LE(field));
              field += 8;
            }
            if (localHeaderOffset === 0xffffffff) localHeaderOffset = Number(cd.readBigUInt64LE(field));
          }
          extra += 4 + length;
        }
        entries.push({ name, method, compressedSize, size, localHeaderOffset });
        offset = extraEnd + commentLength;
      }
      return new ZipFile(fd, entries);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  find(pattern: RegExp): Entry | undefined {
    return this.entries.find((entry) => pattern.test(entry.name));
  }

  read(entry: Entry): Buffer {
    const header = read(this.fd, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('Corrupt ZIP local header.');
    const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const data = read(this.fd, start, entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRawSync(data);
    throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
  }

  close(): void {
    closeSync(this.fd);
  }
}
