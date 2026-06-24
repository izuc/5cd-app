import { useState, useCallback, useRef, useEffect } from 'react';
import type { Color, ConversionProgress, ConversionSettings, ShapeData } from './types';
import ConverterWorker from './converter.worker?worker';
import { optimizeSvg } from './svgOptimizer';

interface UseImageConverterReturn {
  palette: Color[];
  pathData: ShapeData[];
  svgContent: string;
  progress: ConversionProgress;
  error: string;
  processImage: (imageData: ImageData, settings: ConversionSettings) => void;
  updateColor: (index: number, color: Color) => void;
}

export function useVectorizer(): UseImageConverterReturn {
  const [palette, setPalette] = useState<Color[]>([]);
  const [pathData, setPathData] = useState<ShapeData[]>([]);
  const [svgContent, setSvgContent] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [progress, setProgress] = useState<ConversionProgress>({
    stage: 'idle',
    progress: 0,
    message: 'Ready'
  });

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
          setError(data.message || 'Vectorise failed.');
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

    setError('');
    setProgress({
      stage: 'loading',
      progress: 0,
      message: 'Starting conversion...'
    });

    // Pass ImageData buffer directly (structured-clone copy; see note below)
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
    error,
    processImage,
    updateColor
  };
}
