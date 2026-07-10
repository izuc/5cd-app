import type { Color } from './types';

interface ColorBox {
  colors: Color[];
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

function createColorBox(colors: Color[]): ColorBox {
  let rMin = 255, rMax = 0;
  let gMin = 255, gMax = 0;
  let bMin = 255, bMax = 0;

  for (const color of colors) {
    rMin = Math.min(rMin, color.r);
    rMax = Math.max(rMax, color.r);
    gMin = Math.min(gMin, color.g);
    gMax = Math.max(gMax, color.g);
    bMin = Math.min(bMin, color.b);
    bMax = Math.max(bMax, color.b);
  }

  return { colors, rMin, rMax, gMin, gMax, bMin, bMax };
}

function getLongestAxis(box: ColorBox): 'r' | 'g' | 'b' {
  const rRange = box.rMax - box.rMin;
  const gRange = box.gMax - box.gMin;
  const bRange = box.bMax - box.bMin;

  if (rRange >= gRange && rRange >= bRange) return 'r';
  if (gRange >= rRange && gRange >= bRange) return 'g';
  return 'b';
}

function splitBox(box: ColorBox): [ColorBox, ColorBox] {
  const axis = getLongestAxis(box);
  const sorted = [...box.colors].sort((a, b) => a[axis] - b[axis]);
  const mid = Math.floor(sorted.length / 2);

  return [
    createColorBox(sorted.slice(0, mid)),
    createColorBox(sorted.slice(mid))
  ];
}

function getAverageColor(box: ColorBox): Color {
  let r = 0, g = 0, b = 0, a = 0;
  const count = box.colors.length;

  for (const color of box.colors) {
    r += color.r;
    g += color.g;
    b += color.b;
    a += color.a;
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
    a: Math.round(a / count)
  };
}

export function colorDistance(c1: Color, c2: Color): number {
  const dr = c1.r - c2.r;
  const dg = c1.g - c2.g;
  const db = c1.b - c2.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// Select `count` colors from the candidates, spreading across colour space but
// WEIGHTED by how many samples each candidate actually represents. Pure
// farthest-point selection actively preferred junk candidates (blends of two real
// hues left stranded between clusters — maximally "diverse", representing nothing);
// population weighting keeps the palette anchored to colours that exist in the
// image while the distance term still spreads it across distinct hues.
function selectDiverseColors(candidates: Color[], count: number, populations?: number[]): Color[] {
  if (candidates.length <= count) return candidates;
  if (count <= 0) return [];

  const pop = (i: number) => (populations && populations[i] !== undefined ? populations[i] : 1);

  const selected: Color[] = [];
  const used = new Set<number>();

  // Start with the most-represented candidate.
  let startIdx = 0;
  for (let i = 1; i < candidates.length; i++) if (pop(i) > pop(startIdx)) startIdx = i;
  selected.push(candidates[startIdx]);
  used.add(startIdx);

  // Greedily add the candidate with the best (population-weighted) separation
  // from everything already selected. sqrt(pop) so a huge background colour can't
  // drown out small-but-real accent colours.
  while (selected.length < count) {
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue;

      let minDist = Infinity;
      for (const sel of selected) {
        const d = colorDistance(candidates[i], sel);
        if (d < minDist) minDist = d;
      }

      const score = Math.sqrt(pop(i)) * minDist;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    selected.push(candidates[bestIdx]);
    used.add(bestIdx);
  }

  return selected;
}

// Count unique colors in the image (with tolerance for near-duplicates)
function countUniqueColors(colors: Color[], tolerance: number = 5): number {
  if (colors.length === 0) return 0;

  const unique: Color[] = [colors[0]];

  for (let i = 1; i < colors.length; i++) {
    const color = colors[i];
    let isUnique = true;

    for (const u of unique) {
      if (colorDistance(color, u) < tolerance) {
        isUnique = false;
        break;
      }
    }

    if (isUnique) {
      unique.push(color);
      // Early exit if we've found enough - no need to count past a reasonable max
      if (unique.length > 256) break;
    }
  }

  return unique.length;
}

function kMeansIterate(colors: Color[], centroids: Color[], iterations: number): { centroids: Color[]; clusters: Color[][] } {
  let currentCentroids = [...centroids];
  let clusters: Color[][] = currentCentroids.map(() => []);

  for (let i = 0; i < iterations; i++) {
    // Assign points to clusters
    clusters = currentCentroids.map(() => []);

    for (const color of colors) {
      let minDist = Infinity;
      let closestIdx = 0;

      for (let j = 0; j < currentCentroids.length; j++) {
        const d = colorDistance(color, currentCentroids[j]);
        if (d < minDist) {
          minDist = d;
          closestIdx = j;
        }
      }
      clusters[closestIdx].push(color);
    }

    // Update centroids
    let changed = false;
    const newCentroids = clusters.map((cluster, idx) => {
      if (cluster.length === 0) return currentCentroids[idx];

      let r = 0, g = 0, b = 0;
      for (const c of cluster) {
        r += c.r;
        g += c.g;
        b += c.b;
      }

      const newC = {
        r: Math.round(r / cluster.length),
        g: Math.round(g / cluster.length),
        b: Math.round(b / cluster.length),
        a: 255
      };

      if (colorDistance(newC, currentCentroids[idx]) > 1) changed = true;
      return newC;
    });

    currentCentroids = newCentroids;
    if (!changed) break;
  }

  return { centroids: currentCentroids, clusters };
}

// Mode snap: if one EXACT colour makes up a large share of a cluster (flat/
// posterised art), use it verbatim instead of the mean — bad median-cut seeds
// otherwise leave a centroid stuck between two solid hues (e.g. pure red rendered
// as plum because stray blue samples share its cluster). AA/photo clusters have no
// dominant exact colour (top shares are a few percent), so they keep the mean.
function modeSnap(centroids: Color[], clusters: Color[][]): boolean {
  let snapped = false;
  for (let idx = 0; idx < centroids.length; idx++) {
    const cluster = clusters[idx];
    if (!cluster || cluster.length < 8) continue;
    const tally = new Map<number, number>();
    let bestKey = -1;
    let bestCount = 0;
    for (const c of cluster) {
      const key = (c.r << 16) | (c.g << 8) | c.b;
      const n = (tally.get(key) || 0) + 1;
      tally.set(key, n);
      if (n > bestCount) { bestCount = n; bestKey = key; }
    }
    if (bestCount >= cluster.length * 0.34) {
      const snappedC = { r: (bestKey >> 16) & 255, g: (bestKey >> 8) & 255, b: bestKey & 255, a: 255 };
      if (colorDistance(snappedC, centroids[idx]) > 1) snapped = true;
      centroids[idx] = snappedC;
    }
  }
  return snapped;
}

function kMeansRefinement(colors: Color[], centroids: Color[], iterations: number = 5): { centroids: Color[]; populations: number[] } {
  const first = kMeansIterate(colors, centroids, iterations);
  let result = first.centroids;
  let clusters = first.clusters;
  // Snapping perturbs the centroids; a short second round lets stray samples
  // migrate to their true (now-exact) centroids, then snap once more.
  if (modeSnap(result, first.clusters)) {
    const second = kMeansIterate(colors, result, 3);
    result = second.centroids;
    clusters = second.clusters;
    modeSnap(result, second.clusters);
  }
  return { centroids: result, populations: clusters.map((c) => c.length) };
}

export function preprocessImage(imageData: ImageData): Uint8ClampedArray {
  const width = imageData.width;
  const height = imageData.height;
  let input: Uint8ClampedArray = imageData.data;
  let output = new Uint8ClampedArray(input.length);

  // Edge-preserving smoothing (smart blur): if a pixel is similar to a neighbour,
  // blend with it; genuinely different neighbours are excluded so real edges stay.
  // T=45 / 3 passes: JPEG mosquito noise near high-contrast edges is ±20-40, and it
  // is what made quantised label boundaries wander (ragged "bitten" letter edges) —
  // the old T=10 single pass left it untouched. Real design edges are far above 45.
  const T = 45;
  const N = 3;

  for (let pass = 0; pass < N; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;

        let rSum = 0, gSum = 0, bSum = 0, count = 0;
        const r = input[idx];
        const g = input[idx + 1];
        const b = input[idx + 2];

        // Check 3x3 window
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy;
            const nx = x + dx;

            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nIdx = (ny * width + nx) * 4;
              const nr = input[nIdx];
              const ng = input[nIdx + 1];
              const nb = input[nIdx + 2];

              if (Math.abs(r - nr) < T && Math.abs(g - ng) < T && Math.abs(b - nb) < T) {
                rSum += nr;
                gSum += ng;
                bSum += nb;
                count++;
              }
            }
          }
        }

