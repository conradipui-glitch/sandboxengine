// png-crc32.mjs — CRC-32 для PNG-чанков (ISO-3309), минимальная реализация.
const TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c;
}

export function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
