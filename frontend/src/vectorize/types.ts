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

// Colour ramp fitted to a shape's underlying pixels. Coordinates are in the
// OUTPUT viewBox (native) space. `stops` (t ascending in [0,1]) carry the 1-D
// colour profile — more than two stops when the ramp is curved (specular
// sheens). Exactly one of `linear` (axis endpoints) or `radial` (glow centre +
// radius) is set, whichever profile model explained the shape's pixels better.
export interface ShapeGradient {
  stops: Array<{ t: number; c: Color }>;
  linear?: { x1: number; y1: number; x2: number; y2: number };
  radial?: { cx: number; cy: number; r: number };
}

export interface ShapeData {
  path: string;          // outer contour + any enclosed-hole subpaths
  color: Color;          // the LABEL colour — identity for grouping/background logic
  fillColor?: Color;     // this component's own (interior) mean — truer local paint
  area: number;
  isBackground: boolean;
  hasHoles?: boolean;    // true → path has hole subpaths and needs fill-rule=evenodd
  gradient?: ShapeGradient; // present → fill with a gradient instead of the flat colour
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
