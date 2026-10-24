import { join } from 'node:path';
import { ensureVersion, resolveApp } from '../apple/app.js';
import { applyPush, checkLimits, loadRemoteListing, planPush } from '../apple/listing.js';
import { androidMetadataDir, metadataDir } from '../core/config.js';
import { type FieldChange, renderChanges } from '../core/diff.js';
import { CliError } from '../core/errors.js';
import { APPLE_FIELD_NAMES, type AppleField, readAppleMetadata, writeAppleLocale } from '../metadata/apple.js';
import { writeText } from '../metadata/files.js';
import { PLAY_FIELD_NAMES, type PlayField, readPlayLocales, writeChangelog, writePlayLocale } from '../metadata/play.js';
import { applyPlayPush, checkPlayLimits, listingToFields, planPlayPush } from '../play/listing.js';
import { appStore, type Command, dryRunNote, googlePlay, list, PLATFORM_OPTION, platforms } from './context.js';

const LOCALE_OPTION = { name: 'locale', alias: 'l', type: 'list' as const, value: '<codes>', description: 'Only these locales (comma separated or repeated).' };
const FIELD_OPTION = { name: 'field', type: 'list' as const, value: '<names>', description: 'Only these fields (e.g. keywords,promotional_text).' };

export const pull: Command = {
  name: 'pull',
  summary: 'Download store listings into fastlane-style metadata folders',
  usage: 'searvia pull [--platform ios|android] [--locale en-US,tr] [--version 2.1.0]',
  description:
    'Reads every localization from App Store Connect (name, subtitle, keywords, description, promotional text, What’s New, URLs) and Google Play (title, short and full description, video, release notes of the track) and writes them as text files. Existing files are overwritten; review with git diff.',
  options: [
    PLATFORM_OPTION,
    LOCALE_OPTION,
    { name: 'version', type: 'string', value: '<x.y.z>', description: 'App Store version to read (default: the editable one, else the live one).' },
    { name: 'track', type: 'string', value: '<track>', description: 'Google Play track whose release notes go to changelogs/ (default production).' },
  ],
  examples: ['searvia pull', 'searvia pull --platform ios --locale en-US,de-DE'],
  async run(context) {
    const result: Record<string, unknown> = {};
    const only = list(context.options.locale);
    for (const platform of platforms(context)) {
      if (platform === 'ios') {
        const client = appStore(context);
        const app = await resolveApp(client, context.loaded.config.ios ?? {});
        const remote = await loadRemoteListing(client, app, { platform: context.loaded.config.ios?.platform, versionString: context.options.version as string | undefined });
        const dir = metadataDir(context.loaded);
        const files: string[] = [];
        for (const [locale, fields] of Object.entries(remote.locales)) {
          if (only && !only.includes(locale)) continue;
          files.push(...writeAppleLocale(dir, locale, fields));
        }
        const copyright = remote.version?.attributes?.copyright;
        if (copyright) {
          writeText(join(dir, 'copyright.txt'), copyright);
          files.push(join(dir, 'copyright.txt'));
        }
        context.out.success(
          `App Store: ${app.name} ${remote.version?.attributes?.versionString ?? ''} → ${Object.keys(remote.locales).length} locales, ${files.length} files in ${dir}`,
        );
        result.ios = { app, version: remote.version?.attributes?.versionString, locales: Object.keys(remote.locales), files };
      } else {
        const play = googlePlay(context);
        const dir = androidMetadataDir(context.loaded);
        const track = (context.options.track as string | undefined) ?? 'production';
        const { listings, release } = await play.withEdit(
          async (editId) => ({
            listings: await play.listings(editId),
            release: await play
              .track(editId, track)
              .then((value) => (value.releases ?? []).find((item) => item.status === 'completed' || item.status === 'inProgress'))
              .catch(() => undefined),
          }),
          { commit: false },
        );
        const files: string[] = [];
        for (const listing of listings) {
          if (only && !only.includes(listing.language)) continue;
          files.push(...writePlayLocale(dir, listing.language, listingToFields(listing)));
        }
        const code = release?.versionCodes?.map(Number).sort((a, b) => b - a)[0];
        if (code !== undefined) {
          for (const note of release?.releaseNotes ?? []) {
            if (only && !only.includes(note.language)) continue;
            files.push(writeChangelog(dir, note.language, code, note.text));
          }
        }
        context.out.success(`Google Play: ${play.packageName} → ${listings.length} languages, ${files.length} files in ${dir}`);
        result.android = { packageName: play.packageName, locales: listings.map((item) => item.language), files };
      }
    }
    return result;
  },
};

