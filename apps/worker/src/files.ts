import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm, stat, writeFile } from "node:fs/promises";

export type Hex32 = `0x${string}`;
export type Artifact = { path: string; sha256: Hex32; size: number };

export async function sha256File(file: string): Promise<Hex32> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return `0x${h.digest("hex")}`;
}

export async function artifact(file: string): Promise<Artifact> {
  const [sha256, st] = await Promise.all([sha256File(file), stat(file)]);
  return { path: file, sha256, size: st.size };
}

/** First `n` bytes of a file (fewer if it is shorter). */
export async function readHead(file: string, n: number): Promise<Uint8Array> {
  const fh = await open(file, "r");
  try {
    const buf = new Uint8Array(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** PNG width/height from the IHDR chunk; throws if the file is not a PNG. */
export async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const b = await readHead(file, 24);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((v, i) => b[i] !== v)) throw new Error(`${file} is not a PNG`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}
