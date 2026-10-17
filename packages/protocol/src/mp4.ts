// Minimal ISO-BMFF reader for the delivery check (§5: masters are `-movflags +faststart`, so `moov` sits in the
// first KFC1 chunk). Reads moov/mvhd (timescale, duration) and the video track's tkhd (width, height).
// Returns null for anything truncated, malformed, fragmented-without-duration or without a video track:
// a null result means "unverifiable", never "OK".

export type Mp4Header = { durationMs: number; width: number; height: number; timescale: number };

type Box = { type: string; start: number; end: number }; // payload is [start, end)

/** Header of the box at `off`; `end` is the declared end, which may lie beyond `limit` (truncated data). */
function boxAt(view: DataView, off: number, limit: number): Box | null {
  if (limit - off < 8) return null;
  let size = view.getUint32(off);
  const type = String.fromCharCode(
    view.getUint8(off + 4),
    view.getUint8(off + 5),
    view.getUint8(off + 6),
    view.getUint8(off + 7),
  );
  let header = 8;
  if (size === 1) {
    if (limit - off < 16) return null;
    const large = view.getBigUint64(off + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    header = 16;
  } else if (size === 0) {
    size = limit - off; // box extends to the end of its container
  }
  if (size < header) return null;
  return { type, start: off + header, end: off + size };
}

/** Child boxes of [start, end), or null if any child is malformed or overruns its parent. */
function children(view: DataView, start: number, end: number): Box[] | null {
  const out: Box[] = [];
  for (let off = start; off < end; ) {
    const b = boxAt(view, off, end);
    if (!b || b.end > end) return null;
    out.push(b);
    off = b.end;
  }
  return out;
}

const find = (list: Box[], type: string): Box | undefined => list.find((b) => b.type === type);

function readMvhd(view: DataView, b: Box): { timescale: number; duration: bigint } | null {
  const version = view.getUint8(b.start);
  const need = version === 1 ? 32 : 20;
  if (version > 1 || b.end - b.start < need) return null;
  const timescale = version === 1 ? view.getUint32(b.start + 20) : view.getUint32(b.start + 12);
  const duration = version === 1 ? view.getBigUint64(b.start + 24) : BigInt(view.getUint32(b.start + 16));
  const unknown = version === 1 ? 0xffff_ffff_ffff_ffffn : 0xffff_ffffn;
  if (timescale === 0 || duration === unknown) return null;
  return { timescale, duration };
}

function readTkhdSize(view: DataView, b: Box): { width: number; height: number } | null {
  const version = view.getUint8(b.start);
  const at = version === 1 ? 88 : 76; // fullbox header + times/ids + reserved/layer/group/volume + matrix
  if (version > 1 || b.end - b.start < at + 8) return null;
  return {
    width: Math.round(view.getUint32(b.start + at) / 65536),
    height: Math.round(view.getUint32(b.start + at + 4) / 65536),
  };
}

function handlerOf(view: DataView, trak: Box): string | null {
  const trakKids = children(view, trak.start, trak.end);
  const mdia = trakKids && find(trakKids, "mdia");
  const mdiaKids = mdia ? children(view, mdia.start, mdia.end) : null;
  const hdlr = mdiaKids && find(mdiaKids, "hdlr");
  if (!hdlr || hdlr.end - hdlr.start < 12) return null;
  const p = hdlr.start + 8; // version/flags (4) + pre_defined (4)
  return String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));
}

function parse(bytes: Uint8Array): Mp4Header | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  // Walk top-level boxes up to moov. Any box that runs past the available bytes before moov is found (mdat
  // first in a non-faststart file, or a truncated moov) means moov is not available here.
  let moov: Box | undefined;
  for (let off = 0; off < len && !moov; ) {
    const b = boxAt(view, off, len);
    if (!b || b.end > len) return null;
    if (b.type === "moov") moov = b;
    off = b.end;
  }
  if (!moov) return null;

  const kids = children(view, moov.start, moov.end);
  if (!kids) return null;
  const mvhdBox = find(kids, "mvhd");
  const mvhd = mvhdBox ? readMvhd(view, mvhdBox) : null;
  if (!mvhd) return null;

  for (const trak of kids.filter((b) => b.type === "trak")) {
    if (handlerOf(view, trak) !== "vide") continue;
    const trakKids = children(view, trak.start, trak.end);
    const tkhd = trakKids && find(trakKids, "tkhd");
    const size = tkhd ? readTkhdSize(view, tkhd) : null;
    if (!size || size.width === 0 || size.height === 0) return null;
    const ts = BigInt(mvhd.timescale);
    const durationMs = Number((mvhd.duration * 1000n + ts / 2n) / ts);
    if (!Number.isSafeInteger(durationMs)) return null;
    return { durationMs, width: size.width, height: size.height, timescale: mvhd.timescale };
  }
  return null;
}

/** Duration/size of a faststart MP4 from its leading bytes, or null if that cannot be established. */
export function parseMp4Header(bytes: Uint8Array): Mp4Header | null {
  if (!(bytes instanceof Uint8Array)) return null;
  try {
    return parse(bytes);
  } catch {
    return null;
  }
}
