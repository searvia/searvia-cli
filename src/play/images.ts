import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CliError } from '../core/errors.js';
import { httpRequest } from '../core/http.js';
import type { Output } from '../core/output.js';
import { sha256 } from '../core/util.js';
import { contentType, imageFileInfo } from '../media/image.js';
import { type PlayImageType, readPlayImages, SINGLE_IMAGE_TYPES } from '../metadata/play.js';
import type { GooglePlay } from './client.js';

/** edits.images.upload accepts up to 15 MB per image (discovery document maxSize). */
const MAX_BYTES = 15 * 1024 * 1024;
/** Play Console: up to 8 screenshots per device type. */
const MAX_SCREENSHOTS = 8;

/**
 * Graphic asset rules from Play Console Help (https://support.google.com/googleplay/android-developer/answer/9866151):
 * icon 512×512 (≤ 1024 KB), feature graphic 1024×500, TV banner 1280×720, phone screenshots 320–3840 px with the long
 * side at most twice the short side, tablet screenshots 1080–7680 px, Wear OS screenshots square and ≥ 384 px.
 */
export function validatePlayImage(type: PlayImageType, width: number, height: number, size: number): string | undefined {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (size > MAX_BYTES) return `is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is 15 MB.`;
  switch (type) {
    case 'icon':
      if (width !== 512 || height !== 512) return `is ${width}×${height}; the icon must be 512×512.`;
      if (size > 1024 * 1024) return 'is over 1024 KB; the icon limit is 1024 KB.';
      return undefined;
    case 'featureGraphic':
      return width === 1024 && height === 500 ? undefined : `is ${width}×${height}; the feature graphic must be 1024×500.`;
    case 'tvBanner':
      return width === 1280 && height === 720 ? undefined : `is ${width}×${height}; the TV banner must be 1280×720.`;
    case 'phoneScreenshots':
    case 'tvScreenshots':
      if (short < 320 || long > 3840) return `is ${width}×${height}; sides must be between 320 and 3840 px.`;
      return long > short * 2 ? `is ${width}×${height}; the long side can be at most twice the short side.` : undefined;
    case 'sevenInchScreenshots':
    case 'tenInchScreenshots':
      if (short < 1080 || long > 7680) return `is ${width}×${height}; tablet screenshots need sides between 1080 and 7680 px.`;
      return long > short * 2 ? `is ${width}×${height}; the long side can be at most twice the short side.` : undefined;
    case 'wearScreenshots':
      return width === height && width >= 384 ? undefined : `is ${width}×${height}; Wear OS screenshots must be square, at least 384×384.`;
  }
}

export interface LocalPlayImage {
  path: string;
  sha256: string;
  contentType: string;
}

export function scanPlayImages(dir: string, locales: string[]): { images: Record<string, Partial<Record<PlayImageType, LocalPlayImage[]>>>; errors: string[] } {
  const images: Record<string, Partial<Record<PlayImageType, LocalPlayImage[]>>> = {};
  const errors: string[] = [];
  for (const locale of locales) {
    const found = readPlayImages(dir, locale);
    const out: Partial<Record<PlayImageType, LocalPlayImage[]>> = {};
    for (const [type, paths] of Object.entries(found) as Array<[PlayImageType, string[]]>) {
      if (!SINGLE_IMAGE_TYPES.includes(type) && paths.length > MAX_SCREENSHOTS) errors.push(`${locale} ${type}: ${paths.length} images; Google Play allows ${MAX_SCREENSHOTS}.`);
      out[type] = paths.map((path) => {
        try {
          const info = imageFileInfo(path);
          const problem = validatePlayImage(type, info.width, info.height, statSync(path).size);
          if (problem) errors.push(`${locale}/${type}/${basename(path)} ${problem}`);
          if (info.alpha && type !== 'icon') errors.push(`${locale}/${type}/${basename(path)} has an alpha channel; use JPEG or 24-bit PNG.`);
        } catch (error) {
          errors.push(`${locale}/${type}/${basename(path)}: ${(error as Error).message}`);
        }
        return { path, sha256: sha256(readFileSync(path)), contentType: contentType(path) };
      });
    }
    if (Object.keys(out).length) images[locale] = out;
  }
  return { images, errors };
}

export interface ImagePlan {
  locale: string;
  type: PlayImageType;
  action: 'unchanged' | 'replace';
  local: number;
  remote: number;
}

/** Replaces each image type whose files differ (by SHA-256, in order) from Google Play. Runs inside an open edit. */
export async function syncPlayImages(
  play: GooglePlay,
  editId: string,
  images: Record<string, Partial<Record<PlayImageType, LocalPlayImage[]>>>,
  options: { apply: boolean; out?: Output },
): Promise<ImagePlan[]> {
  const plans: ImagePlan[] = [];
  for (const [locale, types] of Object.entries(images)) {
    for (const [type, local] of Object.entries(types) as Array<[PlayImageType, LocalPlayImage[]]>) {
      const remote = await play.images(editId, locale, type);
      const same = remote.length === local.length && remote.every((image, index) => image.sha256 === local[index]?.sha256);
      plans.push({ locale, type, action: same ? 'unchanged' : 'replace', local: local.length, remote: remote.length });
      if (same || !options.apply) continue;
      options.out?.step(`${locale} ${type}: uploading ${local.length} image${local.length === 1 ? '' : 's'}`);
      if (remote.length) await play.deleteAllImages(editId, locale, type);
      for (const image of local) await play.uploadImage(editId, locale, type, readFileSync(image.path), image.contentType);
    }
  }
  return plans;
}

export async function downloadPlayImages(
  play: GooglePlay,
  editId: string,
  locales: string[],
  types: PlayImageType[],
  dir: string,
  write: (path: string, data: Buffer) => void,
  out?: Output,
): Promise<string[]> {
  const saved: string[] = [];
  for (const locale of locales) {
    for (const type of types) {
      const images = await play.images(editId, locale, type);
      for (const [index, image] of images.entries()) {
        if (!image.url) continue;
        const response = await httpRequest({ method: 'GET', url: image.url }, { service: 'Google Play image CDN', out });
        if (!response.ok) throw new CliError(`Could not download ${type} ${index + 1} for ${locale} (${response.status}).`);
        const data = Buffer.from(await response.arrayBuffer());
        const ext = response.headers.get('content-type')?.includes('jpeg') ? 'jpg' : 'png';
        const path = SINGLE_IMAGE_TYPES.includes(type)
          ? join(dir, locale, 'images', `${type}.${ext}`)
          : join(dir, locale, 'images', type, `${String(index + 1).padStart(2, '0')}.${ext}`);
        write(path, data);
        saved.push(path);
      }
    }
  }
  return saved;
}
