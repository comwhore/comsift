// Pure color helpers for Graph View coloring.

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const clean = hex.trim().replace(/^#/, "");
  const full = clean.length === 3 ? clean.split("").map(char => char + char).join("") : clean;
  const value = /^[0-9a-f]{6}$/i.test(full) ? parseInt(full, 16) : 0x808080;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map(part => Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, "0")).join("");
}

export function rgbToInt(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (r << 16) + (g << 8) + b;
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function isDark(hex: string): boolean { return luminance(hex) < 0.12; }

/** Linear mix: amount 0 → a, 1 → b. */
export function mix(a: string, b: string, amount: number): string {
  const t = Math.min(1, Math.max(0, amount));
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export function mixAll(colors: string[]): string {
  if (!colors.length) return "#808080";
  const sum = colors.map(hexToRgb).reduce<Rgb>((acc, rgb) => [acc[0] + rgb[0], acc[1] + rgb[1], acc[2] + rgb[2]], [0, 0, 0]);
  return rgbToHex([sum[0] / colors.length, sum[1] / colors.length, sum[2] / colors.length]);
}

/**
 * Shade of a person's color for a note `distance` links away.
 * 0 = the person itself, 1 = directly related (slightly brighter, capped), further = dimmer.
 * Dark colors brighten with distance instead of disappearing into the background.
 */
export function shade(base: string, distance: number, fade: number): string {
  if (distance <= 0) return base;
  const step = Math.min(0.5, Math.max(0.05, fade));
  const dark = isDark(base);
  if (distance === 1) return mix(base, "#ffffff", dark ? 0.3 : Math.min(0.18, 0.9 - luminance(base)));
  const amount = Math.min(0.8, step * (distance - 1));
  return dark ? mix(mix(base, "#ffffff", 0.3), "#c8c8c8", amount) : mix(base, "#4a4a4a", amount);
}

/** Pleasant, well separated random color (random hue, fixed saturation/lightness band). */
export function randomColor(random: () => number = Math.random): string {
  return hslToHex(random() * 360, 0.55 + random() * 0.25, 0.5 + random() * 0.12);
}

/** Stable color for a key (same key, same color). */
export function hashColor(key: string): string {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  let state = hash >>> 0;
  return randomColor(() => {
    state = Math.imul(state ^ (state >>> 15), 2246822507) >>> 0;
    state = Math.imul(state ^ (state >>> 13), 3266489909) >>> 0;
    return ((state ^= state >>> 16) >>> 0) / 4294967296;
  });
}

export function hslToHex(hue: number, saturation: number, lightness: number): string {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** Obsidian tag segment: letters, digits, -, _ only. */
export function tagSlug(name: string): string {
  const slug = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "").toLowerCase();
  return /^\d+$/.test(slug) ? `p${slug}` : slug || "person";
}
