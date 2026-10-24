import { changed, type FieldChange, normalise } from '../core/diff.js';
import { CliError } from '../core/errors.js';
import type { Output } from '../core/output.js';
import { bytes, chars } from '../core/util.js';
import { APPLE_FIELD_NAMES, APPLE_FIELDS, type AppleField, type AppleLocaleFields } from '../metadata/apple.js';
import { type AppRef, consoleUrl, editableInfo, editableVersion, listAppInfos, listVersions, liveVersion, versionState } from './app.js';
import { type AppStoreConnect, type Resource, ref } from './client.js';

export interface RemoteListing {
  app: AppRef;
  versions: Resource[];
  /** The version whose text was read: editable, else the requested one, else live, else newest. */
  version: Resource | null;
  editable: Resource | null;
  live: Resource | null;
  info: Resource | null;
  infoEditable: boolean;
  versionLocalizations: Resource[];
  liveLocalizations: Resource[];
  infoLocalizations: Resource[];
  locales: Record<string, AppleLocaleFields>;
}

const same = (a: unknown, b: string) => String(a ?? '').toLowerCase() === b.toLowerCase();

export async function loadRemoteListing(client: AppStoreConnect, app: AppRef, options: { platform?: string; versionString?: string } = {}): Promise<RemoteListing> {
  const versions = await listVersions(client, app.id, options.platform ?? 'IOS');
  const editable = editableVersion(versions) ?? null;
  const live = liveVersion(versions) ?? null;
  const requested = options.versionString ? versions.find((version) => version.attributes?.versionString === options.versionString) : undefined;
  if (options.versionString && !requested && !editable) throw new CliError(`Version ${options.versionString} not found in App Store Connect.`);
  const version = requested ?? editable ?? live ?? versions[0] ?? null;

  const infos = await listAppInfos(client, app.id);
  const infoEdit = editableInfo(infos) ?? null;
  const info =
    infoEdit ?? infos.find((item) => ['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE'].includes(String(item.attributes?.state ?? item.attributes?.appStoreState))) ?? infos[0] ?? null;

  const versionLocalizations = version ? (await client.getAll(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`)).data : [];
  const liveLocalizations = live && live.id !== version?.id ? (await client.getAll(`/v1/appStoreVersions/${live.id}/appStoreVersionLocalizations`)).data : versionLocalizations;
  const infoLocalizations = info ? (await client.getAll(`/v1/appInfos/${info.id}/appInfoLocalizations`)).data : [];

  const locales: Record<string, AppleLocaleFields> = {};
  for (const localization of [...versionLocalizations, ...infoLocalizations]) {
    const locale = String(localization.attributes?.locale ?? '');
    if (!locale) continue;
    const isInfo = localization.type === 'appInfoLocalizations';
    const fields = (locales[locale] ??= {});
    for (const field of APPLE_FIELD_NAMES) {
      const spec = APPLE_FIELDS[field];
      if ((spec.scope === 'info') !== isInfo) continue;
      const value = localization.attributes?.[spec.attribute];
      fields[field] = typeof value === 'string' ? value : '';
    }
  }

  return { app, versions, version, editable, live, info, infoEditable: infoEdit !== null, versionLocalizations, liveLocalizations, infoLocalizations, locales };
}

export interface LimitIssue {
  locale: string;
  field: AppleField;
  message: string;
}

export function checkLimits(locales: Record<string, AppleLocaleFields>): LimitIssue[] {
  const issues: LimitIssue[] = [];
  for (const [locale, fields] of Object.entries(locales)) {
    for (const field of APPLE_FIELD_NAMES) {
      const value = fields[field];
      const limit = (APPLE_FIELDS[field] as { limit?: number }).limit;
      if (value === undefined || !limit) continue;
      const size = field === 'keywords' ? bytes(value) : chars(value);
      if (size > limit) issues.push({ locale, field, message: `${locale} ${field} is ${size}/${limit} ${field === 'keywords' ? 'bytes' : 'characters'}.` });
    }
    if (fields.name !== undefined && normalise(fields.name) === null) issues.push({ locale, field: 'name', message: `${locale} name.txt is empty; the App Store needs a name.` });
  }
  return issues;
}

export interface PushPlan {
  changes: FieldChange[];
  /** Locales that don't exist in App Store Connect yet (version and/or app info localization). */
  missingLocales: string[];
  needsEditableVersion: boolean;
  needsEditableInfo: boolean;
}

/** Field-by-field comparison of local files with App Store Connect; only fields with a local file take part. */
export function planPush(remote: RemoteListing, local: Record<string, AppleLocaleFields>, only?: AppleField[]): PushPlan {
  const changes: FieldChange[] = [];
  const missing = new Set<string>();
  let needsEditableVersion = false;
  let needsEditableInfo = false;

  for (const [locale, fields] of Object.entries(local)) {
    const remoteKey = Object.keys(remote.locales).find((key) => same(key, locale));
    const remoteFields = remoteKey ? (remote.locales[remoteKey] as AppleLocaleFields) : undefined;
    for (const field of APPLE_FIELD_NAMES) {
      if (!(field in fields) || (only && !only.includes(field))) continue;
      const before = remoteFields?.[field];
      const after = fields[field];
      if (!changed(before, after)) continue;
      changes.push({ platform: 'ios', locale, field, before: normalise(before), after: normalise(after) });
      const scope = APPLE_FIELDS[field].scope;
      const hasLocalization =
        scope === 'info'
          ? remote.infoLocalizations.some((item) => same(item.attributes?.locale, locale))
          : remote.versionLocalizations.some((item) => same(item.attributes?.locale, locale));
      if (!hasLocalization) missing.add(locale);
      if (scope === 'info') needsEditableInfo = true;
      else if (field !== 'promotional_text') needsEditableVersion = true;
    }
  }
  return { changes, missingLocales: [...missing], needsEditableVersion, needsEditableInfo };
}

/**
 * Writes a plan. Promotional text also goes to the live version (Apple lets it change without review); every other
 * version field needs the editable version, the name/subtitle need the editable app info (created with a new version).
 */
export async function applyPush(client: AppStoreConnect, remote: RemoteListing, plan: PushPlan, options: { createLocales?: boolean; out?: Output }): Promise<{ written: number }> {
  if (plan.changes.length === 0) return { written: 0 };
  if (plan.missingLocales.length && !options.createLocales) {
    throw new CliError(`These locales don't exist in App Store Connect yet: ${plan.missingLocales.join(', ')}.`, { hint: 'Run again with --create-locales to add them.' });
  }
  if (plan.needsEditableVersion && !remote.editable) {
    throw new CliError(`There is no editable version (latest is ${remote.version?.attributes?.versionString ?? 'none'}, ${versionState(remote.version)}).`, {
      hint: 'Pass --create-version <x.y.z> to open a new version, or use `searvia release`. Only the promotional text can change on a live version.',
    });
  }
  if (plan.needsEditableInfo && !remote.infoEditable) {
    throw new CliError('The app name and subtitle can only change together with a new version.', { hint: 'Pass --create-version <x.y.z>.' });
  }

  let written = 0;
  const byLocale = new Map<string, FieldChange[]>();
  for (const change of plan.changes) byLocale.set(change.locale, [...(byLocale.get(change.locale) ?? []), change]);

  for (const [locale, changes] of byLocale) {
    const versionAttributes: Record<string, string> = {};
    const infoAttributes: Record<string, string> = {};
    for (const change of changes) {
      const spec = APPLE_FIELDS[change.field as AppleField];
      (spec.scope === 'info' ? infoAttributes : versionAttributes)[spec.attribute] = change.after ?? '';
    }

    if (Object.keys(versionAttributes).length) {
      const promoOnly = Object.keys(versionAttributes).every((key) => key === 'promotionalText');
      const targets: Array<{ version: Resource; localizations: Resource[] }> = [];
      if (remote.editable)
        targets.push({
          version: remote.editable,
          localizations:
            remote.editable.id === remote.version?.id
              ? remote.versionLocalizations
              : (await client.getAll(`/v1/appStoreVersions/${remote.editable.id}/appStoreVersionLocalizations`)).data,
        });
      if (promoOnly && remote.live && remote.live.id !== remote.editable?.id) targets.push({ version: remote.live, localizations: remote.liveLocalizations });
      if (targets.length === 0) throw new CliError('This app has no App Store version yet.', { hint: 'Pass --create-version <x.y.z>.' });

      for (const [index, target] of targets.entries()) {
        const existing = target.localizations.find((item) => same(item.attributes?.locale, locale));
        const attributes = index === 0 ? versionAttributes : { promotionalText: versionAttributes.promotionalText as string };
        if (existing) {
          await client.patch(`/v1/appStoreVersionLocalizations/${existing.id}`, { data: { type: 'appStoreVersionLocalizations', id: existing.id, attributes } });
        } else if (index === 0) {
          await client.post('/v1/appStoreVersionLocalizations', {
            data: { type: 'appStoreVersionLocalizations', attributes: { locale, ...attributes }, relationships: { appStoreVersion: ref('appStoreVersions', target.version.id) } },
          });
        } else continue;
        options.out?.debug(`${locale}: wrote ${Object.keys(attributes).join(', ')} to version ${target.version.attributes?.versionString}`);
      }
    }

    if (Object.keys(infoAttributes).length && remote.info) {
      const existing = remote.infoLocalizations.find((item) => same(item.attributes?.locale, locale));
      if (existing) {
        await client.patch(`/v1/appInfoLocalizations/${existing.id}`, { data: { type: 'appInfoLocalizations', id: existing.id, attributes: infoAttributes } });
      } else {
        if (!infoAttributes.name) throw new CliError(`A new ${locale} localization needs name.txt.`);
        await client.post('/v1/appInfoLocalizations', {
          data: { type: 'appInfoLocalizations', attributes: { locale, ...infoAttributes }, relationships: { appInfo: ref('appInfos', remote.info.id) } },
        });
      }
    }
    written += changes.length;
  }
  return { written };
}

export function listingUrl(app: AppRef): string {
  return consoleUrl(app.id);
}
