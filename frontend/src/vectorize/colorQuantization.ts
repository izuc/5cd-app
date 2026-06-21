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

// Use farthest point sampling to select the most diverse colors from candidates
// This maximizes the minimum distance between any two selected colors
function selectDiverseColors(candidates: Color[], count: number): Color[] {
  if (candidates.length <= count) return candidates;
  if (count <= 0) return [];

  const selected: Color[] = [];
  const used = new Set<number>();

  // Start with the first color (usually the most common from median cut)
  selected.push(candidates[0]);
  used.add(0);

  // Greedily select colors that are furthest from all already-selected colors
  while (selected.length < count) {
    let bestIdx = -1;
    let bestMinDist = -1;

    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue;

      // Find minimum distance to any already-selected color
      let minDist = Infinity;
      for (const sel of selected) {
        const d = colorDistance(candidates[i], sel);
        if (d < minDist) minDist = d;
      }

      // Keep track of the candidate with the largest minimum distance
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
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

function kMeansRefinement(colors: Color[], centroids: Color[], iterations: number = 5): Color[] {
  let currentCentroids = [...centroids];

  for (let i = 0; i < iterations; i++) {
    // Assign points to clusters
    const clusters: Color[][] = currentCentroids.map(() => []);
    
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

  return currentCentroids;
}

export function preprocessImage(imageData: ImageData): Uint8ClampedArray {
  const width = imageData.width;
  const height = imageData.height;
  const input = imageData.data;
  const output = new Uint8ClampedArray(input.length);
  
  // Simple edge-preserving smoothing (Smart Blur)
  // If a pixel is similar to neighbors, blend them. If distinct, keep it.
  
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
            
            // Edge preservation threshold
            // Reduced from 30 to 10 to preserve more fine detail while still reducing noise
            if (Math.abs(r - nr) < 10 && Math.abs(g - ng) < 10 && Math.abs(b - nb) < 10) {
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
  // This helps preserve text colors that might otherwise be underrepresented
  const edgeStep = Math.max(1, Math.floor(totalPixels / 30000));
  for (let y = 1; y < height - 1; y += Math.max(1, Math.floor(edgeStep / width))) {
    for (let x = 1; x < width - 1; x += 2) {
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

  // Generate MORE candidate colors than needed (3x), then select the most diverse
  // This gives us better options to choose from
  const candidateCount = Math.min(targetColorCount * 3, uniqueColorCount);

  // Median cut algorithm - generate extra candidates
  let boxes: ColorBox[] = [createColorBox(colors)];

  while (boxes.length < candidateCount) {
    let maxIndex = 0;
    let maxCount = 0;
    // Find box with largest color count
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].colors.length > maxCount) {
        maxCount = boxes[i].colors.length;
        maxIndex = i;
      }
    }

    if (maxCount <= 1) break;

    const [box1, box2] = splitBox(boxes[maxIndex]);
    boxes.splice(maxIndex, 1, box1, box2);

    if (onProgress) {
      onProgress(boxes.length / candidateCount * 0.5);
    }
  }

  const candidatePalette = boxes.map(getAverageColor);

  // Refine candidates with K-Means for better accuracy
  const refinedCandidates = kMeansRefinement(colors, candidatePalette);

  if (onProgress) {
    onProgress(0.8);
  }

  // Use farthest point sampling to select the most diverse colors
  // This ensures maximum visual difference between selected colors
  const diversePalette = selectDiverseColors(refinedCandidates, targetColorCount);

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

export function denoiseQuantized(
  quantized: Uint8Array,
  width: number,
  height: number,
  iterations: number = 1
): Uint8Array {
  let current = quantized;
  
  for (let i = 0; i < iterations; i++) {
    const next = new Uint8Array(current.length);
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        
        // Collect neighbor counts
        const counts = new Map<number, number>();
        let maxCount = 0;
        let majorityColor = current[idx];
        
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nIdx = ny * width + nx;
              const color = current[nIdx];
              const newCount = (counts.get(color) || 0) + 1;
              counts.set(color, newCount);
              
              if (newCount > maxCount) {
                maxCount = newCount;
                majorityColor = color;
              }
            }
          }
        }
        
        next[idx] = majorityColor;
      }
    }
    current = next;
  }
  
  return current;
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
  qualityLevel: 'fast' | 'balanced' | 'high' | 'detailed' = 'balanced'
): Uint8Array {
  let result = quantized;

  // DETAILED mode: Minimal cleaning to preserve fine features like text
  if (qualityLevel === 'detailed') {
    // Very light denoising - just 1-2 passes to remove noise
    result = denoiseQuantized(result, width, height, 2);

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

  // Update quantized data with new indices
  const newQuantized = new Uint8Array(quantized.length);
  for (let i = 0; i < quantized.length; i++) {
    newQuantized[i] = oldToNew[quantized[i]];
  }

  return {
    palette: newPalette,
    quantized: newQuantized,
    mapping: oldToNew
  };
}