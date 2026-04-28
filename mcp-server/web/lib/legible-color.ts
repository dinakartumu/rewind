// Small utility to make sure a brand color (often pulled from cover-art
// dominant_color extraction) reads against the host theme's background.
//
// We don't know the host's exact bg from inside the iframe (Claude
// Desktop and iOS both ship light + dark variants), so the strategy is:
// reject colors that fall in the top OR bottom luminance band — those
// are guaranteed-invisible on at least one theme. Anything in the
// middle band passes through; the caller falls back to a sensible
// theme-aware default (typically `currentColor` so the text color
// adapts) when this returns null.

function parseColor(c: string): [number, number, number] | null {
  if (!c) return null;
  const hex = c.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let s = hex[1];
    if (s.length === 3) {
      s = s
        .split('')
        .map((x) => x + x)
        .join('');
    }
    if (s.length !== 6 && s.length !== 8) return null;
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    return [r, g, b];
  }
  const rgb = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  return null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/**
 * If `color` will be invisible against either light or dark themes,
 * return `fallback`. Otherwise return the color unchanged.
 *
 * The luminance bands are tuned so common brand colors (most reds,
 * blues, greens, browns, oranges) pass through, while pure white,
 * near-white, pure black, and near-black get rejected — those are
 * the colors that vanish against the host's background.
 */
export function legibleColor(
  color: string | null | undefined,
  fallback: string = 'currentColor'
): string {
  if (!color) return fallback;
  const rgb = parseColor(color);
  if (!rgb) return color; // CSS var / hsl / unknown — pass through, can't judge
  const lum = luminance(rgb);
  if (lum > 0.85 || lum < 0.05) return fallback;
  return color;
}
