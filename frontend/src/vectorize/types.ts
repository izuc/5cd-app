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

// Linear colour ramp fitted to a shape's underlying pixels. Coordinates are in
// the OUTPUT viewBox (native) space; endpoints are the ramp's extreme points.
export interface ShapeGradient {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  c0: Color;
  c1: Color;
}

export interface ShapeData {
  path: string;          // outer contour + any enclosed-hole subpaths
  color: Color;
  area: number;
  isBackground: boolean;
  hasHoles?: boolean;    // true → path has hole subpaths and needs fill-rule=evenodd
  gradient?: ShapeGradient; // present → fill with a linearGradient instead of the flat colour
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
