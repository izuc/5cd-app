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

  // Optimize path d attributes - reduce decimal precision
  result = result.replace(/\bd="([^"]+)"/g, (_match, pathData) => {
    const optimizedPath = optimizePathData(pathData, precision);
    return `d="${optimizedPath}"`;
  });

  // Optimize other numeric attributes
  result = result.replace(/\b(x|y|width|height|cx|cy|r|rx|ry|x1|y1|x2|y2)="([^"]+)"/g, (fullMatch, attr, value) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      return `${attr}="${roundToPrecision(num, precision)}"`;
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
 * Optimize path data string - remove redundancy and use shorter commands
 */
function optimizePathData(pathData: string, _precision: number): string {
  // Parse path into points (handle decimals)
  const points: Array<{cmd: string, x: number, y: number}> = [];

  // Match M command (with decimals)
  const moveMatch = pathData.match(/M(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (!moveMatch) return pathData;

  points.push({cmd: 'M', x: Math.round(parseFloat(moveMatch[1])), y: Math.round(parseFloat(moveMatch[2]))});

  // Extract all L commands (with decimals)
  const lineRegex = /L(-?\d+\.?\d*),(-?\d+\.?\d*)/g;
  let match;
  while ((match = lineRegex.exec(pathData)) !== null) {
    points.push({cmd: 'L', x: Math.round(parseFloat(match[1])), y: Math.round(parseFloat(match[2]))});
  }

  if (points.length < 2) return pathData;

  // Step 1: Remove duplicate consecutive points
  const deduped: typeof points = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = deduped[deduped.length - 1];
    const curr = points[i];
    if (curr.x !== prev.x || curr.y !== prev.y) {
      deduped.push(curr);
    }
  }

  // Step 2: Remove collinear points (points on straight line between neighbors)
  const simplified: typeof points = [deduped[0]];
  for (let i = 1; i < deduped.length - 1; i++) {
    const prev = simplified[simplified.length - 1];
    const curr = deduped[i];
    const next = deduped[i + 1];

    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;

    // Cross product - if 0, points are collinear
    if (dx1 * dy2 - dx2 * dy1 !== 0) {
      simplified.push(curr);
    }
  }
  if (deduped.length > 1) {
    simplified.push(deduped[deduped.length - 1]);
  }

  // Step 3: Build optimized path with relative h/v/l commands
  let result = `M${simplified[0].x},${simplified[0].y}`;
  let curX = simplified[0].x;
  let curY = simplified[0].y;

  for (let i = 1; i < simplified.length; i++) {
    const dx = simplified[i].x - curX;
    const dy = simplified[i].y - curY;

    if (dx === 0 && dy === 0) continue;

    if (dy === 0) {
      result += `h${dx}`;
    } else if (dx === 0) {
      result += `v${dy}`;
    } else {
      result += `l${dx},${dy}`;
    }

    curX = simplified[i].x;
    curY = simplified[i].y;
  }

  // Preserve Z if original had it
  if (pathData.toUpperCase().includes('Z')) {
    result += 'Z';
  }

  return result;
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
