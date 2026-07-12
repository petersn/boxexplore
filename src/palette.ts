import type { Tileset } from './tileset';

/** A rectangular tile selection from the tileset (for future face texturing). */
export interface Stamp {
  tx: number;
  ty: number;
  w: number;
  h: number;
}

/**
 * The tileset picker. Click selects a tile; click-drag selects a rectangular
 * multi-tile stamp (Crocotile-style tilebrush).
 */
export class Palette {
  stamp: Stamp = { tx: 0, ty: 0, w: 1, h: 1 };
  onSelect: ((s: Stamp) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 2;
  private dragAnchor: { tx: number; ty: number } | null = null;

  constructor(canvas: HTMLCanvasElement, private tileset: Tileset) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    tileset.subscribe(() => this.refresh());

    canvas.addEventListener('pointerdown', (e) => {
      const t = this.tileAt(e);
      if (!t) return;
      canvas.setPointerCapture(e.pointerId);
      this.dragAnchor = t;
      this.setStampRect(t, t);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragAnchor) return;
      const t = this.tileAt(e, true);
      if (t) this.setStampRect(this.dragAnchor, t);
    });
    canvas.addEventListener('pointerup', () => (this.dragAnchor = null));

    this.refresh();
  }

  /** Set the stamp to a single tile (used by the eyedropper). */
  select(tx: number, ty: number): void {
    this.setStampRect({ tx, ty }, { tx, ty });
  }

  private setStampRect(a: { tx: number; ty: number }, b: { tx: number; ty: number }): void {
    const tx = Math.min(a.tx, b.tx);
    const ty = Math.min(a.ty, b.ty);
    this.stamp = {
      tx,
      ty,
      w: Math.abs(a.tx - b.tx) + 1,
      h: Math.abs(a.ty - b.ty) + 1,
    };
    this.onSelect?.(this.stamp);
    this.draw();
  }

  private tileAt(e: PointerEvent, clampToBounds = false): { tx: number; ty: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const py = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    const step = this.tileset.tileSize * this.scale;
    let tx = Math.floor(px / step);
    let ty = Math.floor(py / step);
    if (clampToBounds) {
      tx = Math.max(0, Math.min(this.tileset.cols - 1, tx));
      ty = Math.max(0, Math.min(this.tileset.rows - 1, ty));
    } else if (tx < 0 || ty < 0 || tx >= this.tileset.cols || ty >= this.tileset.rows) {
      return null;
    }
    return { tx, ty };
  }

  refresh(): void {
    const img = this.tileset.canvas;
    // integer scale that fits the sidebar comfortably
    this.scale = Math.max(1, Math.min(4, Math.floor(256 / Math.max(img.width, 1))));
    this.canvas.width = img.width * this.scale;
    this.canvas.height = img.height * this.scale;
    // clamp stamp to new bounds
    const s = this.stamp;
    s.tx = Math.min(s.tx, this.tileset.cols - 1);
    s.ty = Math.min(s.ty, this.tileset.rows - 1);
    s.w = Math.min(s.w, this.tileset.cols - s.tx);
    s.h = Math.min(s.h, this.tileset.rows - s.ty);
    this.draw();
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const ts = this.tileset;
    const step = ts.tileSize * this.scale;

    // checkerboard backdrop (shows transparency)
    ctx.fillStyle = '#26292e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2d3138';
    const c = 8 * this.scale;
    for (let y = 0; y < canvas.height; y += c)
      for (let x = (y / c) % 2 === 0 ? 0 : c; x < canvas.width; x += c * 2)
        ctx.fillRect(x, y, c, c);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(ts.canvas, 0, 0, canvas.width, canvas.height);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = step; x < canvas.width; x += step) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, canvas.height);
    }
    for (let y = step; y < canvas.height; y += step) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(canvas.width, y + 0.5);
    }
    ctx.stroke();

    // stamp selection
    const s = this.stamp;
    ctx.strokeStyle = '#ffb454';
    ctx.lineWidth = 2;
    ctx.strokeRect(s.tx * step + 1, s.ty * step + 1, s.w * step - 2, s.h * step - 2);
  }
}
