/**
 * IFS (Konami arcade asset archive) reader.
 *
 * Ports the parts of mon/ifstools that we need to pull jackets, appeal
 * cards, and other assets straight out of the game install at runtime
 * without anyone having to pre-extract them.
 *
 * IFS layout:
 *   0x00 u32 BE  magic (0x6CAD8F89)
 *   0x04 u16 BE  file version
 *   0x06 u16 BE  ~version (xor validation)
 *   0x08 u32 BE  unix timestamp
 *   0x0C u32 BE  ifs tree size (KBin manifest length)
 *   0x10 u32 BE  manifest_end (absolute byte offset where the data blob
 *                starts — every file's offset is relative to this)
 *   0x14 16 B    manifest MD5 (only present when version >= 2)
 *   0x24 ...     KBin-encoded manifest tree, then the compressed data blob
 *
 * The manifest is Konami's binary XML — we reuse the kdecode() we already
 * have for the eamuse protocol. Each leaf file node in the decoded tree
 * stores its data-section position as [offset, size] or [offset, size, time]
 * in @content; folders are non-leaf nodes whose children are other nodes.
 *
 * Texture IFS (like s_jacket00.ifs) additionally carry image_rect / uv_rect
 * children per texture that describe where the decoded pixels go inside the
 * final PNG. The pixel data itself is a Konami LZ77-compressed BGRA blob
 * preceded by an 8-byte header [uncompressedSize BE, compressedSize BE].
 */

import * as fs from 'fs';
import { createHash } from 'crypto';
import xml2json from 'fast-xml-parser';
import { PNG } from 'pngjs';
import { kdecode } from './KBinJSON';
import { Logger } from './Logger';

const IFS_MAGIC = 0x6cad8f89;
const HEADER_SIZE = 36;

/** A parsed entry in the IFS manifest. */
export interface IfsFileEntry {
  /** Segments of the file's path in the manifest tree, already demunged. */
  pathParts: string[];
  /** Joined path (forward-slash separated), useful as a cache key. */
  path: string;
  /** Byte offset into the data blob (i.e. absolute file offset = manifest_end + dataOffset). */
  dataOffset: number;
  /** Byte length of the raw entry in the data blob. */
  dataSize: number;
  /** Unix timestamp if the manifest supplied one. */
  time?: number;
  /** Present only for texture entries — full image rectangle (doubled coords: [x1, x2, y1, y2]). */
  imgrect?: number[];
  /** Present only for texture entries — UV rectangle. */
  uvrect?: number[];
  /** Present only for texture entries — format identifier (e.g. 'argb8888rev'). */
  format?: string;
}

/** A loaded IFS archive. */
export interface IfsArchive {
  filePath: string;
  manifestEnd: number;
  buffer: Buffer;
  files: IfsFileEntry[];
  /** basename → entries that share that basename (could be multiple if the IFS nests folders that reuse names). */
  byBasename: Map<string, IfsFileEntry[]>;
  /**
   * For MD5Folder-style archives (SDVX jackets, appeal cards, etc.) this maps
   * the real asset name (e.g. `jk_0001_0`) to its texture metadata, populated
   * on demand from `tex/texturelist.xml`. For archives without an
   * MD5Folder this stays null.
   */
  textureList?: Map<string, IfsTextureListEntry> | null;
}

export interface IfsTextureListEntry {
  /** Real asset name, e.g. `jk_0001_0`. */
  name: string;
  /** File entry carrying the texture payload (the MD5-hashed leaf inside the IFS). */
  file: IfsFileEntry;
  /** [x1, x2, y1, y2] in doubled (subpixel) coordinates. */
  imgrect?: number[];
  /** [x1, x2, y1, y2] UV rectangle. */
  uvrect?: number[];
  /** argb8888rev, etc. */
  format?: string;
}

