// Web Worker for image conversion - Simple reliable vectorization

import type { Color, ShapeData } from './types';
import { medianCutQuantization, quantizeImage, preprocessImage, adaptiveClean, createForegroundMask, mergeSimilarColors, createTransparencyMask, upscaleMask } from './colorQuantization';
import { traceAllColors, generateSvg } from './pathTracing';

type QualityLevel = 'fast' | 'balanced' | 'high' | 'detailed';

interface WorkerMessage {
  type: 'process' | 'regenerate';
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
  palette?: Color[];
  quantizedData?: Uint8Array;
}

interface WorkerResponse {
  type: 'progress' | 'palette' | 'complete' | 'error';
  progress?: number;
  message?: string;
  palette?: Color[];
  quantizedData?: number[];
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
  const { type, imageData, settings, palette, quantizedData } = e.data;

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

      // Gentle clean at native res — drop anti-alias speckles WITHOUT the heavy
      // majority/morphological erosion the old 'high' path used (which melted text).
      postProgress(0.5, 'Cleaning...');
      quantized = adaptiveClean(quantized, origWidth, origHeight, colorCount, Math.max(8, minArea), 'detailed');

      postProgress(0.55, 'Merging similar colors...');
      const mergeThreshold = qualityLevel === 'detailed' ? 4 : qualityLevel === 'high' ? 6 : 8;
      const merged = mergeSimilarColors(newPalette, quantized, mergeThreshold);
      const finalPalette = merged.palette;
      const nativeLabels = merged.quantized;

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
      }

      postProgress(0.6, 'Tracing shapes...');
      const selectedSet = new Set(selectedColors);
      const pathData = traceAllColors(
        traceLabels,
        workingWidth,
        workingHeight,
        finalPalette,
        selectedSet,
        smoothness,
        0,
        (p) => postProgress(0.6 + p * 0.3, 'Tracing shapes...'),
        qualityLevel,
        finalMask
      );

      postProgress(0.95, 'Generating SVG...');
      const svgContent = generateSvg(pathData, origWidth, origHeight, removeBackground, scaleFactor, hasTransparentSource);

      self.postMessage({
        type: 'complete',
        palette: finalPalette,
        quantizedData: Array.from(nativeLabels),
        pathData,
        svgContent,
        width: origWidth,
        height: origHeight
      } as WorkerResponse);

    } else if (type === 'regenerate' && palette && quantizedData) {
      const { smoothness, minArea, removeBackground, hasTransparentSource, selectedColors, qualityLevel = 'balanced' } = settings;

      const width = e.data.imageData?.width || 0;
      const height = e.data.imageData?.height || 0;

      postProgress(0.3, 'Regenerating...');

      let quantized = new Uint8Array(quantizedData);

      if (minArea > 0) {
        quantized = adaptiveClean(quantized, width, height, palette.length, minArea, qualityLevel) as Uint8Array;
      }

      const selectedSet = new Set(selectedColors);

      const pathData = traceAllColors(
        quantized,
        width,
        height,
        palette,
        selectedSet,
        smoothness,
        0,
        (p) => postProgress(0.3 + p * 0.6, 'Regenerating...'),
        qualityLevel,
        null
      );

      const svgContent = generateSvg(pathData, width, height, removeBackground, 1, hasTransparentSource);

      self.postMessage({ type: 'complete', pathData, svgContent } as WorkerResponse);
    }
  } catch (error) {
    console.error('Worker error:', error);
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Unknown error' } as WorkerResponse);
  }
};

export {};
