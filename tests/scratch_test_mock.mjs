import fs from 'fs';
import ort from 'onnxruntime-node';
import sharp from 'sharp';

const MODEL_FILE = 'models/jigsaw-model.onnx';
const INPUT_SIZE = 320;
const CONF_THRESHOLD = 0.5;

async function preprocess(imageInput) {
  const meta = await sharp(imageInput).metadata();
  const origW = meta.width;
  const origH = meta.height;

  const scale = Math.min(INPUT_SIZE / origW, INPUT_SIZE / origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);
  const padX = (INPUT_SIZE - newW) / 2;
  const padY = (INPUT_SIZE - newH) / 2;

  const resized = await sharp(imageInput)
    .resize(newW, newH)
    .extend({
      top: Math.floor(padY),
      bottom: Math.ceil(padY),
      left: Math.floor(padX),
      right: Math.ceil(padX),
      background: { r: 114, g: 114, b: 114 },
    })
    .raw()
    .toBuffer();

  const floatData = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < pixelCount; i++) {
    floatData[i] = resized[i * 3] / 255.0;
    floatData[pixelCount + i] = resized[i * 3 + 1] / 255.0;
    floatData[2 * pixelCount + i] = resized[i * 3 + 2] / 255.0;
  }

  return { data: floatData, scale, padX: Math.floor(padX), padY: Math.floor(padY), origW, origH };
}

async function run() {
  const html = fs.readFileSync('D:/Script/Test/FlowUltraTech/docs/mocks/mock_captcha_jigsaw.html', 'utf8');
  const bgMatch = html.match(/id="jigsaw-bg-img"[^>]+src="data:image\/jpeg;base64,([^"]+)"/);

  if (!bgMatch) {
    console.log('Not found');
    return;
  }
  const bgBuf = Buffer.from(bgMatch[1], 'base64');
  const letterbox = await preprocess(bgBuf);

  const session = await ort.InferenceSession.create(MODEL_FILE);
  const inputName = session.inputNames[0];
  const tensor = new ort.Tensor("float32", letterbox.data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const result = await session.run({ [inputName]: tensor });
  const out = result[session.outputNames[0]];
  const data = out.data;
  const [batch, numChannels, numBoxes] = out.dims;
  const numClasses = numChannels - 4;

  const boxes = [];
  for (let i = 0; i < numBoxes; i++) {
    let maxScore = -Infinity;
    let cls = -1;
    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * numBoxes + i];
      if (score > maxScore) {
        maxScore = score;
        cls = c;
      }
    }
    if (maxScore < CONF_THRESHOLD) continue;

    const cx = data[0 * numBoxes + i];
    const cy = data[1 * numBoxes + i];
    const w = data[2 * numBoxes + i];
    const h = data[3 * numBoxes + i];

    const x1 = (cx - w / 2 - letterbox.padX) / letterbox.scale;
    const y1 = (cy - h / 2 - letterbox.padY) / letterbox.scale;
    const x2 = (cx + w / 2 - letterbox.padX) / letterbox.scale;
    const y2 = (cy + h / 2 - letterbox.padY) / letterbox.scale;

    boxes.push({ x1, y1, x2, y2, width: x2 - x1, height: y2 - y1, center: (x1 + x2) / 2, conf: maxScore, cls });
  }

  console.log('Mock image detected boxes:', JSON.stringify(boxes, null, 2));
}

run().catch(console.error);
