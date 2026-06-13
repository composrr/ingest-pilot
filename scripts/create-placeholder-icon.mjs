import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const size = 32;
const xorBytes = size * size * 4;
const maskBytes = size * 4;
const dibBytes = 40 + xorBytes + maskBytes;
const icoBytes = 6 + 16 + dibBytes;
const buffer = Buffer.alloc(icoBytes);

let offset = 0;
buffer.writeUInt16LE(0, offset);
offset += 2;
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(1, offset);
offset += 2;

buffer.writeUInt8(size, offset++);
buffer.writeUInt8(size, offset++);
buffer.writeUInt8(0, offset++);
buffer.writeUInt8(0, offset++);
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(32, offset);
offset += 2;
buffer.writeUInt32LE(dibBytes, offset);
offset += 4;
buffer.writeUInt32LE(22, offset);
offset += 4;

buffer.writeUInt32LE(40, offset);
offset += 4;
buffer.writeInt32LE(size, offset);
offset += 4;
buffer.writeInt32LE(size * 2, offset);
offset += 4;
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(32, offset);
offset += 2;
buffer.writeUInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(xorBytes, offset);
offset += 4;
buffer.writeInt32LE(0, offset);
offset += 4;
buffer.writeInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(0, offset);
offset += 4;

for (let y = size - 1; y >= 0; y -= 1) {
  for (let x = 0; x < size; x += 1) {
    const cx = x - 15.5;
    const cy = y - 15.5;
    const distance = Math.sqrt(cx * cx + cy * cy);
    const inside = distance < 14.5;
    const accent = x > 18 && y > 6 && y < 25;
    const r = inside ? (accent ? 201 : 23) : 0;
    const g = inside ? (accent ? 167 : 23) : 0;
    const b = inside ? (accent ? 255 : 23) : 0;
    const a = inside ? 255 : 0;

    buffer.writeUInt8(b, offset++);
    buffer.writeUInt8(g, offset++);
    buffer.writeUInt8(r, offset++);
    buffer.writeUInt8(a, offset++);
  }
}

mkdirSync(join("src-tauri", "icons"), { recursive: true });
writeFileSync(join("src-tauri", "icons", "icon.ico"), buffer);
