import type { Color, ShapeData, Point } from './types';
import { colorToHex } from './colorQuantization';

// ============ Geometric Helpers ============

// Calculate angle between three points (in radians)
function getAngle(p1: Point, p2: Point, p3: Point): number {
  const v1x = p1.x - p2.x;
  const v1y = p1.y - p2.y;
  const v2x = p3.x - p2.x;
  const v2y = p3.y - p2.y;

  const dot = v1x * v2x + v1y * v2y;
  const cross = v1x * v2y - v1y * v2x;

  return Math.atan2(Math.abs(cross), dot);
}

// Detect corners - points where angle changes sharply
function detectCorners(points: Point[], angleThreshold: number = Math.PI / 4): Set<number> {
  const corners = new Set<number>();
  if (points.length < 3) return corners;

  for (let i = 0; i < points.length; i++) {
    const p1 = points[(i - 1 + points.length) % points.length];
    const p2 = points[i];
    const p3 = points[(i + 1) % points.length];

    const angle = getAngle(p1, p2, p3);

    // If angle is sharp enough, mark as corner
    if (angle < Math.PI - angleThreshold) {
      corners.add(i);
    }
  }

  return corners;
}

// Smooth points while preserving corners using weighted averaging
function smoothPathPreservingCorners(
  points: Point[],
  corners: Set<number>,
  iterations: number = 2,
  weight: number = 0.25
): Point[] {
  if (points.length < 3) return points;

  let current = [...points];

  for (let iter = 0; iter < iterations; iter++) {
    const next: Point[] = [];

    for (let i = 0; i < current.length; i++) {
      if (corners.has(i)) {
        // Preserve corner points
        next.push(current[i]);
      } else {
        // Smooth non-corner points
        const prev = current[(i - 1 + current.length) % current.length];
        const curr = current[i];
        const nextP = current[(i + 1) % current.length];

        next.push({
          x: curr.x * (1 - 2 * weight) + prev.x * weight + nextP.x * weight,
          y: curr.y * (1 - 2 * weight) + prev.y * weight + nextP.y * weight
        });
      }
    }

    current = next;
  }

  return current;
}

// Chaikin's corner cutting algorithm for smooth curves (exported for potential use)
export function chaikinSmooth(points: Point[], iterations: number = 1): Point[] {
  if (points.length < 3 || iterations <= 0) return points;

  let current = points;

  for (let iter = 0; iter < iterations; iter++) {
    const next: Point[] = [];

    for (let i = 0; i < current.length; i++) {
      const p0 = current[i];
      const p1 = current[(i + 1) % current.length];

      // Create two new points at 25% and 75% along each segment
      next.push({
        x: p0.x * 0.75 + p1.x * 0.25,
        y: p0.y * 0.75 + p1.y * 0.25
      });
      next.push({
        x: p0.x * 0.25 + p1.x * 0.75,
        y: p0.y * 0.25 + p1.y * 0.75
      });
    }

    current = next;
  }

  return current;
}

