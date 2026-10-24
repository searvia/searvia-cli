import { existsSync } from 'node:fs';
import { editableVersion, listVersions, resolveApp } from '../apple/app.js';
import type { ManualStep, ReleaseStep } from '../apple/release.js';
import { cancelSubmission, iosStatus, releaseIos, submitForReview } from '../apple/release.js';
import { scanScreenshots } from '../apple/screenshots.js';
import { androidMetadataDir, metadataDir, screenshotsDir } from '../core/config.js';
import { CliError } from '../core/errors.js';
import { parseDuration } from '../core/util.js';
import { readAppleMetadata } from '../metadata/apple.js';
import { playLocales, readPlayLocales } from '../metadata/play.js';
import { scanPlayImages } from '../play/images.js';
import { playStatus, releasePlay } from '../play/release.js';
import { appStore, type Command, type Context, dryRunNote, googlePlay, PLATFORM_OPTION, platforms } from './context.js';

function printManual(context: Context, manual: ManualStep[]): void {
  if (manual.length === 0) return;
  context.out.log(context.out.paint('bold', '\nNot available through the store APIs (do these once in the console):'));
  for (const item of manual) context.out.log(`  • ${item.item}\n    ${context.out.paint('gray', item.why)}\n    ${item.url}`);
}

export const release: Command = {
  name: 'release',
  summary: 'Ship a version end to end (metadata, screenshots, build, review, rollout)',
  usage: 'searvia release [--platform ios|android] [--version x.y.z] [--ipa file | --build-number n] [--aab file] [--yes]',
  description:
    'App Store: ensure the version → push metadata → upload screenshots → (upload the .ipa) → wait for processing → export compliance → attach the build → App Review contact and demo account (password from SEARVIA_DEMO_PASSWORD) → age rating → release type / date / copyright → phased release → submit with reviewSubmissions. Google Play: one edit with listings → images → bundle → track release (rollout %, release notes from changelogs/) → commit. Without --yes every step only reports what it would do.',
  options: [
    PLATFORM_OPTION,
    { name: 'version', type: 'string', value: '<x.y.z>', description: 'App Store version (default: from the .ipa).' },
    { name: 'build-number', type: 'string', value: '<n>', description: 'App Store build to attach (default: newest processed build of the version).' },
    { name: 'ipa', type: 'string', value: '<file>', description: 'Upload this .ipa first.' },
    { name: 'aab', type: 'string', value: '<file>', description: 'Upload this Android App Bundle.' },
    { name: 'version-code', type: 'list', value: '<codes>', description: 'Google Play: release already uploaded version codes.' },
    { name: 'track', type: 'string', value: '<track>', description: 'Google Play track (default android.track, else production).' },
    { name: 'rollout', type: 'number', value: '<percent>', description: 'Google Play staged rollout percentage; without a new build it changes the current rollout.' },
    { name: 'status', type: 'string', value: '<status>', description: 'Google Play release status: completed, inProgress, draft or halted.' },
    { name: 'release-name', type: 'string', value: '<name>', description: 'Google Play release name (default: versionName from the bundle).' },
    { name: 'submit', type: 'boolean', default: true, description: 'App Store: submit for review (--no-submit to stop before).' },
    { name: 'skip-metadata', type: 'boolean', description: 'Do not push metadata.' },
    { name: 'skip-screenshots', type: 'boolean', description: 'Do not upload screenshots/images.' },
    { name: 'create-locales', type: 'boolean', description: 'Create localizations that exist locally only.' },
    { name: 'changes-not-sent-for-review', type: 'boolean', description: 'Google Play: commit without sending for review.' },
    { name: 'timeout', type: 'string', value: '<duration>', default: '60m', description: 'How long to wait for build processing.' },
  ],
  examples: [
    'searvia release --platform ios --ipa build/App.ipa',
    'searvia release --platform ios --version 2.4.0 --build-number 112 --yes',
    'searvia release --platform android --aab app.aab --track production --rollout 10 --yes',
    'searvia release --platform android --rollout 50 --yes   # raise a staged rollout',
  ],
  async run(context) {
    const result: Record<string, unknown> = { applied: context.apply };
    const timeoutMs = parseDuration(String(context.options.timeout ?? '60m'));

    for (const platform of platforms(context)) {
      if (platform === 'ios') {
        const ios = context.loaded.config.ios ?? {};
        const client = appStore(context);
        const app = await resolveApp(client, ios);
        context.out.log(context.out.paint('bold', `App Store · ${app.name}`));
        const metadataPath = metadataDir(context.loaded);
        const shotsPath = screenshotsDir(context.loaded);
        const demoEnv = ios.review?.demoPasswordEnv ?? 'SEARVIA_DEMO_PASSWORD';
        const outcome = await releaseIos(client, app, ios, {
          apply: context.apply,
          versionString: context.options.version as string | undefined,
          buildNumber: context.options.buildNumber as string | undefined,
          ipa: context.options.ipa as string | undefined,
          metadata: context.options.skipMetadata || !existsSync(metadataPath) ? undefined : readAppleMetadata(metadataPath),
          screenshots: context.options.skipScreenshots || !existsSync(shotsPath) ? undefined : scanScreenshots(shotsPath),
          createLocales: Boolean(context.options.createLocales),
          submit: Boolean(context.options.submit),
          waitTimeoutMs: timeoutMs,
          demoPassword: context.env[demoEnv],
          out: context.out,
        });
        printManual(context, outcome.manual);
        result.ios = outcome;
      } else {
        const play = googlePlay(context);
        const dir = androidMetadataDir(context.loaded);
        context.out.log(context.out.paint('bold', `Google Play · ${play.packageName}`));
        const locales = playLocales(dir);
        const images = context.options.skipScreenshots ? undefined : scanPlayImages(dir, locales);
        if (images?.errors.length) throw new CliError(`Images are not valid:\n  ${images.errors.join('\n  ')}`);
        const outcome = await releasePlay(play, {
          apply: context.apply,
          track: (context.options.track as string | undefined) ?? context.loaded.config.android?.track ?? 'production',
          aab: context.options.aab as string | undefined,
          versionCodes: ((context.options.versionCode as string[] | undefined) ?? []).map(Number),
          status: context.options.status as never,
          rollout: context.options.rollout as number | undefined,
          releaseName: context.options.releaseName as string | undefined,
          metadataDir: dir,
          listings: context.options.skipMetadata ? undefined : readPlayLocales(dir),
          images: images?.images,
          createLocales: Boolean(context.options.createLocales),
          changesNotSentForReview: Boolean(context.options.changesNotSentForReview),
          out: context.out,
        });
        printManual(context, outcome.manual);
        result.android = outcome;
      }
    }
    dryRunNote(context);
    return result;
  },
};

