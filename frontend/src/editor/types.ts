// Core data model for the layered studio editor.
//
// Layers use a shared center-based Transform so raster and text layers get the
// same handle math, hit-testing and flatten path. Raster bitmaps live in the
// bitmapRegistry (real <canvas> elements), NOT in this state — layers only
// carry their intrinsic pixel size.

export interface Transform {
  cx: number;          // layer center, document px
  cy: number;
  scaleX: number;
  scaleY: number;
  rotation: number;    // degrees, about the center
}

interface LayerBase {
  id: string;          // crypto.randomUUID(); also used as the server-side bitmap filename stem
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;     // 0..1
  transform: Transform;
}

export interface RasterLayer extends LayerBase {
  type: 'raster';
  pixelWidth: number;  // intrinsic bitmap size (registry canvas size)
  pixelHeight: number;
  bitmapUrl?: string;  // server copy of the bitmap, set after a save round-trip
}

export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;        // \n = line break; no wrapping box
  fontFamily: string;
  fontSize: number;    // document px
  fontWeight: 400 | 700;
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;  // multiplier
}

export type Layer = RasterLayer | TextLayer;

export interface EditorDoc {
  version: 1;
  width: number;               // document px = base generation size
  height: number;
  baseGenerationId: number | null;
}

export type Tool =
  | 'select' | 'pan'
  | 'brush' | 'eraser'
  | 'line' | 'rect' | 'ellipse'
  | 'text' | 'picker';

export type AiScope = 'image' | 'layer' | 'all-layers' | 'new-layer';

/** Pixels of a sub-rect of a layer bitmap, for undo/redo of paint operations. */
export interface RectSnapshot {
  x: number;
  y: number;
  data: ImageData;
}

export type HistoryEntry =
  | { kind: 'layer-props'; layerId: string; before: Partial<Layer>; after: Partial<Layer> }
  | { kind: 'reorder'; layerId: string; from: number; to: number }
  | { kind: 'add-layer'; layer: Layer; index: number; bitmap?: ImageData }
  | { kind: 'remove-layer'; layer: Layer; index: number; bitmap?: ImageData }
  | { kind: 'bitmap'; layerId: string; before: RectSnapshot; after: RectSnapshot }
  | { kind: 'batch'; entries: HistoryEntry[] };

/** Wire shape stored in editor_documents.doc_json. The server treats it as
 *  opaque except layers[].id and layers[].bitmap_url, which it owns. */
export interface SerializedDoc {
  version: 1;
  width: number;
  height: number;
  base_generation_id: number | null;
  layers: SerializedLayer[];
}

export type SerializedLayer =
  | ({ type: 'raster'; bitmap_url?: string; pixelWidth: number; pixelHeight: number } & SerializedLayerBase)
  | ({ type: 'text' } & Pick<TextLayer, 'text' | 'fontFamily' | 'fontSize' | 'fontWeight' | 'italic' | 'color' | 'align' | 'lineHeight'> & SerializedLayerBase);

interface SerializedLayerBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  transform: Transform;
}

export interface Point {
  x: number;
  y: number;
}
