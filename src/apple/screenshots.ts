import { readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { CliError } from '../core/errors.js';
import { httpRequest } from '../core/http.js';
import type { Output } from '../core/output.js';
import { md5, poll } from '../core/util.js';
import { imageFileInfo } from '../media/image.js';
import { listDirs, listImages, localeDirs } from '../metadata/files.js';
import { type AppStoreConnect, type Resource, ref } from './client.js';
import { detectDisplayType, MAX_PER_SET } from './display-types.js';
import { runUploadOperations } from './upload.js';

export interface LocalScreenshot {
  path: string;
  file: string;
  type: string;
  width: number;
  height: number;
  size: number;
  checksum: string;
}

export interface ScanResult {
  locales: Record<string, Record<string, LocalScreenshot[]>>;
  errors: string[];
  warnings: string[];
}

/**
 * Reads `<screenshots>/<locale>/*.png|jpg` (and optional `<locale>/<DISPLAY_TYPE>/` subfolders), assigns each image a
 * display type and validates size, alpha and the 10-per-set limit before anything is uploaded.
 */
export function scanScreenshots(dir: string, only?: string[]): ScanResult {
  const result: ScanResult = { locales: {}, errors: [], warnings: [] };
  for (const locale of localeDirs(dir)) {
    if (only?.length && !only.includes(locale)) continue;
    const files = [...listImages(join(dir, locale)), ...listDirs(join(dir, locale)).flatMap((sub) => listImages(join(dir, locale, sub)))];
    const groups: Record<string, LocalScreenshot[]> = {};
    for (const path of files) {
      const name = relative(dir, path);
      let info: ReturnType<typeof imageFileInfo>;
      try {
        info = imageFileInfo(path);
      } catch (error) {
        result.errors.push(`${name}: ${(error as Error).message}`);
        continue;
      }
      const detected = detectDisplayType(relative(join(dir, locale), path), info.width, info.height);
      if (!detected.type) {
        result.errors.push(`${name}: ${detected.error}`);
        continue;
      }
      if (info.alpha) result.errors.push(`${name}: has an alpha channel; App Store screenshots can't be transparent (export as JPEG or PNG without alpha).`);
      const data = readFileSync(path);
      (groups[detected.type] ??= []).push({
        path,
        file: basename(path),
        type: detected.type,
        width: info.width,
        height: info.height,
        size: statSync(path).size,
        checksum: md5(data),
      });
    }
    for (const [type, shots] of Object.entries(groups)) {
      if (shots.length > MAX_PER_SET) result.errors.push(`${locale} ${type}: ${shots.length} screenshots; the App Store allows ${MAX_PER_SET} per display size.`);
    }
    result.locales[locale] = groups;
  }
  return result;
}

export interface SetPlan {
  locale: string;
  type: string;
  action: 'unchanged' | 'replace' | 'create' | 'append';
  local: number;
  remote: number;
}

async function screenshotSets(client: AppStoreConnect, localizationId: string): Promise<Resource[]> {
  return (await client.getAll(`/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`)).data;
}

async function screenshotsOf(client: AppStoreConnect, setId: string): Promise<Resource[]> {
  return (await client.getAll(`/v1/appScreenshotSets/${setId}/appScreenshots`)).data;
}

/** Reserve → upload parts → commit with the MD5 of the whole file. Returns the screenshot id. */
export async function uploadScreenshot(
  client: AppStoreConnect,
  setId: string,
  shot: { path: string; file: string; size: number; checksum: string },
  out?: Output,
): Promise<string> {
  const reservation = await client.post('/v1/appScreenshots', {
    data: { type: 'appScreenshots', attributes: { fileName: shot.file, fileSize: shot.size }, relationships: { appScreenshotSet: ref('appScreenshotSets', setId) } },
  });
  const data = readFileSync(shot.path);
  await runUploadOperations(reservation.attributes?.uploadOperations ?? [], async (offset, length) => data.subarray(offset, offset + length), { out });
  await client.patch(`/v1/appScreenshots/${reservation.id}`, {
    data: { type: 'appScreenshots', id: reservation.id, attributes: { uploaded: true, sourceFileChecksum: shot.checksum } },
  });
  return reservation.id;
}

/** Waits until App Store Connect processed the screenshots (assetDeliveryState COMPLETE); FAILED is terminal. */
export async function waitForScreenshots(client: AppStoreConnect, ids: string[], options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const pending = new Set(ids);
  const result = await poll(
    async () => {
      for (const id of [...pending]) {
        const shot = (await client.get(`/v1/appScreenshots/${id}`)).data as Resource;
        const state = shot.attributes?.assetDeliveryState?.state;
        if (state === 'COMPLETE') pending.delete(id);
        if (state === 'FAILED') {
          const errors = (shot.attributes?.assetDeliveryState?.errors ?? []).map((error: { description?: string; code?: string }) => error.description ?? error.code).join('; ');
          throw new CliError(`App Store Connect rejected ${shot.attributes?.fileName}: ${errors || 'processing failed'}.`);
        }
      }
      return pending.size === 0 ? true : undefined;
    },
    { intervalMs: options.intervalMs ?? 3000, timeoutMs: options.timeoutMs ?? 10 * 60_000 },
  );
  if (!result) throw new CliError(`${pending.size} screenshots are still processing in App Store Connect; check again later.`);
}

/**
 * Makes each remote screenshot set match the local folder. A set whose checksums already match (same files, same
 * order) is left alone; otherwise its screenshots are replaced (or, with `append`, added) and put in local order.
 */
export async function syncScreenshots(
  client: AppStoreConnect,
  localizations: Resource[],
  local: ScanResult['locales'],
  options: { apply: boolean; append?: boolean; createLocales?: boolean; versionId?: string; out?: Output },
): Promise<SetPlan[]> {
  const plans: SetPlan[] = [];
  for (const [locale, groups] of Object.entries(local)) {
    let localization = localizations.find((item) => String(item.attributes?.locale).toLowerCase() === locale.toLowerCase());
    if (!localization) {
      if (!options.createLocales || !options.versionId) {
        throw new CliError(`${locale} has screenshots but no localization in this App Store version.`, { hint: 'Push its metadata first or pass --create-locales.' });
      }
      if (options.apply) {
        localization = await client.post('/v1/appStoreVersionLocalizations', {
          data: { type: 'appStoreVersionLocalizations', attributes: { locale }, relationships: { appStoreVersion: ref('appStoreVersions', options.versionId) } },
        });
      }
    }
    const sets = localization ? await screenshotSets(client, localization.id) : [];

    for (const [type, shots] of Object.entries(groups)) {
      let set = sets.find((item) => item.attributes?.screenshotDisplayType === type);
      const existing = set ? await screenshotsOf(client, set.id) : [];
      const same = existing.length === shots.length && existing.every((shot, index) => shot.attributes?.sourceFileChecksum === shots[index]?.checksum);
      const action: SetPlan['action'] = same ? 'unchanged' : !set ? 'create' : options.append ? 'append' : 'replace';
      plans.push({ locale, type, action, local: shots.length, remote: existing.length });
      if (!options.apply || action === 'unchanged' || !localization) continue;

      if (options.append && existing.length + shots.length > MAX_PER_SET) {
        throw new CliError(`${locale} ${type}: ${existing.length} existing + ${shots.length} new screenshots exceed ${MAX_PER_SET}.`);
      }
      options.out?.step(`${locale} ${type}: uploading ${shots.length} screenshot${shots.length === 1 ? '' : 's'}`);
      if (!set) {
        set = await client.post('/v1/appScreenshotSets', {
          data: {
            type: 'appScreenshotSets',
            attributes: { screenshotDisplayType: type },
            relationships: { appStoreVersionLocalization: ref('appStoreVersionLocalizations', localization.id) },
          },
        });
      } else if (!options.append) {
        for (const shot of existing) await client.delete(`/v1/appScreenshots/${shot.id}`);
      }
      const ids: string[] = [];
      for (const shot of shots) ids.push(await uploadScreenshot(client, set.id, shot, options.out));
      await waitForScreenshots(client, ids);
      const order = [...(options.append ? existing.map((shot) => shot.id) : []), ...ids];
      await client.request('PATCH', `/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, { body: { data: order.map((id) => ({ type: 'appScreenshots', id })) } });
    }
  }
  return plans;
}

/** Downloads every screenshot of the given localizations as `<dir>/<locale>/<NN>_<DISPLAY_TYPE>.<ext>`. */
export async function downloadScreenshots(
  client: AppStoreConnect,
  localizations: Resource[],
  dir: string,
  write: (path: string, data: Buffer) => void,
  out?: Output,
): Promise<string[]> {
  const saved: string[] = [];
  for (const localization of localizations) {
    const locale = String(localization.attributes?.locale);
    for (const set of await screenshotSets(client, localization.id)) {
      const type = String(set.attributes?.screenshotDisplayType);
      const shots = await screenshotsOf(client, set.id);
      for (const [index, shot] of shots.entries()) {
        const asset = shot.attributes?.imageAsset;
        if (!asset?.templateUrl) continue;
        const ext = /\.jpe?g$/i.test(String(shot.attributes?.fileName)) ? 'jpg' : 'png';
        const url = String(asset.templateUrl).replace('{w}', String(asset.width)).replace('{h}', String(asset.height)).replace('{f}', ext);
        const response = await httpRequest({ method: 'GET', url }, { service: 'App Store image CDN', out });
        if (!response.ok) throw new CliError(`Could not download ${shot.attributes?.fileName} (${response.status}).`);
        const path = join(dir, locale, `${String(index + 1).padStart(2, '0')}_${type}.${ext}`);
        write(path, Buffer.from(await response.arrayBuffer()));
        saved.push(path);
      }
    }
  }
  return saved;
}

/** Deletes screenshot sets (and their screenshots), optionally only some display types. */
export async function clearScreenshots(
  client: AppStoreConnect,
  localizations: Resource[],
  options: { types?: string[]; apply: boolean },
): Promise<Array<{ locale: string; type: string; count: number }>> {
  const removed: Array<{ locale: string; type: string; count: number }> = [];
  for (const localization of localizations) {
    for (const set of await screenshotSets(client, localization.id)) {
      const type = String(set.attributes?.screenshotDisplayType);
      if (options.types?.length && !options.types.includes(type)) continue;
      const count = (await screenshotsOf(client, set.id)).length;
      removed.push({ locale: String(localization.attributes?.locale), type, count });
      if (options.apply) await client.delete(`/v1/appScreenshotSets/${set.id}`);
    }
  }
  return removed;
}