export const push: Command = {
  name: 'push',
  summary: 'Upload metadata folders to the stores (dry-run diff unless --yes)',
  usage: 'searvia push [--platform ios|android] [--locale ..] [--field ..] [--create-locales] [--create-version x.y.z] [--yes]',
  description:
    'Compares the local text files with the live store data and prints a field-by-field diff. With --yes the changes are written: App Store text goes to the editable version (promotional text also to the live version, where Apple allows it without review); Google Play changes go into one edit that is committed at the end. Only fields that have a file locally take part, so you can manage a subset.',
  options: [
    PLATFORM_OPTION,
    LOCALE_OPTION,
    FIELD_OPTION,
    { name: 'create-locales', type: 'boolean', description: 'Create localizations/listings that exist locally but not in the store.' },
    { name: 'create-version', type: 'string', value: '<x.y.z>', description: 'App Store: open this version if there is no editable one.' },
    { name: 'changes-not-sent-for-review', type: 'boolean', description: 'Google Play: commit without sending for review (for apps with managed publishing / rejected updates).' },
    { name: 'force', type: 'boolean', description: 'Push even when a field exceeds the store limit (the store will reject it).' },
  ],
  examples: ['searvia push', 'searvia push --platform ios --field keywords --yes', 'searvia push --platform android --locale tr-TR --yes'],
  async run(context) {
    const only = list(context.options.locale);
    const fields = list(context.options.field);
    const allChanges: FieldChange[] = [];
    const result: Record<string, unknown> = { applied: context.apply };

    for (const platform of platforms(context)) {
      if (platform === 'ios') {
        const local = readAppleMetadata(metadataDir(context.loaded), only);
        if (Object.keys(local.locales).length === 0) {
          context.out.warn(`No App Store metadata in ${metadataDir(context.loaded)} (run \`searvia pull\` first).`);
          continue;
        }
        const unknown = fields?.filter((field) => !APPLE_FIELD_NAMES.includes(field as AppleField) && !PLAY_FIELD_NAMES.includes(field as PlayField));
        if (unknown?.length) throw new CliError(`Unknown field(s): ${unknown.join(', ')}.`);
        const limits = checkLimits(local.locales);
        if (limits.length && !context.options.force)
          throw new CliError(`Metadata exceeds store limits:\n  ${limits.map((issue) => issue.message).join('\n  ')}`, {
            hint: 'Fix the files (see `searvia audit`) or pass --force.',
          });

        const client = appStore(context);
        const app = await resolveApp(client, context.loaded.config.ios ?? {});
        const createVersion = context.options.createVersion as string | undefined;
        let ensured: Awaited<ReturnType<typeof ensureVersion>> | undefined;
        if (createVersion)
          ensured = await ensureVersion(client, app.id, { versionString: createVersion, platform: context.loaded.config.ios?.platform, create: true, dryRun: !context.apply });
        const remote = await loadRemoteListing(client, app, { platform: context.loaded.config.ios?.platform });
        const plan = planPush(remote, local.locales, fields?.filter((field) => APPLE_FIELD_NAMES.includes(field as AppleField)) as AppleField[] | undefined);
        allChanges.push(...plan.changes);
        context.out.log(
          context.out.paint(
            'bold',
            `App Store · ${app.name} · version ${remote.editable?.attributes?.versionString ?? remote.version?.attributes?.versionString ?? '–'}${ensured && ensured.action !== 'existing' ? ` (${ensured.action} ${createVersion})` : ''}`,
          ),
        );
        if (plan.changes.length === 0) context.out.log('  No changes.');
        renderChanges(context.out, plan.changes);
        if (plan.missingLocales.length) context.out.warn(`New locales: ${plan.missingLocales.join(', ')}${context.options.createLocales ? '' : ' (needs --create-locales)'}`);
        if (context.apply && plan.changes.length) {
          const { written } = await applyPush(client, remote, plan, { createLocales: Boolean(context.options.createLocales), out: context.out });
          context.out.success(`App Store: ${written} fields updated.`);
        }
        result.ios = { app, changes: plan.changes, missingLocales: plan.missingLocales };
      } else {
        const dir = androidMetadataDir(context.loaded);
        const local = readPlayLocales(dir, only);
        if (Object.keys(local).length === 0) {
          context.out.warn(`No Google Play metadata in ${dir} (run \`searvia pull\` first).`);
          continue;
        }
        const limits = checkPlayLimits(local);
        if (limits.length && !context.options.force) throw new CliError(`Store listing exceeds limits:\n  ${limits.join('\n  ')}`);
        const play = googlePlay(context);
        const plan = await play.withEdit(
          async (editId) => {
            const remote = await play.listings(editId);
            const computed = planPlayPush(remote, local, fields?.filter((field) => PLAY_FIELD_NAMES.includes(field as PlayField)) as PlayField[] | undefined);
            context.out.log(context.out.paint('bold', `Google Play · ${play.packageName}`));
            if (computed.changes.length === 0) context.out.log('  No changes.');
            renderChanges(context.out, computed.changes);
            if (context.apply && computed.changes.length) await applyPlayPush(play, editId, remote, local, computed, { createLocales: Boolean(context.options.createLocales) });
            return computed;
          },
          { commit: context.apply, changesNotSentForReview: Boolean(context.options.changesNotSentForReview) },
        );
        allChanges.push(...plan.changes);
        if (context.apply && plan.changes.length) context.out.success(`Google Play: ${plan.changes.length} fields updated and committed.`);
        result.android = { packageName: play.packageName, changes: plan.changes, missingLocales: plan.missingLocales };
      }
    }
    if (allChanges.length) dryRunNote(context, `${allChanges.length} field changes shown`);
    result.changes = allChanges.length;
    return result;
  },
};
