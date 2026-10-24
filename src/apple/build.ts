import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AscCredentials } from '../core/config.js';
import { CliError } from '../core/errors.js';
import type { Output } from '../core/output.js';
import { formatBytes, poll } from '../core/util.js';
import { parsePlist } from '../media/plist.js';
import { ZipFile } from '../media/zip.js';
import { type AppStoreConnect, type Resource, ref, relatedId } from './client.js';
import { runUploadOperations } from './upload.js';

export interface BundleInfo {
  bundleId?: string;
  shortVersion?: string;
  buildNumber?: string;
  usesNonExemptEncryption?: boolean;
}

/** Reads CFBundleIdentifier, CFBundleShortVersionString and CFBundleVersion from Payload/<App>.app/Info.plist. */
export function readIpaInfo(path: string): BundleInfo {
  const zip = ZipFile.open(path);
  try {
    const entry = zip.find(/^Payload\/[^/]+\.app\/Info\.plist$/);
    if (!entry) throw new CliError(`${basename(path)} has no Payload/*.app/Info.plist; is it an .ipa?`);
    const plist = parsePlist(zip.read(entry)) as Record<string, unknown>;
    return {
      bundleId: plist.CFBundleIdentifier as string | undefined,
      shortVersion: plist.CFBundleShortVersionString as string | undefined,
      buildNumber: plist.CFBundleVersion as string | undefined,
      usesNonExemptEncryption: typeof plist.ITSAppUsesNonExemptEncryption === 'boolean' ? plist.ITSAppUsesNonExemptEncryption : undefined,
    };
  } finally {
    zip.close();
  }
}

async function md5OfFile(path: string): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface BuildUploadResult {
  buildUploadId: string;
  state: string;
  buildId?: string;
  errors: string[];
  warnings: string[];
}

/**
 * Uploads an .ipa/.pkg with the App Store Connect build upload API (buildUploads + buildUploadFiles, App Store
 * Connect API 4.1): create the upload, reserve the file, send the parts, commit with the MD5 checksum, then wait
 * until Apple has processed it.
 * https://developer.apple.com/documentation/appstoreconnectapi/build-uploads
 */
export async function uploadBuild(
  client: AppStoreConnect,
  options: { appId: string; path: string; platform: string; shortVersion: string; buildNumber: string; wait: boolean; timeoutMs: number; out?: Output },
): Promise<BuildUploadResult> {
  const { size } = await stat(options.path);
  const isPkg = /\.pkg$/i.test(options.path);
  const upload = await client.post('/v1/buildUploads', {
    data: {
      type: 'buildUploads',
      attributes: { cfBundleShortVersionString: options.shortVersion, cfBundleVersion: options.buildNumber, platform: options.platform },
      relationships: { app: ref('apps', options.appId) },
    },
  });
  const file = await client.post('/v1/buildUploadFiles', {
    data: {
      type: 'buildUploadFiles',
      attributes: { fileName: basename(options.path), fileSize: size, uti: isPkg ? 'com.apple.pkg' : 'com.apple.ipa', assetType: 'ASSET' },
      relationships: { buildUpload: ref('buildUploads', upload.id) },
    },
  });

  options.out?.step(`Uploading ${basename(options.path)} (${formatBytes(size)})`);
  const handle = await open(options.path, 'r');
  let reported = 0;
  try {
    await runUploadOperations(
      file.attributes?.uploadOperations ?? [],
      async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      },
      {
        out: options.out,
        onProgress: (done, total) => {
          const percent = Math.floor((done / total) * 100);
          if (percent >= reported + 20) {
            reported = percent - (percent % 20);
            options.out?.debug(`${percent}% uploaded`);
          }
        },
      },
    );
  } finally {
    await handle.close();
  }

  await client.patch(`/v1/buildUploadFiles/${file.id}`, {
    data: { type: 'buildUploadFiles', id: file.id, attributes: { uploaded: true, sourceFileChecksums: { file: { hash: await md5OfFile(options.path), algorithm: 'MD5' } } } },
  });

  const read = async (): Promise<BuildUploadResult> => {
    const current = (await client.get(`/v1/buildUploads/${upload.id}`, { include: 'build' })).data as Resource;
    const state = current.attributes?.state ?? {};
    const text = (list?: Array<{ code?: string; description?: string }>) => (list ?? []).map((item) => item.description ?? item.code ?? '').filter(Boolean);
    return {
      buildUploadId: upload.id,
      state: String(state.state ?? 'PROCESSING'),
      buildId: relatedId(current, 'build'),
      errors: text(state.errors),
      warnings: text(state.warnings),
    };
  };

  if (!options.wait) return read();
  options.out?.step('Waiting for App Store Connect to process the upload');
  const final = await poll(
    async () => {
      const current = await read();
      return current.state === 'COMPLETE' || current.state === 'FAILED' ? current : undefined;
    },
    { intervalMs: 15_000, timeoutMs: options.timeoutMs },
  );
  const result = final ?? (await read());
  if (result.state === 'FAILED') throw new CliError(`App Store Connect rejected the build: ${result.errors.join('; ') || 'processing failed'}.`, { details: result });
  return result;
}

