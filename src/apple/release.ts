import type { AppReviewConfig, IosConfig } from '../core/config.js';
import { CliError } from '../core/errors.js';
import type { Output } from '../core/output.js';
import type { AppleMetadata } from '../metadata/apple.js';
import { type AppRef, consoleUrl, ensureVersion, listVersions, versionState } from './app.js';
import { readIpaInfo, uploadBuild, waitForBuild } from './build.js';
import { type AppStoreConnect, type Resource, ref, relatedId } from './client.js';
import { applyPush, checkLimits, loadRemoteListing, planPush } from './listing.js';
import { type ScanResult, syncScreenshots } from './screenshots.js';

export interface ReleaseStep {
  step: string;
  status: 'done' | 'skipped' | 'planned' | 'unchanged';
  detail?: string;
}

export interface ManualStep {
  item: string;
  why: string;
  url: string;
}

export interface IosReleaseOptions {
  apply: boolean;
  versionString?: string;
  buildNumber?: string;
  ipa?: string;
  metadata?: AppleMetadata;
  screenshots?: ScanResult;
  createLocales?: boolean;
  submit: boolean;
  waitTimeoutMs: number;
  demoPassword?: string;
  out?: Output;
}

const ACTIVE_REVIEW_STATES = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES'];

/** Things the App Store Connect API cannot do; printed with the page to open. */
export function iosManualSteps(app: AppRef): ManualStep[] {
  return [
    {
      item: 'App Privacy (privacy nutrition labels)',
      why: 'The App Store Connect API has no endpoint for App Privacy answers; they are required before the first submission and when data collection changes.',
      url: consoleUrl(app.id, 'distribution/privacy'),
    },
  ];
}

function reviewAttributes(review: AppReviewConfig | undefined, metadata: AppleMetadata | undefined, demoPassword: string | undefined): Record<string, unknown> {
  const files = metadata?.review ?? {};
  const attributes: Record<string, unknown> = {
    contactFirstName: review?.firstName ?? files.first_name,
    contactLastName: review?.lastName ?? files.last_name,
    contactPhone: review?.phone ?? files.phone_number,
    contactEmail: review?.email ?? files.email_address,
    demoAccountName: review?.demoUser ?? files.demo_user,
    demoAccountPassword: demoPassword ?? files.demo_password,
    notes: review?.notes ?? files.notes,
  };
  if (review?.demoRequired !== undefined) attributes.demoAccountRequired = review.demoRequired;
  else if (attributes.demoAccountName) attributes.demoAccountRequired = true;
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined && value !== ''));
}

/**
 * One command from metadata to "Waiting for Review": version → metadata → screenshots → build (upload, processing,
 * export compliance, attach) → review details → age rating → release options → phased release → submission.
 * Without `apply` every step only reports what it would do.
 */
