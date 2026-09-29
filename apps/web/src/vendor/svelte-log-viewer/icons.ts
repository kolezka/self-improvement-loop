// Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first.
// Lucide icon paths under the ISC License: https://lucide.dev/license

export const ICON_PATHS = {
  ArrowDownToLine: ["M12 3v14", "m6 11 6 6 6-6", "M19 21H5"],
  Check: ["M20 6 9 17l-5-5"],
  Copy: ["M8 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z", "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"],
  Download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
  FilterX: ["M13.5 2h-11l7 9v7l4 2v-9.5", "m17 8 5 5", "m22 8-5 5"],
  Hash: ["M4 9h16", "M4 15h16", "M10 3 8 21", "m6 21 2-18", "m18 3-2 18", "m16 21 2-18"],
  ScrollText: ["M15 12h-5", "M15 8h-5", "M15 16h-5", "M3 19.4V4.6A2.6 2.6 0 0 1 5.6 2H19a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5.6A2.6 2.6 0 0 1 3 19.4Z"],
  Timer: ["M10 2h4", "M12 14v-4", "M4.93 4.93 3.52 3.52", "M19.07 4.93l1.41-1.41", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"],
  WrapText: ["M3 6h18", "M3 12h15a3 3 0 0 1 0 6h-4", "m14 18-2 2 2 2", "M3 18h7"],
} as const;

export type IconName = keyof typeof ICON_PATHS;
