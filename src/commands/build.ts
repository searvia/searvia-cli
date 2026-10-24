import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveApp } from '../apple/app.js';
import { readIpaInfo, uploadBuild, uploadWithAltool, waitForBuild } from '../apple/build.js';
import { androidMetadataDir, ascCredentials } from '../core/config.js';
import { CliError, UsageError } from '../core/errors.js';
import { formatBytes, parseDuration } from '../core/util.js';
import { releasePlay } from '../play/release.js';
import { appStore, type Command, dryRunNote, googlePlay } from './context.js';

export const build: Command = {
  name: 'build',
  summary: 'Upload an iOS .ipa/.pkg or an Android .aab',
  usage: 'searvia build upload <file.ipa|file.aab> [--yes]',
  description:
    'iOS/macOS: uses the App Store Connect build upload API (buildUploads + buildUploadFiles: reserve, upload parts, MD5 commit, wait for processing) — no Xcode needed, works on Linux CI. --altool falls back to `xcrun altool` on macOS. Version and build number are read from the .ipa Info.plist. Android: resumable upload through edits.bundles.upload, then the bundle is put on a track (default internal) and the edit is committed.',
  options: [
    { name: 'ipa', type: 'string', value: '<file>', description: 'iOS .ipa (or macOS .pkg) to upload.' },
    { name: 'aab', type: 'string', value: '<file>', description: 'Android App Bundle to upload.' },
    { name: 'version-string', type: 'string', value: '<x.y.z>', description: 'CFBundleShortVersionString (default: from Info.plist; required for .pkg).' },
    { name: 'build-number', type: 'string', value: '<n>', description: 'CFBundleVersion (default: from Info.plist; required for .pkg).' },
    { name: 'altool', type: 'boolean', description: 'iOS: upload with `xcrun altool` instead of the API (macOS only).' },
    { name: 'wait', type: 'boolean', default: true, description: 'Wait until Apple finished processing (--no-wait to return after the upload).' },
    { name: 'timeout', type: 'string', value: '<duration>', default: '60m', description: 'How long to wait for processing (e.g. 45m).' },
    { name: 'track', type: 'string', value: '<track>', description: 'Android: track to release to (default android.track, else internal).' },
    { name: 'status', type: 'string', value: '<status>', description: 'Android: completed (default), draft, inProgress or halted.' },
    { name: 'rollout', type: 'number', value: '<percent>', description: 'Android: staged rollout percentage (implies inProgress).' },
    { name: 'no-track', type: 'boolean', description: 'Android: only upload the bundle (no track release).' },
  ],
  examples: [
    'searvia build upload build/App.ipa --yes',
    'searvia build upload app-release.aab --track internal --yes',
    'searvia build upload App.pkg --version-string 2.0 --build-number 41 --yes',
  ],
  async run(context) {
    const [action, file] = context.positionals;
    if (action !== 'upload') throw new UsageError('Use `searvia build upload <file>`.');
    const path = (context.options.ipa as string | undefined) ?? (context.options.aab as string | undefined) ?? file;
    if (!path) throw new UsageError('Which file? Pass an .ipa, .pkg or .aab path.');
    if (!existsSync(path)) throw new CliError(`${path} does not exist.`);
    const size = statSync(path).size;
    const timeoutMs = parseDuration(String(context.options.timeout ?? '60m'));

    if (/\.(ipa|pkg)$/i.test(path)) {
      const ios = context.loaded.config.ios ?? {};
      const info = /\.ipa$/i.test(path) ? readIpaInfo(path) : {};
      const shortVersion = (context.options.versionString as string | undefined) ?? info.shortVersion;
      const buildNumber = (context.options.buildNumber as string | undefined) ?? info.buildNumber;
      if (!shortVersion || !buildNumber) throw new UsageError('Pass --version-string and --build-number (they could not be read from the file).');
      if (ios.bundleId && info.bundleId && info.bundleId !== ios.bundleId) throw new CliError(`${basename(path)} is ${info.bundleId}, but the config says ${ios.bundleId}.`);
      const platform = /\.pkg$/i.test(path) ? 'MAC_OS' : (ios.platform ?? 'IOS');
      const client = appStore(context);
      const app = await resolveApp(client, info.bundleId && !ios.appId ? { ...ios, bundleId: info.bundleId } : ios);
      context.out.log(`${app.name} (${app.bundleId}) · ${shortVersion} (${buildNumber}) · ${basename(path)} ${formatBytes(size)}`);
      if (!context.apply) {
        dryRunNote(context, 'Nothing was uploaded');
        return { platform: 'ios', planned: { app, shortVersion, buildNumber, file: path, size } };
      }
      if (context.options.altool) {
        await uploadWithAltool(path, ascCredentials(context.loaded), platform, context.out);
        if (context.options.wait) await waitForBuild(client, { appId: app.id, versionString: shortVersion, buildNumber, timeoutMs, out: context.out });
        context.out.success(`Uploaded ${shortVersion} (${buildNumber}) with altool.`);
        return { platform: 'ios', method: 'altool', shortVersion, buildNumber };
      }
      const uploaded = await uploadBuild(client, { appId: app.id, path, platform, shortVersion, buildNumber, wait: Boolean(context.options.wait), timeoutMs, out: context.out });
      for (const warning of uploaded.warnings) context.out.warn(warning);
      context.out.success(`Uploaded ${shortVersion} (${buildNumber}): ${uploaded.state}${uploaded.buildId ? `, build ${uploaded.buildId}` : ''}.`);
      return { platform: 'ios', method: 'api', shortVersion, buildNumber, ...uploaded };
    }

    if (/\.aab$/i.test(path)) {
      const play = googlePlay(context);
      const track = (context.options.track as string | undefined) ?? context.loaded.config.android?.track ?? 'internal';
      context.out.log(`${play.packageName} · ${basename(path)} ${formatBytes(size)} → ${context.options.noTrack ? 'bundle library only' : `track ${track}`}`);
      if (!context.apply) {
        dryRunNote(context, 'Nothing was uploaded');
        return { platform: 'android', planned: { packageName: play.packageName, file: path, size, track: context.options.noTrack ? null : track } };
      }
      if (context.options.noTrack) {
        const bundle = await play.withEdit((editId) => play.uploadBundle(editId, path), { commit: true });
        context.out.success(`Uploaded versionCode ${bundle.versionCode}.`);
        return { platform: 'android', ...bundle };
      }
      const release = await releasePlay(play, {
        apply: true,
        track,
        aab: path,
        status: context.options.status as never,
        rollout: context.options.rollout as number | undefined,
        metadataDir: androidMetadataDir(context.loaded),
        out: context.out,
      });
      context.out.success(`Uploaded versionCode ${release.versionCodes.join(', ')} to ${track}.`);
      return { platform: 'android', track, ...release };
    }

    throw new UsageError(`${basename(path)} is not an .ipa, .pkg or .aab file.`);
  },
};
