import { useState, useCallback, useRef, useEffect } from 'react';
import type { Color, ConversionProgress, ConversionSettings, ShapeData } from './types';
import ConverterWorker from './converter.worker?worker';
import { optimizeSvg } from './svgOptimizer';

interface UseImageConverterReturn {
  palette: Color[];
  pathData: ShapeData[];
  svgContent: string;
  progress: ConversionProgress;
  processImage: (imageData: ImageData, settings: ConversionSettings) => void;
  regenerateSvg: (settings: ConversionSettings) => void;
  updateColor: (index: number, color: Color) => void;
}

export function useVectorizer(): UseImageConverterReturn {
  const [palette, setPalette] = useState<Color[]>([]);
  const [pathData, setPathData] = useState<ShapeData[]>([]);
  const [svgContent, setSvgContent] = useState<string>('');
  const [progress, setProgress] = useState<ConversionProgress>({
    stage: 'idle',
    progress: 0,
    message: 'Ready'
  });

  // Store for regeneration
  const quantizedDataRef = useRef<number[] | null>(null);
  const imageDimensionsRef = useRef<{ width: number; height: number } | null>(null);
  const workerRef = useRef<Worker | null>(null);

  // Initialize worker
  useEffect(() => {
    workerRef.current = new ConverterWorker();

    workerRef.current.onmessage = (e) => {
      const data = e.data;

      switch (data.type) {
        case 'progress':
          setProgress({
            stage: data.progress < 0.4 ? 'quantizing' : 'tracing',
            progress: data.progress,
            message: data.message
          });
          break;

        case 'palette':
          setPalette(data.palette);
          break;

        case 'complete':
          if (data.palette) setPalette(data.palette);
          if (data.quantizedData) quantizedDataRef.current = data.quantizedData;
          if (data.width && data.height) {
            imageDimensionsRef.current = { width: data.width, height: data.height };
          }
          if (data.pathData) setPathData(data.pathData);
          if (data.svgContent) {
            // Optimize SVG on conversion for smaller size and faster editor
            const optimized = optimizeSvg(data.svgContent, {
              precision: 0,
              minify: false  // Keep readable for editor
            });
            setSvgContent(optimized);
          }
          setProgress({
            stage: 'complete',
            progress: 1,
            message: 'Conversion complete!'
          });
          break;

        case 'error':
          setProgress({
            stage: 'idle',
            progress: 0,
            message: `Error: ${data.message}`
          });
          break;
      }
    };

    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const processImage = useCallback((
    imageData: ImageData,
    settings: ConversionSettings
  ) => {
    if (!workerRef.current) return;

    setProgress({
      stage: 'loading',
      progress: 0,
      message: 'Starting conversion...'
    });

    // Pass ImageData buffer directly (efficient copy)
    workerRef.current.postMessage({
      type: 'process',
      imageData: {
        width: imageData.width,
        height: imageData.height,
        data: imageData.data
      },
      settings: {
        colorCount: settings.colorCount,
        smoothness: settings.smoothness,
        minArea: settings.minArea,
        removeBackground: settings.removeBackground,
        hasTransparentSource: settings.hasTransparentSource,
        selectedColors: Array.from(settings.selectedColors),
        qualityLevel: settings.qualityLevel
      }
    });
  }, []);

  const regenerateSvg = useCallback((settings: ConversionSettings) => {
    if (!workerRef.current || !quantizedDataRef.current || !imageDimensionsRef.current) return;

    setProgress({
      stage: 'tracing',
      progress: 0.4,
      message: 'Regenerating with selected colors...'
    });

    workerRef.current.postMessage({
      type: 'regenerate',
      imageData: {
        width: imageDimensionsRef.current.width,
        height: imageDimensionsRef.current.height,
        data: new Uint8ClampedArray(0)
      },
      settings: {
        colorCount: settings.colorCount,
        smoothness: settings.smoothness,
        minArea: settings.minArea,
        removeBackground: settings.removeBackground,
        hasTransparentSource: settings.hasTransparentSource,
        selectedColors: Array.from(settings.selectedColors),
        qualityLevel: settings.qualityLevel
      },
      palette,
      quantizedData: quantizedDataRef.current
    });
  }, [palette]);

  const updateColor = useCallback((index: number, color: Color) => {
    setPalette(prev => {
      const newPalette = [...prev];
      if (index >= 0 && index < newPalette.length) {
        newPalette[index] = color;
      }
      return newPalette;
    });
  }, []);

  return {
    palette,
    pathData,
    svgContent,
    progress,
    processImage,
    regenerateSvg,
    updateColor
  };
}
