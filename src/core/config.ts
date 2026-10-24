import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CliError } from './errors.js';
import { isRecord } from './util.js';

export interface AppReviewConfig {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  demoUser?: string;
  /** Name of the environment variable holding the demo password (default SEARVIA_DEMO_PASSWORD). */
  demoPasswordEnv?: string;
  demoRequired?: boolean;
  notes?: string;
}

export interface IosConfig {
  /** Numeric App Store Connect app id (Apple ID). Either this or bundleId. */
  appId?: string;
  bundleId?: string;
  platform?: 'IOS' | 'MAC_OS' | 'TV_OS' | 'VISION_OS';
  keyId?: string;
  /** Team keys have an issuer id; individual keys don't. */
  issuerId?: string;
  privateKeyPath?: string;
  /** Storefront countries for the cross-locale audit (default: every storefront where two of your locales are indexed together). */
  countries?: string[];
  /** Your own brand words (allowed in every locale). */
  brand?: string[];
  /** Other companies' brand words that must not appear in metadata. */
  avoid?: string[];
  /** Words to put first when `audit --fix` packs the keyword field. */
  keywords?: string[];
  usesNonExemptEncryption?: boolean;
  releaseType?: 'MANUAL' | 'AFTER_APPROVAL' | 'SCHEDULED';
  earliestReleaseDate?: string;
  phasedRelease?: boolean;
  copyright?: string;
  contentRightsDeclaration?: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' | 'USES_THIRD_PARTY_CONTENT';
  review?: AppReviewConfig;
  /** AgeRatingDeclaration attributes, sent as-is (e.g. { "gambling": false, "violenceCartoonOrFantasy": "NONE" }). */
  ageRating?: Record<string, unknown>;
}

export interface AndroidConfig {
  packageName?: string;
  serviceAccountPath?: string;
  /** Default track for release/build upload (default production for release, internal for build upload). */
  track?: string;
  /** Tracked keywords for the Play density audit. */
  keywords?: string[];
  metadataPath?: string;
}

export interface SearviaConfig {
  metadataPath?: string;
  screenshotsPath?: string;
  ios?: IosConfig;
  android?: AndroidConfig;
  searvia?: { projectId?: number; url?: string };
}

export interface LoadedConfig {
  /** The merged config. */
  config: SearviaConfig;
  /** Directory paths are resolved against (the project root). */
  root: string;
  /** Files that were read, in merge order. */
  files: string[];
  env: NodeJS.ProcessEnv;
}

export const CONFIG_FILE = 'searvia.config.json';
export const LOCAL_CONFIG_FILE = join('.searvia', 'config.json');

function deepMerge<T extends Record<string, unknown>>(base: T, extra: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = isRecord(value) && isRecord(out[key]) ? deepMerge(out[key] as Record<string, unknown>, value) : value;
  }
  return out as T;
}