        output[idx] = rSum / count;
        output[idx + 1] = gSum / count;
        output[idx + 2] = bSum / count;
        output[idx + 3] = input[idx + 3];
      }
    }
    if (pass < N - 1) { const t = input === imageData.data ? new Uint8ClampedArray(input.length) : input; input = output; output = t; }
  }

  return output;
}

export function medianCutQuantization(
  imageData: ImageData,
  colorCount: number,
  onProgress?: (progress: number) => void
): Color[] {
  const { data, width, height } = imageData;
  const colors: Color[] = [];

  // Optimized Sampling: Max ~50k pixels for base colors
  const totalPixels = data.length / 4;
  const step = Math.max(1, Math.floor(totalPixels / 50000));

  for (let i = 0; i < data.length; i += 4 * step) {
    if (data[i + 3] > 128) { // Only include non-transparent pixels
      colors.push({
        r: data[i],
        g: data[i + 1],
        b: data[i + 2],
        a: 255
      });
    }
  }

  // BOOST EDGE COLORS: Sample colors from high-contrast edges (text, fine details)
  // This helps preserve text colors that might otherwise be underrepresented.
  // Use independent integer strides targeting ~TARGET_EDGE_SAMPLES probes. (The old
  // row stride `floor((totalPixels/30000)/width)` = floor(height/30000) collapsed to
  // 0 → 1 for every realistic image, so it scanned ~half of ALL pixels and pushed up
  // to millions of colours into `colors`, ballooning the downstream k-means.)
  const TARGET_EDGE_SAMPLES = 30000;
  const edgeSide = Math.sqrt(TARGET_EDGE_SAMPLES); // ~173
  const stepY = Math.max(1, Math.floor(height / edgeSide));
  const stepX = Math.max(2, Math.floor(width / edgeSide));
  for (let y = 1; y < height - 1; y += stepY) {
    for (let x = 1; x < width - 1; x += stepX) {
      const idx = (y * width + x) * 4;
      const idxLeft = idx - 4;
      const idxRight = idx + 4;
      const idxUp = idx - width * 4;
      const idxDown = idx + width * 4;

      // Calculate local contrast (simple gradient magnitude)
      const dr = Math.abs(data[idxRight] - data[idxLeft]) + Math.abs(data[idxDown] - data[idxUp]);
      const dg = Math.abs(data[idxRight + 1] - data[idxLeft + 1]) + Math.abs(data[idxDown + 1] - data[idxUp + 1]);
      const db = Math.abs(data[idxRight + 2] - data[idxLeft + 2]) + Math.abs(data[idxDown + 2] - data[idxUp + 2]);
      const gradient = dr + dg + db;

      // If this is an edge pixel (high contrast), add it multiple times to boost its influence
      if (gradient > 100 && data[idx + 3] > 128) {
        const edgeColor = {
          r: data[idx],
          g: data[idx + 1],
          b: data[idx + 2],
          a: 255
        };
        // Add edge colors with extra weight
        colors.push(edgeColor);
        colors.push(edgeColor);
      }
    }
  }

  if (colors.length === 0) {
    return [{ r: 0, g: 0, b: 0, a: 255 }];
  }

  // Count unique colors in the image to cap the palette size
  const uniqueColorCount = countUniqueColors(colors, 10);
  const targetColorCount = Math.min(colorCount, uniqueColorCount);

  // Generate MORE candidate colors than needed (3x), then select the most diverse.
  // Deliberately NOT capped at uniqueColorCount: median cut spends early splits
  // peeling off duplicate-heavy boxes (flat backgrounds), so a tight cap can leave
  // genuinely mixed boxes unsplit (distinct colours averaged together). The split
  // loop stops on its own when no splittable box remains.
  const candidateCount = targetColorCount * 3;

  // Median cut algorithm - generate extra candidates
  let boxes: ColorBox[] = [createColorBox(colors)];

  while (boxes.length < candidateCount) {
    let maxIndex = -1;
    let maxCount = 0;
    // Find the box with the largest colour count that can still be MEANINGFULLY
    // split (non-zero colour range). Without the range check, a huge box of
    // identical samples (e.g. a flat white background) wins every round and gets
    // "split" into more identical boxes, starving genuinely mixed boxes — a flat
    // 5-colour logo ended up with all non-background colours averaged into one
    // muddy palette entry.
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const range = (b.rMax - b.rMin) + (b.gMax - b.gMin) + (b.bMax - b.bMin);
      if (range > 0 && b.colors.length > maxCount) {
        maxCount = b.colors.length;
        maxIndex = i;
      }
    }

    if (maxIndex < 0 || maxCount <= 1) break;

    const [box1, box2] = splitBox(boxes[maxIndex]);
    boxes.splice(maxIndex, 1, box1, box2);

    if (onProgress) {
      onProgress(boxes.length / candidateCount * 0.5);
    }
  }

  const candidatePalette = boxes.map(getAverageColor);

  // Refine candidates with K-Means for better accuracy
  const refined = kMeansRefinement(colors, candidatePalette);

  if (onProgress) {
    onProgress(0.8);
  }

  // Drop starved candidates (nearly no samples map to them) — typically stale
  // blend centroids left behind after mode-snapping; they represent nothing that
  // exists in the image but look maximally "diverse" to the selector.
  const minPop = Math.max(2, colors.length * 0.0004);
  const keptColors: Color[] = [];
  const keptPops: number[] = [];
  for (let i = 0; i < refined.centroids.length; i++) {
    if (refined.populations[i] >= minPop) {
      keptColors.push(refined.centroids[i]);
      keptPops.push(refined.populations[i]);
    }
  }
  const pool = keptColors.length >= Math.min(targetColorCount, 2) ? keptColors : refined.centroids;
  const poolPops = pool === keptColors ? keptPops : refined.populations;

  // Population-weighted spread selection (see selectDiverseColors).
  const diversePalette = selectDiverseColors(pool, targetColorCount, poolPops);

  return diversePalette;
}

