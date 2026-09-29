import fs from 'fs';
import sharp from 'sharp';

async function checkPiece() {
  const html = fs.readFileSync('D:/Script/Test/FlowUltraTech/extracted_sources/CaptchaJigsaw.html', 'utf8');
  const pieceMatch = html.match(/<img alt="Captcha"[^>]+src="data:image\/webp;base64,([^"]+)"/);

  if (!pieceMatch) {
    console.log('Piece not found');
    return;
  }
  const pieceBuf = Buffer.from(pieceMatch[1], 'base64');
  const { data, info } = await sharp(pieceBuf).raw().toBuffer({ resolveWithObject: true });
  console.log(`Piece info: ${info.width}x${info.height}, channels: ${info.channels}`);

  // Find non-transparent bounding box of piece
  let minX = info.width, maxX = 0, minY = info.height, maxY = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * info.channels;
      const alpha = info.channels === 4 ? data[idx + 3] : 255;
      if (alpha > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  console.log(`Non-transparent piece bounds in 110x110 tile:`);
  console.log(`minX: ${minX}, maxX: ${maxX}, width: ${maxX - minX + 1}`);
  console.log(`minY: ${minY}, maxY: ${maxY}, height: ${maxY - minY + 1}`);
  console.log(`Piece center in 110x110 tile: ${(minX + maxX) / 2}`);
}

checkPiece().catch(console.error);
