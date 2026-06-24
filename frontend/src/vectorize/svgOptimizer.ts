// SVG Optimizer - Reduces SVG file size

interface OptimizeOptions {
  precision?: number;  // Decimal precision for coordinates (default: 1)
  removeComments?: boolean;
  minify?: boolean;
}

/**
 * Optimize SVG content to reduce file size
 */
export function optimizeSvg(svgContent: string, options: OptimizeOptions = {}): string {
  const {
    precision = 0,
    removeComments = true,
    minify = true
  } = options;

  let result = svgContent;

  // Remove XML declaration if present
  result = result.replace(/<\?xml[^?]*\?>\s*/gi, '');

  // Remove comments
  if (removeComments) {
    result = result.replace(/<!--[\s\S]*?-->/g, '');
  }

  // NOTE: we deliberately do NOT rewrite path `d` attributes here. The previous
  // optimiser only understood M/L commands and rebuilt the path from them — which
  // silently DROPPED every cubic-bezier (C) curve and merged compound/evenodd hole
  // subpaths into one, collapsing most traced shapes (empirically ~85% of shapes
  // lost their curves). The tracer already emits compact, rounded coordinates, so
  // there is nothing to gain and a lot to lose. Leave `d` untouched.

  // Optimize other numeric geometry attributes. The leading (^|[\s"']) anchor stops
  // `width`/`height` from matching INSIDE `stroke-width`/`*-height` (a hyphen is a
  // \b word boundary), which would otherwise round the seam-bridge stroke-width.
  result = result.replace(/(^|[\s"'])(x|y|width|height|cx|cy|r|rx|ry|x1|y1|x2|y2)="([^"]+)"/g, (fullMatch, lead, attr, value) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      return `${lead}${attr}="${roundToPrecision(num, precision)}"`;
    }
    return fullMatch;
  });

  // Optimize viewBox
  result = result.replace(/viewBox="([^"]+)"/g, (_match, viewBox) => {
    const parts = viewBox.split(/\s+/).map((v: string) => {
      const num = parseFloat(v);
      return isNaN(num) ? v : roundToPrecision(num, precision);
    });
    return `viewBox="${parts.join(' ')}"`;
  });

  // Remove empty groups
  result = result.replace(/<g>\s*<\/g>/g, '');

  // Remove unnecessary whitespace in tags
  result = result.replace(/\s+>/g, '>');
  result = result.replace(/>\s+</g, '><');

  // Minify - remove newlines and extra spaces
  if (minify) {
    result = result.replace(/\n\s*/g, '');
    result = result.replace(/\s{2,}/g, ' ');
  }

  // Remove trailing zeros after decimal
  result = result.replace(/(\d+\.\d*?)0+(["\s,])/g, '$1$2');
  result = result.replace(/(\d+)\.0+(["\s,])/g, '$1$2');

  return result.trim();
}

/**
 * Round number to specified precision
 */
function roundToPrecision(num: number, precision: number): string {
  if (isNaN(num)) return '0';

  const factor = Math.pow(10, precision);
  const rounded = Math.round(num * factor) / factor;

  let str = rounded.toFixed(precision);

  if (str.includes('.')) {
    str = str.replace(/\.?0+$/, '');
  }

  if (str === '-0') str = '0';

  return str;
}

/**
 * Get estimated file size in KB
 */
export function getFileSizeKB(content: string): number {
  return new Blob([content]).size / 1024;
}
