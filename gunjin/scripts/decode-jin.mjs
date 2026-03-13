import fs from "node:fs";
import path from "node:path";

const IMAGE_BASE_URL = "https://gunjin.amamiya-lab.net/sozai";
const EXPECTED_SIZE = 192;
const HEADER_BYTES = 96;
const COLS = 6;
const ROWS = 4;
const SLOT_NODE_IDS = [
  "A6",
  "B6",
  "C6",
  "D6",
  "E6",
  "F6",
  "A7",
  "B7",
  "C7",
  "D7",
  "E7",
  "F7",
  "A8",
  "B8",
  "C8",
  "D8",
  "E8",
  "F8",
  "A9",
  "B9",
  "HQ_P",
  null,
  "E9",
  "F9",
];
const CODE_TO_PIECE = Object.freeze({
  1: "marshal",
  2: "general",
  3: "brigadier",
  4: "colonel",
  5: "lieutenantColonel",
  6: "major",
  7: "aircraft",
  8: "tank",
  9: "flag",
  10: "spy",
  11: "mine",
  12: "engineer",
  13: "captain",
  14: "lieutenant",
  15: "secondLieutenant",
  16: "cavalry",
});

function usage() {
  console.error(
    "Usage: node scripts/decode-jin.mjs <file.jin> [--html <output.html>]",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  usage();
}

let inputPath = null;
let htmlPath = null;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--html") {
    htmlPath = args[index + 1];
    if (!htmlPath) {
      usage();
    }
    index += 1;
    continue;
  }
  if (!inputPath) {
    inputPath = arg;
    continue;
  }
  usage();
}

if (!inputPath) {
  usage();
}

const buffer = fs.readFileSync(inputPath);
if (buffer.length !== EXPECTED_SIZE) {
  console.warn(
    `Warning: expected ${EXPECTED_SIZE} bytes but got ${buffer.length} bytes.`,
  );
}

const header = buffer.subarray(0, Math.min(HEADER_BYTES, buffer.length));
const headerIsZeroFilled = header.every((value) => value === 0);
const payload = [];

for (let offset = HEADER_BYTES; offset + 4 <= buffer.length; offset += 4) {
  payload.push(buffer.readInt32LE(offset));
}

if (payload.length !== ROWS * COLS) {
  throw new Error(`Expected ${ROWS * COLS} payload slots but got ${payload.length}.`);
}

const grid = [];
for (let row = 0; row < ROWS; row += 1) {
  const start = row * COLS;
  grid.push(payload.slice(start, start + COLS));
}
const placements = {};
for (let index = 0; index < payload.length; index += 1) {
  const nodeId = SLOT_NODE_IDS[index];
  const value = payload[index];
  if (!nodeId || value === 0) {
    continue;
  }
  const pieceType = CODE_TO_PIECE[value];
  placements[nodeId] = pieceType ?? `unknown_${value}`;
}

const formatCode = (value) => {
  if (value === 0) {
    return " . ";
  }
  return `B${String(value).padStart(2, "0")}`;
};
const formatPiece = (value) => {
  if (value === 0) {
    return " . ";
  }
  return CODE_TO_PIECE[value] ?? `unknown_${value}`;
};

console.log(`File: ${inputPath}`);
console.log(`Bytes: ${buffer.length}`);
console.log(`Header: ${header.length} bytes (${headerIsZeroFilled ? "all zero" : "non-zero present"})`);
console.log("");
console.log("Grid:");
for (const row of grid) {
  console.log(row.map(formatCode).join(" "));
}
console.log("");
console.log("Mapped grid:");
for (const row of grid) {
  console.log(row.map((value) => formatPiece(value).padEnd(18, " ")).join(" "));
}
console.log("");
console.log("Raw payload:");
console.log(payload.join(","));
console.log("");
console.log("placements:");
console.log("  placements: {");
for (const nodeId of SLOT_NODE_IDS) {
  if (!nodeId || !placements[nodeId]) {
    continue;
  }
  console.log(`    ${nodeId}: "${placements[nodeId]}",`);
}
console.log("  },");
console.log("");
console.log("Notes:");
console.log("- This matches the old `通信軍人将棋` / `軍人将棋 Online` layout format.");
console.log("- The first 96 bytes are a header area (observed as zero-filled in sample files).");
console.log("- The remaining 24 little-endian int32 values are a 4x6 layout in row-major order.");
console.log("- `0` is the blank half of the HQ cell; other values map to `B01.gif` .. `B16.gif`.");
console.log("- Piece mapping is inferred from the original formation pages and the known `jin17.jin` image.");

if (htmlPath) {
  const title = path.basename(inputPath);
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --board: #f0cf1a;
      --line: #c29a00;
      --bg: #ece9e1;
      --hq: #ddd8d8;
      --text: #1e2430;
      --link: #1536c7;
    }
    body {
      margin: 0;
      font-family: "Hiragino Sans", "Yu Gothic", sans-serif;
      color: var(--text);
      background: radial-gradient(circle at top, #f7f5ef 0%, var(--bg) 65%);
    }
    main {
      max-width: 720px;
      margin: 0 auto;
      padding: 24px 16px 40px;
    }
    h1 {
      margin: 0 0 16px;
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1.1;
    }
    .meta {
      margin: 0 0 20px;
      font-size: 14px;
    }
    .meta a {
      color: var(--link);
    }
    .board {
      display: grid;
      grid-template-columns: repeat(${COLS}, 1fr);
      gap: 3px;
      width: min(100%, 480px);
      padding: 3px;
      background: var(--line);
      box-shadow: 0 18px 40px rgba(30, 36, 48, 0.18);
    }
    .cell {
      aspect-ratio: 1 / 1;
      display: grid;
      place-items: center;
      background: var(--board);
    }
    .cell.hq-gap {
      background: var(--hq);
    }
    .piece {
      width: 84%;
      height: auto;
      image-rendering: pixelated;
    }
    .codes {
      margin-top: 20px;
      font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre;
      background: rgba(255, 255, 255, 0.6);
      border: 1px solid rgba(30, 36, 48, 0.1);
      padding: 12px;
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">
      Source images: <a href="https://gunjin.amamiya-lab.net/jin_2.html">gunjin.amamiya-lab.net</a>
    </p>
    <section class="board" aria-label="Decoded jin board">
      ${payload.map(renderCell).join("\n      ")}
    </section>
    <div class="codes">${grid.map((row) => row.map(formatCode).join(" ")).join("\n")}</div>
  </main>
</body>
</html>
`;
  fs.writeFileSync(htmlPath, html);
  console.log("");
  console.log(`Wrote HTML preview: ${htmlPath}`);
}

function renderCell(value) {
  if (value === 0) {
    return '<div class="cell hq-gap" title="empty HQ half"></div>';
  }
  const code = `B${String(value).padStart(2, "0")}`;
  const src = `${IMAGE_BASE_URL}/${code}.gif`;
  const pieceType = CODE_TO_PIECE[value] ?? code;
  return `<div class="cell"><img class="piece" src="${src}" alt="${pieceType}" title="${code}: ${pieceType}"></div>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
