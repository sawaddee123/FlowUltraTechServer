import sharp from "sharp";
import { getSession, ort } from "./onnx.js";

const MODEL_FILE = "jigsaw-model.onnx";
const INPUT_SIZE = 320; // Changed from 640 to 320 to match model requirements
const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.45;

interface Letterbox {
  data: Float32Array;
  scale: number;
  padX: number;
  padY: number;
  origWidth: number;
  origHeight: number;
}

const preprocess = async (imageInput: string | Buffer): Promise<Letterbox> => {
  const meta = await sharp(imageInput).metadata();
  const origWidth = meta.width ?? 0;
  const origHeight = meta.height ?? 0;
  if (origWidth === 0 || origHeight === 0) {
    throw new Error("Invalid image dimensions");
  }

  const scale = Math.min(INPUT_SIZE / origWidth, INPUT_SIZE / origHeight);
  const newWidth = Math.round(origWidth * scale);
  const newHeight = Math.round(origHeight * scale);
  const padX = Math.floor((INPUT_SIZE - newWidth) / 2);
  const padY = Math.floor((INPUT_SIZE - newHeight) / 2);

  const { data } = await sharp(imageInput)
    .resize(newWidth, newHeight, { kernel: "cubic" })
    .extend({
      top: padY,
      bottom: INPUT_SIZE - newHeight - padY,
      left: padX,
      right: INPUT_SIZE - newWidth - padX,
      background: { r: 114, g: 114, b: 114 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // RGB HWC -> CHW float32 normalized to [0,1]
  const total = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(3 * total);
  for (let i = 0; i < total; i++) {
    out[i] = (data[i * 3] ?? 0) / 255;
    out[i + total] = (data[i * 3 + 1] ?? 0) / 255;
    out[i + 2 * total] = (data[i * 3 + 2] ?? 0) / 255;
  }

  return { data: out, scale, padX, padY, origWidth, origHeight };
};

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  conf: number;
  cls: number;
}

const iou = (a: Box, b: Box): number => {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
};

const nms = (boxes: Box[], iouThreshold: number): Box[] => {
  const sorted = [...boxes].sort((a, b) => b.conf - a.conf);
  const keep: Box[] = [];
  while (sorted.length > 0) {
    const top = sorted.shift()!;
    keep.push(top);
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (iou(top, sorted[i]!) > iouThreshold) sorted.splice(i, 1);
    }
  }
  return keep;
};

const parseOutput = (
  output: Float32Array,
  shape: readonly number[],
  letterbox: Letterbox,
): Box[] => {
  // Expected shape: [1, 4+nc, anchors] (YOLOv8 ONNX export)
  const features = shape[1] ?? 0;
  const anchors = shape[2] ?? 0;
  const numClasses = features - 4;
  if (numClasses <= 0) return [];

  const boxes: Box[] = [];
  for (let i = 0; i < anchors; i++) {
    let bestCls = 0;
    let bestScore = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = output[(4 + c) * anchors + i] ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestCls = c;
      }
    }
    if (bestScore < CONF_THRESHOLD) continue;

    const cx = output[i] ?? 0;
    const cy = output[anchors + i] ?? 0;
    const w = output[2 * anchors + i] ?? 0;
    const h = output[3 * anchors + i] ?? 0;

    // Undo letterbox: subtract pad, divide scale
    const x1 = (cx - w / 2 - letterbox.padX) / letterbox.scale;
    const y1 = (cy - h / 2 - letterbox.padY) / letterbox.scale;
    const x2 = (cx + w / 2 - letterbox.padX) / letterbox.scale;
    const y2 = (cy + h / 2 - letterbox.padY) / letterbox.scale;

    boxes.push({ x1, y1, x2, y2, conf: bestScore, cls: bestCls });
  }

  return nms(boxes, IOU_THRESHOLD);
};

export interface SlidePositionDetails {
  slideX: number;
  centerX: number;
  centerY: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  conf: number;
}

export const findPositionDetails = async (imageInput: string | Buffer): Promise<SlidePositionDetails | null> => {
  const session = await getSession(MODEL_FILE);
  const letterbox = await preprocess(imageInput);

  const inputName = session.inputNames[0]!;
  const tensor = new ort.Tensor("float32", letterbox.data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const result = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[0]!;
  const out = result[outputName]!;
  const data = out.data as Float32Array;

  const boxes = parseOutput(data, out.dims, letterbox);
  const cls0 = boxes.filter((b) => b.cls === 0);
  if (cls0.length === 0) return null;

  const best = cls0.reduce((a, b) => (b.conf > a.conf ? b : a));
  const w = best.x2 - best.x1;
  const h = best.y2 - best.y1;
  const cx = (best.x1 + best.x2) / 2;
  const cy = (best.y1 + best.y2) / 2;
  // Direct hole coordinate: align piece directly to detected hole position (no offset)
  const slideX = Math.max(0, best.x1);

  return {
    slideX,
    centerX: cx,
    centerY: cy,
    x1: best.x1,
    y1: best.y1,
    x2: best.x2,
    y2: best.y2,
    width: w,
    height: h,
    conf: best.conf,
  };
};

export const findPosition = async (imageInput: string | Buffer): Promise<[number, number]> => {
  const details = await findPositionDetails(imageInput);
  if (!details) return [0, 0];
  return [details.slideX, details.centerY];
};
