const VERSION = 4;
const SIZE = 21 + 4 * (VERSION - 1);
const DATA_CODEWORDS = 80;
const ECC_CODEWORDS = 20;

type Matrix = boolean[][];

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function utf8Bytes(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function gfTables(): { exp: number[]; log: number[] } {
  const exp = Array<number>(512).fill(0);
  const log = Array<number>(256).fill(0);
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255];
  return { exp, log };
}

const GF = gfTables();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF.exp[GF.log[a] + GF.log[b]];
}

function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF.exp[i]);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data: number[], degree: number): number[] {
  const gen = generatorPoly(degree);
  const rem = Array<number>(degree).fill(0);
  for (const value of data) {
    const factor = value ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < degree; i += 1) {
      rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

function appendBits(out: boolean[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) out.push(bit(value, i));
}

function makeCodewords(text: string): number[] {
  const data = utf8Bytes(text);
  if (data.length > 78) {
    throw new Error("QR link is too long for the built-in Telegram QR code.");
  }

  const bits: boolean[] = [];
  appendBits(bits, 0x4, 4);
  appendBits(bits, data.length, 8);
  for (const value of data) appendBits(bits, value, 8);
  appendBits(bits, 0, Math.min(4, DATA_CODEWORDS * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(false);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | (bits[i + j] ? 1 : 0);
    codewords.push(value);
  }
  for (let pad = 0xec; codewords.length < DATA_CODEWORDS; pad ^= 0xfd) {
    codewords.push(pad);
  }
  return [...codewords, ...reedSolomon(codewords, ECC_CODEWORDS)];
}

function blank(): { modules: Matrix; reserved: Matrix } {
  return {
    modules: Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false)),
    reserved: Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false)),
  };
}

function setModule(modules: Matrix, reserved: Matrix, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  modules[y][x] = dark;
  reserved[y][x] = true;
}

function drawFinder(modules: Matrix, reserved: Matrix, x: number, y: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const xx = x + dx;
      const yy = y + dy;
      const dark = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
        && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setModule(modules, reserved, xx, yy, dark);
    }
  }
}

function drawAlignment(modules: Matrix, reserved: Matrix, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setModule(modules, reserved, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(modules: Matrix, reserved: Matrix): void {
  drawFinder(modules, reserved, 0, 0);
  drawFinder(modules, reserved, SIZE - 7, 0);
  drawFinder(modules, reserved, 0, SIZE - 7);
  drawAlignment(modules, reserved, 26, 26);

  for (let i = 0; i < SIZE; i += 1) {
    if (!reserved[6][i]) setModule(modules, reserved, i, 6, i % 2 === 0);
    if (!reserved[i][6]) setModule(modules, reserved, 6, i, i % 2 === 0);
  }

  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setModule(modules, reserved, 8, i, false);
      setModule(modules, reserved, i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) setModule(modules, reserved, SIZE - 1 - i, 8, false);
  for (let i = 0; i < 7; i += 1) setModule(modules, reserved, 8, SIZE - 1 - i, false);
  setModule(modules, reserved, 8, SIZE - 8, true);
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

function placeData(modules: Matrix, reserved: Matrix, codewords: number[]): void {
  let index = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < SIZE; vert += 1) {
      const y = ((right + 1) & 2) === 0 ? SIZE - 1 - vert : vert;
      for (let dx = 0; dx < 2; dx += 1) {
        const x = right - dx;
        if (reserved[y][x]) continue;
        const dark = index < codewords.length * 8 && bit(codewords[index >>> 3], 7 - (index & 7));
        modules[y][x] = dark;
        index += 1;
      }
    }
  }
}

function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask;
  let bitsValue = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if (((bitsValue >>> i) & 1) !== 0) bitsValue ^= 0x537 << (i - 10);
  }
  return (((data << 10) | bitsValue) ^ 0x5412) & 0x7fff;
}

function drawFormat(modules: Matrix, reserved: Matrix, mask: number): void {
  const bitsValue = formatBits(mask);
  for (let i = 0; i <= 5; i += 1) setModule(modules, reserved, 8, i, bit(bitsValue, i));
  setModule(modules, reserved, 8, 7, bit(bitsValue, 6));
  setModule(modules, reserved, 8, 8, bit(bitsValue, 7));
  setModule(modules, reserved, 7, 8, bit(bitsValue, 8));
  for (let i = 9; i < 15; i += 1) setModule(modules, reserved, 14 - i, 8, bit(bitsValue, i));
  for (let i = 0; i < 8; i += 1) setModule(modules, reserved, SIZE - 1 - i, 8, bit(bitsValue, i));
  for (let i = 8; i < 15; i += 1) setModule(modules, reserved, 8, SIZE - 15 + i, bit(bitsValue, i));
  setModule(modules, reserved, 8, SIZE - 8, true);
}

function cloneMatrix(source: Matrix): Matrix {
  return source.map((row) => [...row]);
}

function applyMask(modules: Matrix, reserved: Matrix, mask: number): Matrix {
  const out = cloneMatrix(modules);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (!reserved[y][x] && maskBit(mask, x, y)) out[y][x] = !out[y][x];
    }
  }
  return out;
}

function penalty(modules: Matrix): number {
  let score = 0;
  const rows = modules;
  const cols = Array.from({ length: SIZE }, (_, x) => rows.map((row) => row[x]));
  for (const line of [...rows, ...cols]) {
    let runColor = line[0];
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === runColor) run += 1;
      else {
        if (run >= 5) score += 3 + run - 5;
        runColor = line[i];
        run = 1;
      }
    }
    if (run >= 5) score += 3 + run - 5;
  }
  for (let y = 0; y < SIZE - 1; y += 1) {
    for (let x = 0; x < SIZE - 1; x += 1) {
      const color = modules[y][x];
      if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) score += 3;
    }
  }
  const dark = modules.flat().filter(Boolean).length;
  score += Math.floor(Math.abs((dark * 20) / (SIZE * SIZE) - 10)) * 10;
  return score;
}

function qrMatrix(text: string): Matrix {
  const { modules, reserved } = blank();
  drawFunctionPatterns(modules, reserved);
  placeData(modules, reserved, makeCodewords(text));

  let bestMask = 0;
  let best = applyMask(modules, reserved, 0);
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(modules, reserved, mask);
    const candidateReserved = cloneMatrix(reserved);
    drawFormat(candidate, candidateReserved, mask);
    const candidateScore = penalty(candidate);
    if (candidateScore < bestScore) {
      bestMask = mask;
      best = candidate;
      bestScore = candidateScore;
    }
  }
  drawFormat(best, reserved, bestMask);
  return best;
}

export function qrSvgDataUri(text: string): string {
  const modules = qrMatrix(text);
  const scale = 8;
  const quiet = 4;
  const size = (SIZE + quiet * 2) * scale;
  const rects: string[] = [];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (modules[y][x]) {
        rects.push(`<rect x="${(x + quiet) * scale}" y="${(y + quiet) * scale}" width="${scale}" height="${scale}"/>`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
