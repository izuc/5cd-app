// vectest_harness.ts
var import_fs = require("fs");
var import_pngjs = require("pngjs");
var import_resvg_js = require("@resvg/resvg-js");

// src/vectorize/colorQuantization.ts
function createColorBox(colors) {
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
function getLongestAxis(box) {
  const rRange = box.rMax - box.rMin;
  const gRange = box.gMax - box.gMin;
  const bRange = box.bMax - box.bMin;
  if (rRange >= gRange && rRange >= bRange) return "r";
  if (gRange >= rRange && gRange >= bRange) return "g";
  return "b";
}
function splitBox(box) {
  const axis = getLongestAxis(box);
  const sorted = [...box.colors].sort((a, b) => a[axis] - b[axis]);
  const mid = Math.floor(sorted.length / 2);
  return [
    createColorBox(sorted.slice(0, mid)),
    createColorBox(sorted.slice(mid))
  ];
}
function getAverageColor(box) {
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
function colorDistance(c1, c2) {
  const dr = c1.r - c2.r;
  const dg = c1.g - c2.g;
  const db = c1.b - c2.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
function selectDiverseColors(candidates, count) {
  if (candidates.length <= count) return candidates;
  if (count <= 0) return [];
  const selected = [];
  const used = /* @__PURE__ */ new Set();
  selected.push(candidates[0]);
  used.add(0);
  while (selected.length < count) {
    let bestIdx = -1;
    let bestMinDist = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue;
      let minDist = Infinity;
      for (const sel of selected) {
        const d = colorDistance(candidates[i], sel);
        if (d < minDist) minDist = d;
      }
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
function countUniqueColors(colors, tolerance = 5) {
  if (colors.length === 0) return 0;
  const unique = [colors[0]];
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
      if (unique.length > 256) break;
    }
  }
  return unique.length;
}
function kMeansRefinement(colors, centroids, iterations = 5) {
  let currentCentroids = [...centroids];
  for (let i = 0; i < iterations; i++) {
    const clusters = currentCentroids.map(() => []);
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
function preprocessImage(imageData) {
  const width = imageData.width;
  const height = imageData.height;
  const input = imageData.data;
  const output = new Uint8ClampedArray(input.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      const r = input[idx];
      const g = input[idx + 1];
      const b = input[idx + 2];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nIdx = (ny * width + nx) * 4;
            const nr = input[nIdx];
            const ng = input[nIdx + 1];
            const nb = input[nIdx + 2];
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
function medianCutQuantization(imageData, colorCount2, onProgress) {
  const { data, width, height } = imageData;
  const colors = [];
  const totalPixels = data.length / 4;
  const step = Math.max(1, Math.floor(totalPixels / 5e4));
  for (let i = 0; i < data.length; i += 4 * step) {
    if (data[i + 3] > 128) {
      colors.push({
        r: data[i],
        g: data[i + 1],
        b: data[i + 2],
        a: 255
      });
    }
  }
  const edgeStep = Math.max(1, Math.floor(totalPixels / 3e4));
  for (let y = 1; y < height - 1; y += Math.max(1, Math.floor(edgeStep / width))) {
    for (let x = 1; x < width - 1; x += 2) {
      const idx = (y * width + x) * 4;
      const idxLeft = idx - 4;
      const idxRight = idx + 4;
      const idxUp = idx - width * 4;
      const idxDown = idx + width * 4;
      const dr = Math.abs(data[idxRight] - data[idxLeft]) + Math.abs(data[idxDown] - data[idxUp]);
      const dg = Math.abs(data[idxRight + 1] - data[idxLeft + 1]) + Math.abs(data[idxDown + 1] - data[idxUp + 1]);
      const db = Math.abs(data[idxRight + 2] - data[idxLeft + 2]) + Math.abs(data[idxDown + 2] - data[idxUp + 2]);
      const gradient = dr + dg + db;
      if (gradient > 100 && data[idx + 3] > 128) {
        const edgeColor = {
          r: data[idx],
          g: data[idx + 1],
          b: data[idx + 2],
          a: 255
        };
        colors.push(edgeColor);
        colors.push(edgeColor);
      }
    }
  }
  if (colors.length === 0) {
    return [{ r: 0, g: 0, b: 0, a: 255 }];
  }
  const uniqueColorCount = countUniqueColors(colors, 10);
  const targetColorCount = Math.min(colorCount2, uniqueColorCount);
  const candidateCount = Math.min(targetColorCount * 3, uniqueColorCount);
  let boxes = [createColorBox(colors)];
  while (boxes.length < candidateCount) {
    let maxIndex = 0;
    let maxCount = 0;
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
  const refinedCandidates = kMeansRefinement(colors, candidatePalette);
  if (onProgress) {
    onProgress(0.8);
  }
  const diversePalette = selectDiverseColors(refinedCandidates, targetColorCount);
  return diversePalette;
}
function findClosestColor(color, palette) {
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
function quantizeImage(imageData, palette, onProgress) {
  const data = imageData.data;
  const result = new Uint8Array(data.length / 4);
  for (let i = 0; i < data.length; i += 4) {
    const pixelIndex = i / 4;
    const color = {
      r: data[i],
      g: data[i + 1],
      b: data[i + 2],
      a: data[i + 3]
    };
    if (color.a < 128) {
      result[pixelIndex] = 255;
    } else {
      result[pixelIndex] = findClosestColor(color, palette);
    }
    if (onProgress && pixelIndex % 1e4 === 0) {
      onProgress(pixelIndex / (data.length / 4));
    }
  }
  return result;
}
function denoiseQuantized(quantized, width, height, iterations = 1) {
  let current = quantized;
  for (let i = 0; i < iterations; i++) {
    const next = new Uint8Array(current.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const counts = /* @__PURE__ */ new Map();
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
function cleanSpeckles(quantized, width, height, minArea) {
  if (minArea <= 0) return quantized;
  const visited = new Uint8Array(width * height);
  const result = new Uint8Array(quantized);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] === 1) continue;
      const color = result[idx];
      const regionIndices = [];
      const borderNeighborColors = [];
      const stack = [idx];
      visited[idx] = 1;
      regionIndices.push(idx);
      let ptr = 0;
      while (ptr < stack.length) {
        const currIdx = stack[ptr++];
        const cx = currIdx % width;
        const cy = Math.floor(currIdx / width);
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
              borderNeighborColors.push(neighborColor);
            }
          }
        }
      }
      if (regionIndices.length < minArea && borderNeighborColors.length > 0) {
        const colorCounts = /* @__PURE__ */ new Map();
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
function erodeQuantized(quantized, width, height) {
  const result = new Uint8Array(quantized);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const color = quantized[idx];
      const neighbors = [
        quantized[(y - 1) * width + x],
        quantized[(y + 1) * width + x],
        quantized[y * width + (x - 1)],
        quantized[y * width + (x + 1)]
      ];
      for (const nc of neighbors) {
        if (nc !== color) {
          const counts = /* @__PURE__ */ new Map();
          for (const n of neighbors) {
            if (n !== color) {
              counts.set(n, (counts.get(n) || 0) + 1);
            }
          }
          let maxC = 0, bestColor = color;
          for (const [c, cnt] of counts) {
            if (cnt > maxC) {
              maxC = cnt;
              bestColor = c;
            }
          }
          result[idx] = bestColor;
          break;
        }
      }
    }
  }
  return result;
}
function dilateQuantized(quantized, width, height) {
  const result = new Uint8Array(quantized);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const color = quantized[idx];
      const neighborIndices = [
        (y - 1) * width + x,
        (y + 1) * width + x,
        y * width + (x - 1),
        y * width + (x + 1)
      ];
      const counts = /* @__PURE__ */ new Map();
      for (const ni of neighborIndices) {
        const nc = quantized[ni];
        if (nc !== color && nc !== 255) {
          counts.set(nc, (counts.get(nc) || 0) + 1);
        }
      }
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
function morphologicalOpen(quantized, width, height, iterations = 1) {
  let result = quantized;
  for (let i = 0; i < iterations; i++) {
    result = erodeQuantized(result, width, height);
  }
  for (let i = 0; i < iterations; i++) {
    result = dilateQuantized(result, width, height);
  }
  return result;
}
function morphologicalClose(quantized, width, height, iterations = 1) {
  let result = quantized;
  for (let i = 0; i < iterations; i++) {
    result = dilateQuantized(result, width, height);
  }
  for (let i = 0; i < iterations; i++) {
    result = erodeQuantized(result, width, height);
  }
  return result;
}
function multiPassSpeckleClean(quantized, width, height, colorCount2, baseMinArea) {
  let result = quantized;
  const passes = colorCount2 > 16 ? 3 : 2;
  for (let pass = 0; pass < passes; pass++) {
    const areaThreshold = baseMinArea * (pass + 1);
    result = cleanSpeckles(result, width, height, areaThreshold);
  }
  return result;
}
function adaptiveClean(quantized, width, height, colorCount2, baseMinArea, qualityLevel = "balanced") {
  let result = quantized;
  if (qualityLevel === "detailed") {
    result = denoiseQuantized(result, width, height, 2);
    const tinyArea = Math.max(3, Math.floor(baseMinArea * 0.3));
    result = cleanSpeckles(result, width, height, tinyArea);
    return result;
  }
  if (qualityLevel === "fast") {
    result = denoiseQuantized(result, width, height, 2);
    result = cleanSpeckles(result, width, height, baseMinArea);
    return result;
  }
  if (qualityLevel === "balanced") {
    const denoiseIterations2 = Math.min(4, Math.ceil(colorCount2 / 10) + 2);
    result = denoiseQuantized(result, width, height, denoiseIterations2);
    if (colorCount2 > 16) {
      result = morphologicalOpen(result, width, height, 1);
    }
    const scaledMinArea2 = Math.ceil(baseMinArea * (1 + colorCount2 / 32));
    result = cleanSpeckles(result, width, height, scaledMinArea2);
    result = denoiseQuantized(result, width, height, 1);
    return result;
  }
  const colorFactor = Math.pow(colorCount2 / 8, 1.5);
  const denoiseIterations = Math.min(8, Math.ceil(colorFactor * 2));
  const scaledMinArea = Math.ceil(baseMinArea * Math.max(1, colorFactor));
  result = denoiseQuantized(result, width, height, denoiseIterations);
  if (colorCount2 > 12) {
    result = morphologicalClose(result, width, height, 1);
    result = morphologicalOpen(result, width, height, 1);
    if (colorCount2 > 24) {
      result = morphologicalOpen(result, width, height, 1);
    }
  } else if (colorCount2 > 8) {
    result = morphologicalOpen(result, width, height, 1);
  }
  result = multiPassSpeckleClean(result, width, height, colorCount2, scaledMinArea);
  const finalPasses = colorCount2 > 16 ? 3 : 2;
  result = denoiseQuantized(result, width, height, finalPasses);
  return result;
}
function colorToHex(color) {
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}
function mergeSimilarColors(palette, quantized, threshold = 25) {
  const n = palette.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    if (parent[i] !== i) {
      parent[i] = find(parent[i]);
    }
    return parent[i];
  };
  const union = (i, j) => {
    const pi = find(i);
    const pj = find(j);
    if (pi !== pj) {
      if (pi < pj) {
        parent[pj] = pi;
      } else {
        parent[pi] = pj;
      }
    }
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dist = colorDistance(palette[i], palette[j]);
      if (dist < threshold) {
        union(i, j);
      }
    }
  }
  const groups = /* @__PURE__ */ new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root).push(i);
  }
  const newPalette = [];
  const oldToNew = new Array(n).fill(-1);
  for (const [_root, indices] of groups) {
    const newIndex = newPalette.length;
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
    for (const idx of indices) {
      oldToNew[idx] = newIndex;
    }
  }
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

// src/vectorize/pathTracing.ts
function getAngle(p1, p2, p3) {
  const v1x = p1.x - p2.x;
  const v1y = p1.y - p2.y;
  const v2x = p3.x - p2.x;
  const v2y = p3.y - p2.y;
  const dot = v1x * v2x + v1y * v2y;
  const cross = v1x * v2y - v1y * v2x;
  return Math.atan2(Math.abs(cross), dot);
}
function detectCorners(points, angleThreshold = Math.PI / 4) {
  const corners = /* @__PURE__ */ new Set();
  if (points.length < 3) return corners;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[(i - 1 + points.length) % points.length];
    const p2 = points[i];
    const p3 = points[(i + 1) % points.length];
    const angle = getAngle(p1, p2, p3);
    if (angle < Math.PI - angleThreshold) {
      corners.add(i);
    }
  }
  return corners;
}
function smoothPathPreservingCorners(points, corners, iterations = 2, weight = 0.25) {
  if (points.length < 3) return points;
  let current = [...points];
  for (let iter = 0; iter < iterations; iter++) {
    const next = [];
    for (let i = 0; i < current.length; i++) {
      if (corners.has(i)) {
        next.push(current[i]);
      } else {
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
function simplifyPath(points, tolerance) {
  if (points.length < 3) return points;
  const sqDistToSegment = (p, p1, p2) => {
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
  const simplifySection = (start, end) => {
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
function calculateSignedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}
function ensureClockwise(points) {
  const area = calculateSignedArea(points);
  if (area < 0) {
    return [...points].reverse();
  }
  return points;
}
function refinePathMultiStage(rawPoints, smoothness2, qualityLevel = "balanced") {
  if (rawPoints.length < 3) return rawPoints;
  let points = rawPoints;
  const cornerAngleThreshold = Math.PI / 3;
  const corners = detectCorners(points, cornerAngleThreshold);
  if (qualityLevel === "fast") {
    const simplified = simplifyPath(points, Math.max(1, smoothness2 * 0.3));
    if (simplified.length < 3) return rawPoints;
    return simplified;
  }
  if (qualityLevel === "detailed") {
    points = smoothPathPreservingCorners(points, corners, 1, 0.02);
    points = simplifyPath(points, Math.max(0.1, smoothness2 * 0.05));
    if (points.length < 3) return rawPoints;
    return points;
  }
  if (qualityLevel === "balanced") {
    points = smoothPathPreservingCorners(points, corners, 1, 0.12);
    points = simplifyPath(points, Math.max(0.5, smoothness2 * 0.2));
    if (points.length < 3) return rawPoints;
    return points;
  }
  points = smoothPathPreservingCorners(points, corners, 1, 0.15);
  points = simplifyPath(points, Math.max(0.4, smoothness2 * 0.15));
  if (points.length < 3) return rawPoints;
  return points;
}
function pointsToSvgPathOptimized(points, corners) {
  if (points.length < 2) return "";
  const r = Math.round;
  if (points.length < 3) {
    return `M${r(points[0].x)},${r(points[0].y)}L${r(points[1].x)},${r(points[1].y)}Z`;
  }
  if (points.length < 5) {
    let d2 = `M${r(points[0].x)},${r(points[0].y)}`;
    for (let i = 1; i < points.length; i++) {
      d2 += `L${r(points[i].x)},${r(points[i].y)}`;
    }
    return d2 + "Z";
  }
  const distToSegmentSquared = (p, v, w) => {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return (p.x - v.x) ** 2 + (p.y - v.y) ** 2;
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return (p.x - (v.x + t * (w.x - v.x))) ** 2 + (p.y - (v.y + t * (w.y - v.y))) ** 2;
  };
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
    const cp1 = { x: cp1x, y: cp1y };
    const cp2 = { x: cp2x, y: cp2y };
    const errorThreshold = 0.5;
    if (distToSegmentSquared(cp1, p1, p2) < errorThreshold && distToSegmentSquared(cp2, p1, p2) < errorThreshold) {
      d += `L${r(p2.x)},${r(p2.y)}`;
    } else {
      d += `C${r(cp1x)},${r(cp1y)} ${r(cp2x)},${r(cp2y)} ${r(p2.x)},${r(p2.y)}`;
    }
  }
  return d + "Z";
}
function dilateColorMask(mask, width, height, radius = 1) {
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
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
function erodeColorMask(mask, width, height, radius = 1) {
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
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
function closeColorMask(mask, width, height, radius = 2) {
  const dilated = dilateColorMask(mask, width, height, radius);
  return erodeColorMask(dilated, width, height, radius);
}
var MOORE_NEIGHBORS = [
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 }
];
function traceMaskBoundary(mask, width, height, startX, startY) {
  const boundary = [];
  let curX = startX;
  let curY = startY;
  boundary.push({ x: curX, y: curY });
  let prevX = curX - 1;
  let prevY = curY;
  let iter = 0;
  const maxIter = width * height * 2;
  const isInside = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return mask[y * width + x] === 1;
  };
  while (iter < maxIter) {
    let startNeighborIdx = 0;
    const dx = prevX - curX;
    const dy = prevY - curY;
    for (let i = 0; i < 8; i++) {
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
function traceAllColors(quantized, width, height, palette, selectedColors, smoothness2, minArea = 1, onProgress, qualityLevel = "balanced", foregroundMask, mergeNeighbors = true) {
  const result = [];
  const colorsToTrace = selectedColors.size > 0 ? Array.from(selectedColors) : palette.map((_, i) => i);
  let colorsProcessed = 0;
  const mergeRadius = mergeNeighbors ? qualityLevel === "fast" ? 4 : qualityLevel === "balanced" ? 2 : qualityLevel === "high" ? 1 : 0 : 0;
  for (const colorIndex of colorsToTrace) {
    if (colorIndex >= palette.length || colorIndex === 255) continue;
    const colorMask = new Uint8Array(width * height);
    for (let i = 0; i < quantized.length; i++) {
      if (quantized[i] === colorIndex) {
        if (!foregroundMask || foregroundMask[i] === 1) {
          colorMask[i] = 1;
        }
      }
    }
    const processedMask = mergeRadius > 0 ? closeColorMask(colorMask, width, height, mergeRadius) : colorMask;
    const visited = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (visited[idx]) continue;
        if (processedMask[idx] === 1) {
          const boundary = traceMaskBoundary(processedMask, width, height, x, y);
          let pixelCount = 0;
          let foregroundPixelCount = 0;
          const stack = [idx];
          visited[idx] = 1;
          if (colorMask[idx] === 1) {
            pixelCount++;
            if (foregroundMask && foregroundMask[idx] === 1) {
              foregroundPixelCount++;
            }
          }
          while (stack.length > 0) {
            const pIdx = stack.pop();
            const px = pIdx % width;
            const py = Math.floor(pIdx / width);
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
          let isBackground;
          let touchesEdge = false;
          const edgeMargin = 5;
          for (const p of boundary) {
            if (p.x <= edgeMargin || p.x >= width - edgeMargin - 1 || p.y <= edgeMargin || p.y >= height - edgeMargin - 1) {
              touchesEdge = true;
              break;
            }
          }
          if (foregroundMask) {
            const foregroundRatio = pixelCount > 0 ? foregroundPixelCount / pixelCount : 0;
            if (touchesEdge && foregroundRatio < 0.4) {
              isBackground = true;
            } else {
              isBackground = false;
            }
          } else {
            isBackground = touchesEdge;
          }
          if (pixelCount >= minArea && boundary.length > 2) {
            let refined = refinePathMultiStage(boundary, smoothness2, qualityLevel);
            refined = ensureClockwise(refined);
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
function groupShapesByColor(shapes) {
  const groups = /* @__PURE__ */ new Map();
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
    const group = groups.get(hex);
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
function scalePathString(pathStr, scale) {
  if (scale === 1) return pathStr;
  return pathStr.replace(/-?\d+\.?\d*/g, (match) => {
    const num = parseFloat(match);
    const scaled = num / scale;
    return Math.round(scaled).toString();
  });
}
function generateSvg(shapes, width, height, removeBackground = false, pathScale = 1, hasTransparentSource = false) {
  const colorGroups = groupShapesByColor(shapes);
  let maxBackgroundArea = 0;
  let dominantHex = "#ffffff";
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
  let svg2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="geometricPrecision">
`;
  svg2 += `  <title>Vectorized Image</title>
`;
  svg2 += `  <desc>Generated with Raster2Vector - ${colorGroups.size} colors</desc>
`;
  svg2 += `  <defs>
`;
  svg2 += `    <style>
`;
  svg2 += `      .vector-shape { stroke-linejoin: round; stroke-linecap: round; }
`;
  svg2 += `    </style>
`;
  svg2 += `  </defs>
`;
  svg2 += `  <g id="content">
`;
  if (removeBackground) {
    const allShapesFiltered = [];
    const smallShapeThreshold = width * height * 0.05;
    for (const shape of shapes) {
      const hex = colorToHex(shape.color);
      const isSmallBackground = shape.isBackground && shape.area < smallShapeThreshold;
      const isDominantBg = hex === dominantHex;
      if (!shape.isBackground || isSmallBackground && !isDominantBg) {
        allShapesFiltered.push({
          hex,
          path: shape.path,
          area: shape.area
        });
      }
    }
    if (allShapesFiltered.length === 0) {
      for (const shape of shapes) {
        const hex = colorToHex(shape.color);
        if (hex !== dominantHex) {
          allShapesFiltered.push({
            hex,
            path: shape.path,
            area: shape.area
          });
        }
      }
    }
    allShapesFiltered.sort((a, b) => b.area - a.area);
    const strokeWidth = Math.max(1, 2 / pathScale);
    svg2 += `    <g id="shapes-layer">
`;
    for (const { hex, path } of allShapesFiltered) {
      const scaledPath = scalePathString(path, pathScale);
      svg2 += `      <path fill="${hex}" stroke="${hex}" stroke-width="${strokeWidth}" stroke-linejoin="round" d="${scaledPath}"/>
`;
    }
    svg2 += `    </g>
`;
  } else {
    const allShapesFlat = [];
    for (const shape of shapes) {
      const hex = colorToHex(shape.color);
      allShapesFlat.push({
        hex,
        path: shape.path,
        area: shape.area
      });
    }
    allShapesFlat.sort((a, b) => b.area - a.area);
    const strokeWidthStd = Math.max(0.5, 1 / pathScale);
    svg2 += `    <g id="shapes-layer">
`;
    for (const { hex, path } of allShapesFlat) {
      const scaledPath = scalePathString(path, pathScale);
      svg2 += `      <path fill="${hex}" stroke="${hex}" stroke-width="${strokeWidthStd}" stroke-linejoin="round" d="${scaledPath}"/>
`;
    }
    svg2 += `    </g>
`;
  }
  svg2 += `  </g>
`;
  svg2 += `</svg>`;
  return svg2;
}

// vectest_harness.ts
function upscaleLabels(labels2, w, h, sf2) {
  const nw = w * sf2, nh = h * sf2;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = y / sf2 | 0;
    for (let x = 0; x < nw; x++) out[y * nw + x] = labels2[sy * w + (x / sf2 | 0)];
  }
  return out;
}
var inPath = process.argv[2];
var outPath = process.argv[3];
var quality = process.argv[4] || "high";
var colorCount = parseInt(process.argv[5] || "16", 10);
var smoothness = parseFloat(process.argv[6] || "5");
var removeBg = process.argv[7] === "rmbg";
var png = import_pngjs.PNG.sync.read((0, import_fs.readFileSync)(inPath));
var W = png.width;
var H = png.height;
var img = { width: W, height: H, data: new Uint8ClampedArray(png.data), colorSpace: "srgb" };
var processed = preprocessImage(img);
var pObj = { width: W, height: H, data: processed, colorSpace: "srgb" };
var pal = medianCutQuantization(pObj, colorCount);
var q = quantizeImage(pObj, pal);
q = adaptiveClean(q, W, H, colorCount, Math.max(8, 20), "detailed");
var merged = mergeSimilarColors(pal, q, quality === "detailed" ? 4 : quality === "high" ? 6 : 8);
var sf = quality === "detailed" ? 4 : quality === "high" ? 3 : quality === "balanced" ? 2 : 1;
var labels = merged.quantized;
var ww = W;
var wh = H;
if (sf > 1) {
  labels = upscaleLabels(merged.quantized, W, H, sf);
  ww = W * sf;
  wh = H * sf;
}
var paths = traceAllColors(labels, ww, wh, merged.palette, /* @__PURE__ */ new Set(), smoothness, 0, () => {
}, quality, null);
var svg = generateSvg(paths, W, H, removeBg, sf, false);
(0, import_fs.writeFileSync)(outPath.replace(/\.png$/, ".svg"), svg);
var rendered = new import_resvg_js.Resvg(svg, { fitTo: { mode: "width", value: W }, background: "rgba(255,255,255,0)" }).render().asPng();
(0, import_fs.writeFileSync)(outPath, rendered);
var hasRect = /<rect id="background"/.test(svg);
console.log(`shapes=${paths.length} svgBytes=${svg.length} bgRect=${hasRect} (q=${quality} colors=${colorCount} rmbg=${removeBg})`);