function simplifyPath(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;

  // Ramer-Douglas-Peucker algorithm
  const sqDistToSegment = (p: Point, p1: Point, p2: Point): number => {
    let x = p1.x, y = p1.y;
    let dx = p2.x - x, dy = p2.y - y;

    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = p2.x;
        y = p2.y;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }

    dx = p.x - x;
    dy = p.y - y;
    return dx * dx + dy * dy;
  };

  const simplifySection = (start: number, end: number): Point[] => {
    let maxDist = 0;
    let maxIdx = 0;

    for (let i = start + 1; i < end; i++) {
      const dist = sqDistToSegment(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    if (maxDist > tolerance * tolerance) {
      const left = simplifySection(start, maxIdx);
      const right = simplifySection(maxIdx, end);
      return [...left.slice(0, -1), ...right];
    }

    return [points[start], points[end]];
  };

  return simplifySection(0, points.length - 1);
}

// Calculate the signed area of a polygon (positive = clockwise, negative = counter-clockwise)
function calculateSignedArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

// Ensure path winds in clockwise direction (standard for SVG outer paths)
function ensureClockwise(points: Point[]): Point[] {
  const area = calculateSignedArea(points);
  // If area is negative, path is counter-clockwise - reverse it
  if (area < 0) {
    return [...points].reverse();
  }
  return points;
}

// Fit smooth curves through points using centripetal Catmull-Rom
// Exported for potential future use in advanced smoothing
export function fitSmoothCurve(points: Point[], tension: number = 0.5): Point[] {
  if (points.length < 4) return points;

  const result: Point[] = [];
  const segments = 4; // Points per segment

  for (let i = 0; i < points.length; i++) {
    const p0 = points[(i - 1 + points.length) % points.length];
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const p3 = points[(i + 2) % points.length];

    for (let j = 0; j < segments; j++) {
      const t = j / segments;
      const t2 = t * t;
      const t3 = t2 * t;

      // Catmull-Rom spline coefficients
      const c0 = -tension * t3 + 2 * tension * t2 - tension * t;
      const c1 = (2 - tension) * t3 + (tension - 3) * t2 + 1;
      const c2 = (tension - 2) * t3 + (3 - 2 * tension) * t2 + tension * t;
      const c3 = tension * t3 - tension * t2;

      result.push({
        x: c0 * p0.x + c1 * p1.x + c2 * p2.x + c3 * p3.x,
        y: c0 * p0.y + c1 * p1.y + c2 * p2.y + c3 * p3.y
      });
    }
  }

  return result;
}

// Multi-stage path refinement pipeline.
// `simplifyScale` is the label-upscale factor: the trace runs at upscaled resolution
// (e.g. 2-4×) and the path is scaled back down afterwards, so the RDP tolerance must
// be multiplied by it or the simplification is too fine to collapse the nearest-
// neighbour stair-steps — leaving wavy/patchy edges. Because RDP preserves true
// corners (points far from the simplified line), scaling the tolerance straightens
// stair-stepped EDGES without rounding off real corners/vertices.
function refinePathMultiStage(
  rawPoints: Point[],
  smoothness: number,
  qualityLevel: 'fast' | 'balanced' | 'high' | 'detailed' = 'balanced',
  simplifyScale: number = 1
): Point[] {
  if (rawPoints.length < 3) return rawPoints;

  let points = rawPoints;

  // Detect corners before any smoothing
  const cornerAngleThreshold = Math.PI / 3; // 60 degrees
  const corners = detectCorners(points, cornerAngleThreshold);

  if (qualityLevel === 'fast') {
    // Fast: aggressive simplification
    const simplified = simplifyPath(points, Math.max(1.0, smoothness * 0.3) * simplifyScale);
    if (simplified.length < 3) return rawPoints;
    return simplified;
  }

  if (qualityLevel === 'detailed') {
    // DETAILED: Maximum detail preservation for crisp text and fine details
    // Almost no smoothing - preserve original traced edges
    points = smoothPathPreservingCorners(points, corners, 1, 0.02);
    // Minimal simplification - keep nearly all points for sharp text
    points = simplifyPath(points, Math.max(0.1, smoothness * 0.05) * simplifyScale);

    if (points.length < 3) return rawPoints;
    return points;
  }

  if (qualityLevel === 'balanced') {
    // Balanced: moderate smoothing, good detail
    points = smoothPathPreservingCorners(points, corners, 1, 0.12);
    points = simplifyPath(points, Math.max(0.5, smoothness * 0.2) * simplifyScale);

    if (points.length < 3) return rawPoints;
    return points;
  }

  // HIGH QUALITY: Good balance of smoothness and detail
  points = smoothPathPreservingCorners(points, corners, 1, 0.15);
  points = simplifyPath(points, Math.max(0.4, smoothness * 0.15) * simplifyScale);

  if (points.length < 3) return rawPoints;
  return points;
}

// Generate compact path using integer coordinates and smooth bezier curves
function pointsToSvgPathOptimized(points: Point[], corners: Set<number>): string {
  if (points.length < 2) return '';

  const r = Math.round;

  if (points.length < 3) {
    return `M${r(points[0].x)},${r(points[0].y)}L${r(points[1].x)},${r(points[1].y)}Z`;
  }

  // For small shapes, use simple lines
  if (points.length < 5) {
    let d = `M${r(points[0].x)},${r(points[0].y)}`;
    for (let i = 1; i < points.length; i++) {
      d += `L${r(points[i].x)},${r(points[i].y)}`;
    }
    return d + 'Z';
  }

  // Helper: squared distance from point p to segment v-w
  const distToSegmentSquared = (p: Point, v: Point, w: Point): number => {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return (p.x - v.x) ** 2 + (p.y - v.y) ** 2;
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return (p.x - (v.x + t * (w.x - v.x))) ** 2 + (p.y - (v.y + t * (w.y - v.y))) ** 2;
  };

  // Use cubic bezier for smooth curves
  let d = `M${r(points[0].x)},${r(points[0].y)}`;

  for (let i = 0; i < points.length; i++) {
    const p0 = points[(i - 1 + points.length) % points.length];
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const p3 = points[(i + 2) % points.length];

    const isCorner1 = corners.has(i);
    const isCorner2 = corners.has((i + 1) % points.length);

    const tension1 = isCorner1 ? 0.1 : 0.17;
    const tension2 = isCorner2 ? 0.1 : 0.17;

    const cp1x = p1.x + (p2.x - p0.x) * tension1;
    const cp1y = p1.y + (p2.y - p0.y) * tension1;
    const cp2x = p2.x - (p3.x - p1.x) * tension2;
    const cp2y = p2.y - (p3.y - p1.y) * tension2;

    // Check if the curve is effectively a straight line
    // If control points are very close to the line segment p1-p2, use L instead of C
    const cp1 = { x: cp1x, y: cp1y };
    const cp2 = { x: cp2x, y: cp2y };
    const errorThreshold = 0.5; // pixels squared (approx 0.7px distance)

    if (distToSegmentSquared(cp1, p1, p2) < errorThreshold && 
        distToSegmentSquared(cp2, p1, p2) < errorThreshold) {
      d += `L${r(p2.x)},${r(p2.y)}`;
    } else {
      d += `C${r(cp1x)},${r(cp1y)} ${r(cp2x)},${r(cp2y)} ${r(p2.x)},${r(p2.y)}`;
    }
  }

  return d + 'Z';
}

// Legacy function kept for compatibility - now using pointsToSvgPathOptimized instead
export function pointsToSvgPath(points: Point[]): string {
  if (points.length < 2) return '';

  // If we have very few points, just draw lines
  if (points.length < 3) {
    return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}L${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
  }

  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;

  for (let i = 0; i < points.length; i++) {
    const p0 = points[(i - 1 + points.length) % points.length];
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const p3 = points[(i + 2) % points.length];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;

    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += `C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }

  d += 'Z';
  return d;
}

// ============ Efficient Region Tracing ============

// A pixel bounding box (inclusive) so morphology only touches a colour's actual
// footprint instead of the whole (possibly ~4096²) canvas. Without this, closing
// is O(colours × W × H × window) and dominates trace time at upscaled resolution.
type BBox = { x0: number; y0: number; x1: number; y1: number };
const clampBox = (b: BBox, width: number, height: number, pad: number): BBox => ({
  x0: Math.max(0, b.x0 - pad), y0: Math.max(0, b.y0 - pad),
  x1: Math.min(width - 1, b.x1 + pad), y1: Math.min(height - 1, b.y1 + pad),
});

// Morphological dilation to merge nearby same-color regions (bounded to `box`).
function dilateColorMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
  box: BBox
): Uint8Array {
  const result = new Uint8Array(width * height);

  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      if (mask[y * width + x] === 1) {
        // Dilate: set all neighbors within radius
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              result[ny * width + nx] = 1;
            }
          }
        }
      }
    }
  }

  return result;
}

// Morphological erosion to restore original shape boundaries after dilation
// (bounded to `box`, which should be the dilated extent = original bbox + radius).
function erodeColorMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
  box: BBox
): Uint8Array {
  const result = new Uint8Array(width * height);

  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      // Check if all neighbors within radius are set
      let allSet = true;
      outer: for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height || mask[ny * width + nx] === 0) {
            allSet = false;
            break outer;
          }
        }
      }
      if (allSet) {
        result[y * width + x] = 1;
      }
    }
  }

  return result;
}

// Morphological closing (dilate then erode) - merges nearby regions, bounded to
// `box` (the colour's pixel footprint). Dilation grows the footprint by `radius`,
// so erosion runs over box+radius to restore it.
function closeColorMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
  box: BBox
): Uint8Array {
  const dilated = dilateColorMask(mask, width, height, radius, box);
  return erodeColorMask(dilated, width, height, radius, clampBox(box, width, height, radius));
}

// Directions: N, NE, E, SE, S, SW, W, NW
// stored as (dx, dy)
const MOORE_NEIGHBORS = [
  { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
  { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 }
];

// Trace boundary for a specific color index in quantized array (exported for potential use)
export function traceRegionBoundary(
  quantized: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  colorIndex: number
): Point[] {
  const boundary: Point[] = [];
  let curX = startX;
  let curY = startY;

  boundary.push({ x: curX, y: curY });

  let prevX = curX - 1; // Assume we came from left
  let prevY = curY;

  let iter = 0;
  const maxIter = width * height * 2; // Safety break

  const isInside = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return quantized[y * width + x] === colorIndex;
  };

  while (iter < maxIter) {
    let startNeighborIdx = 0;
    const dx = prevX - curX;
    const dy = prevY - curY;

    for(let i=0; i<8; i++) {
      if (MOORE_NEIGHBORS[i].x === dx && MOORE_NEIGHBORS[i].y === dy) {
        startNeighborIdx = i;
        break;
      }
    }

    let nextX = -1, nextY = -1;
    let foundNext = false;

    for (let i = 1; i <= 8; i++) {
      const idx = (startNeighborIdx + i) % 8;
      const nx = curX + MOORE_NEIGHBORS[idx].x;
      const ny = curY + MOORE_NEIGHBORS[idx].y;

      if (isInside(nx, ny)) {
        nextX = nx;
        nextY = ny;
        foundNext = true;
        break;
      }
    }

    if (!foundNext) break;

    boundary.push({ x: nextX, y: nextY });

    if (nextX === startX && nextY === startY) break;

    prevX = curX;
    prevY = curY;
    curX = nextX;
    curY = nextY;
    iter++;
  }

  return boundary;
}

// Trace boundary on a binary mask (1 = inside, 0 = outside)
function traceMaskBoundary(
  mask: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number
): Point[] {
  const boundary: Point[] = [];
  let curX = startX;
  let curY = startY;

  boundary.push({ x: curX, y: curY });

  let prevX = curX - 1;
  let prevY = curY;

  let iter = 0;
  const maxIter = width * height * 2;

  const isInside = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return mask[y * width + x] === 1;
  };

  while (iter < maxIter) {
    let startNeighborIdx = 0;
    const dx = prevX - curX;
    const dy = prevY - curY;

    for(let i=0; i<8; i++) {
      if (MOORE_NEIGHBORS[i].x === dx && MOORE_NEIGHBORS[i].y === dy) {
        startNeighborIdx = i;
        break;
      }
    }

    let nextX = -1, nextY = -1;
    let foundNext = false;

    for (let i = 1; i <= 8; i++) {
      const idx = (startNeighborIdx + i) % 8;
      const nx = curX + MOORE_NEIGHBORS[idx].x;
      const ny = curY + MOORE_NEIGHBORS[idx].y;

      if (isInside(nx, ny)) {
        nextX = nx;
        nextY = ny;
        foundNext = true;
        break;
      }
    }

    if (!foundNext) break;

    boundary.push({ x: nextX, y: nextY });

    if (nextX === startX && nextY === startY) break;

    prevX = curX;
    prevY = curY;
    curX = nextX;
    curY = nextY;
    iter++;
  }

  return boundary;
}

// Identify colors that touch the image perimeter (kept for potential future use)
export function identifyPerimeterColors(
  quantized: Uint8Array,
  width: number,
  height: number
): Set<number> {
  const perimeterColors = new Set<number>();
  
  // Top and Bottom rows
  for (let x = 0; x < width; x++) {
    perimeterColors.add(quantized[x]); // Top
    perimeterColors.add(quantized[(height - 1) * width + x]); // Bottom
  }
  
  // Left and Right columns
  for (let y = 0; y < height; y++) {
    perimeterColors.add(quantized[y * width]); // Left
    perimeterColors.add(quantized[y * width + (width - 1)]); // Right
  }
  
  return perimeterColors;
}

export function traceAllColors(
  quantized: Uint8Array,
  width: number,
  height: number,
  palette: Color[],
  selectedColors: Set<number>,
  smoothness: number,
  minArea: number = 1,
  onProgress?: (progress: number) => void,
  qualityLevel: 'fast' | 'balanced' | 'high' | 'detailed' = 'balanced',
  foregroundMask?: Uint8Array | null,
  mergeNeighbors: boolean = true, // merge nearby same-color regions
  simplifyScale: number = 1       // label-upscale factor (scales RDP tolerance)
): ShapeData[] {
  const result: ShapeData[] = [];

  const colorsToTrace = selectedColors.size > 0
    ? Array.from(selectedColors)
    : palette.map((_, i) => i);

  let colorsProcessed = 0;

  // Determine merge radius based on quality level
  // Higher radius = more aggressive merging, fewer gaps between shapes
  // Lower radius = more detail preservation (better for text)
  // Detailed mode: no merging to preserve crisp text edges
  const mergeRadius = mergeNeighbors
    ? (qualityLevel === 'fast' ? 4 : qualityLevel === 'balanced' ? 2 : qualityLevel === 'high' ? 1 : 0)
    : 0;

  // Process each color separately with optional merging
  for (const colorIndex of colorsToTrace) {
    // Skip invalid indices and transparent marker (255)
    if (colorIndex >= palette.length || colorIndex === 255) continue;

    // Create a binary mask for this color, tracking its pixel bounding box so the
    // (expensive) morphological closing only touches this colour's footprint.
    // Skip pixels that are masked out (transparent areas).
    const colorMask = new Uint8Array(width * height);
    let cnt = 0;
    let bx0 = width, by0 = height, bx1 = -1, by1 = -1;
    for (let i = 0; i < quantized.length; i++) {
      if (quantized[i] === colorIndex) {
        // Only include pixel if no mask, or mask says it's visible (1)
        if (!foregroundMask || foregroundMask[i] === 1) {
          colorMask[i] = 1;
          cnt++;
          const x = i % width, y = (i / width) | 0;
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
          if (y < by0) by0 = y; if (y > by1) by1 = y;
        }
      }
    }

    // Colour not present (e.g. entirely masked out) — nothing to trace.
    if (cnt === 0) { colorsProcessed++; if (onProgress) onProgress(colorsProcessed / colorsToTrace.length); continue; }
    const colorBox: BBox = { x0: bx0, y0: by0, x1: bx1, y1: by1 };

    // Apply morphological closing to merge nearby regions (if enabled)
    const processedMask = mergeRadius > 0
      ? closeColorMask(colorMask, width, height, mergeRadius, colorBox)
      : colorMask;

    // Track visited pixels for this color
    const visited = new Uint8Array(width * height);

    // Scan for regions in the processed mask — only within this colour's footprint
    // (closing can grow it by mergeRadius), not the whole canvas.
    const scanBox = clampBox(colorBox, width, height, mergeRadius);
    for (let y = scanBox.y0; y <= scanBox.y1; y++) {
      for (let x = scanBox.x0; x <= scanBox.x1; x++) {
        const idx = y * width + x;

        if (visited[idx]) continue;

        if (processedMask[idx] === 1) {
          // Found a new region of this color!

          // A. Trace Boundary on the processed mask
          const boundary = traceMaskBoundary(processedMask, width, height, x, y);

          // B. Flood Fill (8-connected) to mark this ENTIRE region as visited AND count area
          // Also track how many pixels are in the foreground mask (if provided)
          // Count original pixels (not dilated) for accurate area
          let pixelCount = 0;
          let foregroundPixelCount = 0;
          const stack = [idx];
          visited[idx] = 1;

          // Count original color pixels in this merged region
          if (colorMask[idx] === 1) {
            pixelCount++;
            if (foregroundMask && foregroundMask[idx] === 1) {
              foregroundPixelCount++;
            }
          }

          while (stack.length > 0) {
            const pIdx = stack.pop()!;
            const px = pIdx % width;
            const py = Math.floor(pIdx / width);

            // Check 8 neighbors
            const neighbors = [
               { nx: px + 1, ny: py },
               { nx: px - 1, ny: py },
               { nx: px, ny: py + 1 },
               { nx: px, ny: py - 1 },
               { nx: px + 1, ny: py + 1 },
               { nx: px - 1, ny: py - 1 },
               { nx: px - 1, ny: py + 1 },
               { nx: px + 1, ny: py - 1 }
            ];

            for (const { nx, ny } of neighbors) {
               if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                 const nIdx = ny * width + nx;
                 if (!visited[nIdx] && processedMask[nIdx] === 1) {
                   visited[nIdx] = 1;
                   // Count original color pixels for accurate area
                   if (colorMask[nIdx] === 1) {
                     pixelCount++;
                     if (foregroundMask && foregroundMask[nIdx] === 1) {
                       foregroundPixelCount++;
                     }
                   }
                   stack.push(nIdx);
                 }
               }
            }
          }

          // Determine if this shape is foreground or background
          let isBackground: boolean;

          // Check if shape touches the image edge (generous margin for morphological closing)
          let touchesEdge = false;
          const edgeMargin = 5; // Increased margin to account for morphological operations
          for (const p of boundary) {
            if (p.x <= edgeMargin || p.x >= width - edgeMargin - 1 ||
                p.y <= edgeMargin || p.y >= height - edgeMargin - 1) {
              touchesEdge = true;
              break;
            }
          }

          if (foregroundMask) {
            // TWO-PASS MODE: Use the foreground mask to determine
            const foregroundRatio = pixelCount > 0 ? foregroundPixelCount / pixelCount : 0;

            // A shape is background ONLY if it touches the edge AND has low foreground ratio
            // Interior shapes are ALWAYS kept to preserve colors within the image
            if (touchesEdge && foregroundRatio < 0.4) {
              isBackground = true;
            } else {
              // Keep all interior shapes and edge shapes with significant foreground
              isBackground = false;
            }
          } else {
            // FALLBACK: Check if shape touches the image edge (original behavior)
            isBackground = touchesEdge;
          }

          // C. Only keep path if area is sufficient
          if (pixelCount >= minArea && boundary.length > 2) {
            // Use multi-stage refinement pipeline
            let refined = refinePathMultiStage(boundary, smoothness, qualityLevel, simplifyScale);

            // Ensure consistent clockwise winding for proper SVG fill behavior
            refined = ensureClockwise(refined);

            // Detect corners for optimized Bezier generation
            const corners = detectCorners(refined, Math.PI / 3);
            const pathStr = pointsToSvgPathOptimized(refined, corners);

            if (pathStr) {
              result.push({
                color: palette[colorIndex],
                path: pathStr,
                area: pixelCount,
                isBackground
              });
            }
          }
        }
      }
    }

    colorsProcessed++;
    if (onProgress) {
      onProgress(colorsProcessed / colorsToTrace.length);
    }
  }

  return result;
}

// Group shapes by color, keeping background and foreground shapes separate
interface ColorGroup {
  color: Color;
  foregroundPaths: string[];
  backgroundPaths: string[];
  foregroundArea: number;
  backgroundArea: number;
  totalArea: number;
}

function groupShapesByColor(shapes: ShapeData[]): Map<string, ColorGroup> {
  const groups = new Map<string, ColorGroup>();

  for (const shape of shapes) {
    const hex = colorToHex(shape.color);

    if (!groups.has(hex)) {
      groups.set(hex, {
        color: shape.color,
        foregroundPaths: [],
        backgroundPaths: [],
        foregroundArea: 0,
        backgroundArea: 0,
        totalArea: 0
      });
    }

    const group = groups.get(hex)!;

    // Separate background shapes from foreground shapes
    if (shape.isBackground) {
      group.backgroundPaths.push(shape.path);
      group.backgroundArea += shape.area;
    } else {
      group.foregroundPaths.push(shape.path);
      group.foregroundArea += shape.area;
    }
    group.totalArea += shape.area;
  }

  return groups;
}

// Create a compound path from multiple path strings
function createCompoundPath(paths: string[]): string {
  // Simply concatenate paths - each already ends with Z
  return paths.join(' ');
}

// Scale path coordinates by dividing all numbers by scale factor
function scalePathString(pathStr: string, scale: number): string {
  if (scale === 1) return pathStr;

  // Match all numbers (including negative and decimals)
  return pathStr.replace(/-?\d+\.?\d*/g, (match) => {
    const num = parseFloat(match);
    const scaled = num / scale;
    // Round to integer for smaller file size
    return Math.round(scaled).toString();
  });
}

export function generateSvg(
  shapes: ShapeData[],
  width: number,
  height: number,
  removeBackground: boolean = false,    // Filter out detected background shapes
  pathScale: number = 1, // Scale factor to divide path coordinates by
  _hasTransparentSource: boolean = false // (kept for call-site compatibility; bg is now always a traced shape)
): string {
  // Group shapes by color for compound paths
  const colorGroups = groupShapesByColor(shapes);

  // Find the dominant background color (largest area touching edges)
  let maxBackgroundArea = 0;
  let dominantHex = '#ffffff';

  for (const [hex, group] of colorGroups) {
    if (group.backgroundArea > maxBackgroundArea) {
      maxBackgroundArea = group.backgroundArea;
      dominantHex = hex;
    }
  }

  // If no background detected, use largest total area
  if (maxBackgroundArea === 0) {
    let maxArea = 0;
    for (const [hex, group] of colorGroups) {
      if (group.totalArea > maxArea) {
        maxArea = group.totalArea;
        dominantHex = hex;
      }
    }
  }

  // Build SVG with proper structure
  // shape-rendering=geometricPrecision asks renderers for the smoothest (anti-aliased)
  // edges rather than crisp/aliased ones.
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="geometricPrecision">\n`;

  // Add metadata/title for better organization
  svg += `  <title>Vectorized Image</title>\n`;
  svg += `  <desc>Generated with Raster2Vector - ${colorGroups.size} colors</desc>\n`;

  // Define styles for easier editing
  svg += `  <defs>\n`;
  svg += `    <style>\n`;
  svg += `      .vector-shape { stroke-linejoin: round; stroke-linecap: round; }\n`;
  svg += `    </style>\n`;
  svg += `  </defs>\n`;

  // NOTE: we deliberately do NOT emit a standalone <rect id="background"> here.
  // The background is already traced as a real shape (the dominant full-canvas
  // path), so a separate rect was redundant AND left an orphan square behind when
  // the user deleted the background colour in the editor (it isn't one of the
  // traced shapes). The traced background shape is the backdrop and is editable
  // like everything else.

  // Main content group
  svg += `  <g id="content">\n`;

  if (removeBackground) {
    // REMOVE BACKGROUND MODE: Filter out detected background shapes
    // Large shapes drawn first, small details on top
    // Include foreground shapes + small background shapes (interior details like letter holes)

    const smallShapeThreshold = width * height * 0.05; // 5% of image area
    // Only punch a background-coloured enclosed region into a transparent hole if it's
    // big enough to be a real counter (letter interior, donut hole). `shape.area` is in
    // working (upscaled) pixels, so scale the threshold by pathScale². Tiny dominant-
    // colour speckles INSIDE solid shapes (anti-alias dust) must NOT be punched, or the
    // shape turns to swiss cheese — they're dropped and left covered by the shape below.
    const holeMinArea = width * height * (pathScale * pathScale) * 0.0002;
    type FShape = { hex: string; path: string; area: number; bbox: number[]; holes: string[] };
    const drawn: FShape[] = [];
    const holeShapes: { path: string; bbox: number[] }[] = [];

    // Rough bbox from a path's coordinates (a superset — control points included —
    // which is fine for hole-in-letter containment).
    const bboxOf = (d: string): number[] => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const nums = d.match(/-?\d+(?:\.\d+)?/g);
      if (nums) for (let i = 0; i + 1 < nums.length; i += 2) {
        const x = parseFloat(nums[i]), y = parseFloat(nums[i + 1]);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return [x0, y0, x1, y1];
    };

    for (const shape of shapes) {
      const hex = colorToHex(shape.color);
      const isDominantBg = hex === dominantHex;

      // An enclosed region in the background colour is a HOLE/counter (letter
      // interiors, donut holes). Punch it out (fill-rule evenodd) so it's truly
      // transparent instead of filled with the background colour — but only if it's
      // large enough to be a genuine counter; tiny speckles are skipped (see above).
      if (isDominantBg && !shape.isBackground) {
        if (shape.area >= holeMinArea) {
          holeShapes.push({ path: shape.path, bbox: bboxOf(shape.path) });
        }
        continue;
      }

      const isSmallBackground = shape.isBackground && shape.area < smallShapeThreshold;
      if (!shape.isBackground || (isSmallBackground && !isDominantBg)) {
        drawn.push({ hex, path: shape.path, area: shape.area, bbox: bboxOf(shape.path), holes: [] });
      }
    }

    // Fallback: if nothing included, include everything except dominant background
    if (drawn.length === 0) {
      for (const shape of shapes) {
        const hex = colorToHex(shape.color);
        if (hex !== dominantHex) drawn.push({ hex, path: shape.path, area: shape.area, bbox: bboxOf(shape.path), holes: [] });
      }
    }

    // Assign each hole to the SMALLEST drawn shape whose bbox contains it, and punch
    // it out of that shape via fill-rule=evenodd. Self-contained per shape, so it
    // works in the downloaded SVG AND the editor (which re-renders shapes) — no mask.
    const contains = (o: number[], i: number[]) => o[0] <= i[0] && o[1] <= i[1] && o[2] >= i[2] && o[3] >= i[3];
    for (const h of holeShapes) {
      let best: FShape | null = null;
      for (const s of drawn) if (contains(s.bbox, h.bbox) && (!best || s.area < best.area)) best = s;
      if (best) best.holes.push(h.path); // unassigned holes are simply left transparent
    }

    // Sort by area descending (largest first, smallest/details on top)
    drawn.sort((a, b) => b.area - a.area);

    // Same-colour stroke bridges the anti-aliasing seam (the "white gaps"); see note
    // in standard mode below. Proportional to the viewBox so it stays a constant
    // on-screen thickness regardless of resolution.
    const strokeWidth = Math.max(1.5, Math.min(width, height) * 0.004);
    svg += `    <g id="shapes-layer">\n`;
    for (const s of drawn) {
      let d = scalePathString(s.path, pathScale);
      let fillRule = '';
      if (s.holes.length) {
        d += ' ' + s.holes.map((hp) => scalePathString(hp, pathScale)).join(' ');
        fillRule = ' fill-rule="evenodd"';
      }
      svg += `      <path fill="${s.hex}"${fillRule} stroke="${s.hex}" stroke-width="${strokeWidth}" stroke-linejoin="round" d="${d}"/>\n`;
    }
    svg += `    </g>\n`;

  } else {
    // STANDARD MODE: Draw all shapes sorted by area (largest first for proper layering)
    // This ensures large background shapes are drawn first, then smaller details on top

    // Collect ALL individual shapes with their colors and areas
    const allShapesFlat: Array<{ hex: string; path: string; area: number }> = [];

    for (const shape of shapes) {
      const hex = colorToHex(shape.color);
      allShapesFlat.push({
        hex,
        path: shape.path,
        area: shape.area
      });
    }

    // Sort by area descending (largest shapes drawn first, smallest on top)
    allShapesFlat.sort((a, b) => b.area - a.area);

    // Same-colour stroke to bridge the browser's anti-aliasing seam between
    // abutting fills (the "white gaps"). Proportional to the viewBox (min side) so it
    // stays a constant on-screen thickness whatever the trace resolution — the old
    // `max(2.5, 3/pathScale)` was only ~0.7 device px on a 2048-viewBox AI trace.
    const strokeWidthStd = Math.max(1.5, Math.min(width, height) * 0.004);
    svg += `    <g id="shapes-layer">\n`;
    for (const { hex, path } of allShapesFlat) {
      const scaledPath = scalePathString(path, pathScale);
      svg += `      <path fill="${hex}" stroke="${hex}" stroke-width="${strokeWidthStd}" stroke-linejoin="round" d="${scaledPath}"/>\n`;
    }
    svg += `    </g>\n`;
  }

  svg += `  </g>\n`;
  svg += `</svg>`;
  return svg;
}

// Alternative: Generate SVG with separate paths but organized in groups (for maximum editability)
export function generateSvgLayered(
  shapes: ShapeData[],
  width: number,
  height: number,
  transparentBackground: boolean = false
): string {
  const colorGroups = groupShapesByColor(shapes);

  // Find dominant background
  let maxBackgroundArea = 0;
  let dominantHex = '#ffffff';

  for (const [hex, group] of colorGroups) {
    if (group.backgroundArea > maxBackgroundArea) {
      maxBackgroundArea = group.backgroundArea;
      dominantHex = hex;
    }
  }

  if (maxBackgroundArea === 0) {
    let maxArea = 0;
    for (const [hex, group] of colorGroups) {
      if (group.totalArea > maxArea) {
        maxArea = group.totalArea;
        dominantHex = hex;
      }
    }
  }

  const sortedGroups = Array.from(colorGroups.entries())
    .sort((a, b) => b[1].totalArea - a[1].totalArea);

  // shape-rendering=geometricPrecision asks renderers for the smoothest (anti-aliased)
  // edges rather than crisp/aliased ones.
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="geometricPrecision">\n`;
  svg += `  <title>Vectorized Image (Layered)</title>\n`;

  if (!transparentBackground) {
    svg += `  <rect id="background" width="100%" height="100%" fill="${dominantHex}"/>\n`;
  }

  // Each color gets its own group with individual paths inside
  for (const [hex, group] of sortedGroups) {
    // Skip dominant background in transparent mode
    if (transparentBackground && hex === dominantHex && group.foregroundPaths.length === 0) {
      continue;
    }

    const colorName = `color-${hex.slice(1)}`;
    svg += `  <g id="${colorName}" fill="${hex}" stroke="${hex}" stroke-width="1" stroke-linejoin="round">\n`;

    // Get paths to draw based on mode
    const pathsToDraw = transparentBackground
      ? group.foregroundPaths.length > 0 ? group.foregroundPaths : group.backgroundPaths
      : [...group.backgroundPaths, ...group.foregroundPaths];

    // Sort paths within group by length (longer = likely larger)
    const sortedPaths = [...pathsToDraw].sort((a, b) => b.length - a.length);

    for (let i = 0; i < sortedPaths.length; i++) {
      svg += `    <path id="${colorName}-${i}" d="${sortedPaths[i]}"/>\n`;
    }

    svg += `  </g>\n`;
  }

  svg += `</svg>`;
  return svg;
}

// Layer data interface
interface LayerData {
  name: string;
  shapes: ShapeData[];
}

// Generate a clean two-layer SVG: base shapes + detail shapes
// Base layer provides silhouette, detail layer adds fine features
export function generateTwoLayerSvg(
  layers: LayerData[],
  width: number,
  height: number,
  transparentBackground: boolean = false
): string {
  // Get all shapes from all layers
  const allShapes = layers.flatMap(l => l.shapes);

  if (allShapes.length === 0) {
    // Empty fallback
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"></svg>`;
  }

  // Group by color
  const colorGroups = groupShapesByColor(allShapes);

  // Find background color (largest area marked as background)
  let dominantHex = '#ffffff';
  let maxBgArea = 0;
  for (const [hex, group] of colorGroups) {
    if (group.backgroundArea > maxBgArea) {
      maxBgArea = group.backgroundArea;
      dominantHex = hex;
    }
  }

  // If no background found, use largest total area
  if (maxBgArea === 0) {
    let maxArea = 0;
    for (const [hex, group] of colorGroups) {
      if (group.totalArea > maxArea) {
        maxArea = group.totalArea;
        dominantHex = hex;
      }
    }
  }

  // Collect paths to draw
  const pathsToDraw: Array<{ hex: string; path: string; area: number }> = [];

  for (const [hex, group] of colorGroups) {
    if (transparentBackground) {
      // Skip colors that are predominantly background (>60%)
      const bgRatio = group.totalArea > 0 ? group.backgroundArea / group.totalArea : 0;
      if (bgRatio > 0.6) continue;

      // Prefer foreground paths, but use all if none marked as foreground
      const paths = group.foregroundPaths.length > 0
        ? group.foregroundPaths
        : [...group.backgroundPaths, ...group.foregroundPaths];

      if (paths.length > 0) {
        pathsToDraw.push({
          hex,
          path: paths.join(' '),
          area: group.foregroundArea || group.totalArea
        });
      }
    } else {
      // Non-transparent: use all paths
      const allPaths = [...group.backgroundPaths, ...group.foregroundPaths];
      if (allPaths.length > 0) {
        pathsToDraw.push({
          hex,
          path: allPaths.join(' '),
          area: group.totalArea
        });
      }
    }
  }

  // Sort by area (largest first for proper layering)
  pathsToDraw.sort((a, b) => b.area - a.area);

  // Build SVG
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">\n`;

  if (!transparentBackground) {
    svg += `<rect width="100%" height="100%" fill="${dominantHex}"/>\n`;
  }

  // Fills layer
  svg += `<g id="fills">\n`;
  for (const { hex, path } of pathsToDraw) {
    svg += `<path fill="${hex}" d="${path}"/>\n`;
  }
  svg += `</g>\n`;

  // Thin stroke layer on top for clean edges
  svg += `<g id="edges" fill="none" stroke-width="0.5">\n`;
  for (const { hex, path } of pathsToDraw) {
    svg += `<path stroke="${hex}" d="${path}"/>\n`;
  }
  svg += `</g>\n`;

  svg += `</svg>`;
  return svg;
}

// Generate a compact SVG with minimal file size
// - Merges all same-color shapes into single compound paths
// - Uses 2 layers: fills (bottom) and strokes (top) for clean edges
// - Reduces coordinate precision to 1 decimal place
export function generateCompactSvg(
  shapes: ShapeData[],
  width: number,
  height: number,
  transparentBackground: boolean = false
): string {
  // Group shapes by color
  const colorGroups = groupShapesByColor(shapes);

  // Find dominant background color
  let maxBackgroundArea = 0;
  let dominantHex = '#ffffff';

  for (const [hex, group] of colorGroups) {
    if (group.backgroundArea > maxBackgroundArea) {
      maxBackgroundArea = group.backgroundArea;
      dominantHex = hex;
    }
  }

  if (maxBackgroundArea === 0) {
    let maxArea = 0;
    for (const [hex, group] of colorGroups) {
      if (group.totalArea > maxArea) {
        maxArea = group.totalArea;
        dominantHex = hex;
      }
    }
  }

  // Collect paths to draw
  const pathsToDraw: Array<{ hex: string; path: string; area: number }> = [];

  if (transparentBackground) {
    // Only include foreground shapes, skip predominantly background colors
    for (const [hex, group] of colorGroups) {
      const backgroundRatio = group.totalArea > 0 ? group.backgroundArea / group.totalArea : 0;
      if (backgroundRatio > 0.6) continue;

      if (group.foregroundPaths.length > 0) {
        // Merge all foreground paths of this color into one compound path
        const mergedPath = group.foregroundPaths.join(' ');
        pathsToDraw.push({ hex, path: mergedPath, area: group.foregroundArea });
      }
    }
  } else {
    // Include all shapes
    for (const [hex, group] of colorGroups) {
      const allPaths = [...group.backgroundPaths, ...group.foregroundPaths];
      if (allPaths.length > 0) {
        const mergedPath = allPaths.join(' ');
        pathsToDraw.push({ hex, path: mergedPath, area: group.totalArea });
      }
    }
  }

  // Sort by area (largest first for proper layering)
  pathsToDraw.sort((a, b) => b.area - a.area);

  // Build compact SVG
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">\n`;

  if (!transparentBackground) {
    svg += `<rect width="100%" height="100%" fill="${dominantHex}"/>\n`;
  }

  // Single group for all fills
  svg += `<g id="fills">\n`;
  for (const { hex, path } of pathsToDraw) {
    svg += `<path fill="${hex}" d="${path}"/>\n`;
  }
  svg += `</g>\n`;

  // Stroke layer on top for clean edges (thin matching strokes)
  svg += `<g id="strokes" fill="none" stroke-width="0.5" stroke-linejoin="round">\n`;
  for (const { hex, path } of pathsToDraw) {
    svg += `<path stroke="${hex}" d="${path}"/>\n`;
  }
  svg += `</g>\n`;

  svg += `</svg>`;
  return svg;
}

// Layer interface for iterative building
interface Layer {
  colorCount: number;
  palette: Color[];
  shapes: ShapeData[];
}

// Generate layered SVG from multiple processing passes
// Each layer represents a different level of detail (fewer colors = base shapes, more colors = detail)
export function generateLayeredSvg(
  layers: Layer[],
  width: number,
  height: number,
  transparentBackground: boolean = false
): string {
  // Collect all foreground shapes from all layers
  // Later layers (more colors) provide finer detail
  const allForegroundShapes: ShapeData[] = [];
  const allBackgroundShapes: ShapeData[] = [];

  for (const layer of layers) {
    for (const shape of layer.shapes) {
      if (shape.isBackground) {
        allBackgroundShapes.push(shape);
      } else {
        allForegroundShapes.push(shape);
      }
    }
  }

  // If transparent mode and we have foreground shapes, use only those
  // Otherwise fall back to using all shapes from the final layer
  const shapesToUse = transparentBackground && allForegroundShapes.length > 0
    ? allForegroundShapes
    : layers[layers.length - 1].shapes;

  // Group shapes by color
  const colorGroups = groupShapesByColor(shapesToUse);

  // Find dominant background color
  let maxBackgroundArea = 0;
  let dominantHex = '#ffffff';

  for (const [hex, group] of colorGroups) {
    if (group.backgroundArea > maxBackgroundArea) {
      maxBackgroundArea = group.backgroundArea;
      dominantHex = hex;
    }
  }

  if (maxBackgroundArea === 0) {
    let maxArea = 0;
    for (const [hex, group] of colorGroups) {
      if (group.totalArea > maxArea) {
        maxArea = group.totalArea;
        dominantHex = hex;
      }
    }
  }

  // Sort by area for layering
  const sortedGroups = Array.from(colorGroups.entries())
    .sort((a, b) => b[1].totalArea - a[1].totalArea);

  // Build SVG
  // shape-rendering=geometricPrecision asks renderers for the smoothest (anti-aliased)
  // edges rather than crisp/aliased ones.
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="geometricPrecision">\n`;
  svg += `  <title>Vectorized Image</title>\n`;
  svg += `  <desc>Generated with Raster2Vector - ${layers.length} layer(s), ${colorGroups.size} colors</desc>\n`;

  svg += `  <defs>\n`;
  svg += `    <style>\n`;
  svg += `      .vector-shape { stroke-linejoin: round; stroke-linecap: round; }\n`;
  svg += `    </style>\n`;
  svg += `  </defs>\n`;

  if (!transparentBackground) {
    svg += `  <rect id="background" width="100%" height="100%" fill="${dominantHex}"/>\n`;
  }

  svg += `  <g id="content">\n`;

  if (transparentBackground) {
    // TRANSPARENT MODE: Only draw foreground shapes
    const pathsToDraw: Array<{ hex: string; paths: string[]; area: number }> = [];

    for (const [hex, group] of sortedGroups) {
      // Skip colors that are predominantly background
      const backgroundRatio = group.totalArea > 0 ? group.backgroundArea / group.totalArea : 0;
      if (backgroundRatio > 0.6) continue;

      // Only use foreground paths
      if (group.foregroundPaths.length > 0) {
        pathsToDraw.push({
          hex,
          paths: group.foregroundPaths,
          area: group.foregroundArea
        });
      }
    }

    pathsToDraw.sort((a, b) => b.area - a.area);

    // Draw grout layer first (thick strokes to fill gaps)
    svg += `    <g id="grout-layer">\n`;
    for (const { hex, paths } of pathsToDraw) {
      if (paths.length === 0) continue;
      const compoundPath = createCompoundPath(paths);
      const colorName = `color-${hex.slice(1)}`;
      svg += `      <path id="${colorName}-grout" class="vector-shape" d="${compoundPath}" fill="${hex}" stroke="${hex}" stroke-width="2"/>\n`;
    }
    svg += `    </g>\n`;

    // Draw main shapes layer
    svg += `    <g id="shapes-layer">\n`;
    for (const { hex, paths } of pathsToDraw) {
      if (paths.length === 0) continue;
      const compoundPath = createCompoundPath(paths);
      const colorName = `color-${hex.slice(1)}`;
      svg += `      <path id="${colorName}" class="vector-shape" data-shapes="${paths.length}" d="${compoundPath}" fill="${hex}" stroke="${hex}" stroke-width="0.5"/>\n`;
    }
    svg += `    </g>\n`;

  } else {
    // STANDARD MODE: Draw all shapes organized by layer
    // Create separate groups for each processing layer for better editability

    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
      const layer = layers[layerIdx];
      const layerName = layerIdx === 0 ? 'base' : `detail-${layerIdx}`;
      const layerGroups = groupShapesByColor(layer.shapes);

      // Sort by area within this layer
      const sortedLayerGroups = Array.from(layerGroups.entries())
        .sort((a, b) => b[1].totalArea - a[1].totalArea);

      svg += `    <g id="layer-${layerName}" data-colors="${layer.colorCount}">\n`;

      for (const [hex, group] of sortedLayerGroups) {
        const allPaths = [...group.backgroundPaths, ...group.foregroundPaths];
        if (allPaths.length === 0) continue;

        const compoundPath = createCompoundPath(allPaths);
        const colorName = `${layerName}-${hex.slice(1)}`;
        svg += `      <path id="${colorName}" class="vector-shape" d="${compoundPath}" fill="${hex}" stroke="${hex}" stroke-width="0.5"/>\n`;
      }

      svg += `    </g>\n`;
    }
  }

  svg += `  </g>\n`;
  svg += `</svg>`;
  return svg;
}
