import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = process.cwd();
const buildDir = path.join(root, "build");

const icoSizes = [16, 32, 48, 64, 128, 256];
const pngSizes = [16, 32, 64, 128, 256, 512, 1024];
const icnsTypes = new Map([
  [16, "icp4"],
  [32, "icp5"],
  [64, "icp6"],
  [128, "ic07"],
  [256, "ic08"],
  [512, "ic09"],
  [1024, "ic10"]
]);

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const crcTable = makeCrcTable();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return output;
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function roundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function triangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function generatePixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const margin = size * 0.08;
  const radius = size * 0.22;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inside = roundedRect(x + 0.5, y + 0.5, margin, margin, size - margin, size - margin, radius);
      if (!inside) {
        continue;
      }

      const mix = (x + y) / (size * 2);
      pixels[offset] = clamp(49 * (1 - mix) + 35 * mix);
      pixels[offset + 1] = clamp(125 * (1 - mix) + 107 * mix);
      pixels[offset + 2] = clamp(244 * (1 - mix) + 115 * mix);
      pixels[offset + 3] = 255;

      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      const shaft = nx > 0.455 && nx < 0.545 && ny > 0.24 && ny < 0.52;
      const head = triangle(nx, ny, 0.32, 0.48, 0.5, 0.66, 0.68, 0.48);
      const trayBase = nx > 0.28 && nx < 0.72 && ny > 0.68 && ny < 0.76;
      const trayCut = nx > 0.36 && nx < 0.64 && ny > 0.62 && ny < 0.70;
      const trayDot = (nx - 0.5) ** 2 + (ny - 0.72) ** 2 < 0.014 ** 2;

      if (shaft || head || (trayBase && !trayCut) || trayDot) {
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
        pixels[offset + 3] = 255;
      }
    }
  }

  return pixels;
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const pixels = generatePixels(size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directories = [];
  let offset = 6 + images.length * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size === 256 ? 0 : image.size;
    entry[1] = image.size === 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    directories.push(entry);
    offset += image.data.length;
  }

  return Buffer.concat([header, ...directories, ...images.map((image) => image.data)]);
}

function icns(images) {
  const chunks = [];
  for (const image of images) {
    const type = icnsTypes.get(image.size);
    if (!type) {
      continue;
    }
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(image.data.length + 8, 4);
    chunks.push(Buffer.concat([header, image.data]));
  }

  const totalSize = 8 + chunks.reduce((sum, data) => sum + data.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalSize, 4);
  return Buffer.concat([header, ...chunks]);
}

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(path.join(buildDir, "icons"), { recursive: true });

const pngImages = pngSizes.map((size) => ({ size, data: png(size) }));
for (const image of pngImages) {
  fs.writeFileSync(path.join(buildDir, "icons", `${image.size}x${image.size}.png`), image.data);
}

fs.writeFileSync(path.join(buildDir, "icon.png"), pngImages.find((image) => image.size === 512).data);
fs.writeFileSync(path.join(buildDir, "icon.ico"), ico(icoSizes.map((size) => ({ size, data: png(size) }))));
fs.writeFileSync(path.join(buildDir, "icon.icns"), icns(pngImages));
