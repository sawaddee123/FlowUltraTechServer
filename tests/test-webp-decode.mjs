import fs from 'fs';
import { decodeBase64Image } from '../dist/utils/image.js';

// Read real WebP captcha from CaptchaSymbol2.html
const html = fs.readFileSync('d:/Script/Test/TiktokStudioSandbox/extracted_sources/CaptchaSymbol2.html', 'utf8');
const match = html.match(/src="(data:image\/webp;base64,[^"]+)"/);

if (!match) {
  console.error('Failed to find WebP captcha in CaptchaSymbol2.html');
  process.exit(1);
}

const dataUrl = match[1];
console.log('Found WebP data URL, length:', dataUrl.length);

const result = decodeBase64Image(dataUrl);
if (!result.ok) {
  console.error('Decode failed:', result.message);
  process.exit(1);
}

const buffer = result.buffer;
console.log('Decoded buffer length:', buffer.length);

// Check RIFF and WEBP signatures
const riff = buffer.subarray(0, 4).toString('ascii');
const webp = buffer.subarray(8, 12).toString('ascii');
console.log('Magic Header:', riff, webp);

if (riff === 'RIFF' && webp === 'WEBP' && buffer.length > 1000) {
  console.log('✅ PASS: WebP decoding from real TikTok CaptchaSymbol2 works perfectly!');
} else {
  console.error('❌ FAIL: Invalid WebP header or length');
  process.exit(1);
}