export function findClosestColor(color: Color, palette: Color[]): number {
  let minDist = Infinity;
  let closestIndex = 0;

  for (let i = 0; i < palette.length; i++) {
    const dist = colorDistance(color, palette[i]);
    if (dist < minDist) {
      minDist = dist;
      closestIndex = i;
    }
  }

  return closestIndex;
}

export function quantizeImage(
  imageData: ImageData,
  palette: Color[],
  onProgress?: (progress: number) => void
): Uint8Array {
  const data = imageData.data;
  const result = new Uint8Array(data.length / 4);

  for (let i = 0; i < data.length; i += 4) {
    const pixelIndex = i / 4;
    const color: Color = {
      r: data[i],
      g: data[i + 1],
      b: data[i + 2],
      a: data[i + 3]
    };

    if (color.a < 128) {
      result[pixelIndex] = 255; // Transparent marker
    } else {
      result[pixelIndex] = findClosestColor(color, palette);
    }

    if (onProgress && pixelIndex % 10000 === 0) {
      onProgress(pixelIndex / (data.length / 4));
    }
  }

  return result;
}

// 3×3 majority filter over the label map. When `palette` is given the filter is
// GATED: a pixel may flip to the majority label only if (a) the two palette colours
// are close (gradient-band noise), or (b) the pixel's colour is approximately a
// MIXTURE of the majority and the second-most-common neighbouring colours — that's
// an anti-alias halo pixel sitting on the boundary between two regions, not a real
// feature. This still consolidates band noise and eats AA halo slivers, but can no
// longer nibble thin high-contrast features: the ungated version was eating the
// solid dark outlines of cartoon/emblem logos, turning them into dashed chains.
export function denoiseQuantized(
  quantized: Uint8Array,
  width: number,
  height: number,
  iterations: number = 1,
  palette?: Color[],
  maxFlipDist: number = 150
): Uint8Array {
  let current = quantized;
  // Reusable tally indexed by colour value (0..255, incl. the 255 transparent marker).
  // Avoids the old per-pixel `new Map()` — at 4096² that was 16.7M Map allocations per
  // pass; this is allocation-free and several× faster.
  const counts = new Uint16Array(256);

  // Pairwise palette distances for the gate (palette ≤ 256 entries; label 255 is the
  // transparent marker — never flip across it, so leave its distances at Infinity).
  let dist: Float32Array | null = null;
  const n = palette ? palette.length : 0;
  if (palette) {
    dist = new Float32Array(256 * 256).fill(Infinity);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        dist[a * 256 + b] = colorDistance(palette[a], palette[b]);
      }
    }
  }

  for (let i = 0; i < iterations; i++) {
    const next = new Uint8Array(current.length);

    for (let y = 0; y < height; y++) {
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < height - 1 ? y + 1 : height - 1;
      for (let x = 0; x < width; x++) {
        const x0 = x > 0 ? x - 1 : 0;
        const x1 = x < width - 1 ? x + 1 : width - 1;

        const cur = current[y * width + x];
        let maxCount = 0;
        let majorityColor = cur;
        for (let ny = y0; ny <= y1; ny++) {
          const row = ny * width;
          for (let nx = x0; nx <= x1; nx++) {
            const c = current[row + nx];
            const nc = ++counts[c];
            if (nc > maxCount) { maxCount = nc; majorityColor = c; }
          }
        }

        let out = majorityColor;
        if (dist && majorityColor !== cur) {
          if (dist[cur * 256 + majorityColor] <= maxFlipDist) {
            // close colours — plain band-noise consolidation
          } else {
            // Mixture test: find the second-most-common neighbour label (≠ majority,
            // ≠ cur) and check whether cur sits "between" the two in colour space.
            let second = -1;
            let secondCount = 0;
            for (let ny = y0; ny <= y1; ny++) {
              const row = ny * width;
              for (let nx = x0; nx <= x1; nx++) {
                const c = current[row + nx];
                if (c !== majorityColor && c !== cur && counts[c] > secondCount) {
                  secondCount = counts[c];
                  second = c;
                }
              }
            }
            const isBlend = second >= 0 &&
              dist[cur * 256 + majorityColor] + dist[cur * 256 + second] <=
              1.25 * dist[majorityColor * 256 + second] + 20;
            if (!isBlend) out = cur;
          }
        }
        next[y * width + x] = out;

        // Reset only the touched entries by re-walking the same window (cheap, no alloc).
        for (let ny = y0; ny <= y1; ny++) {
          const row = ny * width;
          for (let nx = x0; nx <= x1; nx++) counts[current[row + nx]] = 0;
        }
      }
    }
    current = next;
  }

  return current;
}

