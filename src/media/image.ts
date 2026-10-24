import { closeSync, openSync, readSync } from 'node:fs';

export interface ImageInfo {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** PNG colour types 4 and 6 carry alpha; Apple rejects screenshots with alpha channels. */
  alpha: boolean;
}

/** Reads width/height from PNG (IHDR) or JPEG (SOFn) headers without decoding the image. */
export function imageInfo(data: Buffer): ImageInfo {
  if (data.length >= 26 && data.readUInt32BE(0) === 0x89504e47 && data.toString('ascii', 12, 16) === 'IHDR') {
    const colorType = data[25] as number;
    return { format: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20), alpha: colorType === 4 || colorType === 6 };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1] as number;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = data.readUInt16BE(offset + 2);
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7), alpha: false };
      }
      offset += 2 + length;
    }
  }
  throw new Error('Not a PNG or JPEG image.');
}

/** Reads only the header bytes of an image file. */
export function imageFileInfo(path: string): ImageInfo {
  const fd = openSync(path, 'r');
  try {
    let size = 64 * 1024;
    for (;;) {
      const buffer = Buffer.alloc(size);
      const read = readSync(fd, buffer, 0, size, 0);
      try {
        return imageInfo(buffer.subarray(0, read));
      } catch (error) {
        if (read < size || size >= 4 * 1024 * 1024) throw error;
        size *= 4;
      }
    }
  } finally {
    closeSync(fd);
  }
}

export function contentType(path: string): string {
  return /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
}
