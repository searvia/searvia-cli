/** Programmatic API: the same building blocks the CLI uses. */

export { AppStoreConnect } from './apple/client.js';
export { auditApple, auditPlay, fixApple } from './aso/audit.js';
export { analyze as playDensity } from './aso/density.js';
export { countriesFor, LOCALE_NAMES, localesFor, primaryFor, STOREFRONTS } from './aso/locales.js';
export type { AppleFields, Issue, Packed, Review } from './aso/rules.js';
export { BUDGET, CATEGORY, FILLER, filler, items, LIMITS, pack, review } from './aso/rules.js';
export { COMMANDS, main } from './cli.js';
export { signAppStoreConnectToken, signGoogleAssertion } from './core/jwt.js';
export { GooglePlay } from './play/client.js';
export { SearviaClient } from './searvia/mcp.js';
export { VERSION } from './version.js';
