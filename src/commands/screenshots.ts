import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { editableVersion, ensureVersion, listVersions, liveVersion, resolveApp } from '../apple/app.js';
import type { AppStoreConnect, Resource } from '../apple/client.js';
import { ALL_DISPLAY_TYPES } from '../apple/display-types.js';
import { clearScreenshots, downloadScreenshots, scanScreenshots, syncScreenshots } from '../apple/screenshots.js';
import { androidMetadataDir, screenshotsDir } from '../core/config.js';
import { CliError, UsageError } from '../core/errors.js';
import { PLAY_IMAGE_TYPES, type PlayImageType, playLocales } from '../metadata/play.js';
import { downloadPlayImages, scanPlayImages, syncPlayImages } from '../play/images.js';
import { appStore, type Command, type Context, dryRunNote, googlePlay, list, PLATFORM_OPTION, platforms } from './context.js';

function save(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

async function versionLocalizations(client: AppStoreConnect, appId: string, context: Context, mode: 'write' | 'read'): Promise<{ version: Resource; localizations: Resource[] }> {
  const platform = context.loaded.config.ios?.platform ?? 'IOS';
  let version: Resource | undefined | null;
  if (mode === 'write') {
    const createVersion = context.options.createVersion as string | undefined;
    version = (await ensureVersion(client, appId, { versionString: createVersion, platform, create: Boolean(createVersion), dryRun: !context.apply })).version;
    if (!version) {
      throw new CliError('There is no editable App Store version to attach screenshots to.', { hint: 'Pass --create-version <x.y.z> (or use `searvia release`).' });
    }
  } else {
    const versions = await listVersions(client, appId, platform);
    const wanted = context.options.version as string | undefined;
    version = wanted ? versions.find((item) => item.attributes?.versionString === wanted) : (editableVersion(versions) ?? liveVersion(versions) ?? versions[0]);
    if (!version) throw new CliError(wanted ? `Version ${wanted} not found.` : 'This app has no App Store version yet.');
  }
  let localizations = (await client.getAll(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;
  const only = list(context.options.locale);
  if (only) localizations = localizations.filter((item) => only.includes(String(item.attributes?.locale)));
  return { version, localizations };
}

export const screenshots: Command = {
  name: 'screenshots',
  summary: 'Upload, download or clear App Store screenshots and Google Play images',
  usage: 'searvia screenshots <upload|download|clear> [--platform ios|android] [--locale ..] [--type ..] [--yes]',
  description:
    'App Store: images in <screenshots>/<locale>/ are matched to display types by pixel size (or a DISPLAY_TYPE folder/file name), validated (size, no alpha, max 10) and uploaded with Apple’s reservation → upload operations → MD5 commit flow; unchanged sets are skipped. Google Play: <metadata>/android/<locale>/images/{icon,featureGraphic,tvBanner}.png and {phone,sevenInch,tenInch,tv,wear}Screenshots/ via edits.images, compared by SHA-256.',
  options: [
    PLATFORM_OPTION,
    { name: 'locale', alias: 'l', type: 'list', value: '<codes>', description: 'Only these locales.' },
    { name: 'type', type: 'list', value: '<types>', description: 'clear: only these display/image types (e.g. APP_IPHONE_67, phoneScreenshots).' },
    { name: 'append', type: 'boolean', description: 'upload: add to existing App Store sets instead of replacing them.' },
    { name: 'create-locales', type: 'boolean', description: 'upload: create missing App Store version localizations.' },
    { name: 'create-version', type: 'string', value: '<x.y.z>', description: 'upload: open this App Store version when none is editable.' },
    { name: 'version', type: 'string', value: '<x.y.z>', description: 'download: App Store version to read (default editable, else live).' },
  ],
  examples: [
    'searvia screenshots upload --platform ios',
    'searvia screenshots upload --yes',
    'searvia screenshots download --platform android',
    'searvia screenshots clear --platform ios --type APP_IPAD_PRO_129 --yes',
  ],
  async run(context) {
    const action = context.positionals[0];
    if (!action || !['upload', 'download', 'clear'].includes(action)) throw new UsageError('Use `searvia screenshots upload`, `download` or `clear`.');
    const result: Record<string, unknown> = { action, applied: context.apply || action === 'download' };
    const types = list(context.options.type);
    const only = list(context.options.locale);

    for (const platform of platforms(context)) {
      if (platform === 'ios') {
        const client = appStore(context);
        const app = await resolveApp(client, context.loaded.config.ios ?? {});
        const dir = screenshotsDir(context.loaded);
        if (types?.some((type) => !ALL_DISPLAY_TYPES.includes(type))) throw new UsageError(`Unknown display type. Valid: ${ALL_DISPLAY_TYPES.join(', ')}`);

        if (action === 'upload') {
          const scan = scanScreenshots(dir, only);
          for (const warning of scan.warnings) context.out.warn(warning);
          if (scan.errors.length) throw new CliError(`Screenshots are not valid:\n  ${scan.errors.join('\n  ')}`);
          if (Object.keys(scan.locales).length === 0) throw new CliError(`No screenshots in ${dir}/<locale>/.`);
          const { version, localizations } = await versionLocalizations(client, app.id, context, 'write');
          const plans = await syncScreenshots(client, localizations, scan.locales, {
            apply: context.apply,
            append: Boolean(context.options.append),
            createLocales: Boolean(context.options.createLocales),
            versionId: version.id,
            out: context.out,
          });
          context.out.log(context.out.paint('bold', `App Store · ${app.name} · ${version.attributes?.versionString}`));
          context.out.table(plans as unknown as Array<Record<string, unknown>>, ['locale', 'type', 'action', 'local', 'remote']);
          result.ios = { version: version.attributes?.versionString, sets: plans };
        } else if (action === 'download') {
          const { version, localizations } = await versionLocalizations(client, app.id, context, 'read');
          const saved = await downloadScreenshots(client, localizations, dir, save, context.out);
          context.out.success(`App Store ${version.attributes?.versionString}: saved ${saved.length} screenshots to ${dir}`);
          result.ios = { version: version.attributes?.versionString, files: saved };
        } else {
          const { localizations } = await versionLocalizations(client, app.id, context, 'write');
          const removed = await clearScreenshots(client, localizations, { types, apply: context.apply });
          context.out.table(removed as unknown as Array<Record<string, unknown>>, ['locale', 'type', 'count']);
          if (context.apply) context.out.success(`Deleted ${removed.length} screenshot sets.`);
          result.ios = { removed };
        }
      } else {
        const play = googlePlay(context);
        const dir = androidMetadataDir(context.loaded);
        const imageTypes = (types ?? [...PLAY_IMAGE_TYPES]) as PlayImageType[];
        if (imageTypes.some((type) => !PLAY_IMAGE_TYPES.includes(type))) throw new UsageError(`Unknown image type. Valid: ${PLAY_IMAGE_TYPES.join(', ')}`);

        if (action === 'upload') {
          const locales = playLocales(dir).filter((locale) => !only || only.includes(locale));
          const scan = scanPlayImages(dir, locales);
          if (scan.errors.length) throw new CliError(`Images are not valid:\n  ${scan.errors.join('\n  ')}`);
          if (Object.keys(scan.images).length === 0) throw new CliError(`No images in ${dir}/<locale>/images/.`);
          const plans = await play.withEdit((editId) => syncPlayImages(play, editId, scan.images, { apply: context.apply, out: context.out }), { commit: context.apply });
          context.out.log(context.out.paint('bold', `Google Play · ${play.packageName}`));
          context.out.table(plans as unknown as Array<Record<string, unknown>>, ['locale', 'type', 'action', 'local', 'remote']);
          result.android = { images: plans };
        } else if (action === 'download') {
          const saved = await play.withEdit(
            async (editId) => {
              const languages = (await play.listings(editId)).map((listing) => listing.language).filter((locale) => !only || only.includes(locale));
              return downloadPlayImages(play, editId, languages, imageTypes, dir, save, context.out);
            },
            { commit: false },
          );
          context.out.success(`Google Play: saved ${saved.length} images to ${dir}`);
          result.android = { files: saved };
        } else {
          const removed = await play.withEdit(
            async (editId) => {
              const out: Array<{ locale: string; type: string; count: number }> = [];
              for (const listing of await play.listings(editId)) {
                if (only && !only.includes(listing.language)) continue;
                for (const type of imageTypes) {
                  const count = (await play.images(editId, listing.language, type)).length;
                  if (!count) continue;
                  out.push({ locale: listing.language, type, count });
                  if (context.apply) await play.deleteAllImages(editId, listing.language, type);
                }
              }
              return out;
            },
            { commit: context.apply },
          );
          context.out.table(removed as unknown as Array<Record<string, unknown>>, ['locale', 'type', 'count']);
          result.android = { removed };
        }
      }
    }
    if (action !== 'download') dryRunNote(context);
    return result;
  },
};
