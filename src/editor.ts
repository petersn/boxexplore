import { BuildMode } from './build';
import { downloadBinary, idbGet, idbPut, loadScene, serializeScene } from './io';
import { type Quad, quadOutlinePoints, quadsToArray } from './meshbuilder';
import { PaintMode } from './paint';
import { PlanMode } from './planner';
import { PlayController } from './play';
import { Palette, type Stamp } from './palette';
import { ChunkRenderer } from './render';
import { SculptMode, type SculptTool } from './sculpt';
import { Tileset } from './tileset';
import { MVec, type Vec3, srgbHex } from './vec';
import { FOV_Y, NEAR, FAR, Viewport } from './viewport';
import type { FaceRef, RectSel, WorldHandle } from './world';

const AUTOSAVE_KEY = 'autosave';
const GRID_STEPS = [1, 0.5, 0.25, 0.125];

type ModeName = 'build' | 'sculpt' | 'paint' | 'plan';

interface Mode {
  readonly name: ModeName;
  enter(): void;
  exit(): void;
  pointerDown(e: PointerEvent): void;
  pointerMove(e: PointerEvent): void;
  pointerUp(e: PointerEvent): void;
  rmbClick(e: PointerEvent): void;
  key(e: KeyboardEvent): boolean;
  statusInfo(): string;
}

const MODE_HINTS: Record<ModeName, string> = {
  build: `<b>Click a face</b> or <b>drag a rect</b> on its plane (overhang ok) to select, then <b>=</b> extrude present faces · <b>−</b> carve the footprint<br>
<b>O</b> reset the rect's corner offsets · <b>Esc</b> clear · <b>Slab</b> (toolbar) lays starter ground`,
  sculpt: `Tools (left panel): <b>M</b> select · <b>B</b> smooth brush · <b>F</b> draw brush (<b>Alt</b> inverts) — brushes paint over a radius<br>
Select: <b>click</b> · <b>click again</b> drags · <b>drag</b> box (<b>Shift</b> add) · <b>Ctrl/Cmd+click</b> path · <b>X/Y/Z</b> constrain (<b>Shift</b> plane) · <b>=/−</b> nudge · <b>H/U/J/N/O</b> on selection`,
  paint: `<b>Click/drag</b> paint the palette stamp onto faces (multi-tile stamps lay a grid-locked pattern)<br>
<b>R</b> rotate · <b>F</b> flip · <b>Alt+click</b> eyedrop · <b>X+drag</b> or <b>RMB</b> erase · geometry edits carry paint along`,
  plan: `Design the world at macro scale: <b>two height maps</b> (top + underside) and a <b>void mask</b>, 1 plan cell = 4×4 world cells<br>
Left: contour editor (<b>LMB</b> brush · <b>RMB/MMB</b> pan · <b>wheel</b> zoom) · Right: live 3D preview · <b>Generate world</b> builds the real volume`,
};

export class Editor {
  readonly world: WorldHandle;
  readonly tileset = new Tileset();
  readonly viewport: Viewport;
  readonly palette: Palette;
  readonly renderer: ChunkRenderer;

  stamp: Stamp = { tx: 0, ty: 0, w: 1, h: 1 };
  selectedVerts = new Set<string>();
  /** Build mode's active rectangle selection. */
  boxSel: RectSel | null = null;
  /** Geometry view: displaced surface, or the raw voxels underneath. */
  geomView: 'sculpted' | 'voxels' = 'sculpted';
  /** Texture view: untextured shows displacement magnitude as vertex color. */
  texView: 'textured' | 'untextured' = 'textured';
  /** Spatial brush settings (sculpt mode's Smooth/Draw tools). */
  brush = { radius: 2.5, strength: 0.5, topo: true };
  /** Paint brush settings: radius (0 = single face) and random scatter. */
  paintBrush = { radius: 0, scatter: false, unpaintedOnly: false };
  /** Play mode: run around the world with a third-person character. */
  playing = false;
  play: PlayController | null = null;
  private savedCamera: {
    mode: 'orbit' | 'fly';
    target: MVec;
    yaw: number;
    pitch: number;
    dist: number;
  } | null = null;

  /** Grid snap step is per-mode: sculpt work defaults finer than cell layout. */
  private gridStepByMode: Record<ModeName, number> = { build: 1, sculpt: 0.5, paint: 1, plan: 1 };

