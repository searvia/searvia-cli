import { verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeJwt, signAppStoreConnectToken, signGoogleAssertion } from '../src/core/jwt.js';
import { ecKey, rsaKey } from './helpers.js';

describe('App Store Connect ES256 token', () => {
  const key = ecKey();

  it('has the header and claims Apple documents and a valid P-256 signature', () => {
    const token = signAppStoreConnectToken({ keyId: 'ABC123DEFG', issuerId: '57246542-96fe-1a63-e053-0824d011072a', privateKey: key.privateKey, now: 1_528_407_600_000 });
    const { header, payload, signature } = decodeJwt(token);
    expect(header).toEqual({ alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
    expect(payload).toEqual({ iss: '57246542-96fe-1a63-e053-0824d011072a', iat: 1_528_407_600, exp: 1_528_407_600 + 1140, aud: 'appstoreconnect-v1' });
    // JWS ES256 = raw 64-byte r||s, not DER.
    expect(signature.length).toBe(64);
    const [h, p] = token.split('.');
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
  });

  it('never exceeds the 20 minute lifetime and uses sub=user for individual keys', () => {
    const token = signAppStoreConnectToken({ keyId: 'K', privateKey: key.privateKey, now: 0, lifetimeSeconds: 3600 });
    const { payload } = decodeJwt(token);
    expect(payload.exp).toBe(1200);
    expect(payload.sub).toBe('user');
    expect(payload.iss).toBeUndefined();
  });

  it('accepts keys whose newlines were flattened to \\n in CI secrets', () => {
    const flattened = key.privateKey.trim().replace(/\n/g, '\\n');
    expect(() => signAppStoreConnectToken({ keyId: 'K', issuerId: 'I', privateKey: flattened })).not.toThrow();
  });

  it('rejects RSA keys and garbage', () => {
    expect(() => signAppStoreConnectToken({ keyId: 'K', issuerId: 'I', privateKey: rsaKey().privateKey })).toThrow(/EC/);
    expect(() => signAppStoreConnectToken({ keyId: 'K', issuerId: 'I', privateKey: 'nope' })).toThrow(/PEM/);
  });
});

describe('Google service account RS256 assertion', () => {
  it('signs iss/scope/aud/iat/exp with RS256', () => {
    const key = rsaKey();
    const token = signGoogleAssertion({
      clientEmail: 'ci@project.iam.gserviceaccount.com',
      privateKey: key.privateKey,
      privateKeyId: 'kid1',
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      audience: 'https://oauth2.googleapis.com/token',
      now: 1000_000,
    });
    const { header, payload, signature } = decodeJwt(token);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid1' });
    expect(payload).toEqual({
      iss: 'ci@project.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1000,
      exp: 4600,
    });
    const [h, p] = token.split('.');
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key.publicKey, signature)).toBe(true);
  });
});
