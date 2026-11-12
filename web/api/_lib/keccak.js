// Keccak-256 (Ethereum's hash), dependency-free. Fine for the short inputs used here.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const M = (1n << 64n) - 1n;
const rol = (x, n) => (n ? ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M : x);

function permute(A) {
  for (const rc of RC) {
    const C = [0, 1, 2, 3, 4].map((x) => A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4]);
    const D = [0, 1, 2, 3, 4].map((x) => C[(x + 4) % 5] ^ rol(C[(x + 1) % 5], 1));
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] ^= D[x];
    const B = [0, 1, 2, 3, 4].map(() => [0n, 0n, 0n, 0n, 0n]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rol(A[x][y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x][y] = B[x][y] ^ (~B[(x + 1) % 5][y] & M & B[(x + 2) % 5][y]);
    A[0][0] ^= rc;
  }
}

function keccak256(input) {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const rate = 136;
  const len = data.length + 1 + ((rate - ((data.length + 1) % rate)) % rate);
  const p = Buffer.alloc(len);
  data.copy(p);
  p[data.length] ^= 0x01;
  p[len - 1] ^= 0x80;
  const A = [0, 1, 2, 3, 4].map(() => [0n, 0n, 0n, 0n, 0n]);
  for (let off = 0; off < len; off += rate) {
    for (let j = 0; j < rate / 8; j++) A[j % 5][Math.floor(j / 5)] ^= p.readBigUInt64LE(off + 8 * j);
    permute(A);
  }
  const out = Buffer.alloc(32);
  for (let j = 0; j < 4; j++) out.writeBigUInt64LE(A[j % 5][Math.floor(j / 5)], 8 * j);
  return "0x" + out.toString("hex");
}

module.exports = { keccak256 };