  get gridStep(): number {
    return this.gridStepByMode[this.mode?.name ?? 'build'] ?? 1;
  }

  set gridStep(v: number) {
    this.gridStepByMode[this.mode?.name ?? 'build'] = v;
  }

  readonly modes: Record<ModeName, Mode>;
  mode: Mode;

  private handleSizePx = 9;
  private lastCamKey = '';
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveDelay = 600;
  private fpsEma = 60;
  private handleCentroid: Vec3 | null = null;
  private heldKeys = new Set<string>();

  private el = {
    selbox: document.getElementById('selbox') as HTMLDivElement,
    statusbar: document.getElementById('statusbar') as HTMLDivElement,
    status: document.getElementById('status') as HTMLDivElement,
    gridStep: document.getElementById('grid-step') as HTMLSelectElement,
    tileSize: document.getElementById('tile-size') as HTMLInputElement,
    help: document.getElementById('help-overlay') as HTMLDivElement,
    fileTileset: document.getElementById('file-tileset') as HTMLInputElement,
    fileScene: document.getElementById('file-scene') as HTMLInputElement,
    camera: document.getElementById('btn-camera') as HTMLButtonElement,
    play: document.getElementById('btn-play') as HTMLButtonElement,
    geom: document.getElementById('btn-geom') as HTMLButtonElement,
    tex: document.getElementById('btn-tex') as HTMLButtonElement,
    tilesetPanel: document.getElementById('tileset-panel') as HTMLDivElement,
    buildPanel: document.getElementById('build-panel') as HTMLDivElement,
    lodScale: document.getElementById('lod-scale') as HTMLInputElement,
    lodScaleVal: document.getElementById('lod-scale-val') as HTMLSpanElement,
    sculptPanel: document.getElementById('sculpt-panel') as HTMLDivElement,
    brushRadius: document.getElementById('brush-radius') as HTMLInputElement,
    brushRadiusVal: document.getElementById('brush-radius-val') as HTMLSpanElement,
    brushStrength: document.getElementById('brush-strength') as HTMLInputElement,
    brushStrengthVal: document.getElementById('brush-strength-val') as HTMLSpanElement,
    brushTopo: document.getElementById('brush-topo') as HTMLInputElement,
    paintPanel: document.getElementById('paint-panel') as HTMLDivElement,
    paintRadius: document.getElementById('paint-radius') as HTMLInputElement,
    paintRadiusVal: document.getElementById('paint-radius-val') as HTMLSpanElement,
    paintScatter: document.getElementById('paint-scatter') as HTMLInputElement,
    paintUnpainted: document.getElementById('paint-unpainted') as HTMLInputElement,
  };

  constructor(world: WorldHandle) {
    this.world = world;
    const canvas = document.getElementById('viewport') as HTMLCanvasElement;
    this.viewport = new Viewport(canvas);
    this.viewport.setCameraMode('fly'); // default camera is fly; P toggles orbit

    this.renderer = new ChunkRenderer(this.world);
    this.viewport.onResize = (w, h) => this.world.raw.gfx_resize(w, h);

    // axes helper at the origin (overlay slot 5)
    const axes: number[] = [];
    const axisCol: Array<[number, number, number]> = [
      [0.9, 0.2, 0.2],
      [0.3, 0.8, 0.3],
      [0.25, 0.45, 0.9],
    ];
    for (let a = 0; a < 3; a++) {
      const d = [0, 0, 0];
      d[a] = 1.5;
      const [r, g, b] = axisCol[a];
      axes.push(0, 0, 0, r, g, b, 0.7, d[0], d[1], d[2], r, g, b, 0.7);
    }
    this.world.raw.gfx_overlay_lines_colored(5, new Float32Array(axes));

    // palette (tileset preview — texturing the volume comes later)
    this.palette = new Palette(document.getElementById('palette') as HTMLCanvasElement, this.tileset);
    this.palette.onSelect = (s) => {
      this.stamp = s;
    };

    this.modes = {
      build: new BuildMode(this),
      sculpt: new SculptMode(this),
      paint: new PaintMode(this),
      plan: new PlanMode(this),
    };
    this.mode = this.modes.build;

    this.world.subscribe(() => {
      (this.modes.sculpt as SculptMode).invalidateVisible();
      this.pruneSelection();
      this.refreshOverlays();
      this.scheduleAutosave();
    });
    this.tileset.subscribe(() => {
      this.el.tileSize.value = String(this.tileset.tileSize);
      this.uploadTileset();
      this.scheduleAutosave();
    });
    this.uploadTileset();

    this.bindPointer(canvas);
    this.bindKeys();
    this.bindToolbar();
    this.bindDragDrop();

    this.viewport.onTick = (dt) => this.tick(dt);
    this.setMode('build');
    this.restoreAutosave();
  }

