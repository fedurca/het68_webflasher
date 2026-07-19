/**
 * Minimal UF2 parser for RP2350 / RP2040 flash payloads.
 */

const UF2_MAGIC0 = 0x0a324655;
const UF2_MAGIC1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;
const UF2_FLAG_NOFLASH = 0x00000001;
const FLASH_BASE = 0x10000000;
const SECTOR = 4096;

/**
 * @param {ArrayBuffer} buf
 * @param {(pct: number) => void} [onProgress]
 * @returns {Promise<{ blocks: {addr:number, data:ArrayBuffer}[], ranges: {start:number, end:number}[], familyId: number|null }>}
 */
export async function parseUF2(buf, onProgress) {
  if (buf.byteLength === 0 || buf.byteLength % 512 !== 0) {
    throw new Error("Neplatná velikost UF2 souboru");
  }

  const dv = new DataView(buf);
  const blocks = [];
  const ranges = [];
  const total = buf.byteLength / 512;
  let familyId = null;
  let lastPct = -1;

  for (let i = 0, o = 0; o < buf.byteLength; o += 512, i += 1) {
    if (dv.getUint32(o, true) !== UF2_MAGIC0) {
      throw new Error(`Špatný UF2 magic na bloku ${i}`);
    }
    if (dv.getUint32(o + 4, true) !== UF2_MAGIC1) {
      throw new Error(`Špatný UF2 magic2 na bloku ${i}`);
    }
    if (dv.getUint32(o + 508, true) !== UF2_MAGIC_END) {
      throw new Error(`Špatný UF2 end magic na bloku ${i}`);
    }

    const flags = dv.getUint32(o + 8, true);
    if (flags & UF2_FLAG_NOFLASH) continue;

    let addr = dv.getUint32(o + 12, true);
    const size = dv.getUint32(o + 16, true);
    if (size <= 0 || size > 476) {
      throw new Error(`Neplatná velikost payloadu UF2 na bloku ${i}`);
    }

    if (flags & 0x00002000) {
      familyId = dv.getUint32(o + 28, true);
    }

    if (addr < FLASH_BASE) addr += FLASH_BASE;

    blocks.push({
      addr,
      data: buf.slice(o + 32, o + 32 + size),
    });

    const start = addr & ~(SECTOR - 1);
    const end = (addr + size + SECTOR - 1) & ~(SECTOR - 1);
    ranges.push({ start, end });

    const pct = Math.floor(((i + 1) / total) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      if (onProgress) onProgress(pct);
    }
    if ((i & 0xff) === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (blocks.length === 0) {
    throw new Error("UF2 neobsahuje žádné flashovatelné bloky");
  }

  blocks.sort((a, b) => a.addr - b.addr);
  ranges.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }

  return { blocks, ranges: merged, familyId };
}

export { SECTOR, FLASH_BASE };
