export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ColorPalette {
  colors: Color[];
  selected: Set<number>;
}

export interface Point {
  x: number;
  y: number;
}

export interface ShapeData {
  path: string;
  color: Color;
  area: number;
  isBackground: boolean;
}

export type QualityLevel = 'fast' | 'balanced' | 'high' | 'detailed';

export interface ConversionSettings {
  colorCount: number;
  smoothness: number;
  minArea: number;
  removeBackground: boolean;    // Actively detect and remove background shapes
  hasTransparentSource: boolean; // Source image has transparency - don't add bg rect
  selectedColors: Set<number>;
  qualityLevel: QualityLevel;
}

export interface ConversionProgress {
  stage: 'idle' | 'loading' | 'quantizing' | 'tracing' | 'complete';
  progress: number;
  message: string;
}

export interface ImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
