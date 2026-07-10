import type { Color, ShapeData, ShapeGradient, Point } from './types';
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
  simplifyScale: number = 1,
  regionThickness: number = Infinity
): Point[] {
  if (rawPoints.length < 3) return rawPoints;

  let points = rawPoints;

  // Pre-smooth BEFORE corner detection (except fast mode). Pixel-boundary jitter
  // reads as sharp angles, so detecting corners on the raw trace marks noise as
  // "corners" which the corner-preserving smoother then faithfully keeps — ragged
  // type edges. True corners are supported by long runs on both sides and survive
  // two plain smoothing passes; jitter does not.
  if (qualityLevel !== 'fast') {
    const none = new Set<number>();
    points = smoothPathPreservingCorners(points, none, qualityLevel === 'detailed' ? 1 : 2, qualityLevel === 'detailed' ? 0.1 : 0.2);
  }

  // Detect corners after the jitter has been smoothed away
  const cornerAngleThreshold = Math.PI / 3; // 60 degrees
  const corners = detectCorners(points, cornerAngleThreshold);

  // Cap the RDP tolerance for THIN regions (outlines, strokes): a tolerance close to
  // the region's half-width lets the two sides of the polygon collapse into or across
  // each other — long thin outlines turn into pinched "sausage link" chains. Scale the
  // cap to the region thickness (≈ 2·area/perimeter, in working px) so wide regions
  // keep the full smoothing tolerance.
  const thicknessCap = Number.isFinite(regionThickness)
    ? Math.max(0.5 * simplifyScale, regionThickness * 0.3)
    : Infinity;
  const tol = (base: number) => Math.min(base * simplifyScale, thicknessCap);

  if (qualityLevel === 'fast') {
    // Fast: aggressive simplification
    const simplified = simplifyPath(points, tol(Math.max(1.0, smoothness * 0.3)));
    if (simplified.length < 3) return rawPoints;
    return simplified;
  }

  if (qualityLevel === 'detailed') {
    // DETAILED: Maximum detail preservation for crisp text and fine details
    // Almost no smoothing - preserve original traced edges
    points = smoothPathPreservingCorners(points, corners, 1, 0.02);
    // Minimal simplification - keep nearly all points for sharp text
    points = simplifyPath(points, tol(Math.max(0.1, smoothness * 0.05)));

    if (points.length < 3) return rawPoints;
    return points;
  }

  if (qualityLevel === 'balanced') {
    // Balanced: moderate smoothing, good detail
    points = smoothPathPreservingCorners(points, corners, 1, 0.12);
    points = simplifyPath(points, tol(Math.max(0.5, smoothness * 0.2)));

    if (points.length < 3) return rawPoints;
    return points;
  }

  // HIGH QUALITY: Good balance of smoothness and detail
  points = smoothPathPreservingCorners(points, corners, 1, 0.15);
  points = simplifyPath(points, tol(Math.max(0.4, smoothness * 0.15)));

  if (points.length < 3) return rawPoints;
  return points;
}

// ============ Least-squares cubic bezier fitting (Schneider, Graphics Gems) ============
// Fitting cubics across RUNS of dense boundary points (instead of anchoring a curve
// at every polyline vertex) averages residual boundary noise away perpendicular to
// the curve — smoother, crisper edges AND fewer path nodes. Corners are exact
// segment breaks so type stays sharp.

type Seg = { c1: Point; c2: Point; p2: Point; line?: boolean };

const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Point, s: number): Point => ({ x: a.x * s, y: a.y * s });
const norm = (a: Point): Point => {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};

// de Casteljau evaluation of a cubic given its 4 control points
function bezierPoint(v0: Point, v1: Point, v2: Point, v3: Point, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return { x: a * v0.x + b * v1.x + c * v2.x + d * v3.x, y: a * v0.y + b * v1.y + c * v2.y + d * v3.y };
}

