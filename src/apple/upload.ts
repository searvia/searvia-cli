import { ApiError } from '../core/errors.js';
import { httpRequest, redact } from '../core/http.js';
import type { Output } from '../core/output.js';
import { mapLimit } from '../core/util.js';

export interface UploadOperation {
  method: string;
  url: string;
  length: number;
  offset: number;
  requestHeaders?: Array<{ name: string; value: string }>;
}

/**
 * Sends the parts an asset reservation asked for: each operation names the method, the (pre-signed, unauthenticated)
 * URL, the headers and the byte range of the original file. Parts may go in parallel and in any order.
 * https://developer.apple.com/documentation/appstoreconnectapi/uploading-assets-to-app-store-connect
 */
export async function runUploadOperations(
  operations: UploadOperation[],
  readPart: (offset: number, length: number) => Promise<Buffer>,
  options: { out?: Output; concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<void> {
  let done = 0;
  const total = operations.reduce((sum, operation) => sum + operation.length, 0);
  await mapLimit(operations, options.concurrency ?? 4, async (operation) => {
    const body = await readPart(operation.offset, operation.length);
    const headers = Object.fromEntries((operation.requestHeaders ?? []).map((header) => [header.name, header.value]));
    const response = await httpRequest({ method: operation.method, url: operation.url, headers, body }, { service: 'App Store Connect upload', out: options.out });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError('App Store Connect upload', response.status, `part at offset ${operation.offset} failed (${redact(operation.url)}): ${text.slice(0, 200)}`);
    }
    await response.arrayBuffer().catch(() => undefined);
    done += operation.length;
    options.onProgress?.(done, total);
  });
}
