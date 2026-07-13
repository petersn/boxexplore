import type { Editor } from './editor';

// Binary scene container (v6). Little-endian:
//   "BOXW" | u32 version | u32 tileSize | u32 tilesetLen | tileset PNG
//   | u32 docLen | doc (the core's v6 binary document)
const MAGIC = [0x42, 0x4f, 0x58, 0x57]; // "BOXW"
const VERSION = 6;

export function serializeScene(ed: Editor): Uint8Array {
  const doc = ed.world.docBin();
  const tileset = dataUrlToBytes(ed.tileset.toDataURL());
  const out = new Uint8Array(4 + 4 * 4 + tileset.length + doc.length);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, ed.tileset.tileSize, true);
  view.setUint32(12, tileset.length, true);
  out.set(tileset, 16);
  view.setUint32(16 + tileset.length, doc.length, true);
  out.set(doc, 20 + tileset.length);
  return out;
}

export async function loadScene(ed: Editor, data: Uint8Array | ArrayBuffer): Promise<void> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a boxexplore scene file');
  }
  if (view.getUint32(4, true) !== VERSION) {
    throw new Error('unsupported scene version');
  }
  const tileSize = view.getUint32(8, true);
  const tilesetLen = view.getUint32(12, true);
  const docLen = view.getUint32(16 + tilesetLen, true);
  const tileset = bytes.subarray(16, 16 + tilesetLen);
  const doc = bytes.subarray(20 + tilesetLen, 20 + tilesetLen + docLen);
  await ed.tileset.loadImage(new Blob([new Uint8Array(tileset).buffer], { type: 'image/png' }));
  ed.tileset.tileSize = tileSize || 16;
  ed.world.loadDocBin(doc);
  ed.afterSceneLoad();
}

function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function downloadBinary(filename: string, bytes: Uint8Array): void {
  const blob = new Blob([new Uint8Array(bytes).buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// -- autosave: IndexedDB (binary blobs, no localStorage string/quota limits) --

const DB_NAME = 'boxexplore';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(key: string, value: Uint8Array): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function idbGet(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  const out = await new Promise<Uint8Array | null>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result instanceof Uint8Array ? req.result : null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}
