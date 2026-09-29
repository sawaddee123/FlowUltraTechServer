import fs from 'fs';
import { findPosition, findPositionDetails } from '../dist/ml/slide.js';

async function run() {
  const html = fs.readFileSync('D:/Script/Test/FlowUltraTech/extracted_sources/CaptchaJigsaw.html', 'utf8');
  const bgMatch = html.match(/id="captcha-verify-image"\s+src="data:image\/webp;base64,([^"]+)"/);
  const buf = Buffer.from(bgMatch[1], 'base64');

  const pos = await findPosition(buf);
  const det = await findPositionDetails(buf);

  console.log('findPosition:', pos);
  console.log('findPositionDetails:', JSON.stringify(det, null, 2));
}

run().catch(console.error);