  // -- views ---------------------------------------------------------------------

  toggleGeomView(): void {
    this.geomView = this.geomView === 'sculpted' ? 'voxels' : 'sculpted';
    this.el.geom.textContent = this.geomView === 'sculpted' ? 'Sculpted' : 'Voxels';
    this.applyView();
  }

  toggleTexView(): void {
    this.texView = this.texView === 'textured' ? 'untextured' : 'textured';
    this.el.tex.textContent = this.texView === 'textured' ? 'Textured' : 'Untextured';
    this.applyView();
  }

  private applyView(): void {
    this.renderer.view = {
      sculpted: this.geomView === 'sculpted',
      tint: this.texView === 'untextured',
      paint: this.texView === 'textured',
    };
    this.refreshOverlays();
  }

  private uploadTileset(): void {
    const { width, height, data } = this.tileset.rgba();
    this.world.raw.gfx_set_tileset(width, height, data);
    this.world.setTilesetGrid(this.tileset.cols, this.tileset.rows);
  }

  toggleCameraMode(): void {
    this.viewport.setCameraMode(this.viewport.mode === 'orbit' ? 'fly' : 'orbit');
    this.el.camera.textContent = this.viewport.mode === 'orbit' ? 'Orbit' : 'Fly';
  }

  togglePlay(): void {
    if (!this.playing && this.mode.name === 'plan') this.setMode('build');
    if (this.playing) {
      this.playing = false;
      if (this.play) {
        this.world.raw.gfx_set_player(new Float32Array(0));
        this.play = null;
      }
      this.viewport.suspendFly = false;
      this.viewport.distClamp = null;
      const c = this.savedCamera;
      if (c) {
        this.viewport.setCameraMode(c.mode);
        this.viewport.target.copy(c.target);
        this.viewport.yaw = c.yaw;
        this.viewport.pitch = c.pitch;
        this.viewport.dist = c.dist;
      }
      this.el.play.classList.remove('active');
      this.refreshOverlays();
      return;
    }
    // enter play: drop the character where the camera is looking
    this.savedCamera = {
      mode: this.viewport.mode,
      target: this.viewport.target.clone(),
      yaw: this.viewport.yaw,
      pitch: this.viewport.pitch,
      dist: this.viewport.dist,
    };
    this.viewport.setCameraMode('orbit');
    this.viewport.suspendFly = true;
    this.playing = true;
    this.play = new PlayController(this.world);
    this.play.spawnAt(this.viewport.target.x, this.viewport.target.z);
    this.viewport.dist = 16;
    this.viewport.pitch = Math.max(0.25, this.viewport.pitch);
    this.setGhost(null);
    this.setStampGhost(null);
    this.setBrushCursor(null);
    this.hideSelBox();
    this.el.play.classList.add('active');
    this.refreshOverlays();
  }

  /** Watertightness numbers for the derived surface (used by verify scripts). */
  surfaceStats(): { faces: number; oddEdges: number } {
    return this.world.stats();
  }

  // -- edits ---------------------------------------------------------------------

  undo(): void {
    if (this.mode.name === 'plan') {
      (this.modes.plan as PlanMode).undo();
      return;
    }
    this.boxSel = null;
    this.world.undo();
  }

  redo(): void {
    if (this.mode.name === 'plan') {
      (this.modes.plan as PlanMode).redo();
      return;
    }
    this.boxSel = null;
    this.world.redo();
  }

  private pruneSelection(): void {
    for (const key of this.selectedVerts) {
      if (!key.startsWith('L:') || !this.world.surfaceHasCorner(key.slice(2))) {
        this.selectedVerts.delete(key);
      }
    }
  }

  // -- overlays --------------------------------------------------------------------

