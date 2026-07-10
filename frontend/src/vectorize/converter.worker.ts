// Web Worker for image conversion - Simple reliable vectorization

import type { Color, ShapeData } from './types';
import { medianCutQuantization, quantizeImage, preprocessImage, adaptiveClean, createForegroundMask, mergeSimilarColors, createTransparencyMask, upscaleMask, denoiseQuantized, consolidateRegions, mergeInkColors, refineLabelsMRF, refreshPaletteFromLabels, computeLambdaMap, removeBackgroundLabels, mergeGradientBands, reinforceRidges } from './colorQuantization';
import { traceAllColors, generateSvg } from './pathTracing';

type QualityLevel = 'fast' | 'balanced' | 'high' | 'detailed';

interface WorkerMessage {
  type: 'process';
  imageData?: {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };
  settings: {
    colorCount: number;
    smoothness: number;
    minArea: number;
    removeBackground: boolean;      // Actively detect and remove background shapes
    hasTransparentSource: boolean;  // Source has transparency - don't add bg rect
    selectedColors: number[];
    qualityLevel?: QualityLevel;
  };
}

interface WorkerResponse {
  type: 'progress' | 'palette' | 'complete' | 'error';
  progress?: number;
  message?: string;
  palette?: Color[];
  pathData?: ShapeData[];
  svgContent?: string;
  width?: number;
  height?: number;
}

function createImageData(width: number, height: number, data: Uint8ClampedArray): ImageData {
  return { width, height, data, colorSpace: 'srgb' } as ImageData;
}

