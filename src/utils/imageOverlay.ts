import sharp from "sharp";

export interface OverlayOptions {
  captchaType: "slide" | "symbol";
  status?: string;
  result?: {
    position?: number[];
    targetX?: number;
    symbolPositions?: number[][];
    rawPosition?: number[];
    rawSymbolPositions?: number[][];
    scaleX?: number;
    scaleY?: number;
    holeBox?: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
      height: number;
    };
    success?: boolean;
  };
  imageWidth?: number;
  imageHeight?: number;
}

/**
 * Composites solved position markers (slide hole target box, drag line, symbol points)
 * directly onto a captcha image buffer using Sharp and vector SVG.
 */
export const renderOverlayOnImage = async (
  imageBuffer: Buffer,
  options: OverlayOptions
): Promise<Buffer> => {
  const meta = await sharp(imageBuffer).metadata();
  const width = meta.width || options.imageWidth || 640;
  const height = meta.height || options.imageHeight || 360;

  const status = options.status || "CALCULATED";
  const isSuccess = options.result?.success || status === "VERIFIED_SUCCESS";
  const isFailed = status === "VERIFIED_FAILED";

  // Color theme: Emerald for TikTok verified success, Rose for failed, Cyan for calculated
  const primaryColor = isSuccess ? "#10B981" : isFailed ? "#F43F5E" : "#06B6D4";
  const secondaryColor = isSuccess ? "#059669" : isFailed ? "#E11D48" : "#0891B2";
  const fillBg = isSuccess
    ? "rgba(16, 185, 129, 0.22)"
    : isFailed
    ? "rgba(244, 63, 94, 0.22)"
    : "rgba(6, 182, 212, 0.22)";

  let svgElements = "";

  if (options.captchaType === "slide") {
    const scaleX = options.result?.scaleX && options.result.scaleX > 0 ? options.result.scaleX : 1;
    const scaleY = options.result?.scaleY && options.result.scaleY > 0 ? options.result.scaleY : 1;

    let targetX = 0;
    let centerY = height / 2;

    if (options.result?.rawPosition && options.result.rawPosition.length >= 2) {
      targetX = options.result.rawPosition[0] ?? 0;
      centerY = options.result.rawPosition[1] ?? height / 2;
    } else if (options.result?.position && options.result.position.length >= 2) {
      targetX = (options.result.position[0] ?? 0) / scaleX;
      centerY = (options.result.position[1] ?? height / 2) / scaleY;
    } else if (typeof options.result?.targetX === "number") {
      targetX = options.result.targetX / scaleX;
    }

    let boxX = targetX;
    let boxY = centerY - 35;
    let boxW = 70;
    let boxH = 70;

    if (options.result?.holeBox) {
      const hb = options.result.holeBox;
      boxX = hb.x1;
      boxY = hb.y1;
      boxW = hb.width;
      boxH = hb.height;
      centerY = (hb.y1 + hb.y2) / 2;
      targetX = hb.x1;
    } else {
      // Estimate hole dimensions if not recorded
      boxW = Math.max(50, Math.round(width * 0.16));
      boxH = boxW;
      boxX = targetX;
      boxY = Math.max(10, Math.min(height - boxH - 10, centerY - boxH / 2));
    }

    const badgeY = Math.max(8, boxY - 26);
    const badgeText = `🎯 TARGET [X: ${Math.round(targetX)}, Y: ${Math.round(centerY)}]`;

    svgElements = `
      <!-- Slide Track Line from Left -->
      <line x1="12" y1="${centerY}" x2="${Math.max(12, boxX)}" y2="${centerY}"
            stroke="${primaryColor}" stroke-width="3" stroke-dasharray="6,4" marker-end="url(#arrow)" opacity="0.9" />

      <!-- Ghost Start Piece on Left -->
      <rect x="8" y="${boxY}" width="${boxW}" height="${boxH}" rx="8"
            fill="none" stroke="${primaryColor}" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.5" />

      <!-- Target Placement Box -->
      <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="8"
            fill="${fillBg}" stroke="${primaryColor}" stroke-width="3" filter="url(#glow)" />

      <!-- Corner Brackets -->
      <path d="M ${boxX} ${boxY + 16} L ${boxX} ${boxY} L ${boxX + 16} ${boxY}" fill="none" stroke="#FFFFFF" stroke-width="3" />
      <path d="M ${boxX + boxW - 16} ${boxY} L ${boxX + boxW} ${boxY} L ${boxX + boxW} ${boxY + 16}" fill="none" stroke="#FFFFFF" stroke-width="3" />
      <path d="M ${boxX} ${boxY + boxH - 16} L ${boxX} ${boxY + boxH} L ${boxX + 16} ${boxY + boxH}" fill="none" stroke="#FFFFFF" stroke-width="3" />
      <path d="M ${boxX + boxW - 16} ${boxY + boxH} L ${boxX + boxW} ${boxY + boxH} L ${boxX + boxW} ${boxY + boxH - 16}" fill="none" stroke="#FFFFFF" stroke-width="3" />

      <!-- Center Crosshair Reticle -->
      <circle cx="${boxX + boxW / 2}" cy="${centerY}" r="4" fill="${primaryColor}" />
      <circle cx="${boxX + boxW / 2}" cy="${centerY}" r="14" fill="none" stroke="${primaryColor}" stroke-width="1.5" />

      <!-- Coordinate Badge -->
      <g transform="translate(${Math.max(10, Math.min(width - 190, boxX))}, ${badgeY})">
        <rect width="180" height="22" rx="5" fill="#09090b" fill-opacity="0.92" stroke="${primaryColor}" stroke-width="1.5" />
        <text x="10" y="15" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="11" font-weight="700" fill="#FFFFFF">${badgeText}</text>
      </g>
    `;
  } else if (options.captchaType === "symbol") {
    const scaleX = options.result?.scaleX && options.result.scaleX > 0 ? options.result.scaleX : 1;
    const scaleY = options.result?.scaleY && options.result.scaleY > 0 ? options.result.scaleY : 1;

    let points: number[][] = [];
    if (Array.isArray(options.result?.rawSymbolPositions) && options.result.rawSymbolPositions.length > 0) {
      points = options.result.rawSymbolPositions;
    } else if (Array.isArray(options.result?.symbolPositions) && options.result.symbolPositions.length > 0) {
      points = options.result.symbolPositions.map((p) => [
        (p[0] ?? 0) / scaleX,
        (p[1] ?? 0) / scaleY,
      ]);
    }

    if (points.length >= 2) {
      const p1 = points[0]!;
      const p2 = points[1]!;

      svgElements = `
        <!-- Connecting Line from Point 1 to Point 2 -->
        <line x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}"
              stroke="#FACC15" stroke-width="2.5" stroke-dasharray="6,4" marker-end="url(#arrow-yellow)" opacity="0.95" />
      `;
    }

    points.forEach((pt, idx) => {
      const px = pt[0] ?? 0;
      const py = pt[1] ?? 0;
      const color = idx === 0 ? "#F59E0B" : "#06B6D4";
      const num = idx + 1;
      const badgeY = Math.max(10, py - 32);

      svgElements += `
        <!-- Symbol Marker ${num} -->
        <circle cx="${px}" cy="${py}" r="22" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.5" filter="url(#glow)" />
        <circle cx="${px}" cy="${py}" r="15" fill="${color}" stroke="#FFFFFF" stroke-width="2" />
        <text x="${px}" y="${py + 5}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="13" font-weight="900" fill="#000000">${num}</text>

        <!-- Reticle Crosshair -->
        <line x1="${px - 26}" y1="${py}" x2="${px - 17}" y2="${py}" stroke="${color}" stroke-width="2" />
        <line x1="${px + 17}" y1="${py}" x2="${px + 26}" y2="${py}" stroke="${color}" stroke-width="2" />
        <line x1="${px}" y1="${py - 26}" x2="${px}" y2="${py - 17}" stroke="${color}" stroke-width="2" />
        <line x1="${px}" y1="${py + 17}" x2="${px}" y2="${py + 26}" stroke="${color}" stroke-width="2" />

        <!-- Marker Badge -->
        <g transform="translate(${Math.max(10, Math.min(width - 130, px - 60))}, ${badgeY})">
          <rect width="120" height="20" rx="4" fill="#09090b" fill-opacity="0.92" stroke="${color}" stroke-width="1.2" />
          <text x="8" y="14" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="10" font-weight="700" fill="#FFFFFF">#${num} [${Math.round(px)}, ${Math.round(py)}]</text>
        </g>
      `;
    });
  }

  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="${primaryColor}" />
        </marker>
        <marker id="arrow-yellow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#FACC15" />
        </marker>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="${primaryColor}" flood-opacity="0.8"/>
        </filter>
      </defs>
      ${svgElements}
    </svg>
  `;

  return sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
};
