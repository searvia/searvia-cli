import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONFIG_FILE, LOCAL_CONFIG_FILE, type SearviaConfig } from '../core/config.js';
import { CliError } from '../core/errors.js';
import { ask, interactive } from '../core/prompt.js';
import type { Command } from './context.js';

interface Detected {
  metadataPath?: string;
  screenshotsPath?: string;
  bundleId?: string;
  packageName?: string;
  serviceAccountPath?: string;
  keyPath?: string;
  keyId?: string;
  notes: string[];
}

/** Reads what a fastlane setup or an Android project already knows. */
export function detect(root: string): Detected {
  const found: Detected = { notes: [] };
  if (existsSync(join(root, 'fastlane', 'metadata'))) {
    found.metadataPath = 'fastlane/metadata';
    found.notes.push('fastlane/metadata (deliver/supply layout)');
  }
  if (existsSync(join(root, 'fastlane', 'screenshots'))) {
    found.screenshotsPath = 'fastlane/screenshots';
    found.notes.push('fastlane/screenshots');
  }
  const appfile = join(root, 'fastlane', 'Appfile');
  if (existsSync(appfile)) {
    const text = readFileSync(appfile, 'utf8');
    found.bundleId = /app_identifier\s*\(?\s*["']([^"']+)["']/.exec(text)?.[1];
    found.packageName = /package_name\s*\(?\s*["']([^"']+)["']/.exec(text)?.[1];
    found.serviceAccountPath = /json_key_file\s*\(?\s*["']([^"']+)["']/.exec(text)?.[1];
    found.notes.push('fastlane/Appfile');
  }
  for (const gradle of ['android/app/build.gradle', 'android/app/build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts']) {
    const path = join(root, gradle);
    if (!found.packageName && existsSync(path)) {
      found.packageName = /applicationId\s*=?\s*["']([^"']+)["']/.exec(readFileSync(path, 'utf8'))?.[1];
      if (found.packageName) found.notes.push(gradle);
    }
  }
  for (const dir of [root, join(root, '.searvia'), join(root, 'fastlane')]) {
    if (!existsSync(dir)) continue;
    const key = readdirSync(dir).find((name) => /^AuthKey_[A-Z0-9]+\.p8$/.test(name));
    if (key) {
      found.keyPath = relative(root, join(dir, key));
      found.keyId = /^AuthKey_([A-Z0-9]+)\.p8$/.exec(key)?.[1];
      break;
    }
  }
  return found;
}

function ensureIgnored(root: string, entries: string[]): string[] {
  const path = join(root, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !lines.has(entry));
  if (missing.length) appendFileSync(path, `${current && !current.endsWith('\n') ? '\n' : ''}# searvia: local credentials\n${missing.join('\n')}\n`);
  return missing;
}

export const init: Command = {
  name: 'init',
  summary: 'Create searvia.config.json (detects fastlane folders and apps)',
  usage: 'searvia init [--bundle-id ..] [--package-name ..] [--key-id .. --issuer-id .. --key-path ..] [--service-account ..]',
  description:
    'Writes searvia.config.json (shareable: app ids and folders) and .searvia/config.json (local: key ids and paths to the .p8 key and service-account JSON), and adds .searvia/ and key files to .gitignore. Keys never leave your machine except to Apple and Google. Prompts for missing values in a terminal; in CI pass flags or use environment variables instead.',
  options: [
    { name: 'bundle-id', type: 'string', value: '<id>', description: 'iOS bundle identifier.' },
    { name: 'app-id', type: 'string', value: '<id>', description: 'App Store Connect Apple ID (numeric), instead of the bundle id.' },
    { name: 'package-name', type: 'string', value: '<name>', description: 'Android application id.' },
    { name: 'key-id', type: 'string', value: '<id>', description: 'App Store Connect API key id.' },
    { name: 'issuer-id', type: 'string', value: '<uuid>', description: 'App Store Connect issuer id (team keys).' },
    { name: 'key-path', type: 'string', value: '<file.p8>', description: 'Path to the AuthKey_XXXX.p8 file.' },
    { name: 'service-account', type: 'string', value: '<file.json>', description: 'Path to the Google Play service account JSON.' },
    { name: 'metadata-path', type: 'string', value: '<dir>', description: 'Metadata folder (default fastlane/metadata).' },
    { name: 'screenshots-path', type: 'string', value: '<dir>', description: 'Screenshots folder (default fastlane/screenshots).' },
    { name: 'force', type: 'boolean', description: 'Overwrite an existing config.' },
  ],
  examples: ['searvia init', 'searvia init --bundle-id com.example.app --package-name com.example.app --key-path ~/keys/AuthKey_ABC123.p8 --issuer-id 69a6de7e-...'],
  async run(context) {
    const root = context.cwd;
    const configPath = join(root, CONFIG_FILE);
    const localPath = join(root, LOCAL_CONFIG_FILE);
    if (existsSync(configPath) && !context.options.force) throw new CliError(`${CONFIG_FILE} already exists.`, { hint: 'Pass --force to overwrite it.' });

    const found = detect(root);
    if (found.notes.length) context.out.log(`Found: ${found.notes.join(', ')}`);
    const prompt = interactive() && !context.out.json;
    const value = async (flag: string, question: string, fallback?: string) => {
      const given = context.options[flag] as string | undefined;
      if (given) return given;
      return prompt ? await ask(question, fallback) : (fallback ?? '');
    };

    const bundleId = await value('bundleId', 'iOS bundle id (empty to skip iOS)', found.bundleId);
    const appId = context.options.appId as string | undefined;
    const iosEnabled = Boolean(bundleId || appId);
    const keyPath = iosEnabled ? await value('keyPath', 'Path to the App Store Connect .p8 key', found.keyPath) : '';
    const keyId = iosEnabled ? await value('keyId', 'API key id', found.keyId ?? /AuthKey_([A-Z0-9]+)\.p8$/.exec(keyPath)?.[1]) : '';
    const issuerId = iosEnabled ? await value('issuerId', 'Issuer id (empty for an individual key)') : '';
    const packageName = await value('packageName', 'Android package name (empty to skip Android)', found.packageName);
    const serviceAccount = packageName ? await value('serviceAccount', 'Path to the Google Play service account JSON', found.serviceAccountPath) : '';

    const shared: SearviaConfig & { $schema: string } = {
      $schema: 'https://unpkg.com/searvia/schema/config.schema.json',
      metadataPath: (context.options.metadataPath as string | undefined) ?? found.metadataPath ?? 'fastlane/metadata',
      screenshotsPath: (context.options.screenshotsPath as string | undefined) ?? found.screenshotsPath ?? 'fastlane/screenshots',
    };
    if (iosEnabled) shared.ios = { ...(bundleId ? { bundleId } : {}), ...(appId ? { appId } : {}), countries: [], brand: [], avoid: [] };
    if (packageName) shared.android = { packageName, track: 'production' };

    const local: SearviaConfig = {};
    if (iosEnabled && (keyId || keyPath || issuerId))
      local.ios = { ...(keyId ? { keyId } : {}), ...(issuerId ? { issuerId } : {}), ...(keyPath ? { privateKeyPath: keyPath } : {}) };
    if (serviceAccount) local.android = { serviceAccountPath: serviceAccount };

    writeFileSync(configPath, `${JSON.stringify(shared, null, 2)}\n`);
    mkdirSync(join(root, '.searvia'), { recursive: true });
    writeFileSync(localPath, `${JSON.stringify(local, null, 2)}\n`, { mode: 0o600 });

    const ignore = ['.searvia/'];
    for (const path of [keyPath, serviceAccount]) {
      if (path && !path.startsWith('/') && !path.startsWith('~') && !path.startsWith('..') && !path.startsWith('.searvia/')) ignore.push(path);
    }
    const added = existsSync(join(root, '.git')) || existsSync(join(root, '.gitignore')) ? ensureIgnored(root, ignore) : [];

    context.out.success(`Wrote ${CONFIG_FILE} and ${LOCAL_CONFIG_FILE}${added.length ? `; added ${added.join(', ')} to .gitignore` : ''}.`);
    context.out.log('\nNext:\n  searvia doctor        check the keys\n  searvia pull          download your listings\n  searvia audit         offline ASO audit');
    return { config: shared, local: { ios: local.ios ? Object.keys(local.ios) : [], android: local.android ? Object.keys(local.android) : [] }, gitignore: added };
  },
};