function readJsonFile(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CliError(`Could not read ${path}: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new CliError(`${path} must contain a JSON object.`);
  return parsed;
}

/** Finds the project root: the nearest directory (upwards) with a searvia config, else the working directory. */
export function findRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE)) || existsSync(join(dir, LOCAL_CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/**
 * Loads `searvia.config.json` (shareable, committed) and `.searvia/config.json` (local, git-ignored, may hold key
 * paths), then applies environment variables, which always win (CI).
 */
export function loadConfig(options: { cwd?: string; file?: string; env?: NodeJS.ProcessEnv } = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const files: string[] = [];
  let config: SearviaConfig = {};
  let root: string;

  if (options.file) {
    const path = resolve(cwd, options.file);
    if (!existsSync(path)) throw new CliError(`Config file ${path} does not exist.`);
    config = readJsonFile(path) as SearviaConfig;
    files.push(path);
    root = dirname(path);
  } else {
    root = findRoot(cwd);
    for (const name of [CONFIG_FILE, LOCAL_CONFIG_FILE]) {
      const path = join(root, name);
      if (existsSync(path)) {
        config = deepMerge(config as Record<string, unknown>, readJsonFile(path)) as SearviaConfig;
        files.push(path);
      }
    }
  }

  const ios: IosConfig = { ...config.ios };
  const android: AndroidConfig = { ...config.android };
  if (env.ASC_APP_ID) ios.appId = env.ASC_APP_ID;
  if (env.ASC_BUNDLE_ID) ios.bundleId = env.ASC_BUNDLE_ID;
  if (env.ASC_KEY_ID) ios.keyId = env.ASC_KEY_ID;
  if (env.ASC_ISSUER_ID) ios.issuerId = env.ASC_ISSUER_ID;
  if (env.ASC_PRIVATE_KEY_PATH) ios.privateKeyPath = env.ASC_PRIVATE_KEY_PATH;
  if (env.GOOGLE_PLAY_PACKAGE_NAME) android.packageName = env.GOOGLE_PLAY_PACKAGE_NAME;
  if (env.GOOGLE_PLAY_SERVICE_ACCOUNT_PATH) android.serviceAccountPath = env.GOOGLE_PLAY_SERVICE_ACCOUNT_PATH;
  config = { ...config, ios, android };

  return { config, root, files, env };
}

export function resolvePath(loaded: LoadedConfig, path: string): string {
  return isAbsolute(path) ? path : join(loaded.root, path);
}

export function metadataDir(loaded: LoadedConfig): string {
  return resolvePath(loaded, loaded.config.metadataPath ?? 'fastlane/metadata');
}

export function androidMetadataDir(loaded: LoadedConfig): string {
  return resolvePath(loaded, loaded.config.android?.metadataPath ?? join(loaded.config.metadataPath ?? 'fastlane/metadata', 'android'));
}

export function screenshotsDir(loaded: LoadedConfig): string {
  return resolvePath(loaded, loaded.config.screenshotsPath ?? 'fastlane/screenshots');
}

export interface AscCredentials {
  keyId: string;
  issuerId?: string;
  privateKey: string;
}

/** App Store Connect key from ASC_PRIVATE_KEY (contents), ASC_PRIVATE_KEY_PATH or config ios.privateKeyPath. */
export function ascCredentials(loaded: LoadedConfig): AscCredentials {
  const ios = loaded.config.ios ?? {};
  const keyId = ios.keyId;
  let privateKey = loaded.env.ASC_PRIVATE_KEY;
  if (!privateKey && ios.privateKeyPath) {
    const path = resolvePath(loaded, ios.privateKeyPath.replace(/^~(?=\/)/, homedir()));
    if (!existsSync(path)) throw new CliError(`App Store Connect key file ${path} does not exist.`);
    privateKey = readFileSync(path, 'utf8');
  }
  if (!keyId || !privateKey) {
    throw new CliError('App Store Connect credentials are missing.', {
      hint: 'Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY (or ASC_PRIVATE_KEY_PATH), or run `searvia init`. Create a key in App Store Connect › Users and Access › Integrations › App Store Connect API (role: App Manager).',
    });
  }
  return { keyId, issuerId: ios.issuerId || undefined, privateKey };
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

/** Google service account from GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (contents), a path, or GOOGLE_APPLICATION_CREDENTIALS. */
export function playCredentials(loaded: LoadedConfig): ServiceAccount {
  let text = loaded.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  const path = loaded.config.android?.serviceAccountPath ?? loaded.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!text && path) {
    const full = resolvePath(loaded, path.replace(/^~(?=\/)/, homedir()));
    if (!existsSync(full)) throw new CliError(`Service account file ${full} does not exist.`);
    text = readFileSync(full, 'utf8');
  }
  if (!text) {
    throw new CliError('Google Play credentials are missing.', {
      hint: 'Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (file contents) or GOOGLE_PLAY_SERVICE_ACCOUNT_PATH, or run `searvia init`. Invite the service account in Play Console › Users and permissions.',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError('The Google service account is not valid JSON.');
  }
  if (!isRecord(parsed) || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    throw new CliError('The Google service account JSON has no client_email/private_key.', {
      hint: 'Download a JSON key for the service account in Google Cloud Console › IAM › Service accounts › Keys.',
    });
  }
  return parsed as unknown as ServiceAccount;
}

export function hasIos(loaded: LoadedConfig): boolean {
  const ios = loaded.config.ios ?? {};
  return Boolean(ios.appId || ios.bundleId || ios.keyId || loaded.env.ASC_KEY_ID);
}

export function hasAndroid(loaded: LoadedConfig): boolean {
  const android = loaded.config.android ?? {};
  return Boolean(android.packageName || android.serviceAccountPath || loaded.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
}

/** User-level directory for the Searvia API key (never inside the project). */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SEARVIA_HOME) return env.SEARVIA_HOME;
  const base = env.XDG_CONFIG_HOME || (process.platform === 'win32' ? env.APPDATA || join(homedir(), 'AppData', 'Roaming') : join(homedir(), '.config'));
  return join(base, 'searvia');
}
