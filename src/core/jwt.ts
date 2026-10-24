import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { CliError } from './errors.js';

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

function encode(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
}

export function loadPrivateKey(pem: string, what: string): KeyObject {
  try {
    // Keys pasted into CI secrets often lose their line breaks or keep literal "\n".
    const text = pem.includes('\\n') && !pem.includes('\n') ? pem.replace(/\\n/g, '\n') : pem;
    return createPrivateKey({ key: text, format: 'pem' });
  } catch {
    throw new CliError(`${what} is not a valid PEM private key.`, {
      hint: 'Use the full file contents including the BEGIN/END PRIVATE KEY lines.',
    });
  }
}

/**
 * ES256 JWT for the App Store Connect API (header alg ES256, kid, typ JWT; payload iss, iat, exp ≤ 20 min, aud
 * appstoreconnect-v1). Individual keys use `sub: "user"` instead of `iss`.
 * https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests
 */
export function signAppStoreConnectToken(options: { keyId: string; issuerId?: string; privateKey: string; now?: number; lifetimeSeconds?: number }): string {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const lifetime = Math.min(options.lifetimeSeconds ?? 1140, 1200);
  const payload: Record<string, unknown> = options.issuerId
    ? { iss: options.issuerId, iat: now, exp: now + lifetime, aud: 'appstoreconnect-v1' }
    : { sub: 'user', iat: now, exp: now + lifetime, aud: 'appstoreconnect-v1' };
  const input = encode({ alg: 'ES256', kid: options.keyId, typ: 'JWT' }, payload);
  const key = loadPrivateKey(options.privateKey, 'The App Store Connect .p8 key');
  if (key.asymmetricKeyType !== 'ec') throw new CliError('The App Store Connect key must be an EC (P-256) .p8 key.');
  // JWS wants the raw r||s signature (IEEE P1363), not DER.
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${base64url(signature)}`;
}

/**
 * RS256 assertion for the Google OAuth 2.0 service-account flow (iss = client_email, scope, aud = token_uri, ≤ 1 h).
 * https://developers.google.com/identity/protocols/oauth2/service-account#httprest
 */
export function signGoogleAssertion(options: { clientEmail: string; privateKey: string; scope: string; audience: string; privateKeyId?: string; now?: number }): string {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' };
  if (options.privateKeyId) header.kid = options.privateKeyId;
  const input = encode(header, { iss: options.clientEmail, scope: options.scope, aud: options.audience, iat: now, exp: now + 3600 });
  const key = loadPrivateKey(options.privateKey, 'The service account private_key');
  const signature = sign('RSA-SHA256', Buffer.from(input), key);
  return `${input}.${base64url(signature)}`;
}

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signature: Buffer } {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new Error('Not a JWT.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    signature: Buffer.from(signature, 'base64url'),
  };
}