// Merge every "ink-dark" palette entry into the darkest one. Cartoon/emblem art has
// solid dark outline ink, but quantisation splits it across several near-black shades
// (pure black, off-black, darkest navy…) — thin outlines then alternate labels along
// their length and disintegrate into per-colour fragments when traced. Star topology
// (all merge into the single darkest anchor, no transitive chaining) so genuinely
// distinct dark tones (e.g. navy shadow bands) stay separate.
export function mergeInkColors(
  palette: Color[],
  quantized: Uint8Array,
  lumMax: number = 70,
  distMax: number = 75
): { palette: Color[]; quantized: Uint8Array } {
  const lum = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  let anchor = -1;
  let anchorLum = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const l = lum(palette[i]);
    if (l < anchorLum) { anchorLum = l; anchor = i; }
  }
  // No true ink in this image — nothing to do.
  if (anchor < 0 || anchorLum > lumMax * 0.7) return { palette, quantized };

  const absorb = new Uint8Array(palette.length);
  let any = false;
  for (let i = 0; i < palette.length; i++) {
    if (i === anchor) continue;
    if (lum(palette[i]) <= lumMax && colorDistance(palette[i], palette[anchor]) <= distMax) {
      absorb[i] = 1;
      any = true;
    }
  }
  if (!any) return { palette, quantized };

  // Rebuild the palette without the absorbed entries; remap labels.
  const newPalette: Color[] = [];
  const oldToNew = new Array<number>(palette.length).fill(-1);
  for (let i = 0; i < palette.length; i++) {
    if (absorb[i] === 1) continue;
    oldToNew[i] = newPalette.length;
    newPalette.push(palette[i]);
  }
  for (let i = 0; i < palette.length; i++) {
    if (absorb[i] === 1) oldToNew[i] = oldToNew[anchor];
  }

  const newQuantized = new Uint8Array(quantized.length);
  for (let i = 0; i < quantized.length; i++) {
    const v = quantized[i];
    newQuantized[i] = v === 255 ? 255 : oldToNew[v];
  }

  return { palette: newPalette, quantized: newQuantized };
}

