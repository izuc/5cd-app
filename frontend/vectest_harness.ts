// TEMP vectoriser visual-test harness (not committed).
import { readFileSync, writeFileSync } from 'fs';
import { PNG } from 'pngjs';
import { Resvg } from '@resvg/resvg-js';
import {
  medianCutQuantization, quantizeImage, preprocessImage, adaptiveClean, mergeSimilarColors,
} from './src/vectorize/colorQuantization';
import { traceAllColors, generateSvg } from './src/vectorize/pathTracing';

type Q = 'fast' | 'balanced' | 'high' | 'detailed';
function upscaleLabels(labels: Uint8Array, w: number, h: number, sf: number): Uint8Array {
  const nw = w * sf, nh = h * sf;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) { const sy = (y / sf) | 0; for (let x = 0; x < nw; x++) out[y * nw + x] = labels[sy * w + ((x / sf) | 0)]; }
  return out;
}
const inPath = process.argv[2], outPath = process.argv[3];
const quality = (process.argv[4] || 'high') as Q;
const colorCount = parseInt(process.argv[5] || '16', 10);
const smoothness = parseFloat(process.argv[6] || '5');
const removeBg = process.argv[7] === 'rmbg';

const png = PNG.sync.read(readFileSync(inPath));
const W = png.width, H = png.height;
const img = { width: W, height: H, data: new Uint8ClampedArray(png.data), colorSpace: 'srgb' } as ImageData;
const processed = preprocessImage(img);
const pObj = { width: W, height: H, data: processed, colorSpace: 'srgb' } as ImageData;
const pal = medianCutQuantization(pObj, colorCount);
let q = quantizeImage(pObj, pal);
q = adaptiveClean(q, W, H, colorCount, Math.max(8, 20), 'detailed');
const merged = mergeSimilarColors(pal, q, quality === 'detailed' ? 4 : quality === 'high' ? 6 : 8);
const sf = quality === 'detailed' ? 4 : quality === 'high' ? 3 : quality === 'balanced' ? 2 : 1;
let labels = merged.quantized, ww = W, wh = H;
if (sf > 1) { labels = upscaleLabels(merged.quantized, W, H, sf); ww = W * sf; wh = H * sf; }
const paths = traceAllColors(labels, ww, wh, merged.palette, new Set<number>(), smoothness, 0, () => {}, quality, null);
const svg = generateSvg(paths, W, H, removeBg, sf, false);
writeFileSync(outPath.replace(/\.png$/, '.svg'), svg);
const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: W }, background: 'rgba(255,255,255,0)' }).render().asPng();
writeFileSync(outPath, rendered);
const hasRect = /<rect id="background"/.test(svg);
console.log(`shapes=${paths.length} svgBytes=${svg.length} bgRect=${hasRect} (q=${quality} colors=${colorCount} rmbg=${removeBg})`);
