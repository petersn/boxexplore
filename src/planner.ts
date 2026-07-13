import type { Editor } from './editor';

type PlanTool = 'raise' | 'lower' | 'smooth' | 'void' | 'restore';

/**
 * World-planning mode: design the world at macro scale as a pair of height
 * maps (top surface + underside — the world is a floating disc with edges)
 * plus a mask for cells that aren't world at all. The left pane is a
 * zoomable contour-map editor (the Rust core renders the RGBA, one pixel
 * per plan cell = 4×4 world cells); the right pane is the usual 3D view
 * showing a live coarse preview of the disc world. "Generate world"
 * replaces the volume with the plan's geometry, like a shaped Slab.
 */
export class PlanMode {
  readonly name = 'plan' as const;

  tool: PlanTool = 'raise';
  layer: 0 | 1 = 0;
  radius = 12;
  strength = 2;

  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private stroke = false;
  private panning = false;
  private lastPan = { x: 0, y: 0 };
  private off = document.createElement('canvas');
  private previewTimer: ReturnType<typeof setTimeout> | null = null;

  private pane = document.getElementById('plan-pane') as HTMLDivElement;
  private canvas = document.getElementById('plan-canvas') as HTMLCanvasElement;
  private wIn = document.getElementById('plan-w') as HTMLInputElement;
  private hIn = document.getElementById('plan-h') as HTMLInputElement;
  private radiusIn = document.getElementById('plan-radius') as HTMLInputElement;
  private strengthIn = document.getElementById('plan-strength') as HTMLInputElement;