// Contrast-aware region consolidation — the de-mottler. Gradient-heavy art (metallic
// logos, airbrushed shading) quantises into thousands of small islands of adjacent
// ramp shades ("camo" mottling). Size-only speckle cleaning can't fix this: the
// blobs are bigger than dust, and raising the size floor would also delete real
// details (bolts, eyes, highlights). The right rule is size × contrast: a region is
// absorbed into its dominant neighbour only if its colour is CLOSE to that
// neighbour — nearly-identical patches can be quite large and still merge invisibly,
// while a tiny high-contrast detail is never touched.
export function consolidateRegions(
  quantized: Uint8Array,
  width: number,
  height: number,
  palette: Color[],
  baseArea: number = 20,
  floorArea: number = 0
): Uint8Array {
  // Scale thresholds with resolution so behaviour matches across source sizes
  // (tuned at ~1024²; a 2048² source has 4× the pixels per feature).
  const unit = Math.max(0.25, (width * height) / (1024 * 1024));
  const maxAbsorb = Math.max(Math.ceil(16 * baseArea * unit), floorArea); // bookkeeping ceiling
  const result = new Uint8Array(quantized);
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const regionIndices: number[] = [];
  const neighborCounts = new Uint16Array(256);
  const touchedNeighbors: number[] = [];

  // Absorption ceiling as a function of colour distance to the dominant neighbour:
  // nearly identical → merge generously; moderately close → small blobs only;
  // high contrast → never (leave real details alone; dust is handled elsewhere).
  const absorbLimit = (d: number): number => {
    if (d < 24) return maxAbsorb;
    if (d < 48) return Math.ceil(6 * baseArea * unit);
    if (d < 88) return Math.ceil(2 * baseArea * unit);
    return 0;
  };

  for (let start = 0; start < result.length; start++) {
    if (visited[start] === 1) continue;
    const color = result[start];
    if (color === 255) { visited[start] = 1; continue; } // transparent: never absorb

    regionIndices.length = 0;
    touchedNeighbors.length = 0;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    regionIndices.push(start);
    let area = 1;
    // Once a region outgrows every possible ceiling we stop bookkeeping (but must
    // finish the fill so `visited` stays correct — large regions dominate the image).
    let tracking = true;

    let ptr = 0;
    while (ptr < stack.length) {
      const idx = stack[ptr++];
      const cx = idx % width;
      const cy = (idx / width) | 0;
      // 4-connected region growth, matching cleanSpeckles
      for (let n = 0; n < 4; n++) {
        const nx = n === 0 ? cx + 1 : n === 1 ? cx - 1 : cx;
        const ny = n === 2 ? cy + 1 : n === 3 ? cy - 1 : cy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        const nColor = result[nIdx];
        if (nColor === color) {
          if (visited[nIdx] === 0) {
            visited[nIdx] = 1;
            stack.push(nIdx);
            area++;
            if (tracking) {
              regionIndices.push(nIdx);
              if (area > maxAbsorb) tracking = false;
            }
          }
        } else if (tracking && nColor !== 255) {
          if (neighborCounts[nColor] === 0) touchedNeighbors.push(nColor);
          neighborCounts[nColor]++;
        }
      }
    }

    if (tracking && touchedNeighbors.length > 0) {
      let bestColor = -1;
      let bestCount = 0;
      for (const nc of touchedNeighbors) {
        if (neighborCounts[nc] > bestCount) { bestCount = neighborCounts[nc]; bestColor = nc; }
      }
      if (bestColor >= 0 && bestColor < palette.length && color < palette.length) {
        const d = colorDistance(palette[color], palette[bestColor]);
        // Regions below floorArea merge UNCONDITIONALLY (any contrast): the tracer
        // would drop them anyway, but dropping leaves a hole in the drawing while
        // absorbing keeps lines/areas continuous (a mid-line fragment joins the
        // adjacent shade instead of becoming a white gap).
        if (area <= absorbLimit(d) || area < floorArea) {
          for (const rIdx of regionIndices) result[rIdx] = bestColor;
        }
      }
    }
    for (const nc of touchedNeighbors) neighborCounts[nc] = 0;
  }

  return result;
}

// Potts-model label smoothing (ICM): relabel each pixel to minimise
//   colourDistance(pixelRGB, palette[label]) + lambda * (# 8-neighbours that disagree)
// Mottled gradient patches pay for their boundary length and collapse into their
// surroundings; band boundaries settle along the TRUE image edges (data term), which
// also straightens traced linework. Genuine edges resist flipping because the colour
// distance outweighs the smoothness prior. Candidates per pixel = its own label plus
// the distinct neighbour labels, so each pass is cheap. The transparent marker (255)
// never flips either way.
export function refineLabelsMRF(
  labels: Uint8Array,
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  palette: Color[],
  passes: number = 2,
  lambda: number = 10
): Uint8Array {
  const result = new Uint8Array(labels);
  const cand: number[] = [];

  for (let pass = 0; pass < passes; pass++) {
    let changed = 0;
    for (let y = 0; y < height; y++) {
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < height - 1 ? y + 1 : height - 1;
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const cur = result[idx];
        if (cur === 255) continue;

        // Gather distinct neighbour labels (8-connected)
        cand.length = 0;
        cand.push(cur);
        let heterogeneous = false;
        const x0 = x > 0 ? x - 1 : 0;
        const x1 = x < width - 1 ? x + 1 : width - 1;
        for (let ny = y0; ny <= y1; ny++) {
          const row = ny * width;
          for (let nx = x0; nx <= x1; nx++) {
            const l = result[row + nx];
            if (l === cur || l === 255) continue;
            heterogeneous = true;
            if (!cand.includes(l)) cand.push(l);
          }
        }
        // Interior pixels (all neighbours agree) can't improve — the common case.
        if (!heterogeneous) continue;

        const pr = rgba[idx * 4], pg = rgba[idx * 4 + 1], pb = rgba[idx * 4 + 2];
        let bestLabel = cur;
        let bestCost = Infinity;
        for (const l of cand) {
          const c = palette[l];
          if (!c) continue;
          const dr = pr - c.r, dg = pg - c.g, db = pb - c.b;
          let disagree = 0;
          for (let ny = y0; ny <= y1; ny++) {
            const row = ny * width;
            for (let nx = x0; nx <= x1; nx++) {
              if (result[row + nx] !== l) disagree++;
            }
          }
          // the centre pixel counted itself when its label != l; that offset is the
          // same for every candidate except cur, and negligible for the argmin
          const cost = Math.sqrt(dr * dr + dg * dg + db * db) + lambda * disagree;
          if (cost < bestCost) { bestCost = cost; bestLabel = l; }
        }
        if (bestLabel !== cur) { result[idx] = bestLabel; changed++; }
      }
    }
    if (changed === 0) break;
  }

  return result;
}

