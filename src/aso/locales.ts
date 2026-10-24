/**
 * Localizations the App Store searches in each storefront (Apple's "App Store localizations" table). The first is
 * the storefront default; every other one is indexed there too, which means another 30 + 30 characters + 100 bytes of
 * search space. Apple does not combine words across different localizations of the same storefront.
 */

/** App Store Connect locale code → name. */
export const LOCALE_NAMES: Record<string, string> = {
  'en-US': 'English (U.S.)',
  'en-GB': 'English (U.K.)',
  'en-AU': 'English (Australia)',
  'en-CA': 'English (Canada)',
  'es-MX': 'Spanish (Mexico)',
  'es-ES': 'Spanish (Spain)',
  'fr-FR': 'French',
  'fr-CA': 'French (Canada)',
  'de-DE': 'German',
  it: 'Italian',
  'pt-BR': 'Portuguese (Brazil)',
  'pt-PT': 'Portuguese (Portugal)',
  'nl-NL': 'Dutch',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-Hans': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
  'ar-SA': 'Arabic',
  ru: 'Russian',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  tr: 'Turkish',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  no: 'Norwegian',
  pl: 'Polish',
  cs: 'Czech',
  sk: 'Slovak',
  'sl-SI': 'Slovenian',
  hr: 'Croatian',
  hu: 'Hungarian',
  ro: 'Romanian',
  el: 'Greek',
  he: 'Hebrew',
  id: 'Indonesian',
  ms: 'Malay',
  th: 'Thai',
  hi: 'Hindi',
  ca: 'Catalan',
  'ur-PK': 'Urdu',
  'bn-BD': 'Bangla',
  'gu-IN': 'Gujarati',
  'kn-IN': 'Kannada',
  'ml-IN': 'Malayalam',
  'mr-IN': 'Marathi',
  'or-IN': 'Odia',
  'pa-IN': 'Punjabi',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
};

/** Country → localizations searched there (first: default). */
export const STOREFRONTS: Record<string, string[]> = {
  US: ['en-US', 'ar-SA', 'zh-Hans', 'zh-Hant', 'fr-FR', 'ko', 'pt-BR', 'ru', 'es-MX', 'vi'],
  GB: ['en-GB'],
  IE: ['en-GB'],
  ZA: ['en-GB'],
  NG: ['en-GB'],
  KE: ['en-GB'],
  PH: ['en-GB'],
  AU: ['en-AU', 'en-GB'],
  NZ: ['en-AU', 'en-GB'],
  CA: ['en-CA', 'fr-CA'],
  DE: ['de-DE', 'en-GB'],
  AT: ['de-DE', 'en-GB'],
  CH: ['de-DE', 'en-GB', 'fr-FR', 'it'],
  FR: ['fr-FR', 'en-GB'],
  BE: ['en-GB', 'nl-NL', 'fr-FR'],
  LU: ['en-GB', 'fr-FR', 'de-DE'],
  NL: ['nl-NL', 'en-GB'],
  IT: ['it', 'en-GB'],
  ES: ['es-ES', 'ca', 'en-GB'],
  PT: ['pt-PT', 'en-GB'],
  BR: ['pt-BR', 'en-GB'],
  MX: ['es-MX', 'en-GB'],
  AR: ['es-MX', 'en-GB'],
  CL: ['es-MX', 'en-GB'],
  CO: ['es-MX', 'en-GB'],
  PE: ['es-MX', 'en-GB'],
  JP: ['ja', 'en-US'],
  KR: ['ko', 'en-GB'],
  CN: ['zh-Hans', 'en-GB'],
  TW: ['zh-Hant', 'en-GB'],
  HK: ['zh-Hant', 'en-GB'],
  SG: ['en-GB', 'zh-Hans'],
  MY: ['en-GB', 'ms'],
  ID: ['en-GB', 'id'],
  TH: ['en-GB', 'th'],
  VN: ['en-GB', 'vi'],
  IN: ['en-GB', 'bn-BD', 'gu-IN', 'hi', 'kn-IN', 'ml-IN', 'mr-IN', 'or-IN', 'pa-IN', 'ta-IN', 'te-IN', 'ur-PK'],
  PK: ['en-GB', 'ur-PK'],
  TR: ['en-GB', 'tr'],
  CY: ['en-GB', 'el', 'tr'],
  RU: ['ru', 'en-GB', 'uk'],
  UA: ['en-GB', 'ru', 'uk'],
  SE: ['sv', 'en-GB'],
  DK: ['en-GB', 'da'],
  FI: ['en-GB', 'fi'],
  NO: ['en-GB', 'no'],
  PL: ['en-GB', 'pl'],
  CZ: ['en-GB', 'cs'],
  SK: ['en-GB', 'sk'],
  SI: ['en-GB', 'sl-SI'],
  HR: ['en-GB', 'hr'],
  HU: ['en-GB', 'hu'],
  RO: ['en-GB', 'ro'],
  GR: ['en-GB', 'el'],
  IL: ['en-GB', 'he'],
  SA: ['en-GB', 'ar-SA'],
  AE: ['en-GB', 'ar-SA'],
  EG: ['en-GB', 'ar-SA', 'fr-FR'],
  QA: ['en-GB', 'ar-SA'],
  KW: ['en-GB', 'ar-SA'],
  MA: ['en-GB', 'ar-SA', 'fr-FR'],
};

export function localesFor(country: string): string[] {
  return STOREFRONTS[country.toUpperCase()] ?? ['en-GB'];
}

/** Countries where a localization is searched. */
export function countriesFor(locale: string): string[] {
  return Object.keys(STOREFRONTS).filter((country) => (STOREFRONTS[country] as string[]).includes(locale));
}

/** The localization for a language in a country: the first code in that country's list starting with the language. */
export function primaryFor(country: string, language: string): string {
  const locales = localesFor(country);
  return locales.find((locale) => locale.split('-')[0]?.toLowerCase() === language.toLowerCase()) ?? (locales[0] as string);
}

export function localeName(locale: string): string {
  return LOCALE_NAMES[locale] ?? locale;
}