/**
 * Demunge an IFS manifest element name back into a real filename.
 *
 * Sanitize (filename → XML), applied in reverse order:
 *   1. `.` → `_E`
 *   2. `_` → `__`
 *   3. If starts with a digit, prepend `_`
 *
 * So the demunge forward order is:
 *   1. `_E` → `.`
 *   2. `__` → `_`
 *   3. strip leading `_` when followed by a digit
 */
export function demungeIfsName(munged: string): string {
  let out = munged.split('_E').join('.');
  out = out.split('__').join('_');
  if (out.length >= 2 && out[0] === '_' && out[1] >= '0' && out[1] <= '9') {
    out = out.slice(1);
  }
  return out;
}

function parseIntListContent(content: any): number[] | null {
  // kdecode gives the content of a typed list node as an array of numbers
  // (or bigints). For IFS entries the values are always offsets/sizes that
  // comfortably fit in JS numbers, so coerce to Number.
  if (Array.isArray(content)) {
    return content.map((v: any) => (typeof v === 'bigint' ? Number(v) : v));
  }
  // Some kdecode paths store a single-item list as a bare number — tolerate it.
  if (typeof content === 'number') return [content];
  if (typeof content === 'bigint') return [Number(content)];
  // Fallback: the content was a space-delimited string (older kdecode branches).
  if (typeof content === 'string') {
    const parts = content.trim().split(/\s+/).map(s => parseInt(s, 10));
    if (parts.every(n => !isNaN(n))) return parts;
  }
  return null;
}

function isFileNode(node: any): boolean {
  // A leaf file node carries a content tuple [offset, size] or [offset, size, time].
  if (node == null || typeof node !== 'object') return false;
  if (!('@content' in node)) return false;
  const ints = parseIntListContent(node['@content']);
  return !!(ints && ints.length >= 2);
}

function isContainerNode(key: string, value: any): boolean {
  // Skip node bookkeeping ('@attr', '@content') and the reserved '_info_'
  // which carries folder metadata rather than a file.
  if (key === '@attr' || key === '@content') return false;
  if (key === '_info_') return false;
  if (value == null || typeof value !== 'object') return false;
  return true;
}

function walkManifest(
  node: any,
  pathParts: string[],
  out: IfsFileEntry[],
  parentTextureInfo: {
    imgrect?: number[];
    uvrect?: number[];
    format?: string;
  } = {}
) {
  if (!node || typeof node !== 'object') return;

  // Collect optional texture metadata that sits as a sibling of the file nodes
  // inside this container. Passing it down means when we recurse into a
  // texture-atlas entry, we can attach imgrect/uvrect directly to that file.
  const texInfo = { ...parentTextureInfo };
  if (node.imgrect) {
    const v = parseIntListContent(node.imgrect['@content']);
    if (v) texInfo.imgrect = v;
  }
  if (node.uvrect) {
    const v = parseIntListContent(node.uvrect['@content']);
    if (v) texInfo.uvrect = v;
  }
  if (node.format && typeof node.format['@content'] === 'string') {
    texInfo.format = node.format['@content'];
  }

  for (const key of Object.keys(node)) {
    if (!isContainerNode(key, node[key])) continue;
    const child = node[key];

    // kdecode collapses duplicate-named siblings into an array. Treat each
    // element of that array as its own child node.
    const children = Array.isArray(child) ? child : [child];
    for (const c of children) {
      const filename = demungeIfsName(key);
      const nextPath = pathParts.concat(filename);

      // Gather per-file texture metadata where it lives ON the file node
      // itself (not on its parent folder). This is the common layout for
      // SDVX jackets, where each jk_* leaf has its own imgrect/uvrect.
      const selfTex: typeof texInfo = { ...texInfo };
      if (c.imgrect) {
        const v = parseIntListContent(c.imgrect['@content']);
        if (v) selfTex.imgrect = v;
      }
      if (c.uvrect) {
        const v = parseIntListContent(c.uvrect['@content']);
        if (v) selfTex.uvrect = v;
      }
      if (c.format && typeof c.format['@content'] === 'string') {
        selfTex.format = c.format['@content'];
      }

      if (isFileNode(c)) {
        const ints = parseIntListContent(c['@content'])!;
        out.push({
          pathParts: nextPath,
          path: nextPath.join('/'),
          dataOffset: ints[0],
          dataSize: ints[1],
          time: ints[2],
          imgrect: selfTex.imgrect,
          uvrect: selfTex.uvrect,
          format: selfTex.format,
        });
      } else {
        walkManifest(c, nextPath, out, selfTex);
      }
    }
  }
}

