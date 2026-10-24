import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { localeDirs, readText, writeText } from './files.js';

/**
 * App Store metadata in fastlane `deliver` layout: `<metadata>/<locale>/<field>.txt`, plus `copyright.txt` and
 * `review_information/*.txt` at the root. Title/subtitle/privacy URLs live on the app info localization
 * (appInfoLocalizations), the rest on the version localization (appStoreVersionLocalizations).
 * https://developer.apple.com/documentation/appstoreconnectapi/appstoreversionlocalization
 */
export const APPLE_FIELDS = {
  name: { scope: 'info', attribute: 'name', limit: 30 },
  subtitle: { scope: 'info', attribute: 'subtitle', limit: 30 },
  privacy_url: { scope: 'info', attribute: 'privacyPolicyUrl' },
  privacy_choices_url: { scope: 'info', attribute: 'privacyChoicesUrl' },
  keywords: { scope: 'version', attribute: 'keywords', limit: 100 },
  description: { scope: 'version', attribute: 'description', limit: 4000 },
  promotional_text: { scope: 'version', attribute: 'promotionalText', limit: 170 },
  release_notes: { scope: 'version', attribute: 'whatsNew', limit: 4000 },
  support_url: { scope: 'version', attribute: 'supportUrl' },
  marketing_url: { scope: 'version', attribute: 'marketingUrl' },
} as const satisfies Record<string, { scope: 'info' | 'version'; attribute: string; limit?: number }>;

export type AppleField = keyof typeof APPLE_FIELDS;
export const APPLE_FIELD_NAMES = Object.keys(APPLE_FIELDS) as AppleField[];
export type AppleLocaleFields = Partial<Record<AppleField, string>>;

/** fastlane review_information file → AppStoreReviewDetail attribute. */
export const REVIEW_FILES = {
  first_name: 'contactFirstName',
  last_name: 'contactLastName',
  phone_number: 'contactPhone',
  email_address: 'contactEmail',
  demo_user: 'demoAccountName',
  demo_password: 'demoAccountPassword',
  notes: 'notes',
} as const;

export interface AppleMetadata {
  locales: Record<string, AppleLocaleFields>;
  copyright?: string;
  review: Partial<Record<keyof typeof REVIEW_FILES, string>>;
}

const NOT_LOCALES = ['android', 'review_information', 'trade_representative_contact_information', 'default'];

export function readAppleMetadata(dir: string, only?: string[]): AppleMetadata {
  const locales: Record<string, AppleLocaleFields> = {};
  for (const locale of localeDirs(dir, NOT_LOCALES)) {
    if (only?.length && !only.includes(locale)) continue;
    const fields: AppleLocaleFields = {};
    for (const field of APPLE_FIELD_NAMES) {
      const value = readText(join(dir, locale, `${field}.txt`));
      if (value !== undefined) fields[field] = value;
    }
    locales[locale] = fields;
  }
  const review: AppleMetadata['review'] = {};
  for (const file of Object.keys(REVIEW_FILES) as Array<keyof typeof REVIEW_FILES>) {
    const value = readText(join(dir, 'review_information', `${file}.txt`));
    if (value) review[file] = value;
  }
  return { locales, copyright: readText(join(dir, 'copyright.txt')) || undefined, review };
}

export function writeAppleLocale(dir: string, locale: string, fields: AppleLocaleFields): string[] {
  const written: string[] = [];
  for (const field of APPLE_FIELD_NAMES) {
    if (!(field in fields)) continue;
    const path = join(dir, locale, `${field}.txt`);
    // Empty store fields only overwrite files that exist (no clutter of empty files after a pull).
    if (!fields[field] && !existsSync(path)) continue;
    writeText(path, fields[field] ?? '');
    written.push(path);
  }
  return written;
}