  /** Show a textured preview of what a paint click will place. */
  setStampGhost(preview: { quads: Quad[]; uvs: number[] } | null): void {
    if (!preview || preview.quads.length === 0) {
      this.world.raw.gfx_overlay_quads(6, new Float32Array(0), new Float32Array(0), 1, 1, 1, 1);
      return;
    }
    this.world.raw.gfx_overlay_quads(
      6,
      quadsToArray(preview.quads),
      new Float32Array(preview.uvs),
      1,
      1,
      1,
      0.85,
    );
  }

  setGhost(quads: Quad[] | null, erase = false): void {
    if (!quads || quads.length === 0) {
      this.world.raw.gfx_overlay_quads(0, new Float32Array(0), new Float32Array(0), 1, 1, 1, 1);
      return;
    }
    const [r, g, b] = srgbHex(erase ? 0xff5566 : 0x9fd0ff);
    this.world.raw.gfx_overlay_quads(
      0,
      quadsToArray(quads),
      new Float32Array(0),
      r,
      g,
      b,
      erase ? 0.45 : 0.35,
    );
  }

  refreshOverlays(): void {
    const gfx = this.world.raw;
    const none = new Float32Array(0);
    if (this.playing) {
      gfx.gfx_overlay_quads(1, none, none, 1, 1, 1, 1);
      gfx.gfx_overlay_lines(2, none, 1, 1, 1, 1);
      gfx.gfx_overlay_lines_colored(3, none);
      gfx.gfx_set_handles(none);
      return;
    }
    const quads: Quad[] =
      this.mode.name === 'build' ? (this.modes.build as BuildMode).selectionFaces() : [];
    if (quads.length) {
      const [r, g, b] = srgbHex(0x4da3ff);
      gfx.gfx_overlay_quads(1, quadsToArray(quads), none, r, g, b, 0.3);
      const [lr, lg, lb] = srgbHex(0x7fc1ff);
      gfx.gfx_overlay_lines(2, quadOutlinePoints(quads), lr, lg, lb, 1);
    } else {
      gfx.gfx_overlay_quads(1, none, none, 1, 1, 1, 1);
      gfx.gfx_overlay_lines(2, none, 1, 1, 1, 1);
    }

    this.refreshConstraintWidget();

    // corner handles are select-tool chrome — brushes don't need (or pay for) them
    const sculpt = this.modes.sculpt as SculptMode;
    if (this.mode.name === 'sculpt' && sculpt.tool === 'select') {
      const handles = sculpt.visibleHandles();
      const data = new Float32Array(handles.length * 8);
      let cx = 0;
      let cy = 0;
      let cz = 0;
      handles.forEach((h, i) => {
        data[i * 8] = h.pos.x;
        data[i * 8 + 1] = h.pos.y;
        data[i * 8 + 2] = h.pos.z;
        data[i * 8 + 3] = this.handleSizePx;
        cx += h.pos.x;
        cy += h.pos.y;
        cz += h.pos.z;
        if (h.selected) {
          data.set([1, 0.65, 0.25, 1], i * 8 + 4);
        } else {
          data.set([0.85, 0.88, 0.95, 1], i * 8 + 4);
        }
      });
      this.handleCentroid = handles.length
        ? { x: cx / handles.length, y: cy / handles.length, z: cz / handles.length }
        : null;
      gfx.gfx_set_handles(data);
    } else {
      gfx.gfx_set_handles(none);
    }
  }

  /** Position/orient the brush cursor ring, or hide it (point = null). */
  setBrushCursor(point: Vec3 | null, normal?: Vec3, radius = 1): void {
    if (!point || !normal) {
      this.world.raw.gfx_overlay_lines(4, new Float32Array(0), 1, 1, 1, 1);
      return;
    }
    // ring in the plane perpendicular to the normal
    const n = normal;
    const ref = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const ux = n.y * ref.z - n.z * ref.y;
    const uy = n.z * ref.x - n.x * ref.z;
    const uz = n.x * ref.y - n.y * ref.x;
    const ul = Math.hypot(ux, uy, uz) || 1;
    const u = { x: ux / ul, y: uy / ul, z: uz / ul };
    const v = {
      x: n.y * u.z - n.z * u.y,
      y: n.z * u.x - n.x * u.z,
      z: n.x * u.y - n.y * u.x,
    };
    const SEG = 48;
    const pts: number[] = [];
    for (let i = 0; i < SEG; i++) {
      for (const a of [(i / SEG) * Math.PI * 2, (((i + 1) % SEG) / SEG) * Math.PI * 2]) {
        pts.push(
          point.x + (u.x * Math.cos(a) + v.x * Math.sin(a)) * radius,
          point.y + (u.y * Math.cos(a) + v.y * Math.sin(a)) * radius,
          point.z + (u.z * Math.cos(a) + v.z * Math.sin(a)) * radius,
        );
      }
    }
    const [r, g, b] = srgbHex(0xffe08a);
    this.world.raw.gfx_overlay_lines(4, new Float32Array(pts), r, g, b, 0.85);
  }