export function cleanSpeckles(
  quantized: Uint8Array,
  width: number,
  height: number,
  minArea: number
): Uint8Array {
  if (minArea <= 0) return quantized;

  const visited = new Uint8Array(width * height);
  const result = new Uint8Array(quantized); // Copy

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;

      if (visited[idx] === 1) continue;

      const color = result[idx];
      const regionIndices: number[] = [];
      const borderNeighborColors: number[] = []; // Track colors at the border
      const stack = [idx];
      visited[idx] = 1;
      regionIndices.push(idx);

      // Find connected region AND collect border neighbor colors
      let ptr = 0;
      while (ptr < stack.length) {
        const currIdx = stack[ptr++];
        const cx = currIdx % width;
        const cy = Math.floor(currIdx / width);

        // 4-connected for region detection
        const neighbors = [
          { nx: cx + 1, ny: cy },
          { nx: cx - 1, ny: cy },
          { nx: cx, ny: cy + 1 },
          { nx: cx, ny: cy - 1 }
        ];

        for (const { nx, ny } of neighbors) {
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nIdx = ny * width + nx;
            const neighborColor = result[nIdx];

            if (visited[nIdx] === 0 && neighborColor === color) {
              visited[nIdx] = 1;
              stack.push(nIdx);
              regionIndices.push(nIdx);
            } else if (neighborColor !== color && neighborColor !== 255) {
              // This is a border pixel - collect the neighboring color
              borderNeighborColors.push(neighborColor);
            }
          }
        }
      }

      // If region is small speckle, merge it into the most common surrounding color
      if (regionIndices.length < minArea && borderNeighborColors.length > 0) {
        // Find the most common neighboring color
        const colorCounts = new Map<number, number>();
        for (const nc of borderNeighborColors) {
          colorCounts.set(nc, (colorCounts.get(nc) || 0) + 1);
        }

        let maxCount = 0;
        let replacementColor = color;
        for (const [c, count] of colorCounts) {
          if (count > maxCount) {
            maxCount = count;
            replacementColor = c;
          }
        }

        // Overwrite the speckle with the dominant surrounding color
        if (replacementColor !== color) {
          for (const rIdx of regionIndices) {
            result[rIdx] = replacementColor;
          }
        }
      }
    }
  }

  return result;
}

// Morphological erosion - shrinks regions by removing border pixels
export function erodeQuantized(
  quantized: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const result = new Uint8Array(quantized);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const color = quantized[idx];

      // Check 4-connected neighbors - if any differ, this is a border pixel
      const neighbors = [
        quantized[(y - 1) * width + x],
        quantized[(y + 1) * width + x],
        quantized[y * width + (x - 1)],
        quantized[y * width + (x + 1)]
      ];

      for (const nc of neighbors) {
        if (nc !== color) {
          // Border pixel - erode to most common neighbor
          const counts = new Map<number, number>();
          for (const n of neighbors) {
            if (n !== color) {
              counts.set(n, (counts.get(n) || 0) + 1);
            }
          }
          let maxC = 0, bestColor = color;
          for (const [c, cnt] of counts) {
            if (cnt > maxC) { maxC = cnt; bestColor = c; }
          }
          result[idx] = bestColor;
          break;
        }
      }
    }
  }

  return result;
}

// Morphological dilation - grows regions by expanding into neighboring pixels
export function dilateQuantized(
  quantized: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const result = new Uint8Array(quantized);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const color = quantized[idx];

      // Check 4-connected neighbors
      const neighborIndices = [
        (y - 1) * width + x,
        (y + 1) * width + x,
        y * width + (x - 1),
        y * width + (x + 1)
      ];

      // Count neighbor colors (excluding current)
      const counts = new Map<number, number>();
      for (const ni of neighborIndices) {
        const nc = quantized[ni];
        if (nc !== color && nc !== 255) {
          counts.set(nc, (counts.get(nc) || 0) + 1);
        }
      }

      // If a neighbor color appears 3+ times, dilate to it
      for (const [c, cnt] of counts) {
        if (cnt >= 3) {
          result[idx] = c;
          break;
        }
      }
    }
  }

  return result;
}

// Morphological opening: erosion then dilation - removes small protrusions
export function morphologicalOpen(
  quantized: Uint8Array,
  width: number,
  height: number,
  iterations: number = 1
): Uint8Array {
  let result = quantized;
  for (let i = 0; i < iterations; i++) {
    result = erodeQuantized(result, width, height);
  }
  for (let i = 0; i < iterations; i++) {
    result = dilateQuantized(result, width, height);
  }
  return result;
}

// Morphological closing: dilation then erosion - fills small holes
export function morphologicalClose(
  quantized: Uint8Array,
  width: number,
  height: number,
  iterations: number = 1
): Uint8Array {
  let result = quantized;
  for (let i = 0; i < iterations; i++) {
    result = dilateQuantized(result, width, height);
  }
  for (let i = 0; i < iterations; i++) {
    result = erodeQuantized(result, width, height);
  }
  return result;
}

// Aggressive speckle cleaning - multiple passes with increasing thresholds
export function multiPassSpeckleClean(
  quantized: Uint8Array,
  width: number,
  height: number,
  colorCount: number,
  baseMinArea: number
): Uint8Array {
  let result = quantized;

  // Multiple passes with increasing area thresholds
  // This catches nested speckles that appear after first pass
  const passes = colorCount > 16 ? 3 : 2;

  for (let pass = 0; pass < passes; pass++) {
    // Each pass uses a larger threshold to catch remaining speckles
    const areaThreshold = baseMinArea * (pass + 1);
    result = cleanSpeckles(result, width, height, areaThreshold);
  }

  return result;
}