// Upscale of a label map for higher-resolution boundary tracing. Bilinear
// indicator argmax: each output pixel takes the label with the highest
// bilinearly-interpolated indicator weight among its 4 nearest native pixels.
// Boundaries land at sub-native-pixel positions instead of the full-pixel
// stair-steps nearest-neighbour produces — traced digits/outlines come out
// visibly smoother, and one gated denoise pass replaces the two NN needed.
// (255 transparent marker is just another label to the argmax.)
function upscaleLabelsBilinear(labels: Uint8Array, w: number, h: number, sf: number): Uint8Array {
  const nw = w * sf, nh = h * sf;
  const out = new Uint8Array(nw * nh);
  const ls = new Int32Array(4), ws = new Float64Array(4);
  for (let y = 0; y < nh; y++) {
    const ys = (y + 0.5) / sf - 0.5;
    const y0 = Math.max(0, Math.floor(ys)), y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, ys - y0));
    for (let x = 0; x < nw; x++) {
      const xs = (x + 0.5) / sf - 0.5;
      const x0 = Math.max(0, Math.floor(xs)), x1 = Math.min(w - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, xs - x0));
      ls[0] = labels[y0 * w + x0]; ws[0] = (1 - fx) * (1 - fy);
      ls[1] = labels[y0 * w + x1]; ws[1] = fx * (1 - fy);
      ls[2] = labels[y1 * w + x0]; ws[2] = (1 - fx) * fy;
      ls[3] = labels[y1 * w + x1]; ws[3] = fx * fy;
      let best = ls[0];
      let bestW = 0;
      for (let i = 0; i < 4; i++) {
        if (ls[i] < 0) continue;
        let wt = ws[i];
        for (let j = i + 1; j < 4; j++) if (ls[j] === ls[i]) { wt += ws[j]; ls[j] = -1; }
        if (wt > bestW) { bestW = wt; best = ls[i]; }
      }
      out[y * nw + x] = best;
    }
  }
  return out;
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const { type, imageData, settings } = e.data;

  const postProgress = (p: number, m: string) => {
    self.postMessage({ type: 'progress', progress: p, message: m } as WorkerResponse);
  };

  try {
    if (type === 'process' && imageData) {
      const { width: origWidth, height: origHeight, data } = imageData;
      const { colorCount, smoothness, minArea, removeBackground, hasTransparentSource, selectedColors, qualityLevel = 'balanced' } = settings;
      const imgDataObj = createImageData(origWidth, origHeight, data);

      // Create transparency mask BEFORE preprocessing (which may fill transparent areas)
      let transparencyMask: Uint8Array | null = null;
      if (hasTransparentSource) {
        transparencyMask = createTransparencyMask(imgDataObj, 128);
      }

      postProgress(0, 'Preprocessing...');
      const processedData = preprocessImage(imgDataObj);
      let processedImgDataObj = createImageData(origWidth, origHeight, processedData);

      // Quantize at NATIVE resolution so thin features (text, fine lines) keep their
      // crisp edges. (Upscaling the photo first and THEN quantising softens thin dark
      // strokes into the background — that's what was losing text & detail.)
      postProgress(0.2, 'Extracting colors...');
      const newPalette = medianCutQuantization(processedImgDataObj, colorCount);
      self.postMessage({ type: 'palette', palette: newPalette } as WorkerResponse);

      postProgress(0.35, 'Mapping pixels...');
      let quantized = quantizeImage(processedImgDataObj, newPalette);

      // Potts/ICM label refinement: collapses gradient "camo" mottle (patch
      // boundaries cost length) and settles band boundaries along true image
      // edges — smoother bands AND straighter linework. The smoothness weight is
      // EDGE-MODULATED (computeLambdaMap on the pre-filtered image): strong deep
      // in flat/gradient areas where patches live, weak at strong gradients so
      // boundaries lock onto true edges and details stay. The data term reads the
      // RAW (un-blurred) pixels for the tightest edge snapping.
      postProgress(0.45, 'Refining regions...');
      const lambdaMap = computeLambdaMap(processedData, origWidth, origHeight, 6, 36);
      quantized = refineLabelsMRF(quantized, origWidth, origHeight, data, newPalette, 3, 16, lambdaMap);

      // Gentle clean at native res — drop anti-alias speckles WITHOUT the heavy
      // majority/morphological erosion the old 'high' path used (which melted text).
      // Passing the palette contrast-gates the majority filter so thin dark outlines
      // survive while gradient/AA noise is still consolidated.
      postProgress(0.5, 'Cleaning...');
      quantized = adaptiveClean(quantized, origWidth, origHeight, colorCount, Math.max(8, minArea), 'detailed', newPalette);

      postProgress(0.55, 'Merging similar colors...');
      const mergeThreshold = qualityLevel === 'detailed' ? 4 : qualityLevel === 'high' ? 6 : 8;
      const merged = mergeSimilarColors(newPalette, quantized, mergeThreshold);

      // Unify outline ink: near-black shades merge into the darkest palette entry so
      // thin dark outlines are ONE label instead of an alternating mosaic that
      // disintegrates into per-colour fragments when traced.
      const inked = mergeInkColors(merged.palette, merged.quantized);
      const finalPalette = inked.palette;

      // De-mottle: gradient-heavy art (metallic/airbrushed logos) quantises into
      // small islands of adjacent ramp shades. Absorb low-contrast islands into
      // their dominant neighbour (size ceiling scales inversely with contrast), so
      // smooth shading traces as clean flat bands instead of "camo" patches while
      // small HIGH-contrast details (bolts, text, highlights) are untouched.
      postProgress(0.57, 'Consolidating regions...');
      // Floor: regions that would fall under the tracer's speckle floor (see
      // traceMinArea below — same 5e-6 fraction, expressed at native res) are
      // absorbed here instead of dropped there, so they can't leave gaps.
      const nativeFloor = Math.max(4, Math.round(origWidth * origHeight * 5e-6) + 2);
      const nativeLabels = consolidateRegions(inked.quantized, origWidth, origHeight, finalPalette, Math.max(8, minArea), nativeFloor);

      // Smart background removal at the label level: flood the border-dominant
      // colour from the edges (outer background) AND clear enclosed same-colour
      // pockets whose raw pixels statistically match it, while sparing white
      // CONTENT (chrome highlights etc.) that merely shares the palette entry.
      // Removed pixels become the 255 transparent marker; the trace then simply
      // never draws them and enclosing shapes keep the area as evenodd holes.
      let bgRemoved = false;
      if (removeBackground) {
        postProgress(0.575, 'Removing background...');
        bgRemoved = removeBackgroundLabels(nativeLabels, origWidth, origHeight, processedData, finalPalette).removed;
      }

      // Reconnect "dotted" hairlines: blend pixels where a ~1px bright/dark line
      // lost its label are still luminance ridges in the raw image — relabel
      // them back to the line so the thin-link pass below can chain the dashes
      // into one continuous stroke.
      postProgress(0.577, 'Reconnecting lines...');
      const ridged = reinforceRidges(nativeLabels, origWidth, origHeight, processedData, finalPalette).labels;

      // Merge adjacent bands of one smooth ramp into single regions — they trace
      // as one shape with one fitted gradient instead of a patchwork of flat bands.
      postProgress(0.578, 'Merging gradient bands...');
      const banded = mergeGradientBands(ridged, origWidth, origHeight, processedData, finalPalette);
      // COVERAGE pass: any region still below the tracer's floor after
      // thin-linking never got chained, and the tracer would drop it — leaving
      // an uncovered hole in the plane tiling, visible as tiny white specks.
      // Absorb those into their dominant neighbour regardless of contrast.
      // The floor here must match the tracer's NATIVE-equivalent drop size
      // exactly (not nativeFloor, which is slightly larger — using it absorbed
      // high-contrast detail that was tracing fine).
      const coverageFloor = Math.max(2, Math.round(origWidth * origHeight * 3e-6));
      const mergedLabels = consolidateRegions(banded.labels, origWidth, origHeight, finalPalette, 0, coverageFloor, false);

      // Truer fills: recompute each palette entry as the mean of its actual pixels.
      // Uses the PRE-merge labels: band merging pools multi-shade pixels under one
      // label, which would pollute that label's flat colour for the small
      // components elsewhere that still rely on it (merged unions take gradients).
      const displayPalette = refreshPaletteFromLabels(nativeLabels, processedData, finalPalette, origWidth, origHeight);

      // Legacy silhouette mask only as a FALLBACK when no confident border-dominant
      // background exists (e.g. full-bleed art) — the label-level removal above is
      // strictly better when it applies.
      const foregroundMask: Uint8Array | null = removeBackground && !bgRemoved ? createForegroundMask(processedImgDataObj, 4) : null;
      let finalMask: Uint8Array | null = null;
      if (transparencyMask && foregroundMask) {
        finalMask = new Uint8Array(transparencyMask.length);
        for (let i = 0; i < finalMask.length; i++) finalMask[i] = (transparencyMask[i] === 1 && foregroundMask[i] === 1) ? 1 : 0;
      } else {
        finalMask = transparencyMask || foregroundMask || null;
      }

      // Upscale the LABEL map (nearest, cheap) so boundaries are traced at higher
      // resolution for smoother curves, while the quantisation stays crisp.
      const scaleFactor = qualityLevel === 'detailed' ? 4 : qualityLevel === 'high' ? 3 : qualityLevel === 'balanced' ? 2 : 1;
      let workingWidth = origWidth;
      let workingHeight = origHeight;
      let traceLabels = mergedLabels;
      if (scaleFactor > 1) {
        postProgress(0.58, 'Upscaling for smooth curves...');
        traceLabels = upscaleLabelsBilinear(mergedLabels, origWidth, origHeight, scaleFactor);
        if (finalMask) finalMask = upscaleMask(finalMask, origWidth, origHeight, scaleFactor);
        workingWidth = origWidth * scaleFactor;
        workingHeight = origHeight * scaleFactor;
        // One gated majority pass re-absorbs thin intermediate-shade slivers along
        // edges (bilinear upscaling already positions boundaries sub-pixel, so the
        // second pass NN needed is gone). Contrast-gated via the palette so it
        // can't nibble thin high-contrast outlines.
        traceLabels = denoiseQuantized(traceLabels, workingWidth, workingHeight, 1, finalPalette);
      }

      postProgress(0.6, 'Tracing shapes...');
      const selectedSet = new Set(selectedColors);
      // Drop sub-perceptual speckle regions (anti-alias dust along edges). Keyed to a
      // fraction of the working area so it stays resolution-adaptive. Set BELOW the
      // coverage floor (×0.75) so every region the coverage pass kept definitely
      // traces — bilinear upscaling wobbles a region's working-res pixel count by a
      // few percent, and a region that survives coverage but drops at trace would
      // leave an uncovered white speck.
      const traceMinArea = Math.max(2, Math.round(workingWidth * workingHeight * 3e-6 * 0.75));
      const pathData = traceAllColors(
        traceLabels,
        workingWidth,
        workingHeight,
        displayPalette,   // true per-label mean colours for the fills
        selectedSet,
        smoothness,
        traceMinArea,
        (p) => postProgress(0.6 + p * 0.3, 'Tracing shapes...'),
        qualityLevel,
        finalMask,
        true,          // mergeNeighbors
        scaleFactor,   // scale RDP tolerance to the upscaled trace resolution
        processedData, // native-res image → per-shape linearGradient fitting
        origWidth,
        origHeight
      );

      postProgress(0.95, 'Generating SVG...');
      // When the label-level removal ran, the background simply isn't in the shape
      // set any more — use standard mode. The generateSvg remove-bg branch (drop
      // dominant-colour shapes) is only for the legacy fallback; running it on top
      // of label-level removal would misclassify some other edge-touching colour
      // as "the background" and drop real content.
      const svgContent = generateSvg(pathData, origWidth, origHeight, removeBackground && !bgRemoved, scaleFactor, hasTransparentSource);

      self.postMessage({
        type: 'complete',
        palette: displayPalette,
        pathData,
        svgContent,
        width: origWidth,
        height: origHeight
      } as WorkerResponse);
    }
  } catch (error) {
    console.error('Worker error:', error);
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Unknown error' } as WorkerResponse);
  }
};

export {};