export const status: Command = {
  name: 'status',
  summary: 'Review state (App Store) and track state (Google Play)',
  usage: 'searvia status [--platform ios|android]',
  options: [PLATFORM_OPTION],
  async run(context) {
    const result: Record<string, unknown> = {};
    for (const platform of platforms(context)) {
      if (platform === 'ios') {
        const client = appStore(context);
        const app = await resolveApp(client, context.loaded.config.ios ?? {});
        const state = await iosStatus(client, app, context.loaded.config.ios?.platform);
        context.out.log(context.out.paint('bold', `App Store · ${app.name} (${app.bundleId})`));
        context.out.table(state.versions as unknown as Array<Record<string, unknown>>, ['version', 'state', 'build', 'releaseType', 'phasedRelease']);
        if (state.submissions.length) {
          context.out.log(context.out.paint('bold', '\nReview submissions'));
          context.out.table(state.submissions as unknown as Array<Record<string, unknown>>, ['state', 'submittedDate', 'id']);
        }
        result.ios = state;
      } else {
        const play = googlePlay(context);
        const tracks = await playStatus(play);
        context.out.log(context.out.paint('bold', `\nGoogle Play · ${play.packageName}`));
        const rows = tracks.flatMap((track) =>
          (track.releases ?? []).map((item) => ({
            track: track.track,
            release: item.name,
            status: item.status,
            versionCodes: item.versionCodes?.join(', '),
            rollout: item.userFraction !== undefined ? `${Math.round(item.userFraction * 100)}%` : item.status === 'completed' ? '100%' : undefined,
          })),
        );
        context.out.table(rows, ['track', 'release', 'status', 'versionCodes', 'rollout']);
        result.android = { packageName: play.packageName, tracks };
      }
    }
    return result;
  },
};

export const submit: Command = {
  name: 'submit',
  summary: 'Submit the editable App Store version for review, or --cancel a submission',
  usage: 'searvia submit [--cancel] [--yes]',
  description:
    'Submits the editable version (with its attached build) through reviewSubmissions, or withdraws the submission that is waiting for review. Google Play has no withdraw API: halt a staged rollout with `searvia release --platform android --status halted`.',
  options: [
    { ...PLATFORM_OPTION, description: 'Store (only ios supports submit/cancel).' },
    { name: 'cancel', type: 'boolean', description: 'Withdraw the current submission.' },
  ],
  async run(context) {
    const targets = platforms(context);
    if (targets.includes('android') && !targets.includes('ios')) {
      throw new CliError('Google Play has no API to withdraw or submit a release by itself.', {
        hint: 'Use `searvia release --platform android` to commit an edit, or --status halted to stop a staged rollout.',
      });
    }
    const client = appStore(context);
    const ios = context.loaded.config.ios ?? {};
    const app = await resolveApp(client, ios);
    const steps: ReleaseStep[] = [];
    if (context.options.cancel) {
      const active = await cancelSubmission(client, app.id, ios.platform, context.apply);
      if (!active) context.out.log('No submission is waiting for review.');
      else context.out.success(`${context.apply ? 'Cancelled' : 'Would cancel'} submission ${active.id} (${active.attributes?.state}).`);
      steps.push({ step: 'cancel', status: active ? (context.apply ? 'done' : 'planned') : 'unchanged' });
    } else {
      const version = editableVersion(await listVersions(client, app.id, ios.platform));
      if (!version) throw new CliError('There is no editable version to submit.');
      if (context.apply) {
        const submission = await submitForReview(client, app.id, version.id, ios.platform);
        context.out.success(`Submitted ${version.attributes?.versionString} for review (${submission.id}).`);
      } else context.out.log(`Would submit ${version.attributes?.versionString} for review.`);
      steps.push({ step: 'submit', status: context.apply ? 'done' : 'planned', detail: version.attributes?.versionString });
    }
    dryRunNote(context);
    return { steps };
  },
};