// Adaptive denoising - adjusts based on color count and quality mode
export function adaptiveClean(
  quantized: Uint8Array,
  width: number,
  height: number,
  colorCount: number,
  baseMinArea: number,
  qualityLevel: 'fast' | 'balanced' | 'high' | 'detailed' = 'balanced',
  palette?: Color[]
): Uint8Array {
  let result = quantized;

  // DETAILED mode: Minimal cleaning to preserve fine features like text
  if (qualityLevel === 'detailed') {
    // Very light denoising - just 1-2 passes to remove noise. When the palette is
    // available the majority filter is contrast-gated so it cannot eat thin
    // high-contrast features (dark outlines, text strokes) — only low-contrast
    // gradient/AA noise gets consolidated.
    result = denoiseQuantized(result, width, height, 2, palette);

    // Only remove truly tiny speckles (single pixels or very small)
    const tinyArea = Math.max(3, Math.floor(baseMinArea * 0.3));
    result = cleanSpeckles(result, width, height, tinyArea);

    return result;
  }

  // FAST mode: Light cleaning
  if (qualityLevel === 'fast') {
    result = denoiseQuantized(result, width, height, 2);
    result = cleanSpeckles(result, width, height, baseMinArea);
    return result;
  }

  // BALANCED mode: Moderate cleaning
  if (qualityLevel === 'balanced') {
    const denoiseIterations = Math.min(4, Math.ceil(colorCount / 10) + 2);
    result = denoiseQuantized(result, width, height, denoiseIterations);

    if (colorCount > 16) {
      result = morphologicalOpen(result, width, height, 1);
    }

    const scaledMinArea = Math.ceil(baseMinArea * (1 + colorCount / 32));
    result = cleanSpeckles(result, width, height, scaledMinArea);
    result = denoiseQuantized(result, width, height, 1);

    return result;
  }

  // HIGH mode: Aggressive cleaning for smooth results
  const colorFactor = Math.pow(colorCount / 8, 1.5);
  const denoiseIterations = Math.min(8, Math.ceil(colorFactor * 2));
  const scaledMinArea = Math.ceil(baseMinArea * Math.max(1, colorFactor));

  // Stage 1: Heavy majority filter to consolidate regions
  result = denoiseQuantized(result, width, height, denoiseIterations);

  // Stage 2: Morphological operations for high color counts
  if (colorCount > 12) {
    result = morphologicalClose(result, width, height, 1);
    result = morphologicalOpen(result, width, height, 1);

    if (colorCount > 24) {
      result = morphologicalOpen(result, width, height, 1);
    }
  } else if (colorCount > 8) {
    result = morphologicalOpen(result, width, height, 1);
  }

  // Stage 3: Multi-pass speckle removal
  result = multiPassSpeckleClean(result, width, height, colorCount, scaledMinArea);

  // Stage 4: Final smoothing passes
  const finalPasses = colorCount > 16 ? 3 : 2;
  result = denoiseQuantized(result, width, height, finalPasses);

  return result;
}

// Create a foreground mask using low-color segmentation
// Returns a Uint8Array where 1 = foreground, 0 = background
// This uses a "flood fill from edges" approach - anything reachable from the edge is background
export function createForegroundMask(
  imageData: ImageData,
  lowColorCount: number = 4
): Uint8Array {
  const { width, height } = imageData;
  const totalPixels = width * height;

  // Step 1: Quantize to low color count for clear segmentation
  const palette = medianCutQuantization(imageData, lowColorCount);
  let quantized = quantizeImage(imageData, palette);

  // Step 2: Denoise to consolidate regions
  quantized = denoiseQuantized(quantized, width, height, 3);

  // Step 3: Find the dominant edge color (most frequent color on edges)
  const edgeColorCounts = new Map<number, number>();

  for (let x = 0; x < width; x++) {
    const topColor = quantized[x];
    const bottomColor = quantized[(height - 1) * width + x];
    if (topColor !== 255) edgeColorCounts.set(topColor, (edgeColorCounts.get(topColor) || 0) + 1);
    if (bottomColor !== 255) edgeColorCounts.set(bottomColor, (edgeColorCounts.get(bottomColor) || 0) + 1);
  }
  for (let y = 1; y < height - 1; y++) {
    const leftColor = quantized[y * width];
    const rightColor = quantized[y * width + width - 1];
    if (leftColor !== 255) edgeColorCounts.set(leftColor, (edgeColorCounts.get(leftColor) || 0) + 1);
    if (rightColor !== 255) edgeColorCounts.set(rightColor, (edgeColorCounts.get(rightColor) || 0) + 1);
  }

  let dominantEdgeColor = -1;
  let maxCount = 0;
  for (const [color, count] of edgeColorCounts) {
    if (count > maxCount) {
      maxCount = count;
      dominantEdgeColor = color;
    }
  }

  // Step 4: Find all pixels that are NOT the dominant edge color
  // These are "subject seeds" - definitely part of the subject
  const subjectSeeds = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    if (quantized[i] !== 255 && quantized[i] !== dominantEdgeColor) {
      subjectSeeds[i] = 1;
    }
  }

  // Step 5: Find bounding box of subject seeds
  let minX = width, maxX = 0, minY = height, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (subjectSeeds[y * width + x] === 1) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  // Degenerate case: no subject seeds (e.g. a near-flat single-colour image, or all
  // content quantised to the dominant edge colour). The sentinels stay at their
  // init values, so the fill loops below would never run and we'd return an all-zero
  // mask → traceAllColors would exclude EVERY pixel → a blank SVG. Fall back to an
  // all-ones (permissive) mask so remove-background degrades to a no-op, not nothing.
  if (maxX < minX || maxY < minY) {
    const all = new Uint8Array(totalPixels);
    all.fill(1);
    return all;
  }

  // Step 6: Create shape mask using scanline fill
  // For each row, find the leftmost and rightmost subject pixel
  // Fill everything between them (this creates a solid silhouette)
  const shapeMask = new Uint8Array(totalPixels);

  for (let y = minY; y <= maxY; y++) {
    let rowMinX = width, rowMaxX = -1;

    // Find extent of subject seeds in this row
    for (let x = 0; x < width; x++) {
      if (subjectSeeds[y * width + x] === 1) {
        rowMinX = Math.min(rowMinX, x);
        rowMaxX = Math.max(rowMaxX, x);
      }
    }

    // Fill the entire row between the extents
    if (rowMaxX >= rowMinX) {
      for (let x = rowMinX; x <= rowMaxX; x++) {
        shapeMask[y * width + x] = 1;
      }
    }
  }

  // Step 7: Also do vertical fill to handle concave shapes better
  for (let x = minX; x <= maxX; x++) {
    let colMinY = height, colMaxY = -1;

    for (let y = 0; y < height; y++) {
      if (subjectSeeds[y * width + x] === 1) {
        colMinY = Math.min(colMinY, y);
        colMaxY = Math.max(colMaxY, y);
      }
    }

    if (colMaxY >= colMinY) {
      for (let y = colMinY; y <= colMaxY; y++) {
        shapeMask[y * width + x] = 1;
      }
    }
  }

  // Step 8: Dilate the shape mask to ensure we capture edges
  const dilatedMask = new Uint8Array(shapeMask);
  const dilateRadius = 2;

  for (let y = dilateRadius; y < height - dilateRadius; y++) {
    for (let x = dilateRadius; x < width - dilateRadius; x++) {
      const idx = y * width + x;
      if (shapeMask[idx] === 1) {
        for (let dy = -dilateRadius; dy <= dilateRadius; dy++) {
          for (let dx = -dilateRadius; dx <= dilateRadius; dx++) {
            dilatedMask[(y + dy) * width + (x + dx)] = 1;
          }
        }
      }
    }
  }

  return dilatedMask;
}