  constructor(private ed: Editor) {
    document.querySelectorAll<HTMLButtonElement>('#plan-tool-buttons button').forEach((b) => {
      b.addEventListener('click', () => {
        this.tool = b.dataset.ptool as PlanTool;
        this.syncButtons();
      });
    });
    document.querySelectorAll<HTMLButtonElement>('#plan-layer-buttons button').forEach((b) => {
      b.addEventListener('click', () => {
        this.layer = Number(b.dataset.pl) as 0 | 1;
        this.syncButtons();
        this.refresh2d();
      });
    });
    this.radiusIn.addEventListener('input', () => (this.radius = parseFloat(this.radiusIn.value)));
    this.strengthIn.addEventListener(
      'input',
      () => (this.strength = parseFloat(this.strengthIn.value)),
    );
    document.getElementById('plan-init')!.addEventListener('click', () => {
      const [w, h] = this.dims();
      if (w > 0 && !confirm('Replace the current plan?')) return;
      this.ed.world.raw.plan_init(parseInt(this.wIn.value, 10), parseInt(this.hIn.value, 10));
      this.fitView();
      this.refresh2d();
      this.refreshPreview();
    });
    document.getElementById('plan-generate')!.addEventListener('click', () => {
      if (!confirm('Replace the whole world with geometry generated from this plan?')) return;
      this.ed.world.planGenerate();
      this.ed.setMode('build');
      this.ed.viewport.centerOn({ x: 0, y: 0, z: 0 });
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      if (e.button === 0) {
        this.stroke = true;
        this.ed.world.raw.plan_stroke_begin();
        this.applyAt(e);
      } else {
        this.panning = true;
        this.lastPan = { x: e.clientX, y: e.clientY };
      }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.stroke) this.applyAt(e);
      else if (this.panning) {
        this.panX += e.clientX - this.lastPan.x;
        this.panY += e.clientY - this.lastPan.y;
        this.lastPan = { x: e.clientX, y: e.clientY };
        this.repaint();
      }
    });
    const up = () => {
      if (this.stroke) {
        this.ed.world.raw.plan_stroke_end();
        this.ed.world.planTouched();
      }
      this.stroke = false;
      this.panning = false;
    };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const f = Math.pow(1.15, -e.deltaY / 100);
        const z = Math.min(32, Math.max(0.2, this.zoom * f));
        // zoom around the cursor
        this.panX = mx - ((mx - this.panX) / this.zoom) * z;
        this.panY = my - ((my - this.panY) / this.zoom) * z;
        this.zoom = z;
        this.repaint();
      },
      { passive: false },
    );
    new ResizeObserver(() => this.repaint()).observe(this.canvas);
  }

  private dims(): [number, number] {
    const d = this.ed.world.raw.plan_dims();
    return [d[0], d[1]];
  }

  enter(): void {
    const [w] = this.dims();
    if (w === 0) {
      this.ed.world.raw.plan_init(parseInt(this.wIn.value, 10), parseInt(this.hIn.value, 10));
    }
    const [pw, ph] = this.dims();
    this.wIn.value = String(pw);
    this.hIn.value = String(ph);
    this.pane.hidden = false;
    this.ed.world.raw.gfx_plan_mode(true);
    // frame the disc in the 3D view
    const scale = this.ed.world.raw.plan_dims()[2];
    this.ed.viewport.setCameraMode('orbit');
    this.ed.viewport.target.set(0, 0, 0);
    this.ed.viewport.dist = Math.max(pw, ph) * scale * 0.85;
    this.ed.viewport.pitch = 0.7;
    this.fitView();
    this.refresh2d();
    this.refreshPreview();
    this.syncButtons();
  }

  exit(): void {
    this.pane.hidden = true;
    this.stroke = false;
    this.panning = false;
    this.ed.world.raw.gfx_plan_mode(false);
    this.ed.viewport.dist = Math.min(this.ed.viewport.dist, 60);
  }

  private syncButtons(): void {
    document.querySelectorAll<HTMLButtonElement>('#plan-tool-buttons button').forEach((b) => {
      b.classList.toggle('active', b.dataset.ptool === this.tool);
    });
    document.querySelectorAll<HTMLButtonElement>('#plan-layer-buttons button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.pl) === this.layer);
    });
  }

  private fitView(): void {
    const [w, h] = this.dims();
    const cw = this.canvas.clientWidth || 400;
    const ch = this.canvas.clientHeight || 400;
    this.zoom = Math.max(0.2, Math.min(cw / w, ch / h) * 0.92);
    this.panX = (cw - w * this.zoom) / 2;
    this.panY = (ch - h * this.zoom) / 2;
  }

  /** Undo/redo for plan strokes (separate history from the world's). */
  undo(): void {
    if (this.ed.world.raw.plan_undo()) this.afterHistory();
  }

  redo(): void {
    if (this.ed.world.raw.plan_redo()) this.afterHistory();
  }

  private afterHistory(): void {
    this.refresh2d();
    this.refreshPreview();
    this.ed.world.planTouched();
  }

  /** Pull fresh contour pixels from the core and repaint. */
  refresh2d(): void {
    const [w, h] = this.dims();
    if (w === 0) return;
    const rgba = this.ed.world.raw.plan_rgba(this.layer);
    this.off.width = w;
    this.off.height = h;
    const ctx = this.off.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    this.repaint();
  }

  private repaint(): void {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw === 0 || ch === 0 || this.off.width === 0) return;
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.canvas.getContext('2d')!;
    ctx.fillStyle = '#0c0e12';
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.off,
      this.panX,
      this.panY,
      this.off.width * this.zoom,
      this.off.height * this.zoom,
    );
  }

  /** Throttled rebuild of the 3D disc preview. */
  private refreshPreview(): void {
    if (this.previewTimer) return;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      const [w, h] = this.dims();
      const step = Math.max(1, Math.ceil(Math.max(w, h) / 256));
      this.ed.world.raw.gfx_plan_preview(step);
    }, 150);
  }

  private applyAt(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left - this.panX) / this.zoom;
    const cy = (e.clientY - rect.top - this.panY) / this.zoom;
    const raw = this.ed.world.raw;
    switch (this.tool) {
      case 'raise':
        raw.plan_brush(cx, cy, this.radius, this.strength * 0.35, this.layer);
        break;
      case 'lower':
        raw.plan_brush(cx, cy, this.radius, -this.strength * 0.35, this.layer);
        break;
      case 'smooth':
        raw.plan_smooth(cx, cy, this.radius, 0.4, this.layer);
        break;
      case 'void':
        raw.plan_mask_brush(cx, cy, this.radius, false);
        break;
      case 'restore':
        raw.plan_mask_brush(cx, cy, this.radius, true);
        break;
    }
    this.refresh2d();
    this.refreshPreview();
  }

  // -- Mode interface (the 3D pane: camera-only interaction) --------------------

  pointerDown(e: PointerEvent): void {
    this.ed.viewport.beginCameraDrag('orbit', e);
  }

  pointerMove(): void {}

  pointerUp(): void {
    this.ed.viewport.endCameraDrag();
  }

  rmbClick(): void {}

  key(): boolean {
    return false;
  }

  statusInfo(): string {
    const [w, h, s] = this.ed.world.raw.plan_dims();
    return `plan ${w}×${h} (world ${w * s}×${h * s}) · ${this.tool} · ${this.layer === 0 ? 'top' : 'bottom'} · LMB paint · RMB/MMB pan · wheel zoom`;
  }
}
