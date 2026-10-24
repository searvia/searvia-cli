/**
 * Screenshot sizes App Store Connect accepts per display type (portrait; landscape is the same pair swapped), from
 * Apple's screenshot specifications. Up to 10 screenshots per set; PNG or JPEG without alpha.
 * https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications
 * Enum: https://developer.apple.com/documentation/appstoreconnectapi/screenshotdisplaytype
 */
export const DISPLAY_SIZES: Record<string, Array<[number, number]>> = {
  // 6.9" and 6.7" (Dynamic Island, large)
  APP_IPHONE_67: [
    [1320, 2868],
    [1290, 2796],
    [1260, 2736],
  ],
  // 6.5" (Face ID, large)
  APP_IPHONE_65: [
    [1284, 2778],
    [1242, 2688],
  ],
  // 6.3" and 6.1" (Dynamic Island, medium)
  APP_IPHONE_61: [
    [1206, 2622],
    [1179, 2556],
  ],
  // 5.8" (Face ID, medium)
  APP_IPHONE_58: [
    [1170, 2532],
    [1125, 2436],
    [1080, 2340],
  ],
  APP_IPHONE_55: [[1242, 2208]],
  APP_IPHONE_47: [[750, 1334]],
  APP_IPHONE_40: [
    [640, 1096],
    [640, 1136],
    [600, 1136],
  ],
  APP_IPHONE_35: [
    [640, 920],
    [640, 960],
    [600, 960],
  ],
  // 13" iPad
  APP_IPAD_PRO_3GEN_129: [
    [2064, 2752],
    [2048, 2732],
  ],
  // 12.9" iPad Pro (2nd generation)
  APP_IPAD_PRO_129: [[2048, 2732]],
  // 11" iPad
  APP_IPAD_PRO_3GEN_11: [
    [1488, 2266],
    [1668, 2420],
    [1668, 2388],
    [1640, 2360],
  ],
  APP_IPAD_105: [[1668, 2224]],
  APP_IPAD_97: [
    [1536, 2008],
    [1536, 2048],
    [1496, 2048],
    [768, 1004],
    [768, 1024],
    [748, 1024],
  ],
  APP_DESKTOP: [
    [800, 1280],
    [900, 1440],
    [1600, 2560],
    [1800, 2880],
  ],
  APP_APPLE_TV: [
    [1080, 1920],
    [2160, 3840],
  ],
  APP_APPLE_VISION_PRO: [[2160, 3840]],
  APP_WATCH_ULTRA: [
    [422, 514],
    [410, 502],
  ],
  APP_WATCH_SERIES_10: [[416, 496]],
  APP_WATCH_SERIES_7: [[396, 484]],
  APP_WATCH_SERIES_4: [[368, 448]],
  APP_WATCH_SERIES_3: [[312, 390]],
};

export const DISPLAY_TYPES = Object.keys(DISPLAY_SIZES);
export const IMESSAGE_TYPES = DISPLAY_TYPES.filter((type) => /^APP_(IPHONE|IPAD)_/.test(type) && type !== 'APP_IPHONE_35').map(
  (type) => `I${type.replace(/^APP_/, 'MESSAGE_APP_')}`,
);
export const ALL_DISPLAY_TYPES = [...DISPLAY_TYPES, ...IMESSAGE_TYPES];
export const MAX_PER_SET = 10;

function fits(type: string, width: number, height: number): boolean {
  const base = type.replace(/^IMESSAGE_/, '');
  return (DISPLAY_SIZES[base] ?? []).some(([w, h]) => (w === width && h === height) || (w === height && h === width));
}

/**
 * The display type for an image: an explicit type in the folder or file name wins (`APP_IPHONE_67/01.png`,
 * `01_APP_IPAD_PRO_129.png`), otherwise the pixel size decides. 2048×2732 is the 13" set unless named for the
 * 2nd-generation 12.9" iPad Pro. Paths containing "imessage" go to the iMessage sets.
 */
export function detectDisplayType(path: string, width: number, height: number): { type?: string; error?: string } {
  const named = ALL_DISPLAY_TYPES.filter((type) => new RegExp(`(^|[^A-Z0-9_])${type}([^A-Z0-9_]|$)`).test(path.toUpperCase())).sort((a, b) => b.length - a.length)[0];
  if (named) {
    return fits(named, width, height) ? { type: named } : { error: `${width}×${height} is not a valid size for ${named} (${describe(named)}).` };
  }
  const imessage = /imessage/i.test(path);
  const candidates = DISPLAY_TYPES.filter((type) => fits(type, width, height));
  if (candidates.length === 0) return { error: `${width}×${height} matches no App Store screenshot size.` };
  let type = candidates[0] as string;
  if (candidates.includes('APP_IPAD_PRO_3GEN_129') && candidates.includes('APP_IPAD_PRO_129')) {
    type = /2nd|12[._-]?9/i.test(path) ? 'APP_IPAD_PRO_129' : 'APP_IPAD_PRO_3GEN_129';
  }
  if (imessage) {
    const message = `I${type.replace(/^APP_/, 'MESSAGE_APP_')}`;
    if (!IMESSAGE_TYPES.includes(message)) return { error: `${type} has no iMessage variant.` };
    type = message;
  }
  return { type };
}

export function describe(type: string): string {
  return (DISPLAY_SIZES[type.replace(/^IMESSAGE_/, '')] ?? []).map(([w, h]) => `${w}×${h}`).join(', ');
}