  /** Sync the sculpt-tool buttons with the active tool. */
  updateToolButtons(): void {
    const tool = (this.modes.sculpt as SculptMode).tool;
    document.querySelectorAll<HTMLButtonElement>('#tool-buttons button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
  }

  /** Axis lines through the sculpt selection while an x/y/z constraint is active. */
  private refreshConstraintWidget(): void {
    const vm = this.modes.sculpt as SculptMode;
    const c = this.mode.name === 'sculpt' ? vm.constraint : null;
    const centroid = c ? vm.selectionCentroid() : null;
    if (!c || !centroid) {
      this.world.raw.gfx_overlay_lines_colored(3, new Float32Array(0));
      return;
    }
    const AXIS_COLORS: Array<[number, number, number]> = [
      [0.95, 0.35, 0.35],
      [0.45, 0.85, 0.4],
      [0.35, 0.55, 0.95],
    ];
    const axes = c.plane ? [0, 1, 2].filter((a) => a !== c.axis) : [c.axis];
    const data: number[] = [];
    const EXT = 64;
    for (const a of axes) {
      const dir = [0, 0, 0];
      dir[a] = 1;
      const [r, g, b] = AXIS_COLORS[a];
      data.push(
        centroid.x - dir[0] * EXT,
        centroid.y - dir[1] * EXT,
        centroid.z - dir[2] * EXT,
        r,
        g,
        b,
        0.85,
        centroid.x + dir[0] * EXT,
        centroid.y + dir[1] * EXT,
        centroid.z + dir[2] * EXT,
        r,
        g,
        b,
        0.85,
      );
    }
    this.world.raw.gfx_overlay_lines_colored(3, new Float32Array(data));
  }

  showSelBox(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const el = this.el.selbox;
    el.hidden = false;
    el.style.left = `${Math.min(a.x, b.x)}px`;
    el.style.top = `${Math.min(a.y, b.y)}px`;
    el.style.width = `${Math.abs(a.x - b.x)}px`;
    el.style.height = `${Math.abs(a.y - b.y)}px`;
  }

  hideSelBox(): void {
    this.el.selbox.hidden = true;
  }

  // -- picking ------------------------------------------------------------------

  pickVolFace(e: PointerEvent): { face: FaceRef; point: Vec3 } | null {
    const ray = this.viewport.rayFromEvent(e);
    const hit = this.world.pick(ray.origin, ray.dir, this.geomView === 'sculpted');
    if (!hit) return null;
    return { face: hit.face, point: hit.point };
  }

  /** Like pickVolFace, from canvas coordinates (paint sweep interpolation). */
  pickVolFaceAt(x: number, y: number): { face: FaceRef; point: Vec3 } | null {
    const ray = this.viewport.rayAt(x, y);
    const hit = this.world.pick(ray.origin, ray.dir, this.geomView === 'sculpted');
    if (!hit) return null;
    return { face: hit.face, point: hit.point };
  }

  // -- modes ---------------------------------------------------------------------

  setMode(name: ModeName): void {
    // hand a build-mode rect selection over to sculpt mode as its corners
    let handoff: string[] | null = null;
    if (this.mode.name === 'build' && name === 'sculpt' && this.boxSel) {
      handoff = (this.modes.build as BuildMode).selectionLatticeKeys();
    }
    this.mode.exit();
    this.mode = this.modes[name];
    this.mode.enter();
    if (handoff?.length) {
      this.selectedVerts.clear();
      for (const lk of handoff) this.selectedVerts.add(`L:${lk}`);
    }
    this.el.tilesetPanel.hidden = name !== 'paint';
    this.el.buildPanel.hidden = name !== 'build';
    this.el.sculptPanel.hidden = name !== 'sculpt';
    this.el.paintPanel.hidden = name !== 'paint';
    document.querySelectorAll<HTMLButtonElement>('#mode-buttons button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === name);
    });
    this.el.status.innerHTML = MODE_HINTS[name];
    this.el.gridStep.value = String(this.gridStep);
    this.refreshOverlays();
  }

