import type { IosConfig } from '../core/config.js';
import { CliError } from '../core/errors.js';
import { type AppStoreConnect, type Resource, ref } from './client.js';

/** Version states in which metadata, screenshots and the build can still change. */
export const EDITABLE_STATES = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
export const LIVE_STATES = ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'];
/** App info states in which the name and subtitle can change. */
const EDITABLE_INFO_STATES = [...EDITABLE_STATES, 'PREPARE_FOR_SUBMISSION'];

export interface AppRef {
  id: string;
  name: string;
  bundleId: string;
  primaryLocale?: string;
}

export function versionState(version: Resource | null | undefined): string {
  return String(version?.attributes?.appVersionState ?? version?.attributes?.appStoreState ?? '');
}

export function infoState(info: Resource | null | undefined): string {
  return String(info?.attributes?.state ?? info?.attributes?.appStoreState ?? '');
}

export const consoleUrl = (appId: string, page = 'distribution') => `https://appstoreconnect.apple.com/apps/${appId}/${page}`;

/** The app from ios.appId or ios.bundleId. Apps cannot be created through the API: the record must exist first. */
export async function resolveApp(client: AppStoreConnect, ios: IosConfig): Promise<AppRef> {
  let app: Resource | undefined;
  if (ios.appId) {
    app = (await client.get(`/v1/apps/${encodeURIComponent(ios.appId)}`, { 'fields[apps]': 'name,bundleId,primaryLocale' })).data as Resource;
  } else if (ios.bundleId) {
    const { data } = await client.getAll('/v1/apps', { 'filter[bundleId]': ios.bundleId, 'fields[apps]': 'name,bundleId,primaryLocale' });
    app = data.find((item) => item.attributes?.bundleId === ios.bundleId);
  } else {
    throw new CliError('No iOS app configured.', { hint: 'Set ios.bundleId (or ios.appId) in searvia.config.json, or ASC_BUNDLE_ID.' });
  }
  if (!app) {
    throw new CliError(`No App Store Connect app with bundle id ${ios.bundleId}.`, {
      hint: 'Apple does not allow creating app records through the API. Create it once in App Store Connect › Apps › + (https://appstoreconnect.apple.com/apps), then run again.',
    });
  }
  return { id: app.id, name: String(app.attributes?.name ?? ''), bundleId: String(app.attributes?.bundleId ?? ''), primaryLocale: app.attributes?.primaryLocale };
}

/** Versions of the platform, newest first. */
export async function listVersions(client: AppStoreConnect, appId: string, platform = 'IOS'): Promise<Resource[]> {
  const { data } = await client.getAll(`/v1/apps/${appId}/appStoreVersions`, { 'filter[platform]': platform });
  return data.sort((a, b) => String(b.attributes?.createdDate ?? '').localeCompare(String(a.attributes?.createdDate ?? '')));
}

export function editableVersion(versions: Resource[]): Resource | undefined {
  return versions.find((version) => EDITABLE_STATES.includes(versionState(version)));
}

export function liveVersion(versions: Resource[]): Resource | undefined {
  return versions.find((version) => LIVE_STATES.includes(versionState(version)));
}

export async function listAppInfos(client: AppStoreConnect, appId: string): Promise<Resource[]> {
  return (await client.getAll(`/v1/apps/${appId}/appInfos`)).data;
}

export function editableInfo(infos: Resource[]): Resource | undefined {
  return infos.find((info) => EDITABLE_INFO_STATES.includes(infoState(info)));
}

/**
 * The version to work on: the editable version when it exists (renamed to `versionString` if given and different),
 * else a new one when `create` is set. Apple allows one editable version per platform.
 */
export async function ensureVersion(
  client: AppStoreConnect,
  appId: string,
  options: { versionString?: string; platform?: string; create?: boolean; dryRun?: boolean },
): Promise<{ version: Resource | null; action: 'existing' | 'renamed' | 'created' | 'would-create' | 'would-rename' }> {
  const platform = options.platform ?? 'IOS';
  const versions = await listVersions(client, appId, platform);
  const editable = editableVersion(versions);

  if (editable) {
    const current = String(editable.attributes?.versionString ?? '');
    if (!options.versionString || options.versionString === current) return { version: editable, action: 'existing' };
    if (options.dryRun) return { version: editable, action: 'would-rename' };
    const renamed = await client.patch(`/v1/appStoreVersions/${editable.id}`, {
      data: { type: 'appStoreVersions', id: editable.id, attributes: { versionString: options.versionString } },
    });
    return { version: renamed ?? editable, action: 'renamed' };
  }

  if (!options.versionString || !options.create) return { version: null, action: 'existing' };
  if (versions.some((version) => version.attributes?.versionString === options.versionString)) {
    throw new CliError(
      `Version ${options.versionString} already exists and can no longer be edited (${versionState(versions.find((v) => v.attributes?.versionString === options.versionString))}).`,
      {
        hint: 'Use a higher version number.',
      },
    );
  }
  if (options.dryRun) return { version: null, action: 'would-create' };
  const created = await client.post('/v1/appStoreVersions', {
    data: { type: 'appStoreVersions', attributes: { platform, versionString: options.versionString }, relationships: { app: ref('apps', appId) } },
  });
  return { version: created, action: 'created' };
}
