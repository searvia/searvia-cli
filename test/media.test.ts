import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readIpaInfo } from '../src/apple/build.js';
import { detectDisplayType } from '../src/apple/display-types.js';
import { imageInfo } from '../src/media/image.js';
import { parsePlist } from '../src/media/plist.js';
import { png, tempDir, zip } from './helpers.js';

/** Builds a tiny binary plist: { CFBundleVersion: "42", Flag: true, N: 7 }. */
function binaryPlist(): Buffer {
  const objects: Buffer[] = [];
  const ascii = (text: string) => Buffer.concat([Buffer.from(text.length < 15 ? [0x50 | text.length] : [0x5f, 0x10, text.length]), Buffer.from(text, 'ascii')]);
  // 0 dict, 1..3 keys, 4..6 values
  objects.push(Buffer.from([0xd3, 1, 2, 3, 4, 5, 6]));
  objects.push(ascii('CFBundleVersion'), ascii('Flag'), ascii('N'));
  objects.push(ascii('42'), Buffer.from([0x09]), Buffer.from([0x10, 7]));
  const header = Buffer.from('bplist00', 'ascii');
  const offsets: number[] = [];
  let position = header.length;
  for (const object of objects) {
    offsets.push(position);
    position += object.length;
  }
  const table = Buffer.from(offsets);
  const trailer = Buffer.alloc(32);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(position), 24);
  return Buffer.concat([header, ...objects, table, trailer]);
}

describe('images', () => {
  it('reads PNG size and alpha', () => {
    expect(imageInfo(png(1320, 2868))).toEqual({ format: 'png', width: 1320, height: 2868, alpha: false });
    expect(imageInfo(png(10, 10, 6)).alpha).toBe(true);
  });
  it('reads JPEG size from SOF0', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0a, 0x00, 0x05, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageInfo(jpeg)).toMatchObject({ format: 'jpeg', width: 0x0500, height: 0x0a00 });
  });
  it('maps pixel sizes to App Store display types', () => {
    expect(detectDisplayType('01.png', 1320, 2868).type).toBe('APP_IPHONE_67');
    expect(detectDisplayType('01.png', 2868, 1320).type).toBe('APP_IPHONE_67');
    expect(detectDisplayType('01.png', 1242, 2688).type).toBe('APP_IPHONE_65');
    expect(detectDisplayType('01.png', 2048, 2732).type).toBe('APP_IPAD_PRO_3GEN_129');
    expect(detectDisplayType('iPad Pro (12.9-inch) (2nd generation)-01.png', 2048, 2732).type).toBe('APP_IPAD_PRO_129');
    expect(detectDisplayType('imessage/01.png', 1290, 2796).type).toBe('IMESSAGE_APP_IPHONE_67');
    expect(detectDisplayType('APP_IPHONE_61/a.png', 1179, 2556).type).toBe('APP_IPHONE_61');
    expect(detectDisplayType('APP_IPHONE_61/a.png', 1320, 2868).error).toMatch(/not a valid size/);
    expect(detectDisplayType('x.png', 1000, 1000).error).toMatch(/matches no/);
  });
});

describe('plist and ipa', () => {
  it('parses binary plists', () => {
    expect(parsePlist(binaryPlist())).toEqual({ CFBundleVersion: '42', Flag: true, N: 7 });
  });
  it('parses XML plists', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>2.4.0</string><key>Arr</key><array><string>a &amp; b</string><integer>3</integer></array><key>ITSAppUsesNonExemptEncryption</key><false/></dict></plist>`;
    expect(parsePlist(Buffer.from(xml))).toEqual({ CFBundleShortVersionString: '2.4.0', Arr: ['a & b', 3], ITSAppUsesNonExemptEncryption: false });
  });
  it('reads Info.plist from an .ipa', () => {
    const dir = tempDir();
    const plist =
      '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.app</string><key>CFBundleShortVersionString</key><string>3.1</string><key>CFBundleVersion</key><string>77</string></dict></plist>';
    writeFileSync(
      join(dir, 'App.ipa'),
      zip({ 'Payload/App.app/Info.plist': plist, 'Payload/App.app/App': 'binary', 'Payload/App.app/Frameworks/X.framework/Info.plist': '<plist><dict/></plist>' }),
    );
    expect(readIpaInfo(join(dir, 'App.ipa'))).toEqual({ bundleId: 'com.example.app', shortVersion: '3.1', buildNumber: '77', usesNonExemptEncryption: undefined });
  });
});