export function colorToHex(color: Color): string {
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

// Upscale image data using bilinear interpolation for more detailed tracing
export function upscaleImageData(
  imageData: ImageData,
  scale: number = 2
): { data: Uint8ClampedArray; width: number; height: number } {
  const { width, height, data } = imageData;
  const newWidth = Math.floor(width * scale);
  const newHeight = Math.floor(height * scale);
  const newData = new Uint8ClampedArray(newWidth * newHeight * 4);

  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      // Map back to source coordinates
      const srcX = x / scale;
      const srcY = y / scale;

      // Get the four nearest pixels
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);

      // Calculate interpolation weights
      const wx = srcX - x0;
      const wy = srcY - y0;

      // Bilinear interpolation for each channel
      const idx00 = (y0 * width + x0) * 4;
      const idx01 = (y0 * width + x1) * 4;
      const idx10 = (y1 * width + x0) * 4;
      const idx11 = (y1 * width + x1) * 4;

      const destIdx = (y * newWidth + x) * 4;

      for (let c = 0; c < 4; c++) {
        const v00 = data[idx00 + c];
        const v01 = data[idx01 + c];
        const v10 = data[idx10 + c];
        const v11 = data[idx11 + c];

        // Bilinear interpolation
        const v0 = v00 * (1 - wx) + v01 * wx;
        const v1 = v10 * (1 - wx) + v11 * wx;
        const v = v0 * (1 - wy) + v1 * wy;

        newData[destIdx + c] = Math.round(v);
      }
    }
  }

  return { data: newData, width: newWidth, height: newHeight };
}

// Create a mask from the alpha channel - 1 = opaque (trace), 0 = transparent (skip)
export function createTransparencyMask(
  imageData: ImageData,
  alphaThreshold: number = 128
): Uint8Array {
  const { width, height, data } = imageData;
  const mask = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    // Alpha is the 4th byte (index 3) of each pixel
    const alpha = data[i * 4 + 3];
    mask[i] = alpha >= alphaThreshold ? 1 : 0;
  }

  return mask;
}

// Upscale a mask to match upscaled image dimensions
export function upscaleMask(
  mask: Uint8Array,
  origWidth: number,
  origHeight: number,
  scale: number
): Uint8Array {
  const newWidth = Math.floor(origWidth * scale);
  const newHeight = Math.floor(origHeight * scale);
  const newMask = new Uint8Array(newWidth * newHeight);

  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      // Map back to source coordinates
      const srcX = Math.floor(x / scale);
      const srcY = Math.floor(y / scale);
      const srcIdx = srcY * origWidth + srcX;
      const destIdx = y * newWidth + x;
      newMask[destIdx] = mask[srcIdx];
    }
  }

  return newMask;
}

export function colorToRgba(color: Color): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`;
}

// Merge similar colors in the palette and update quantized data
// Returns { palette: merged palette, quantized: updated quantized data, mapping: old index -> new index }
export function mergeSimilarColors(
  palette: Color[],
  quantized: Uint8Array,
  threshold: number = 25 // Color distance threshold for merging
): { palette: Color[]; quantized: Uint8Array; mapping: number[] } {
  const n = palette.length;

  // Build a union-find structure to group similar colors
  const parent: number[] = Array.from({ length: n }, (_, i) => i);

  const find = (i: number): number => {
    if (parent[i] !== i) {
      parent[i] = find(parent[i]);
    }
    return parent[i];
  };

  const union = (i: number, j: number) => {
    const pi = find(i);
    const pj = find(j);
    if (pi !== pj) {
      // Merge into the one with lower index (keeps more "important" colors)
      if (pi < pj) {
        parent[pj] = pi;
      } else {
        parent[pi] = pj;
      }
    }
  };

  // Find pairs of similar colors and merge them
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dist = colorDistance(palette[i], palette[j]);
      if (dist < threshold) {
        union(i, j);
      }
    }
  }

  // Collect groups and compute merged colors (weighted average would be better, but simple average works)
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(i);
  }

  // Create new palette with merged colors
  const newPalette: Color[] = [];
  const oldToNew: number[] = new Array(n).fill(-1);

  for (const [_root, indices] of groups) {
    const newIndex = newPalette.length;

    // Average the colors in this group
    let r = 0, g = 0, b = 0, a = 0;
    for (const idx of indices) {
      r += palette[idx].r;
      g += palette[idx].g;
      b += palette[idx].b;
      a += palette[idx].a;
    }
    const count = indices.length;
    newPalette.push({
      r: Math.round(r / count),
      g: Math.round(g / count),
      b: Math.round(b / count),
      a: Math.round(a / count)
    });

    // Map all old indices to new index
    for (const idx of indices) {
      oldToNew[idx] = newIndex;
    }
  }

  // Update quantized data with new indices. Preserve the transparent marker (255):
  // oldToNew has no entry for it, so without this transparent pixels would map to
  // colour 0 and get filled instead of staying transparent.
  const newQuantized = new Uint8Array(quantized.length);
  for (let i = 0; i < quantized.length; i++) {
    const v = quantized[i];
    newQuantized[i] = v === 255 ? 255 : oldToNew[v];
  }

  return {
    palette: newPalette,
    quantized: newQuantized,
    mapping: oldToNew
  };
}