  // -- persistence ------------------------------------------------------------------

  private scheduleAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      const t0 = performance.now();
      const bytes = serializeScene(this);
      // serialization blocks the frame — big documents back off so editing
      // stays smooth (a 15 MB world saves every ~2 s instead of every 0.6 s)
      this.autosaveDelay = Math.min(20000, Math.max(600, (performance.now() - t0) * 25));
      idbPut(AUTOSAVE_KEY, bytes).catch(() => {
        // storage may be unavailable; skip silently
      });
    }, this.autosaveDelay);
  }

  private async restoreAutosave(): Promise<void> {
    try {
      const raw = await idbGet(AUTOSAVE_KEY);
      if (raw) await loadScene(this, raw);
    } catch (err) {
      console.warn('autosave restore failed', err);
    }
  }

  afterSceneLoad(): void {
    this.world.clearHistory();
    this.selectedVerts.clear();
    this.boxSel = null;
    this.palette.refresh();
    this.el.tileSize.value = String(this.tileset.tileSize);
    this.refreshOverlays();
  }

  private newScene(): void {
    if (this.world.cellCount() && !confirm('Clear the whole scene?')) return;
    this.world.clear();
    this.selectedVerts.clear();
    this.boxSel = null;
    this.world.makeSlab(16, 16, 2); // starter ground: never leave the user stuck
    this.refreshOverlays();
  }

  /** Toolbar Slab button: ask for dimensions, lay ground centered at origin. */
  promptSlab(): void {
    const raw = prompt('Slab size: width (x)  depth (z)  thickness (y)', '24 24 2');
    if (!raw) return;
    const nums = raw.split(/[\s,x×]+/).map((t) => parseInt(t, 10)).filter((n) => Number.isFinite(n));
    if (nums.length < 2) return;
    const [sx, sz, t] = [nums[0], nums[1], nums[2] ?? 1];
    this.world.makeSlab(sx, sz, t);
    this.refreshOverlays();
  }

  // -- input wiring -------------------------------------------------------------------

  private bindPointer(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      if (this.playing) {
        // any button orbits the chase camera
        this.viewport.beginCameraDrag('orbit', e);
        return;
      }
      if (e.button === 2) this.viewport.beginCameraDrag('orbit', e);
      else if (e.button === 1) {
        e.preventDefault();
        this.viewport.beginCameraDrag('pan', e);
      } else if (e.button === 0) this.mode.pointerDown(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.viewport.cameraDragActive) this.viewport.moveCameraDrag(e);
      else this.mode.pointerMove(e);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (this.viewport.cameraDragActive) {
        const moved = this.viewport.endCameraDrag();
        if (e.button === 2 && moved < 6) this.mode.rmbClick(e);
      } else if (e.button === 0) {
        this.mode.pointerUp(e);
      }
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.viewport.zoom(e.deltaY);
    }, { passive: false });
  }

  keyHeld(k: string): boolean {
    return this.heldKeys.has(k);
  }

  private bindKeys(): void {
    window.addEventListener('keyup', (e) => this.heldKeys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.heldKeys.clear());
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      this.heldKeys.add(e.key.toLowerCase());

      if (this.playing) {
        const low = e.key.toLowerCase();
        if (low === 'g' || low === 'escape') this.togglePlay();
        if (low === ' ') e.preventDefault();
        return;
      }

      if (!this.el.help.hidden) {
        if (e.key === 'Escape' || e.key === '?') this.el.help.hidden = true;
        return;
      }

      const low = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        switch (low) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) this.redo();
            else this.undo();
            return;
          case 'y':
            e.preventDefault();
            this.redo();
            return;
          case 's':
            e.preventDefault();
            downloadBinary('scene.bxw', serializeScene(this));
            return;
          case 'o':
            e.preventDefault();
            this.el.fileScene.click();
            return;
          default:
            if (this.mode.key(e)) e.preventDefault();
            return;
        }
      }

      switch (low) {
        case '1':
          this.setMode('build');
          return;
        case '2':
          this.setMode('sculpt');
          return;
        case '3':
          this.setMode('paint');
          return;
        case '4':
          this.setMode('plan');
          return;
        case 'tab': {
          e.preventDefault();
          const order: ModeName[] = ['build', 'sculpt', 'paint'];
          this.setMode(order[(order.indexOf(this.mode.name) + 1) % order.length]);
          return;
        }
        case '[':
          this.cycleGridStep(-1);
          return;
        case ']':
          this.cycleGridStep(1);
          return;
        case 'g':
          this.togglePlay();
          return;
        case '?':
          this.el.help.hidden = false;
          return;
        case 'c':
          this.centerCamera();
          return;
        case 'p':
          this.toggleCameraMode();
          return;
        case 'v':
          this.toggleGeomView();
          return;
        case 't':
          this.toggleTexView();
          return;
        default:
          if (this.mode.key(e)) e.preventDefault();
      }
    });
    this.el.help.addEventListener('click', () => (this.el.help.hidden = true));
  }

  private cycleGridStep(dir: number): void {
    const i = GRID_STEPS.indexOf(this.gridStep);
    const next = GRID_STEPS[(i + dir + GRID_STEPS.length) % GRID_STEPS.length];
    this.gridStep = next;
    this.el.gridStep.value = String(next);
  }

  private centerCamera(): void {
    if (this.boxSel) {
      const s = this.boxSel;
      const p = [0, 0, 0];
      p[s.axis] = s.plane;
      const other = [0, 1, 2].filter((a) => a !== s.axis);
      p[other[0]] = (Math.min(s.a0, s.a1) + Math.max(s.a0, s.a1) + 1) / 2;
      p[other[1]] = (Math.min(s.b0, s.b1) + Math.max(s.b0, s.b1) + 1) / 2;
      this.viewport.centerOn({ x: p[0], y: p[1], z: p[2] });
      return;
    }
    this.viewport.centerOn({ x: 0, y: 0, z: 0 });
  }

  private bindToolbar(): void {
    document.querySelectorAll<HTMLButtonElement>('#mode-buttons button').forEach((b) => {
      b.addEventListener('click', () => this.setMode(b.dataset.mode as ModeName));
    });
    this.el.gridStep.addEventListener('change', () => {
      this.gridStep = parseFloat(this.el.gridStep.value);
    });
    this.el.camera.addEventListener('click', () => this.toggleCameraMode());
    this.el.play.addEventListener('click', () => this.togglePlay());
    this.el.geom.addEventListener('click', () => this.toggleGeomView());
    this.el.tex.addEventListener('click', () => this.toggleTexView());
    document.getElementById('btn-slab')!.addEventListener('click', () => this.promptSlab());
    document.querySelectorAll<HTMLButtonElement>('#tool-buttons button').forEach((b) => {
      b.addEventListener('click', () => {
        (this.modes.sculpt as SculptMode).setTool(b.dataset.tool as SculptTool);
      });
    });
    this.el.brushRadius.addEventListener('input', () => {
      this.brush.radius = parseFloat(this.el.brushRadius.value);
      this.el.brushRadiusVal.textContent = this.brush.radius.toFixed(1);
    });
    this.el.brushStrength.addEventListener('input', () => {
      this.brush.strength = parseFloat(this.el.brushStrength.value);
      this.el.brushStrengthVal.textContent = this.brush.strength.toFixed(2);
    });
    this.el.brushTopo.addEventListener('change', () => {
      this.brush.topo = this.el.brushTopo.checked;
    });
    this.el.paintRadius.addEventListener('input', () => {
      this.paintBrush.radius = parseFloat(this.el.paintRadius.value);
      this.el.paintRadiusVal.textContent = this.paintBrush.radius.toFixed(1);
      (this.modes.paint as PaintMode).refreshPreview();
    });
    this.el.paintScatter.addEventListener('change', () => {
      this.paintBrush.scatter = this.el.paintScatter.checked;
      (this.modes.paint as PaintMode).refreshPreview();
    });
    this.el.paintUnpainted.addEventListener('change', () => {
      this.paintBrush.unpaintedOnly = this.el.paintUnpainted.checked;
    });
    this.el.lodScale.addEventListener('input', () => {
      const v = parseFloat(this.el.lodScale.value);
      this.renderer.lodScale = v;
      this.el.lodScaleVal.textContent = `${v.toFixed(2).replace(/\.?0+$/, '')}×`;
    });
    document.getElementById('btn-undo')!.addEventListener('click', () => this.undo());
    document.getElementById('btn-redo')!.addEventListener('click', () => this.redo());
    document.getElementById('btn-new')!.addEventListener('click', () => this.newScene());
    document.getElementById('btn-save')!.addEventListener('click', () => {
      downloadBinary('scene.bxw', serializeScene(this));
    });
    document.getElementById('btn-open')!.addEventListener('click', () => this.el.fileScene.click());
    document.getElementById('btn-help')!.addEventListener('click', () => {
      this.el.help.hidden = !this.el.help.hidden;
    });
    document.getElementById('btn-load-tileset')!.addEventListener('click', () => {
      this.el.fileTileset.click();
    });

    this.el.fileTileset.addEventListener('change', async () => {
      const file = this.el.fileTileset.files?.[0];
      if (file) await this.tileset.loadImage(file);
      this.el.fileTileset.value = '';
    });
    this.el.fileScene.addEventListener('change', async () => {
      const file = this.el.fileScene.files?.[0];
      if (file) {
        try {
          await loadScene(this, await file.arrayBuffer());
        } catch (err) {
          alert(`Could not load scene: ${err}`);
        }
      }
      this.el.fileScene.value = '';
    });
    this.el.tileSize.addEventListener('change', () => {
      this.tileset.setTileSize(parseInt(this.el.tileSize.value, 10));
    });
  }

  private bindDragDrop(): void {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (file.type.startsWith('image/')) {
        await this.tileset.loadImage(file);
      } else if (file.name.endsWith('.json')) {
        try {
          await loadScene(this, await file.arrayBuffer());
        } catch (err) {
          alert(`Could not load scene: ${err}`);
        }
      }
    });
  }

  // -- per-frame ---------------------------------------------------------------------

  private tick(dt: number): void {
    if (dt > 0) this.fpsEma = this.fpsEma * 0.95 + (1 / dt) * 0.05;
    const eye = this.viewport.cameraPos();

    // corner handles are occlusion-filtered, so refresh them as the camera moves
    const sculpt = this.modes.sculpt as SculptMode;
    if (this.mode.name === 'sculpt' && sculpt.tool === 'select') {
      const camKey = `${eye.x.toFixed(2)},${eye.y.toFixed(2)},${eye.z.toFixed(2)},${this.viewport.yaw.toFixed(3)},${this.viewport.pitch.toFixed(3)}`;
      if (camKey !== this.lastCamKey) {
        this.lastCamKey = camKey;
        // shrink the handle dots as you zoom out so they don't wash the view
        const c = this.handleCentroid;
        const d =
          this.viewport.mode === 'orbit'
            ? this.viewport.dist
            : c
              ? Math.hypot(eye.x - c.x, eye.y - c.y, eye.z - c.z)
              : 14;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.handleSizePx = (Math.max(2.5, Math.min(9, 126 / Math.max(d, 1))) / 2) * dpr;
        sculpt.invalidateVisible();
        this.refreshOverlays();
      }
    }

    // play mode: step the character controller (drives the chase camera)
    if (this.playing && this.play) {
      this.play.update(dt, (k) => this.heldKeys.has(k), this.viewport);
    }

    // hand the frame to the Rust renderer (remesh budget + culling + draw)
    const f = this.viewport.forward();
    this.world.raw.gfx_frame(eye.x, eye.y, eye.z, f.x, f.y, f.z, FOV_Y, NEAR, FAR);

    const parts = [
      `${Math.round(this.fpsEma)} fps`,
      this.playing ? 'PLAYING (G/Esc exits)' : this.mode.name,
      `cam ${this.viewport.mode}`,
      `view ${this.geomView}/${this.texView}`,
      `grid ${this.gridStep}`,
      `${this.world.cellCount()} cells`,
      `${this.renderer.chunkCount()}+${this.renderer.regionCount()} meshes`,
      `${this.renderer.drawCalls()} draws`,
    ];
    const info = this.mode.statusInfo();
    if (info) parts.push(info);
    this.el.statusbar.textContent = parts.join('  ·  ');
  }
}