/**
 * Read and parse an IFS archive from disk. Throws on unreadable files or
 * unrecognized headers. The returned archive holds a full in-memory copy of
 * the file — callers that open many large IFSes should cache.
 */
export function loadIfs(filePath: string): IfsArchive {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < HEADER_SIZE) {
    throw new Error(`IFS file too small: ${filePath}`);
  }

  const magic = buffer.readUInt32BE(0);
  if (magic !== IFS_MAGIC) {
    throw new Error(`Not an IFS file (bad magic): ${filePath}`);
  }
  const version = buffer.readUInt16BE(4);
  const versionCheck = buffer.readUInt16BE(6);
  if ((version ^ versionCheck) !== 0xffff) {
    throw new Error(`IFS version check failed: ${filePath}`);
  }

  // bytes 8..12 are the unix timestamp, bytes 12..16 are the manifest size in
  // memory; we use manifest_end directly.
  const manifestEnd = buffer.readUInt32BE(16);
  const manifestStart = version >= 2 ? HEADER_SIZE : 20;
  if (manifestEnd <= manifestStart || manifestEnd > buffer.length) {
    throw new Error(`IFS manifest_end (${manifestEnd}) out of range for ${filePath}`);
  }

  const manifestBlob = buffer.slice(manifestStart, manifestEnd);
  const manifest = kdecode(manifestBlob);
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Failed to decode IFS manifest KBin: ${filePath}`);
  }

  // The manifest has a single root element (e.g. <imgfs>); recurse into it.
  const rootKeys = Object.keys(manifest).filter(k => isContainerNode(k, manifest[k]));
  const files: IfsFileEntry[] = [];
  for (const rk of rootKeys) {
    walkManifest(manifest[rk], [], files);
  }

  const byBasename = new Map<string, IfsFileEntry[]>();
  for (const f of files) {
    const base = f.pathParts[f.pathParts.length - 1];
    const list = byBasename.get(base) || [];
    list.push(f);
    byBasename.set(base, list);
  }

  return { filePath, manifestEnd, buffer, files, byBasename };
}

const archiveCache = new Map<string, { mtimeMs: number; archive: IfsArchive }>();

/**
 * Cached variant of loadIfs. Invalidates automatically when the underlying
 * file's mtime changes, so re-syncing a new game dump doesn't require a
 * server restart.
 */
export function openIfs(filePath: string): IfsArchive {
  const stat = fs.statSync(filePath);
  const cached = archiveCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.archive;
  const archive = loadIfs(filePath);
  archiveCache.set(filePath, { mtimeMs: stat.mtimeMs, archive });
  return archive;
}

/** Grab the raw bytes for a file entry from the IFS data blob. */
export function readFileEntry(archive: IfsArchive, entry: IfsFileEntry): Buffer {
  const start = archive.manifestEnd + entry.dataOffset;
  const end = start + entry.dataSize;
  if (end > archive.buffer.length) {
    throw new Error(
      `IFS entry out of range (${entry.path}: offset=${entry.dataOffset} size=${entry.dataSize})`
    );
  }
  return archive.buffer.slice(start, end);
}

/**
 * Decompress Konami's LZ77 variant. Identical to the inline decompressor in
 * plugins/sdvx@asphyxia/handlers/webui.ts — kept here so other assets can use
 * it without depending on the plugin.
 */
export function lz77Decompress(buf: Buffer): Buffer {
  const out: number[] = [];
  let off = 0;
  let running = true;
  while (running) {
    const flag = buf.readUInt8(off++);
    for (let i = 0; i < 8; i++) {
      if ((flag >> i) & 1) {
        out.push(buf.readUInt8(off++));
      } else {
        const w = buf.readUInt16BE(off);
        off += 2;
        const position = w >> 4;
        let length = (w & 0x0f) + 3;
        if (position === 0) {
          running = false;
          break;
        }
        // Position can refer past the current decompression window if the
        // window has just started — pad with zeroes to match ifstools.
        if (position > out.length) {
          let diff = Math.min(position - out.length, length);
          for (let p = 0; p < diff; p++) out.push(0);
          length -= diff;
        }
        const srcStart = out.length - position;
        if (srcStart + length < out.length) {
          for (let k = 0; k < length; k++) out.push(out[srcStart + k]);
        } else {
          for (let k = 0; k < length; k++) out.push(out[out.length - position]);
        }
      }
    }
  }
  return Buffer.from(out);
}

/**
 * Encode a raw RGBA pixel buffer as a PNG file. Thin wrapper around pngjs so
 * callers don't have to know the sync/async pack variants.
 */
export function encodePng(pixels: Buffer, width: number, height: number): Buffer {
  const png = new PNG({ width, height, colorType: 6, bitDepth: 8, inputHasAlpha: true });
  png.data = pixels;
  return PNG.sync.write(png);
}

/**
 * Decode a DXT1 (BC1) compressed texture into an RGBA8 pixel buffer.
 * Each 4×4 pixel block is 8 bytes: two RGB565 colors + 16 × 2-bit indices.
 * Used for jackets in SDVX — stored as DXT1 to keep the archive compact.
 */
export function decodeDxt1(src: Buffer, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const expected = blocksX * blocksY * 8;
  if (src.length < expected) {
    throw new Error(
      `DXT1 buffer too small: ${src.length} bytes, need ${expected} for ${width}x${height}`
    );
  }

  const palette = new Uint8Array(16); // 4 colors × RGBA

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * 8;
      const c0 = src.readUInt16LE(off);
      const c1 = src.readUInt16LE(off + 2);
      const indices = src.readUInt32LE(off + 4);

      // RGB565 → RGB888 (spread 5/6 bit fields to full byte range).
      const r0 = (((c0 >> 11) & 0x1f) * 255) / 31;
      const g0 = (((c0 >> 5) & 0x3f) * 255) / 63;
      const b0 = ((c0 & 0x1f) * 255) / 31;
      const r1 = (((c1 >> 11) & 0x1f) * 255) / 31;
      const g1 = (((c1 >> 5) & 0x3f) * 255) / 63;
      const b1 = ((c1 & 0x1f) * 255) / 31;

      palette[0] = r0; palette[1] = g0; palette[2] = b0; palette[3] = 255;
      palette[4] = r1; palette[5] = g1; palette[6] = b1; palette[7] = 255;

      if (c0 > c1) {
        // Opaque 4-color mode: interpolate 2 intermediate colors.
        palette[8]  = (2 * r0 + r1) / 3;
        palette[9]  = (2 * g0 + g1) / 3;
        palette[10] = (2 * b0 + b1) / 3;
        palette[11] = 255;
        palette[12] = (r0 + 2 * r1) / 3;
        palette[13] = (g0 + 2 * g1) / 3;
        palette[14] = (b0 + 2 * b1) / 3;
        palette[15] = 255;
      } else {
        // 3-color + 1-bit-alpha mode: index 3 is transparent black.
        palette[8]  = (r0 + r1) / 2;
        palette[9]  = (g0 + g1) / 2;
        palette[10] = (b0 + b1) / 2;
        palette[11] = 255;
        palette[12] = 0; palette[13] = 0; palette[14] = 0; palette[15] = 0;
      }

      for (let py = 0; py < 4; py++) {
        const dy = by * 4 + py;
        if (dy >= height) break;
        for (let px = 0; px < 4; px++) {
          const dx = bx * 4 + px;
          if (dx >= width) break;
          const idx = (indices >> (2 * (py * 4 + px))) & 0x3;
          const dstOff = (dy * width + dx) * 4;
          const palOff = idx * 4;
          out[dstOff]     = palette[palOff];
          out[dstOff + 1] = palette[palOff + 1];
          out[dstOff + 2] = palette[palOff + 2];
          out[dstOff + 3] = palette[palOff + 3];
        }
      }
    }
  }
  return out;
}

/**
 * Extract a texture entry (imgrect-bearing) from the archive and return a
 * PNG-encoded buffer. Throws if the entry is missing texture metadata or if
 * the decompressed size disagrees with the header.
 *
 * Handles both the `argb8888rev` pixel format (used by the UI sprite sheets
 * the plugin already extracted — the legacy path) and the `dxt1` block
 * format used for jackets.
 */
export function extractTextureAsPng(archive: IfsArchive, entry: IfsFileEntry): Buffer {
  if (!entry.imgrect) {
    throw new Error(`IFS entry has no imgrect, not a texture: ${entry.path}`);
  }
  const raw = readFileEntry(archive, entry);
  if (raw.length < 8) throw new Error(`Texture payload too small: ${entry.path}`);

  const uncompressedSize = raw.readUInt32BE(0);
  const body = raw.slice(8);

  const decoded = lz77Decompress(body);
  if (decoded.length !== uncompressedSize) {
    throw new Error(
      `Texture decompression size mismatch for ${entry.path} ` +
        `(expected ${uncompressedSize}, got ${decoded.length})`
    );
  }

  // imgrect is [x1, x2, y1, y2] in doubled (subpixel) coordinates.
  const [x1, x2, y1, y2] = entry.imgrect;
  const width = Math.floor(x2 / 2) - Math.floor(x1 / 2);
  const height = Math.floor(y2 / 2) - Math.floor(y1 / 2);
  if (width <= 0 || height <= 0) {
    throw new Error(`Texture has non-positive dimensions (${width}x${height}): ${entry.path}`);
  }

  const fmt = (entry.format || '').toLowerCase();
  let rgba: Buffer;
  if (fmt === 'dxt1') {
    rgba = decodeDxt1(decoded, width, height);
  } else {
    // Default path — argb8888rev (BGRA byte order). Swap to RGBA in place.
    const pixels = Buffer.from(decoded);
    for (let i = 0; i + 3 < pixels.length; i += 4) {
      const b = pixels[i];
      pixels[i] = pixels[i + 2];
      pixels[i + 2] = b;
    }
    const expected = width * height * 4;
    if (pixels.length !== expected) {
      Logger.warn(
        `IFS texture pixel buffer size (${pixels.length}) != ${expected} for ${entry.path} (format=${fmt || 'argb8888rev?'})`
      );
    }
    rgba = pixels.slice(0, expected);
  }

  return encodePng(rgba, width, height);
}

/**
 * Find a single texture entry in the archive by basename (e.g. `jk_0001_0`).
 * Returns null if not found. If multiple entries share the same basename
 * (unlikely for jackets), returns the first.
 */
export function findTextureByBasename(
  archive: IfsArchive,
  basename: string
): IfsFileEntry | null {
  const hits = archive.byBasename.get(basename);
  if (!hits || hits.length === 0) return null;
  // Prefer texture entries (those with imgrect) over anything else.
  const withRect = hits.find(h => h.imgrect);
  return withRect || hits[0];
}

/**
 * Read a text file out of the archive. If the payload is LZ77-compressed
 * (8-byte header + avslz body, the same scheme textures use), transparently
 * decompress. Returns UTF-8 decoded text.
 */
export function readTextFile(archive: IfsArchive, entry: IfsFileEntry): string {
  const raw = readFileEntry(archive, entry);
  // Heuristic: plain XML starts with `<`. If so, don't try to decompress.
  if (raw.length > 0 && raw[0] === 0x3c /* '<' */) {
    return raw.toString('utf8');
  }
  // Fall back to the texture-style 8-byte-header avslz wrapping.
  if (raw.length > 8) {
    try {
      const uncompressedSize = raw.readUInt32BE(0);
      const body = raw.slice(8);
      const decompressed = lz77Decompress(body);
      if (decompressed.length === uncompressedSize) return decompressed.toString('utf8');
    } catch {
      /* fall through */
    }
  }
  // Last resort: return as-is; callers can decide what to do with it.
  return raw.toString('utf8');
}

/**
 * Read a file that might be stored as a KBin-encoded blob (common for
 * `texturelist.xml` — the extension says XML but the bytes are Konami's
 * binary XML encoding, so plain string/XML parsing would see garbage). We
 * detect the KBin signature byte 0xA0 and delegate to kdecode; otherwise we
 * fall through to the normal text reader and let the caller parse it as XML.
 */
export function readKbinOrTextFile(archive: IfsArchive, entry: IfsFileEntry): any {
  const raw = readFileEntry(archive, entry);
  if (raw.length > 0 && raw[0] === 0xa0) {
    const decoded = kdecode(raw);
    if (decoded && typeof decoded === 'object') return decoded;
  }
  return readTextFile(archive, entry);
}

function collectIntList(node: any, key: string): number[] | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const child = node[key];
  if (child == null) return undefined;
  // fast-xml-parser gives a string like "0 256 0 256" unless parseNodeValue
  // turns it into a single number.
  const text = typeof child === 'object' ? child['#text'] ?? child['@content'] : child;
  if (typeof text === 'string') {
    const parts = text.trim().split(/\s+/).map(s => parseInt(s, 10));
    if (parts.every(n => !isNaN(n))) return parts;
  }
  if (typeof text === 'number') return [text];
  return undefined;
}

function kbinNodeAttr(node: any, key: string): string | undefined {
  if (!node || typeof node !== 'object' || !node['@attr']) return undefined;
  const v = node['@attr'][key];
  return typeof v === 'string' ? v : undefined;
}

function kbinChildAsArray(parent: any, key: string): any[] {
  if (!parent || typeof parent !== 'object') return [];
  const v = parent[key];
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function kbinNumberArray(node: any, key: string): number[] | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const child = node[key];
  if (!child) return undefined;
  // kdecode stores typed numeric arrays in @content.
  const content = child['@content'];
  if (Array.isArray(content)) {
    return content.map((v: any) => (typeof v === 'bigint' ? Number(v) : v));
  }
  if (typeof content === 'number') return [content];
  if (typeof content === 'string') {
    const parts = content.trim().split(/\s+/).map(s => parseInt(s, 10));
    if (parts.every(n => !isNaN(n))) return parts;
  }
  return undefined;
}

/**
 * Parse the `tex/texturelist.xml` file inside an MD5Folder-style archive and
 * return a map of real names (e.g. `jk_0001_0`) to their texture metadata.
 * The file is in Konami's KBin encoding despite the .xml extension; we decode
 * it via kdecode and walk the resulting tree. Memoizes the result on the
 * archive object so subsequent lookups are free.
 *
 * Expected KBin tree:
 *   texturelist
 *     @attr.compress = "avslz"
 *     texture (array)
 *       @attr.name = "tex000" (hashed into the outer manifest)
 *       @attr.format = "argb8888rev" (or dxt1/etc.)
 *       size
 *       image (array — usually 1 entry per texture for jackets)
 *         @attr.name = "jk_0001_0" (real asset name)
 *         imgrect @content = [x1, x2, y1, y2]
 *         uvrect  @content = [x1, x2, y1, y2]
 */
export function loadTextureList(archive: IfsArchive): Map<string, IfsTextureListEntry> | null {
  if (archive.textureList !== undefined) return archive.textureList;

  const listEntry = archive.files.find(f => f.path === 'tex/texturelist.xml');
  if (!listEntry) {
    archive.textureList = null;
    return null;
  }

  const parsed = readKbinOrTextFile(archive, listEntry);
  let root: any = null;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // KBin decoded — shape is { texturelist: {...} }
    root = parsed.texturelist;
    if (!root && 'texturelist' in parsed) root = parsed.texturelist;
  }
  if (typeof parsed === 'string') {
    // Plain XML fallback — leave for archives that still ship raw XML.
    const xml = xml2json.parse(parsed, {
      attributeNamePrefix: '@_',
      ignoreAttributes: false,
      parseNodeValue: false,
      parseAttributeValue: false,
      trimValues: true,
      arrayMode: false,
    });
    root = xml && xml.texturelist;
  }

  if (!root || typeof root !== 'object') {
    archive.textureList = null;
    return null;
  }

  const textures = kbinChildAsArray(root, 'texture');

  const result = new Map<string, IfsTextureListEntry>();

  for (const tex of textures) {
    // The `name` on <texture> is what the outer manifest keyed its blob by.
    // For SDVX's MD5Folder variant, the outer file is stored under the MD5 of
    // this name (e.g. `md5("tex000")`).
    const texName =
      kbinNodeAttr(tex, 'name') /* KBin-attribute form */ ||
      (tex && typeof tex['@_name'] === 'string' ? tex['@_name'] : undefined); // XML fallback
    if (!texName) continue;

    let file = findTextureByBasename(archive, texName);
    if (!file && !/^[a-f0-9]{32}$/i.test(texName)) {
      file = findTextureByBasename(archive, md5Hex(texName));
    }
    if (!file) continue;

    const format = kbinNodeAttr(tex, 'format') || (tex && tex['@_format']) || undefined;

    // `image` is usually 1 entry (one jacket per texture). Some older dumps
    // have imgrect/uvrect directly on <texture>; handle both.
    let images = kbinChildAsArray(tex, 'image');
    if (images.length === 0 && (tex.imgrect || tex.uvrect)) {
      images = [tex];
    }

    for (const img of images) {
      const realName =
        kbinNodeAttr(img, 'name') ||
        (img && typeof img['@_name'] === 'string' ? img['@_name'] : undefined) ||
        texName;
      if (!realName) continue;
      const imgrect = kbinNumberArray(img, 'imgrect') || kbinNumberArray(tex, 'imgrect');
      const uvrect = kbinNumberArray(img, 'uvrect') || kbinNumberArray(tex, 'uvrect');
      result.set(realName, { name: realName, file, imgrect, uvrect, format });
    }
  }

  archive.textureList = result;
  return result;
}

/**
 * Find a texture by its real (user-visible) name, falling back through all
 * archives passed in. Uses the texturelist.xml inside each archive to resolve
 * MD5Folder-style hashed filenames — this is the common path for SDVX
 * jackets, appeal cards, etc.
 */
export function findTextureEntryByRealName(
  archives: IfsArchive[],
  realName: string
): { archive: IfsArchive; entry: IfsTextureListEntry } | null {
  for (const archive of archives) {
    const list = loadTextureList(archive);
    const hit = list && list.get(realName);
    if (hit) return { archive, entry: hit };
  }
  return null;
}

/**
 * Convenience: extract a named texture as a PNG, picking the right archive.
 */
export function extractNamedTextureAsPng(
  archives: IfsArchive[],
  realName: string
): Buffer | null {
  const hit = findTextureEntryByRealName(archives, realName);
  if (!hit) return null;
  const { archive, entry } = hit;
  // Build a synthesized IfsFileEntry that carries the imgrect from the
  // texturelist — the underlying blob lives at entry.file's offsets.
  const synth: IfsFileEntry = {
    ...entry.file,
    imgrect: entry.imgrect,
    uvrect: entry.uvrect,
    format: entry.format,
  };
  return extractTextureAsPng(archive, synth);
}

/** Quick MD5 hex helper for cases where we need to confirm an MD5Folder mapping. */
export function md5Hex(input: string): string {
  return createHash('md5').update(input).digest('hex');
}