export async function releaseIos(
  client: AppStoreConnect,
  app: AppRef,
  ios: IosConfig,
  options: IosReleaseOptions,
): Promise<{ steps: ReleaseStep[]; manual: ManualStep[]; versionId?: string }> {
  const out = options.out;
  const steps: ReleaseStep[] = [];
  const record = (step: string, status: ReleaseStep['status'], detail?: string) => {
    steps.push({ step, status, detail });
    const mark = status === 'done' ? '✓' : status === 'planned' ? '→' : '·';
    out?.log(`  ${mark} ${step}${detail ? `: ${detail}` : ''}${status === 'planned' ? ' (dry run)' : ''}`);
  };
  const platform = ios.platform ?? 'IOS';
  const apply = options.apply;

  // Version and build number: flags, else the .ipa.
  let versionString = options.versionString;
  let buildNumber = options.buildNumber;
  let usesEncryptionFromPlist: boolean | undefined;
  if (options.ipa && /\.ipa$/i.test(options.ipa)) {
    const info = readIpaInfo(options.ipa);
    versionString ??= info.shortVersion;
    buildNumber ??= info.buildNumber;
    usesEncryptionFromPlist = info.usesNonExemptEncryption;
    if (ios.bundleId && info.bundleId && info.bundleId !== ios.bundleId) throw new CliError(`${options.ipa} is ${info.bundleId}, not ${ios.bundleId}.`);
  }
  if (!versionString) throw new CliError('Which version? Pass --version <x.y.z> (or --ipa so it is read from Info.plist).');

  // 1. Version
  const ensured = await ensureVersion(client, app.id, { versionString, platform, create: true, dryRun: !apply });
  const version = ensured.version;
  record('version', ensured.action === 'existing' ? 'unchanged' : apply ? 'done' : 'planned', `${versionString} (${ensured.action}${version ? `, ${versionState(version)}` : ''})`);

  // 2. Metadata
  if (options.metadata && Object.keys(options.metadata.locales).length) {
    const limits = checkLimits(options.metadata.locales);
    if (limits.length) throw new CliError(`Metadata exceeds store limits:\n  ${limits.map((issue) => issue.message).join('\n  ')}`);
    if (version) {
      const remote = await loadRemoteListing(client, app, { platform });
      const plan = planPush(remote, options.metadata.locales);
      if (plan.changes.length === 0) record('metadata', 'unchanged');
      else if (!apply) record('metadata', 'planned', `${plan.changes.length} field changes`);
      else {
        await applyPush(client, remote, plan, { createLocales: options.createLocales, out });
        record('metadata', 'done', `${plan.changes.length} field changes`);
      }
    } else record('metadata', 'planned', 'after the version is created');
  } else record('metadata', 'skipped', 'no metadata folder');

  // 3. Screenshots
  if (options.screenshots && Object.keys(options.screenshots.locales).length) {
    if (options.screenshots.errors.length) throw new CliError(`Screenshots are not valid:\n  ${options.screenshots.errors.join('\n  ')}`);
    if (version) {
      const localizations = (await client.getAll(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data;
      const plans = await syncScreenshots(client, localizations, options.screenshots.locales, { apply, createLocales: options.createLocales, versionId: version.id, out });
      const changedSets = plans.filter((plan) => plan.action !== 'unchanged');
      record(
        'screenshots',
        changedSets.length === 0 ? 'unchanged' : apply ? 'done' : 'planned',
        `${changedSets.length} of ${plans.length} sets ${apply ? 'updated' : 'to update'}`,
      );
    } else record('screenshots', 'planned', 'after the version is created');
  } else record('screenshots', 'skipped', 'no screenshots folder');

  // 4. Build: upload → processing → export compliance → attach
  let build: Resource | null = null;
  if (options.ipa) {
    if (!buildNumber) throw new CliError('Pass --build-number for a .pkg upload.');
    if (apply) {
      const uploaded = await uploadBuild(client, {
        appId: app.id,
        path: options.ipa,
        platform,
        shortVersion: versionString,
        buildNumber,
        wait: true,
        timeoutMs: options.waitTimeoutMs,
        out,
      });
      record('build upload', 'done', `${versionString} (${buildNumber}), ${uploaded.state}`);
    } else record('build upload', 'planned', `${options.ipa} as ${versionString} (${buildNumber})`);
  }
  if (apply && version) {
    build = await waitForBuild(client, { appId: app.id, versionString, buildNumber, timeoutMs: options.waitTimeoutMs, out });
    record('build processing', 'done', `build ${build.attributes?.version} is VALID`);

    const encryption = ios.usesNonExemptEncryption ?? usesEncryptionFromPlist;
    if (build.attributes?.usesNonExemptEncryption === null || build.attributes?.usesNonExemptEncryption === undefined) {
      if (encryption === undefined) {
        throw new CliError('Export compliance is not answered for this build.', {
          hint: 'Set ios.usesNonExemptEncryption (true/false) in searvia.config.json, or ITSAppUsesNonExemptEncryption in Info.plist.',
        });
      }
      await client.patch(`/v1/builds/${build.id}`, { data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: encryption } } });
      record('export compliance', 'done', `usesNonExemptEncryption = ${encryption}`);
    } else record('export compliance', 'unchanged', `usesNonExemptEncryption = ${build.attributes?.usesNonExemptEncryption}`);

    const attached = (await client.find(`/v1/appStoreVersions/${version.id}/build`)) as Resource | null;
    if (attached?.id === build.id) record('attach build', 'unchanged', String(build.attributes?.version));
    else {
      await client.request('PATCH', `/v1/appStoreVersions/${version.id}/relationships/build`, { body: ref('builds', build.id) });
      record('attach build', 'done', String(build.attributes?.version));
    }
  } else {
    record(
      'build',
      'planned',
      buildNumber ? `wait for build ${buildNumber}, set export compliance, attach` : 'wait for the newest build of this version, set export compliance, attach',
    );
  }

  // 5. App Review information
  const review = reviewAttributes(ios.review, options.metadata, options.demoPassword);
  if (Object.keys(review).length && version) {
    if (apply) {
      const existing = await client.find(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`);
      if (existing) await client.patch(`/v1/appStoreReviewDetails/${existing.id}`, { data: { type: 'appStoreReviewDetails', id: existing.id, attributes: review } });
      else
        await client.post('/v1/appStoreReviewDetails', {
          data: { type: 'appStoreReviewDetails', attributes: review, relationships: { appStoreVersion: ref('appStoreVersions', version.id) } },
        });
      record(
        'app review information',
        'done',
        Object.keys(review)
          .filter((key) => key !== 'demoAccountPassword')
          .join(', ') + (review.demoAccountPassword ? ', demoAccountPassword (from env)' : ''),
      );
    } else record('app review information', 'planned', Object.keys(review).join(', '));
  } else record('app review information', 'skipped', 'no ios.review in config');

  // 6. Age rating
  if (ios.ageRating && Object.keys(ios.ageRating).length) {
    if (apply) {
      const infos = (await client.getAll(`/v1/apps/${app.id}/appInfos`)).data;
      const info = infos.find((item) => ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED'].includes(String(item.attributes?.state))) ?? infos[0];
      const declaration = info ? await client.find(`/v1/appInfos/${info.id}/ageRatingDeclaration`) : null;
      if (!declaration) throw new CliError('Could not find the age rating declaration of the app info.');
      await client.patch(`/v1/ageRatingDeclarations/${declaration.id}`, { data: { type: 'ageRatingDeclarations', id: declaration.id, attributes: ios.ageRating } });
      record('age rating', 'done', `${Object.keys(ios.ageRating).length} answers`);
    } else record('age rating', 'planned', `${Object.keys(ios.ageRating).length} answers`);
  } else record('age rating', 'skipped', 'no ios.ageRating in config');

  // 7. Content rights
  if (ios.contentRightsDeclaration) {
    if (apply) await client.patch(`/v1/apps/${app.id}`, { data: { type: 'apps', id: app.id, attributes: { contentRightsDeclaration: ios.contentRightsDeclaration } } });
    record('content rights', apply ? 'done' : 'planned', ios.contentRightsDeclaration);
  }

  // 8. Release type, date, copyright
  const versionAttributes: Record<string, unknown> = {};
  if (ios.releaseType) versionAttributes.releaseType = ios.releaseType;
  if (ios.earliestReleaseDate) versionAttributes.earliestReleaseDate = ios.earliestReleaseDate;
  const copyright = options.metadata?.copyright ?? ios.copyright;
  if (copyright) versionAttributes.copyright = copyright;
  if (Object.keys(versionAttributes).length && version) {
    if (apply) await client.patch(`/v1/appStoreVersions/${version.id}`, { data: { type: 'appStoreVersions', id: version.id, attributes: versionAttributes } });
    record(
      'release options',
      apply ? 'done' : 'planned',
      Object.entries(versionAttributes)
        .map(([key, value]) => `${key}=${value}`)
        .join(', '),
    );
  }

  // 9. Phased release (7-day automatic rollout for updates)
  if (ios.phasedRelease !== undefined && version) {
    const phased = await client.find(`/v1/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`);
    if (ios.phasedRelease && !phased) {
      if (apply) {
        await client.post('/v1/appStoreVersionPhasedReleases', {
          data: { type: 'appStoreVersionPhasedReleases', attributes: { phasedReleaseState: 'INACTIVE' }, relationships: { appStoreVersion: ref('appStoreVersions', version.id) } },
        });
      }
      record('phased release', apply ? 'done' : 'planned', 'enabled');
    } else if (!ios.phasedRelease && phased) {
      if (apply) await client.delete(`/v1/appStoreVersionPhasedReleases/${phased.id}`);
      record('phased release', apply ? 'done' : 'planned', 'disabled');
    } else record('phased release', 'unchanged', ios.phasedRelease ? 'enabled' : 'off');
  }

  // 10. Submit
  if (!options.submit) record('submit for review', 'skipped', '--no-submit');
  else if (!apply || !version) record('submit for review', 'planned');
  else {
    const submission = await submitForReview(client, app.id, version.id, platform);
    record('submit for review', 'done', `review submission ${submission.id} (${submission.attributes?.state ?? 'WAITING_FOR_REVIEW'})`);
  }

  return { steps, manual: iosManualSteps(app), versionId: version?.id };
}

/** Adds the version to a review submission (reusing an unsent draft) and submits it. */
export async function submitForReview(client: AppStoreConnect, appId: string, versionId: string, platform = 'IOS'): Promise<Resource> {
  const submissions = (await client.getAll('/v1/reviewSubmissions', { 'filter[app]': appId, 'filter[platform]': platform, include: 'appStoreVersionForReview' })).data;
  const active = submissions.find((item) => ACTIVE_REVIEW_STATES.includes(String(item.attributes?.state)));
  if (active) {
    if (relatedId(active, 'appStoreVersionForReview') === versionId) return active;
    throw new CliError(`Another submission is already ${active.attributes?.state}.`, { hint: 'Cancel it with `searvia submit --cancel` first.' });
  }
  let draft = submissions.find((item) => item.attributes?.state === 'READY_FOR_REVIEW');
  if (!draft) {
    draft = await client.post('/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform }, relationships: { app: ref('apps', appId) } } });
  }
  const items = (await client.getAll(`/v1/reviewSubmissions/${draft.id}/items`, { include: 'appStoreVersion' })).data;
  if (!items.some((item) => relatedId(item, 'appStoreVersion') === versionId)) {
    await client.post('/v1/reviewSubmissionItems', {
      data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: ref('reviewSubmissions', draft.id), appStoreVersion: ref('appStoreVersions', versionId) } },
    });
  }
  return (await client.patch(`/v1/reviewSubmissions/${draft.id}`, { data: { type: 'reviewSubmissions', id: draft.id, attributes: { submitted: true } } })) ?? draft;
}

/** Withdraws the submission that is waiting for or in review. */
export async function cancelSubmission(client: AppStoreConnect, appId: string, platform = 'IOS', apply = true): Promise<Resource | null> {
  const submissions = (await client.getAll('/v1/reviewSubmissions', { 'filter[app]': appId, 'filter[platform]': platform })).data;
  const active = submissions.find((item) => [...ACTIVE_REVIEW_STATES, 'READY_FOR_REVIEW'].includes(String(item.attributes?.state)));
  if (!active) return null;
  if (apply) await client.patch(`/v1/reviewSubmissions/${active.id}`, { data: { type: 'reviewSubmissions', id: active.id, attributes: { canceled: true } } });
  return active;
}

export interface IosStatus {
  app: AppRef;
  versions: Array<{ version: string; state: string; build?: string; releaseType?: string; phasedRelease?: string; createdDate?: string }>;
  submissions: Array<{ id: string; state: string; submittedDate?: string }>;
}

export async function iosStatus(client: AppStoreConnect, app: AppRef, platform = 'IOS'): Promise<IosStatus> {
  const versions = (await listVersions(client, app.id, platform)).slice(0, 3);
  const rows: IosStatus['versions'] = [];
  for (const version of versions) {
    const build = await client.find(`/v1/appStoreVersions/${version.id}/build`);
    const phased = await client.find(`/v1/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`);
    rows.push({
      version: String(version.attributes?.versionString),
      state: versionState(version),
      build: build?.attributes?.version,
      releaseType: version.attributes?.releaseType,
      phasedRelease: phased ? `${phased.attributes?.phasedReleaseState}${phased.attributes?.currentDayNumber ? ` day ${phased.attributes.currentDayNumber}/7` : ''}` : undefined,
      createdDate: version.attributes?.createdDate,
    });
  }
  const submissions = (await client.getAll('/v1/reviewSubmissions', { 'filter[app]': app.id, 'filter[platform]': platform })).data
    .sort((a, b) => String(b.attributes?.submittedDate ?? '').localeCompare(String(a.attributes?.submittedDate ?? '')))
    .slice(0, 5)
    .map((item) => ({ id: item.id, state: String(item.attributes?.state), submittedDate: item.attributes?.submittedDate }));
  return { app, versions: rows, submissions };
}