function chordLengthParameterize(pts: Point[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) {
    u.push(u[i - first - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = u[u.length - 1] || 1;
  for (let i = 0; i < u.length; i++) u[i] /= total;
  return u;
}

// Least-squares solve for the two inner control points given end tangents.
function generateBezier(pts: Point[], first: number, last: number, u: number[], tHat1: Point, tHat2: Point): [Point, Point, Point, Point] {
  const p0 = pts[first], p3 = pts[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;

  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
    const a1 = scale(tHat1, b1);
    const a2 = scale(tHat2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(pts[first + i], add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }

  const det = c00 * c11 - c01 * c01;
  let alpha1 = 0, alpha2 = 0;
  if (Math.abs(det) > 1e-12) {
    alpha1 = (x0 * c11 - x1 * c01) / det;
    alpha2 = (c00 * x1 - c01 * x0) / det;
  }
  const segLen = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  // Wu/Barsky heuristic fallback for degenerate/negative solutions
  if (alpha1 < 1e-6 * segLen || alpha2 < 1e-6 * segLen) {
    alpha1 = alpha2 = segLen / 3;
  }
  return [p0, add(p0, scale(tHat1, alpha1)), add(p3, scale(tHat2, alpha2)), p3];
}

// Max squared deviation of the points from the fitted curve (+ split index)
function computeMaxError(pts: Point[], first: number, last: number, bez: [Point, Point, Point, Point], u: number[]): { maxDist: number; split: number } {
  let maxDist = 0;
  let split = (last - first + 1) >> 1;
  for (let i = first + 1; i < last; i++) {
    const p = bezierPoint(bez[0], bez[1], bez[2], bez[3], u[i - first]);
    const d = (p.x - pts[i].x) ** 2 + (p.y - pts[i].y) ** 2;
    if (d > maxDist) { maxDist = d; split = i; }
  }
  return { maxDist, split };
}

// One Newton-Raphson step refining each point's curve parameter
function reparameterize(pts: Point[], first: number, u: number[], bez: [Point, Point, Point, Point]): number[] {
  const out = new Array<number>(u.length);
  const [v0, v1, v2, v3] = bez;
  // derivative control points
  const d1 = [scale(sub(v1, v0), 3), scale(sub(v2, v1), 3), scale(sub(v3, v2), 3)];
  const d2 = [scale(sub(d1[1], d1[0]), 2), scale(sub(d1[2], d1[1]), 2)];
  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t;
    const q = bezierPoint(v0, v1, v2, v3, t);
    const q1 = { x: mt * mt * d1[0].x + 2 * mt * t * d1[1].x + t * t * d1[2].x, y: mt * mt * d1[0].y + 2 * mt * t * d1[1].y + t * t * d1[2].y };
    const q2 = { x: mt * d2[0].x + t * d2[1].x, y: mt * d2[0].y + t * d2[1].y };
    const diff = sub(q, pts[first + i]);
    const num = dot(diff, q1);
    const den = dot(q1, q1) + dot(diff, q2);
    out[i] = Math.abs(den) > 1e-12 ? t - num / den : t;
    if (out[i] < 0) out[i] = 0; else if (out[i] > 1) out[i] = 1;
  }
  return out;
}

function centerTangent(pts: Point[], i: number): Point {
  const a = pts[i - 1], b = pts[i + 1];
  return norm({ x: a.x - b.x, y: a.y - b.y });
}

function fitCubic(pts: Point[], first: number, last: number, tHat1: Point, tHat2: Point, errSq: number, out: Seg[], depth: number): void {
  const n = last - first + 1;
  if (n <= 2 || depth > 24) {
    out.push({ c1: pts[first], c2: pts[last], p2: pts[last], line: true });
    return;
  }
  let u = chordLengthParameterize(pts, first, last);
  let bez = generateBezier(pts, first, last, u, tHat1, tHat2);
  let { maxDist, split } = computeMaxError(pts, first, last, bez, u);

  if (maxDist > errSq && maxDist < errSq * 16) {
    for (let it = 0; it < 3; it++) {
      u = reparameterize(pts, first, u, bez);
      bez = generateBezier(pts, first, last, u, tHat1, tHat2);
      const r = computeMaxError(pts, first, last, bez, u);
      maxDist = r.maxDist; split = r.split;
      if (maxDist <= errSq) break;
    }
  }
  if (maxDist <= errSq) {
    out.push({ c1: bez[1], c2: bez[2], p2: bez[3] });
    return;
  }

  // split at the worst point and recurse with a smooth centre tangent
  if (split <= first) split = first + 1;
  if (split >= last) split = last - 1;
  const tC = centerTangent(pts, split);
  fitCubic(pts, first, split, tHat1, tC, errSq, out, depth + 1);
  fitCubic(pts, split, last, scale(tC, -1), tHat2, errSq, out, depth + 1);
}

// RDP variant that returns the INDICES of the kept vertices (structure detection)
function rdpIndices(points: Point[], first: number, last: number, tolSq: number, keep: number[]): void {
  let maxDist = 0, idx = -1;
  const a = points[first], b = points[last];
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  for (let i = first + 1; i < last; i++) {
    const p = points[i];
    let d: number;
    if (l2 === 0) d = (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
    else {
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      d = (p.x - (a.x + t * dx)) ** 2 + (p.y - (a.y + t * dy)) ** 2;
    }
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > tolSq && idx > 0) {
    rdpIndices(points, first, idx, tolSq, keep);
    keep.push(idx);
    rdpIndices(points, idx, last, tolSq, keep);
  }
}

// Convert one closed dense contour into path segments: structural corners become
// exact breaks; the runs between them are least-squares fitted with cubics (or a
// straight line when the run is essentially straight).
function fitContour(dense: Point[], errSq: number): { start: Point; segs: Seg[] } | null {
  // dedupe consecutive duplicates (Moore trace can revisit)
  const pts: Point[] = [];
  for (const p of dense) {
    const l = pts[pts.length - 1];
    if (!l || Math.abs(l.x - p.x) > 1e-9 || Math.abs(l.y - p.y) > 1e-9) pts.push(p);
  }
  if (pts.length > 1) {
    const f = pts[0], l = pts[pts.length - 1];
    if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) pts.pop();
  }
  const n = pts.length;
  if (n < 3) return null;

  // Structural vertices via index-tracking RDP over the closed loop (split at 0 and
  // the far point so the recursion has endpoints).
  const far = n >> 1;
  const keep: number[] = [0];
  rdpIndices(pts, 0, far, errSq * 4, keep);
  keep.push(far);
  rdpIndices(pts, far, n - 1, errSq * 4, keep);

  // Corners = structural vertices with a sharp turn (measured between neighbouring
  // structural vertices, so dense-point jitter can't fake an angle).
  const breaks: number[] = [];
  for (let k = 0; k < keep.length; k++) {
    const iPrev = keep[(k - 1 + keep.length) % keep.length];
    const i = keep[k];
    const iNext = keep[(k + 1) % keep.length];
    const angle = getAngle(pts[iPrev], pts[i], pts[iNext]);
    if (angle < Math.PI - Math.PI / 3) breaks.push(i); // > 60 deg turn
  }
  // Need at least two breaks for closed-loop fitting; synthesize if the shape is
  // entirely smooth (e.g. a circle).
  if (breaks.length === 0) breaks.push(0, far);
  else if (breaks.length === 1) breaks.push((breaks[0] + far) % n);
  breaks.sort((a, b) => a - b);

  const segs: Seg[] = [];
  for (let k = 0; k < breaks.length; k++) {
    const i0 = breaks[k];
    const i1 = breaks[(k + 1) % breaks.length];
    // unwrap the run i0..i1 (possibly crossing the loop seam)
    const run: Point[] = [];
    for (let i = i0; ; i = (i + 1) % n) {
      run.push(pts[i]);
      if (i === i1) break;
    }
    if (run.length < 2) continue;
    if (run.length === 2) {
      segs.push({ c1: run[0], c2: run[1], p2: run[1], line: true });
      continue;
    }
    // straight run? max deviation from chord below tolerance -> single line
    let straight = true;
    const a = run[0], b = run[run.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    for (let i = 1; i < run.length - 1 && straight; i++) {
      const p = run[i];
      let d: number;
      if (l2 === 0) d = (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
      else {
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = (p.x - (a.x + t * dx)) ** 2 + (p.y - (a.y + t * dy)) ** 2;
      }
      if (d > errSq) straight = false;
    }
    if (straight) {
      segs.push({ c1: a, c2: b, p2: b, line: true });
      continue;
    }
    // one-sided end tangents (corner = C0 break keeps corners crisp)
    const tHat1 = norm(sub(run[Math.min(2, run.length - 1)], run[0]));
    const tHat2 = norm(sub(run[Math.max(run.length - 3, 0)], run[run.length - 1]));
    fitCubic(run, 0, run.length - 1, tHat1, tHat2, errSq, segs, 0);
  }
  if (!segs.length) return null;
  return { start: pts[breaks[0]], segs };
}

function segsToPath(start: Point, segs: Seg[]): string {
  const f = (v: number) => Math.round(v * 10) / 10;
  let d = `M${f(start.x)},${f(start.y)}`;
  for (const s of segs) {
    if (s.line) d += `L${f(s.p2.x)},${f(s.p2.y)}`;
    else d += `C${f(s.c1.x)},${f(s.c1.y)} ${f(s.c2.x)},${f(s.c2.y)} ${f(s.p2.x)},${f(s.p2.y)}`;
  }
  return d + 'Z';
}

// Full contour -> path-string pipeline used by the tracer for balanced/high/detailed:
// light jitter smoothing, winding normalisation, then least-squares cubic fitting.
function contourToPath(
  boundary: Point[],
  smoothness: number,
  qualityLevel: 'fast' | 'balanced' | 'high' | 'detailed',
  simplifyScale: number,
  regionThickness: number
): string {
  let pts = boundary;
  if (qualityLevel !== 'fast') {
    const none = new Set<number>();
    // THIN regions get extra position-smoothing: their simplify tolerance is
    // deliberately capped tight (so the two sides can't collapse together),
    // which means simplification never removes their boundary jitter — the
    // hairline "wobble". Smoothing relaxes the jitter without any collapse
    // risk because it averages positions rather than dropping points.
    const thin = Number.isFinite(regionThickness) && regionThickness < 6;
    const passes = qualityLevel === 'detailed' ? 1 : thin ? 4 : 2;
    const weight = qualityLevel === 'detailed' ? 0.1 : thin ? 0.28 : 0.2;
    pts = smoothPathPreservingCorners(pts, none, passes, weight);
  }
  pts = ensureClockwise(pts);

  const qualityTol = qualityLevel === 'detailed' ? Math.max(0.4, smoothness * 0.12)
    : qualityLevel === 'balanced' ? Math.max(0.6, smoothness * 0.22)
    : Math.max(0.5, smoothness * 0.18); // high
  let tol = qualityTol * simplifyScale;
  if (Number.isFinite(regionThickness)) {
    tol = Math.min(tol, Math.max(0.5 * simplifyScale, regionThickness * 0.3));
  }
  const fitted = fitContour(pts, tol * tol);
  if (!fitted) {
    // degenerate contour — fall back to the legacy polyline path
    const corners = detectCorners(pts, Math.PI / 3);
    return pointsToSvgPathOptimized(pts, corners);
  }
  return segsToPath(fitted.start, fitted.segs);
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

    // Corners are EXACT polygon vertices: zero tension into/out of a corner keeps
    // type corners sharp instead of slightly rounding through them.
    const tension1 = isCorner1 ? 0 : 0.17;
    const tension2 = isCorner2 ? 0 : 0.17;

    const cp1x = p1.x + (p2.x - p0.x) * tension1;
    const cp1y = p1.y + (p2.y - p0.y) * tension1;
    const cp2x = p2.x - (p3.x - p1.x) * tension2;
    const cp2y = p2.y - (p3.y - p1.y) * tension2;

    // Check if the curve is effectively a straight line
    // If control points are very close to the line segment p1-p2, use L instead of C
    const cp1 = { x: cp1x, y: cp1y };
    const cp2 = { x: cp2x, y: cp2y };
    // squared px: ~1.3px — snaps micro-wobbly near-straight runs (glyph stems, box
    // edges) to clean lines; genuine curves deviate far more than this.
    const errorThreshold = 1.7;

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

// Moore-neighbour boundary trace against an arbitrary inside-predicate.
function traceBoundaryPredicate(
  isInside: (x: number, y: number) => boolean,
  startX: number,
  startY: number,
  maxIter: number
): Point[] {
  const boundary: Point[] = [];
  let curX = startX;
  let curY = startY;

  boundary.push({ x: curX, y: curY });

  let prevX = curX - 1;
  let prevY = curY;

  let iter = 0;

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
  const isInside = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return mask[y * width + x] === 1;
  };
  return traceBoundaryPredicate(isInside, startX, startY, width * height * 2);
}

// Find the HOLES of a connected component: complement cells (any other label /
// colour) that are fully enclosed by the component, i.e. not reachable from the
// component's padded bbox ring without crossing it. Returns each hole's size and
// its Moore-traced boundary. Component pixels are identified via compIdMap==compId.
function extractHoles(
  compIdMap: Int32Array,
  compId: number,
  width: number,
  height: number,
  bx0: number, by0: number, bx1: number, by1: number,
  holeMinArea: number
): Array<{ size: number; boundary: Point[] }> {
  const holes: Array<{ size: number; boundary: Point[] }> = [];
  // Pad by 1 (clamped) so the "outside" flood can wrap around the component.
  const hx0 = Math.max(0, bx0 - 1), hy0 = Math.max(0, by0 - 1);
  const hx1 = Math.min(width - 1, bx1 + 1), hy1 = Math.min(height - 1, by1 + 1);
  const hw = hx1 - hx0 + 1, hh = hy1 - hy0 + 1;
  if (hw < 3 || hh < 3) return holes;

  // 0 = unclassified, 1 = outside, >=2 = hole id
  const lab = new Uint16Array(hw * hh);
  const queue: number[] = [];

  const seed = (gx: number, gy: number) => {
    const li = (gy - hy0) * hw + (gx - hx0);
    if (lab[li] === 0 && compIdMap[gy * width + gx] !== compId) {
      lab[li] = 1;
      queue.push(li);
    }
  };
  for (let gx = hx0; gx <= hx1; gx++) { seed(gx, hy0); seed(gx, hy1); }
  for (let gy = hy0; gy <= hy1; gy++) { seed(hx0, gy); seed(hx1, gy); }

  // BFS (4-connected — the correct dual of the 8-connected component) marking
  // everything reachable from the ring as outside.
  let qp = 0;
  while (qp < queue.length) {
    const li = queue[qp++];
    const lx = li % hw, ly = (li / hw) | 0;
    // left
    if (lx > 0 && lab[li - 1] === 0 && compIdMap[(ly + hy0) * width + (lx - 1 + hx0)] !== compId) { lab[li - 1] = 1; queue.push(li - 1); }
    // right
    if (lx < hw - 1 && lab[li + 1] === 0 && compIdMap[(ly + hy0) * width + (lx + 1 + hx0)] !== compId) { lab[li + 1] = 1; queue.push(li + 1); }
    // up
    if (ly > 0 && lab[li - hw] === 0 && compIdMap[(ly - 1 + hy0) * width + (lx + hx0)] !== compId) { lab[li - hw] = 1; queue.push(li - hw); }
    // down
    if (ly < hh - 1 && lab[li + hw] === 0 && compIdMap[(ly + 1 + hy0) * width + (lx + hx0)] !== compId) { lab[li + hw] = 1; queue.push(li + hw); }
  }

  // Remaining unclassified complement cells are enclosed → group them into holes.
  let nextHoleId = 2;
  const holeQueue: number[] = [];
  for (let ly = 0; ly < hh; ly++) {
    for (let lx = 0; lx < hw; lx++) {
      const li = ly * hw + lx;
      if (lab[li] !== 0) continue;
      if (compIdMap[(ly + hy0) * width + (lx + hx0)] === compId) continue;
      if (nextHoleId >= 65535) return holes; // Uint16 id budget exhausted (pathological)
      const hid = nextHoleId++;
      lab[li] = hid;
      holeQueue.length = 0;
      holeQueue.push(li);
      let size = 0;
      let hp = 0;
      while (hp < holeQueue.length) {
        const ci = holeQueue[hp++];
        size++;
        const cx = ci % hw, cy = (ci / hw) | 0;
        if (cx > 0 && lab[ci - 1] === 0 && compIdMap[(cy + hy0) * width + (cx - 1 + hx0)] !== compId) { lab[ci - 1] = hid; holeQueue.push(ci - 1); }
        if (cx < hw - 1 && lab[ci + 1] === 0 && compIdMap[(cy + hy0) * width + (cx + 1 + hx0)] !== compId) { lab[ci + 1] = hid; holeQueue.push(ci + 1); }
        if (cy > 0 && lab[ci - hw] === 0 && compIdMap[(cy - 1 + hy0) * width + (cx + hx0)] !== compId) { lab[ci - hw] = hid; holeQueue.push(ci - hw); }
        if (cy < hh - 1 && lab[ci + hw] === 0 && compIdMap[(cy + 1 + hy0) * width + (cx + hx0)] !== compId) { lab[ci + hw] = hid; holeQueue.push(ci + hw); }
      }
      if (size < holeMinArea) continue; // parent fill covers micro-holes
      // (lx,ly) is the topmost-leftmost cell of this hole — a valid Moore start.
      const isInHole = (gx: number, gy: number) => {
        if (gx < hx0 || gx > hx1 || gy < hy0 || gy > hy1) return false;
        return lab[(gy - hy0) * hw + (gx - hx0)] === hid;
      };
      const boundary = traceBoundaryPredicate(isInHole, lx + hx0, ly + hy0, hw * hh * 2);
      if (boundary.length > 2) holes.push({ size, boundary });
    }
  }

  return holes;
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

// Accumulated least-squares sums for fitting colour(x, y) = a + b·x + c·y over a
// component's source pixels (positions in native/viewBox coordinates).
interface GradSums {
  n: number;
  sx: number; sy: number; sxx: number; syy: number; sxy: number;
  sc: Float64Array;   // Σ channel            (r, g, b)
  scx: Float64Array;  // Σ channel · x
  scy: Float64Array;  // Σ channel · y
  scc: Float64Array;  // Σ channel²
  // Interior-only colour sums (all 4-neighbours share the label) — boundary
  // pixels are anti-alias blends and wash the component's own colour.
  inN: number; inR: number; inG: number; inB: number;
}

// Fit a colour ramp to a component and decide whether a gradient fill is
// warranted. Quantisation flattens smooth shading (metallic chrome, airbrushed
// fades) into banded fills; this fits a 1-D colour PROFILE along the dominant
// ramp direction — binned means of the component's own pixels, simplified to a
// few stops — so curved ramps (specular sheens: dark → bright band → dark) are
// captured too, which a straight 2-stop linear model cannot represent. The
// plane fit supplies only the DIRECTION; acceptance is judged on the profile
// residual, so nonlinear-but-1-D ramps pass while genuinely textured regions
// (brushed-metal noise) keep a high within-bin variance and stay flat-filled.
function fitShapeGradient(
  g: GradSums,
  samples: Int32Array,   // native pixel indices of the component's samples [0..g.n)
  tBuf: Float32Array,    // scratch: projection of each sample onto the ramp axis
  rgba: Uint8ClampedArray,
  srcW: number
): ShapeGradient | undefined {
  if (g.n < 300) return undefined;

  // Plane fit (shared 3×3 normal equations, explicit inverse) → ramp direction.
  const m00 = g.n, m01 = g.sx, m02 = g.sy;
  const m11 = g.sxx, m12 = g.sxy, m22 = g.syy;
  const det = m00 * (m11 * m22 - m12 * m12) - m01 * (m01 * m22 - m12 * m02) + m02 * (m01 * m12 - m11 * m02);
  // Degenerate spatial spread (hairline components) — no reliable direction.
  if (!(Math.abs(det) > 1e-3 * g.n)) return undefined;
  // (Only the slope rows of the inverse are needed — the intercept doesn't
  // affect the ramp direction.)
  const i01 = (m02 * m12 - m01 * m22) / det;
  const i02 = (m01 * m12 - m02 * m11) / det;
  const i11 = (m00 * m22 - m02 * m02) / det;
  const i12 = (m01 * m02 - m00 * m12) / det;
  const i22 = (m00 * m11 - m01 * m01) / det;
  const b = new Float64Array(3), c = new Float64Array(3);
  let sseFlat = 0;
  for (let ch = 0; ch < 3; ch++) {
    b[ch] = i01 * g.sc[ch] + i11 * g.scx[ch] + i12 * g.scy[ch];
    c[ch] = i02 * g.sc[ch] + i12 * g.scx[ch] + i22 * g.scy[ch];
    sseFlat += Math.max(0, g.scc[ch] - (g.sc[ch] * g.sc[ch]) / g.n);
  }

  // Ramp direction: dominant eigenvector of Σ (per-channel gradient)·(gradientᵀ),
  // so channels moving in opposite directions (blue up, red down) still agree.
  let gxx = 0, gxy = 0, gyy = 0;
  for (let ch = 0; ch < 3; ch++) { gxx += b[ch] * b[ch]; gxy += b[ch] * c[ch]; gyy += c[ch] * c[ch]; }
  const tr = gxx + gyy;
  const d2 = Math.sqrt(Math.max(0, (gxx - gyy) * (gxx - gyy) + 4 * gxy * gxy));
  const l1 = (tr + d2) / 2;
  if (!(l1 > 1e-12)) return undefined;
  let dx: number, dy: number;
  if (Math.abs(gxy) > 1e-12) { dx = l1 - gyy; dy = gxy; }
  else if (gxx >= gyy) { dx = 1; dy = 0; }
  else { dx = 0; dy = 1; }
  const dl = Math.hypot(dx, dy);
  dx /= dl; dy /= dl;

  const mx = g.sx / g.n, my = g.sy / g.n;
  // Finer profile resolution for large components: long ramps across big fields
  // carry curvature that 12 bins under-sample; small shapes keep coarse bins so
  // noisy means can't invent stops.
  const K = g.n > 20000 ? 16 : 12;

  // Bin the samples along whatever 1-D parameterisation is in tBuf and return
  // the profile residual (within-bin variance) + stop-candidate points with t
  // normalised to [0,1]. Bin means are actual pixel means — no clamping needed.
  type P = { t: number; r: number; g: number; b: number };
  const bn = new Float64Array(K);
  const bsc = [new Float64Array(K), new Float64Array(K), new Float64Array(K)];
  const bscc = [new Float64Array(K), new Float64Array(K), new Float64Array(K)];
  const buildProfile = (tmin: number, tmax: number): { sse: number; pts: P[] } | null => {
    if (!(tmax - tmin >= 6)) return null; // ramp too short to matter
    bn.fill(0);
    for (let ch = 0; ch < 3; ch++) { bsc[ch].fill(0); bscc[ch].fill(0); }
    const tspan = tmax - tmin;
    for (let k = 0; k < g.n; k++) {
      const bi = Math.min(K - 1, (((tBuf[k] - tmin) / tspan) * K) | 0);
      const i4 = samples[k] * 4;
      bn[bi]++;
      for (let ch = 0; ch < 3; ch++) {
        const v = rgba[i4 + ch];
        bsc[ch][bi] += v; bscc[ch][bi] += v * v;
      }
    }
    let sse = 0;
    for (let bi = 0; bi < K; bi++) {
      if (bn[bi] === 0) continue;
      for (let ch = 0; ch < 3; ch++) sse += Math.max(0, bscc[ch][bi] - (bsc[ch][bi] * bsc[ch][bi]) / bn[bi]);
    }
    const pts: P[] = [];
    for (let bi = 0; bi < K; bi++) {
      if (bn[bi] < Math.max(2, g.n / (K * 20))) continue; // starved bin — unreliable mean
      pts.push({ t: (bi + 0.5) / K, r: bsc[0][bi] / bn[bi], g: bsc[1][bi] / bn[bi], b: bsc[2][bi] / bn[bi] });
    }
    if (pts.length < 2) return null;
    return { sse, pts };
  };

  // LINEAR: project every sample onto the plane-fit axis; endpoints come from
  // the OBSERVED extremes (bbox corners extrapolate on diagonal/L-shaped regions).
  let ltmin = Infinity, ltmax = -Infinity;
  for (let k = 0; k < g.n; k++) {
    const i = samples[k];
    const t = dx * ((i % srcW) - mx) + dy * (((i / srcW) | 0) - my);
    tBuf[k] = t;
    if (t < ltmin) ltmin = t;
    if (t > ltmax) ltmax = t;
  }
  const linearP = buildProfile(ltmin, ltmax);

  // RADIAL: distance from a deviation-weighted centre — for a glow/halo the
  // pixels that differ most from the mean ARE the anomaly core, so weighting
  // the centroid by squared colour deviation lands the centre on it. A wrong
  // centre (asymmetric shapes) just produces a poor profile and loses the SSE
  // comparison below — conservative by construction.
  const cmR = g.sc[0] / g.n, cmG = g.sc[1] / g.n, cmB = g.sc[2] / g.n;
  let wSum = 0, wxs = 0, wys = 0;
  for (let k = 0; k < g.n; k++) {
    const i4 = samples[k] * 4;
    const dr = rgba[i4] - cmR, dg = rgba[i4 + 1] - cmG, db = rgba[i4 + 2] - cmB;
    const w = dr * dr + dg * dg + db * db;
    const i = samples[k];
    wSum += w; wxs += w * (i % srcW); wys += w * ((i / srcW) | 0);
  }
  const rcx = wSum > 1e-9 ? wxs / wSum : mx;
  const rcy = wSum > 1e-9 ? wys / wSum : my;
  let rmax = 0;
  for (let k = 0; k < g.n; k++) {
    const i = samples[k];
    const t = Math.hypot((i % srcW) - rcx, ((i / srcW) | 0) - rcy);
    tBuf[k] = t;
    if (t > rmax) rmax = t;
  }
  const radialP = buildProfile(0, rmax);

  // Pick the model that explains the pixels better (radial needs a clear win —
  // linear is the safer default for ambiguous shapes), then gate vs flat fill:
  // the profile must genuinely explain the variation or a flat fill is more
  // honest — textured regions keep high within-bin variance and stay flat.
  const useRadial = !!radialP && (!linearP || radialP.sse < 0.9 * linearP.sse);
  const chosen = useRadial ? radialP! : linearP;
  if (!chosen) return undefined;
  if (!(chosen.sse <= 0.55 * sseFlat)) return undefined;
  const pts = chosen.pts;
  // Pin the profile ends: linear stretches to both endpoints; radial offsets
  // are fractions of r from the centre, and SVG pads inward from the first stop.
  if (!useRadial) pts[0].t = 0;
  pts[pts.length - 1].t = 1;

  // Visible ramp span across the whole profile.
  let span = 0;
  for (let ch = 0; ch < 3; ch++) {
    let lo = 255, hi = 0;
    for (const p of pts) { const v = ch === 0 ? p.r : ch === 1 ? p.g : p.b; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo > span) span = hi - lo;
  }
  if (span < 14) return undefined;

  // Simplify to few stops: recursively keep the point deviating most from the
  // linear interpolation of its kept neighbours (Douglas-Peucker in colour-t space).
  const keep = new Set<number>([0, pts.length - 1]);
  const rec = (i0: number, i1: number) => {
    if (i1 - i0 < 2 || keep.size >= 6) return;
    let best = -1, bestDev = 0;
    for (let k = i0 + 1; k < i1; k++) {
      const f = (pts[k].t - pts[i0].t) / Math.max(1e-9, pts[i1].t - pts[i0].t);
      const dr = pts[k].r - (pts[i0].r + (pts[i1].r - pts[i0].r) * f);
      const dg = pts[k].g - (pts[i0].g + (pts[i1].g - pts[i0].g) * f);
      const db = pts[k].b - (pts[i0].b + (pts[i1].b - pts[i0].b) * f);
      const dev = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
      if (dev > bestDev) { bestDev = dev; best = k; }
    }
    if (best >= 0 && bestDev > 4) {
      keep.add(best);
      rec(i0, best);
      rec(best, i1);
    }
  };
  rec(0, pts.length - 1);

  const rc = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const stops = Array.from(keep).sort((p, q) => p - q).map((k) => ({
    t: Math.round(pts[k].t * 1000) / 1000,
    c: { r: rc(pts[k].r), g: rc(pts[k].g), b: rc(pts[k].b), a: 255 } as Color,
  }));

  const r1 = (v: number) => Math.round(v * 10) / 10;
  if (useRadial) {
    return { stops, radial: { cx: r1(rcx), cy: r1(rcy), r: r1(rmax) } };
  }
  return {
    stops,
    linear: { x1: r1(mx + dx * ltmin), y1: r1(my + dy * ltmin), x2: r1(mx + dx * ltmax), y2: r1(my + dy * ltmax) },
  };
}

// Geometric shape recognition. Rasterised circles (bolts, rivets, dots, wheels)
// and axis-aligned rectangles (windows, bars, tiles, counters) come out of the
// generic curve fitter as slightly wobbly bezier blobs; when a component's
// boundary IS one of these primitives, emitting the exact geometry is strictly
// crisper. Gates are strict so organic blobs can never false-positive:
// - rectangle: the component (plus its enclosed holes) fills ≥98.5% of its
//   bounding box — for a connected region that is only true of a rectangle;
// - circle: boundary radius about the centroid is near-constant AND the area
//   matches πr² — the area check rejects rings/stars whose boundary alone
//   could masquerade.
// `area` must include enclosed-hole area so frames and donuts snap too.
function snapPrimitivePath(
  boundary: Point[],
  area: number,
  bx0: number, by0: number, bx1: number, by1: number
): string | null {
  if (boundary.length < 8 || area < 16) return null;
  const f = (v: number) => Math.round(v * 10) / 10;

  // Rectangle. Small shapes get a tolerant fill gate (their misses are ragged
  // anti-aliased edge pixels); large shapes stay strict — a loose gate on a
  // 200×100 region could hide a ~26px corner radius, and squaring off a
  // visibly rounded rectangle is worse than curve-fitting it.
  const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
  if (w >= 3 && h >= 3 && area >= w * h * (w * h <= 4000 ? 0.97 : 0.985)) {
    return `M ${bx0} ${by0} L ${bx1} ${by0} L ${bx1} ${by1} L ${bx0} ${by1} Z`;
  }

  // Circle
  let cx = 0, cy = 0;
  for (const p of boundary) { cx += p.x; cy += p.y; }
  cx /= boundary.length; cy /= boundary.length;
  let rsum = 0;
  for (const p of boundary) rsum += Math.hypot(p.x - cx, p.y - cy);
  const r = rsum / boundary.length;
  if (r < 2.5) return null;
  let maxDev = 0;
  for (const p of boundary) {
    const d = Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);
    if (d > maxDev) maxDev = d;
  }
  if (maxDev > Math.max(0.08 * r, 1.5)) return null;
  if (Math.abs(area - Math.PI * r * r) > 0.12 * Math.PI * r * r) return null;
  const k = 0.5522847498 * r;
  return `M ${f(cx - r)} ${f(cy)}` +
    ` C ${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)}` +
    ` C ${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)}` +
    ` C ${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)}` +
    ` C ${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} Z`;
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
  simplifyScale: number = 1,      // label-upscale factor (scales RDP tolerance)
  sourceRgba?: Uint8ClampedArray | null, // native-res image for gradient fitting
  sourceWidth: number = 0,
  sourceHeight: number = 0
): ShapeData[] {
  const result: ShapeData[] = [];

  const colorsToTrace = selectedColors.size > 0
    ? Array.from(selectedColors)
    : palette.map((_, i) => i);

  let colorsProcessed = 0;

  // Global component-id map shared across all colours (ids are unique and only ever
  // grow, so it never needs resetting). Used by hole extraction to test membership
  // of the CURRENT component, which per-colour `visited` can't (it accumulates).
  const compIdMap = new Int32Array(width * height);
  let compCounter = 0;

  // Merge radius (morphological closing on each colour's mask before tracing).
  // Only 'fast' keeps a little closing to cut shape count. For every quality level
  // above it the closing is DISABLED: closing one colour's mask also bridges it
  // ACROSS other colours' thin features (a 2px close covers any ≤4px line that
  // crosses it), and those bridged shapes then paint over the line periodically —
  // outlines rendered as "bead chains". The label map is already consolidated
  // upstream, so tracing the exact per-pixel partition is both cleaner and safer.
  const mergeRadius = mergeNeighbors && qualityLevel === 'fast' ? 2 : 0;

  // Gradient fitting samples the native-res source on the native grid (every
  // sfi-th working pixel) — statistically identical to sampling every working
  // pixel at a fraction of the cost. Sums live in `gs`, reset per component;
  // sample indices are kept (reusable buffers) so the profile fit can bin the
  // component's pixels along the ramp axis once the direction is known.
  const doGrad = !!(sourceRgba && sourceWidth > 0 && sourceHeight > 0 && width % sourceWidth === 0);
  const sfi = doGrad ? Math.max(1, Math.round(width / sourceWidth)) : 1;
  const gradSamples = doGrad ? new Int32Array(sourceWidth * sourceHeight) : new Int32Array(0);
  const gradT = doGrad ? new Float32Array(sourceWidth * sourceHeight) : new Float32Array(0);
  const gs: GradSums = {
    n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0,
    sc: new Float64Array(3), scx: new Float64Array(3), scy: new Float64Array(3), scc: new Float64Array(3),
    inN: 0, inR: 0, inG: 0, inB: 0,
  };
  let curColor = -1; // label being traced — for the interiority test in gradAccum
  const gradAccum = (px: number, py: number, idx: number) => {
    if (px % sfi !== 0 || py % sfi !== 0) return;
    const gx = px / sfi, gy = py / sfi;
    const si = gy * sourceWidth + gx;
    gradSamples[gs.n] = si;
    gs.n++;
    gs.sx += gx; gs.sy += gy; gs.sxx += gx * gx; gs.syy += gy * gy; gs.sxy += gx * gy;
    for (let ch = 0; ch < 3; ch++) {
      const v = sourceRgba![si * 4 + ch];
      gs.sc[ch] += v; gs.scx[ch] += v * gx; gs.scy[ch] += v * gy; gs.scc[ch] += v * v;
    }
    if (px > 0 && px < width - 1 && py > 0 && py < height - 1 &&
        quantized[idx - 1] === curColor && quantized[idx + 1] === curColor &&
        quantized[idx - width] === curColor && quantized[idx + width] === curColor) {
      gs.inN++;
      gs.inR += sourceRgba![si * 4];
      gs.inG += sourceRgba![si * 4 + 1];
      gs.inB += sourceRgba![si * 4 + 2];
    }
  };
  const gradReset = () => {
    gs.n = 0; gs.sx = 0; gs.sy = 0; gs.sxx = 0; gs.syy = 0; gs.sxy = 0;
    gs.sc.fill(0); gs.scx.fill(0); gs.scy.fill(0); gs.scc.fill(0);
    gs.inN = 0; gs.inR = 0; gs.inG = 0; gs.inB = 0;
  };

  // Process each color separately with optional merging
  for (const colorIndex of colorsToTrace) {
    // Skip invalid indices and transparent marker (255)
    if (colorIndex >= palette.length || colorIndex === 255) continue;
    curColor = colorIndex;

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

          // A. Flood Fill (8-connected) to mark this ENTIRE region as visited, count
          // area and record the component id + bbox (needed for hole extraction).
          // Also track how many pixels are in the foreground mask (if provided)
          // Count original pixels (not dilated) for accurate area
          compCounter++;
          const compId = compCounter;
          compIdMap[idx] = compId;
          let pixelCount = 0;
          let foregroundPixelCount = 0;
          let cbx0 = x, cby0 = y, cbx1 = x, cby1 = y;
          const stack = [idx];
          visited[idx] = 1;
          if (doGrad) gradReset();

          // Count original color pixels in this merged region
          if (colorMask[idx] === 1) {
            pixelCount++;
            if (foregroundMask && foregroundMask[idx] === 1) {
              foregroundPixelCount++;
            }
            if (doGrad) gradAccum(x, y, idx);
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
                   compIdMap[nIdx] = compId;
                   if (nx < cbx0) cbx0 = nx; if (nx > cbx1) cbx1 = nx;
                   if (ny < cby0) cby0 = ny; if (ny > cby1) cby1 = ny;
                   // Count original color pixels for accurate area
                   if (colorMask[nIdx] === 1) {
                     pixelCount++;
                     if (foregroundMask && foregroundMask[nIdx] === 1) {
                       foregroundPixelCount++;
                     }
                     if (doGrad) gradAccum(nx, ny, nIdx);
                   }
                   stack.push(nIdx);
                 }
               }
            }
          }

          // Region too small to keep — skip before any boundary work.
          if (pixelCount < minArea) continue;

          // B. Trace the OUTER boundary. (x,y) is the topmost-leftmost pixel of the
          // component, a valid Moore-trace start.
          const boundary = traceMaskBoundary(processedMask, width, height, x, y);
          if (boundary.length <= 2) continue;

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

          // C. Extract HOLES — complement areas fully enclosed by this component.
          // Without them a ring/net-like shape is drawn as its filled outer hull and
          // ERASES everything beneath its openings (painter's-order overdraw): once
          // the cleanup stages produce large well-connected components, whole regions
          // "white out". Each hole becomes an extra subpath and the shape is filled
          // with fill-rule=evenodd, so z-order no longer matters for enclosed content.
          const holes = extractHoles(compIdMap, compId, width, height, cbx0, cby0, cbx1, cby1, minArea);

          // Estimated stroke thickness of the region (working px): 2·area/perimeter
          // over ALL contours. Thin regions (outlines) get a capped simplify tolerance
          // so their two sides can't collapse into each other ("sausage" pinching).
          let boundaryTotal = boundary.length;
          for (const h of holes) boundaryTotal += h.boundary.length;
          const regionThickness = (2 * pixelCount) / boundaryTotal;

          const useFit = qualityLevel !== 'fast';

          // Geometric snap first — for a true circle/rectangle the exact
          // primitive beats any fitted curve. Enclosed holes count toward the
          // fill area so frames and donuts qualify on their outer boundary.
          let holeArea = 0;
          for (const h of holes) holeArea += h.size;
          const snapped = useFit
            ? snapPrimitivePath(boundary, pixelCount + holeArea, cbx0, cby0, cbx1, cby1)
            : null;

          let pathStr: string;
          if (snapped) {
            pathStr = snapped;
          } else if (useFit) {
            // Least-squares cubic fitting across corner-to-corner runs (see
            // contourToPath) — smooths boundary noise the polyline pipeline keeps.
            pathStr = contourToPath(boundary, smoothness, qualityLevel, simplifyScale, regionThickness);
          } else {
            // FAST: legacy polyline pipeline (RDP + heuristic beziers)
            let refined = refinePathMultiStage(boundary, smoothness, qualityLevel, simplifyScale, regionThickness);
            refined = ensureClockwise(refined);
            const corners = detectCorners(refined, Math.PI / 3);
            pathStr = pointsToSvgPathOptimized(refined, corners);
          }
          if (!pathStr) continue;

          let hasHoles = false;
          for (const h of holes) {
            const holeThickness = (2 * h.size) / h.boundary.length;
            let hPath: string;
            if (useFit) {
              let hx0 = width, hy0 = height, hx1 = -1, hy1 = -1;
              for (const p of h.boundary) {
                if (p.x < hx0) hx0 = p.x; if (p.x > hx1) hx1 = p.x;
                if (p.y < hy0) hy0 = p.y; if (p.y > hy1) hy1 = p.y;
              }
              hPath = snapPrimitivePath(h.boundary, h.size, hx0, hy0, hx1, hy1)
                || contourToPath(h.boundary, smoothness, qualityLevel, simplifyScale, holeThickness);
            } else {
              const hRefined = refinePathMultiStage(h.boundary, smoothness, qualityLevel, simplifyScale, holeThickness);
              if (hRefined.length < 3) continue;
              const hCorners = detectCorners(hRefined, Math.PI / 3);
              hPath = pointsToSvgPathOptimized(hRefined, hCorners);
            }
            if (hPath) {
              pathStr += hPath;
              hasHoles = true;
            }
          }

          // Colour-ramp fit (native/viewBox coordinates).
          const gradient = doGrad
            ? fitShapeGradient(gs, gradSamples, gradT, sourceRgba!, sourceWidth)
            : undefined;

          // This component's own colour (interior mean — boundary pixels are AA
          // blends): truer than the label's global mean, which averages every
          // component of the label across the whole image. Label colour stays
          // as the shape's identity for grouping/background decisions.
          let fillColor: Color | undefined;
          if (doGrad && gs.inN >= 30) {
            fillColor = { r: Math.round(gs.inR / gs.inN), g: Math.round(gs.inG / gs.inN), b: Math.round(gs.inB / gs.inN), a: 255 };
          } else if (doGrad && gs.n >= 30) {
            fillColor = { r: Math.round(gs.sc[0] / gs.n), g: Math.round(gs.sc[1] / gs.n), b: Math.round(gs.sc[2] / gs.n), a: 255 };
          }

          result.push({
            color: palette[colorIndex],
            fillColor,
            path: pathStr,
            area: pixelCount,
            isBackground,
            hasHoles,
            gradient
          });
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
    // One decimal place: integer rounding at the output viewBox added ±0.5px jitter
    // to every anchor, visible as micro-wobble on shallow curves and long stems.
    return (Math.round(scaled * 10) / 10).toString();
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

  // Fitted colour ramps become real linearGradient fills. Defs are collected
  // while the body is built, then assembled into the header. userSpaceOnUse +
  // output-viewBox coordinates so the ramp lines up with the traced geometry in
  // every renderer; the seam-bridge stroke uses the same paint so it stays
  // invisible over the gradient.
  const gradDefs: string[] = [];
  const paintFor = (hex: string, gradient?: ShapeGradient): string => {
    if (!gradient || (!gradient.linear && !gradient.radial)) return hex;
    const id = `lg${gradDefs.length}`;
    let stops = '';
    for (const s of gradient.stops) stops += `<stop offset="${s.t}" stop-color="${colorToHex(s.c)}"/>`;
    if (gradient.radial) {
      const rg = gradient.radial;
      gradDefs.push(
        `    <radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${rg.cx}" cy="${rg.cy}" r="${rg.r}">` +
        stops +
        `</radialGradient>\n`
      );
    } else {
      const lg = gradient.linear!;
      gradDefs.push(
        `    <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${lg.x1}" y1="${lg.y1}" x2="${lg.x2}" y2="${lg.y2}">` +
        stops +
        `</linearGradient>\n`
      );
    }
    return `url(#${id})`;
  };

  // NOTE: we deliberately do NOT emit a standalone <rect id="background"> here.
  // The background is already traced as a real shape (the dominant full-canvas
  // path), so a separate rect was redundant AND left an orphan square behind when
  // the user deleted the background colour in the editor (it isn't one of the
  // traced shapes). The traced background shape is the backdrop and is editable
  // like everything else.

  // Body first (it registers gradient defs), header + defs assembled at the end.
  let svg = `  <g id="content">\n`;

  if (removeBackground) {
    // REMOVE BACKGROUND MODE: Filter out detected background shapes
    // Large shapes drawn first, small details on top
    // Include foreground shapes + small background shapes (interior details like letter holes)

    const smallShapeThreshold = width * height * 0.05; // 5% of image area
    type FShape = { hex: string; fillHex: string; path: string; area: number; hasHoles?: boolean; gradient?: ShapeGradient };
    const drawn: FShape[] = [];

    for (const shape of shapes) {
      const hex = colorToHex(shape.color);
      const isDominantBg = hex === dominantHex;

      // An enclosed region in the background colour is a counter (letter interior,
      // donut hole): skip drawing it. Every shape now carries its enclosed holes as
      // evenodd subpaths, so the area underneath is genuinely transparent — no punch
      // bookkeeping needed.
      if (isDominantBg && !shape.isBackground) continue;

      const isSmallBackground = shape.isBackground && shape.area < smallShapeThreshold;
      if (!shape.isBackground || (isSmallBackground && !isDominantBg)) {
        drawn.push({ hex, fillHex: colorToHex(shape.fillColor || shape.color), path: shape.path, area: shape.area, hasHoles: shape.hasHoles, gradient: shape.gradient });
      }
    }

    // Fallback: if nothing included, include everything except dominant background
    if (drawn.length === 0) {
      for (const shape of shapes) {
        const hex = colorToHex(shape.color);
        if (hex !== dominantHex) drawn.push({ hex, fillHex: colorToHex(shape.fillColor || shape.color), path: shape.path, area: shape.area, hasHoles: shape.hasHoles, gradient: shape.gradient });
      }
    }

    // Sort by area descending (largest first, smallest/details on top)
    drawn.sort((a, b) => b.area - a.area);

    // Same-colour stroke bridges the anti-aliasing seam (the "white gaps"); see note
    // in standard mode below.
    const strokeWidth = Math.max(1, Math.min(width, height) * 0.0006);
    svg += `    <g id="shapes-layer">\n`;
    for (const s of drawn) {
      const d = scalePathString(s.path, pathScale);
      const fillRule = s.hasHoles ? ' fill-rule="evenodd"' : '';
      const p = paintFor(s.fillHex, s.gradient);
      // data-c carries the LABEL colour whenever the paint differs from it
      // (gradient or per-component fill) so the editor's colour rail can still
      // group/select/recolour shapes by colour.
      const dataC = s.gradient || s.fillHex !== s.hex ? ` data-c="${s.hex}"` : '';
      svg += `      <path fill="${p}"${fillRule}${dataC} stroke="${p}" stroke-width="${strokeWidth}" stroke-linejoin="round" d="${d}"/>\n`;
    }
    svg += `    </g>\n`;

  } else {
    // STANDARD MODE: Draw all shapes sorted by area (largest first for proper layering)
    // This ensures large background shapes are drawn first, then smaller details on top

    // Collect ALL individual shapes with their colors and areas
    const allShapesFlat: Array<{ hex: string; fillHex: string; path: string; area: number; hasHoles?: boolean; gradient?: ShapeGradient }> = [];

    for (const shape of shapes) {
      const hex = colorToHex(shape.color);
      allShapesFlat.push({
        hex,
        fillHex: colorToHex(shape.fillColor || shape.color),
        path: shape.path,
        area: shape.area,
        hasHoles: shape.hasHoles,
        gradient: shape.gradient
      });
    }

    // Sort by area descending (largest shapes drawn first, smallest on top)
    allShapesFlat.sort((a, b) => b.area - a.area);

    // Same-colour stroke to bridge the browser's anti-aliasing seam between
    // abutting fills (the "white gaps"). Kept NARROW (~1px in viewBox units): a
    // shape's stroke invades its neighbour's territory by half its width, and the
    // old fat proportional stroke (0.004·min = ~8px at 2048) was painting over thin
    // features wherever a later-drawn shape abutted them — outlines rendered as
    // "bead chains". The tracer now emits an exact hole-aware tiling, so seams are
    // hairline-only and a hairline bridge is all that's needed.
    const strokeWidthStd = Math.max(1, Math.min(width, height) * 0.0006);
    svg += `    <g id="shapes-layer">\n`;
    for (const { hex, fillHex, path, hasHoles, gradient } of allShapesFlat) {
      const scaledPath = scalePathString(path, pathScale);
      const fillRule = hasHoles ? ' fill-rule="evenodd"' : '';
      const p = paintFor(fillHex, gradient);
      // data-c: label colour for the editor's colour rail (see remove-bg branch).
      const dataC = gradient || fillHex !== hex ? ` data-c="${hex}"` : '';
      svg += `      <path fill="${p}"${fillRule}${dataC} stroke="${p}" stroke-width="${strokeWidthStd}" stroke-linejoin="round" d="${scaledPath}"/>\n`;
    }
    svg += `    </g>\n`;
  }

  svg += `  </g>\n`;
  svg += `</svg>`;

  // Assemble header now the body has registered its gradient defs.
  // shape-rendering=geometricPrecision asks renderers for the smoothest
  // (anti-aliased) edges rather than crisp/aliased ones.
  let header = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="geometricPrecision">\n`;
  header += `  <title>Vectorized Image</title>\n`;
  header += `  <desc>Generated with Raster2Vector - ${colorGroups.size} colors</desc>\n`;
  header += `  <defs>\n`;
  header += `    <style>\n`;
  header += `      .vector-shape { stroke-linejoin: round; stroke-linecap: round; }\n`;
  header += `    </style>\n`;
  header += gradDefs.join('');
  header += `  </defs>\n`;
  return header + svg;
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