/**
 * Fallback for machines without API build uploads: `xcrun altool --upload-app` with the same API key. altool looks
 * for AuthKey_<KEY_ID>.p8 in API_PRIVATE_KEYS_DIR, so the key is written to a private temp folder for the call.
 */
export async function uploadWithAltool(path: string, credentials: AscCredentials, platform: string, out?: Output): Promise<void> {
  if (process.platform !== 'darwin') throw new CliError('--altool needs macOS with Xcode installed.');
  if (!credentials.issuerId) throw new CliError('altool needs a team API key (with an issuer id).');
  const dir = await mkdtemp(join(tmpdir(), 'searvia-keys-'));
  try {
    await writeFile(join(dir, `AuthKey_${credentials.keyId}.p8`), credentials.privateKey, { mode: 0o600 });
    const type = { IOS: 'ios', MAC_OS: 'macos', TV_OS: 'appletvos', VISION_OS: 'visionos' }[platform] ?? 'ios';
    const args = ['altool', '--upload-app', '-f', path, '-t', type, '--apiKey', credentials.keyId, '--apiIssuer', credentials.issuerId];
    out?.step(`xcrun ${args.join(' ')}`);
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn('xcrun', args, { stdio: 'inherit', env: { ...process.env, API_PRIVATE_KEYS_DIR: dir } });
      child.on('error', reject);
      child.on('exit', (exit) => resolve(exit ?? 1));
    });
    if (code !== 0) throw new CliError(`altool exited with code ${code}.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Finds the build for a version/build number, waiting until processing finished (processingState VALID). */
export async function waitForBuild(
  client: AppStoreConnect,
  options: { appId: string; versionString: string; buildNumber?: string; timeoutMs: number; out?: Output },
): Promise<Resource> {
  const query = {
    'filter[app]': options.appId,
    'filter[preReleaseVersion.version]': options.versionString,
    ...(options.buildNumber ? { 'filter[version]': options.buildNumber } : {}),
    sort: '-uploadedDate',
    limit: 1,
  };
  let announced = false;
  const build = await poll(
    async () => {
      const found = ((await client.get('/v1/builds', query)).data as Resource[])[0];
      const state = found?.attributes?.processingState;
      if (state === 'VALID') return found;
      if (state === 'FAILED' || state === 'INVALID') throw new CliError(`Build ${found?.attributes?.version} is ${state} in App Store Connect.`);
      if (!announced) {
        options.out?.step(found ? `Build ${found.attributes?.version} is processing…` : `Waiting for build ${options.buildNumber ?? ''} of ${options.versionString} to appear…`);
        announced = true;
      }
      return undefined;
    },
    { intervalMs: 30_000, timeoutMs: options.timeoutMs },
  );
  if (!build) {
    throw new CliError(`No processed build ${options.buildNumber ?? ''} for version ${options.versionString} yet.`, {
      hint: 'Upload one with `searvia build upload`, or raise --timeout.',
    });
  }
  return build;
}
