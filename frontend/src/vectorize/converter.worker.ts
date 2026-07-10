// Web Worker for image conversion - Simple reliable vectorization

import type { Color, ShapeData } from './types';
import { medianCutQuantization, quantizeImage, preprocessImage, adaptiveClean, createForegroundMask, mergeSimilarColors, createTransparencyMask, upscaleMask, denoiseQuantized, consolidateRegions, mergeInkColors, refineLabelsMRF, refreshPaletteFromLabels, computeLambdaMap } from './colorQuantization';
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

// Nearest-neighbour upscale of a label map — preserves crisp quantised edges so we
// can trace boundaries at higher resolution (smoother curves) without re-softening.
function upscaleLabels(labels: Uint8Array, w: number, h: number, sf: number): Uint8Array {
  const nw = w * sf, nh = h * sf;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = (y / sf) | 0;
    for (let x = 0; x < nw; x++) out[y * nw + x] = labels[sy * w + ((x / sf) | 0)];
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

      // Truer fills: recompute each palette entry as the mean of its actual pixels
      // now that merging/consolidation has settled the label map.
      const displayPalette = refreshPaletteFromLabels(nativeLabels, processedData, finalPalette);

      // Background / transparency masks (at native res).
      const foregroundMask: Uint8Array | null = removeBackground ? createForegroundMask(processedImgDataObj, 4) : null;
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
      let traceLabels = nativeLabels;
      if (scaleFactor > 1) {
        postProgress(0.58, 'Upscaling for smooth curves...');
        traceLabels = upscaleLabels(nativeLabels, origWidth, origHeight, scaleFactor);
        if (finalMask) finalMask = upscaleMask(finalMask, origWidth, origHeight, scaleFactor);
        workingWidth = origWidth * scaleFactor;
        workingHeight = origHeight * scaleFactor;
        // Two majority passes on the upscaled labels round off the nearest-neighbour
        // stair-steps and re-absorb thin intermediate-shade slivers along edges, so
        // boundaries trace as clean lines instead of patchy/wavy ones. Contrast-gated
        // (via the palette) so it can't nibble thin high-contrast outlines.
        traceLabels = denoiseQuantized(traceLabels, workingWidth, workingHeight, 2, finalPalette);
      }

      postProgress(0.6, 'Tracing shapes...');
      const selectedSet = new Set(selectedColors);
      // Drop sub-perceptual speckle regions (anti-alias dust along edges). Keyed to a
      // fraction of the working area so it stays resolution-adaptive: aggressive on the
      // high-res AI-upscaled trace (~4096px, where speckle explodes) and gentle on
      // low-res sources. ~5e-6 ≈ a 4-5px blob at native res; verified not to touch the
      // cup/text on the test logo while cutting shape count (and file size) ~half.
      const traceMinArea = Math.max(2, Math.round(workingWidth * workingHeight * 5e-6));
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
        scaleFactor    // scale RDP tolerance to the upscaled trace resolution
      );

      postProgress(0.95, 'Generating SVG...');
      const svgContent = generateSvg(pathData, origWidth, origHeight, removeBackground, scaleFactor, hasTransparentSource);

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
