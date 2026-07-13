export interface UVRect {
  u0: number; // left
  v0: number; // bottom (flipY texture convention)
  u1: number; // right
  v1: number; // top
}

/**
 * The tileset image (drawn externally, e.g. in Aseprite) plus tile-size metadata.
 * Backed by a canvas so it can be serialized into save files.
 */
export class Tileset {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  tileSize = 16;
  private listeners = new Set<() => void>();

  constructor() {
    this.canvas.width = 128;
    this.canvas.height = 128;
    this.ctx = this.canvas.getContext('2d')!;
    this.drawDefault();
  }

  /** Raw pixels for the renderer's atlas upload. Rows are flipped so that
   *  v=0 is the image's BOTTOM, matching the mesher's flipY UV convention. */
  rgba(): { width: number; height: number; data: Uint8Array } {
    const { width, height } = this.canvas;
    const img = this.ctx.getImageData(0, 0, width, height).data;
    const out = new Uint8Array(img.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      out.set(img.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
    }
    return { width, height, data: out };
  }

  get cols(): number {
    return Math.max(1, Math.floor(this.canvas.width / this.tileSize));
  }

  get rows(): number {
    return Math.max(1, Math.floor(this.canvas.height / this.tileSize));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  setTileSize(px: number): void {
    this.tileSize = Math.max(2, Math.floor(px) || 16);
    this.emit();
  }

  /** UV rect for the tile at column tx, row ty (rows counted from the TOP of the image). */
  tileUV(tx: number, ty: number): UVRect {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ts = this.tileSize;
    return {
      u0: (tx * ts) / w,
      u1: ((tx + 1) * ts) / w,
      v1: 1 - (ty * ts) / h,
      v0: 1 - ((ty + 1) * ts) / h,
    };
  }

  /** Convert a UV point back to tile coords (row from top). */
  tileFromUV(u: number, v: number): { tx: number; ty: number } {
    const ts = this.tileSize;
    return {
      tx: Math.floor((u * this.canvas.width) / ts + 1e-4),
      ty: Math.floor(((1 - v) * this.canvas.height) / ts + 1e-4),
    };
  }

  async loadImage(source: Blob | string): Promise<void> {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('could not decode image'));
      el.src = typeof source === 'string' ? source : URL.createObjectURL(source);
    });
    this.canvas.width = img.naturalWidth;
    this.canvas.height = img.naturalHeight;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(img, 0, 0);
    if (typeof source !== 'string') URL.revokeObjectURL(img.src);
    this.emit();
  }

  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  /** Procedural placeholder tileset so the editor works before any image is loaded. */
  private drawDefault(): void {
    const ctx = this.ctx;
    const ts = 16;
    ctx.clearRect(0, 0, 128, 128);
    for (let ty = 0; ty < 8; ty++) {
      for (let tx = 0; tx < 8; tx++) {
        const i = ty * 8 + tx;
        const x = tx * ts;
        const y = ty * ts;
        const hue = (i * 47) % 360;
        const light = 38 + ((i * 13) % 25);
        ctx.fillStyle = `hsl(${hue} 45% ${light}%)`;
        ctx.fillRect(x, y, ts, ts);
        // simple per-tile pattern variants so tiles are distinguishable
        ctx.fillStyle = `hsl(${hue} 50% ${light + 12}%)`;
        switch (i % 4) {
          case 0: // specks
            for (let k = 0; k < 5; k++) {
              const px = (k * 7 + i * 3) % 14;
              const py = (k * 11 + i * 5) % 14;
              ctx.fillRect(x + 1 + px, y + 1 + py, 1, 1);
            }
            break;
          case 1: // bricks
            ctx.fillRect(x, y + 7, ts, 1);
            ctx.fillRect(x + 7, y, 1, 7);
            ctx.fillRect(x + 3, y + 8, 1, 8);
            break;
          case 2: // checker
            for (let cy = 0; cy < 4; cy++)
              for (let cx = 0; cx < 4; cx++)
                if ((cx + cy) % 2 === 0) ctx.fillRect(x + cx * 4, y + cy * 4, 4, 4);
            break;
          case 3: // top highlight strip
            ctx.fillRect(x, y, ts, 3);
            break;
        }
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.strokeRect(x + 0.5, y + 0.5, ts - 1, ts - 1);
      }
    }
  }
}
