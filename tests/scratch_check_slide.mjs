import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { findPosition } from '../dist/ml/slide.js';

async function test() {
  const htmlPath = 'd:/Script/Test/FlowUltraTech/docs/mocks/mock_captcha_jigsaw.html';
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/id="captcha-verify-image"[^>]+src="data:image\/[^;]+;base64,([^"]+)"/);
  if (!match) {
    console.log('No image found in mock HTML');
    return;
  }
  const buf = Buffer.from(match[1], 'base64');
  const meta = await sharp(buf).metadata();
  console.log('Mock Image Dimensions:', meta.width, 'x', meta.height);

  const pos = await findPosition(buf);
  console.log('findPosition on Mock Image:', pos);

  // Also check CaptchaJigsaw.html from extracted_sources
  const realHtmlPath = 'd:/Script/Test/FlowUltraTech/extracted_sources/CaptchaJigsaw.html';
  if (fs.existsSync(realHtmlPath)) {
    const realHtml = fs.readFileSync(realHtmlPath, 'utf8');
    const realMatch = realHtml.match(/id="captcha-verify-image"[^>]+src="data:image\/[^;]+;base64,([^"]+)"/);
    if (realMatch) {
      const realBuf = Buffer.from(realMatch[1], 'base64');
      const realMeta = await sharp(realBuf).metadata();
      console.log('Real CaptchaJigsaw Image Dimensions:', realMeta.width, 'x', realMeta.height);
      const realPos = await findPosition(realBuf);
      console.log('findPosition on Real CaptchaJigsaw Image:', realPos);
    }
  }
  process.exit(0);
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});
