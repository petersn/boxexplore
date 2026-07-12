import * as THREE from 'three';
import { type BoxSel, BuildMode } from './build';
import { type Stamp, axisFrame, frameLocal } from './frame';
import { downloadText, loadScene, serializeScene } from './io';
import { buildGeometry, buildOutlineGeometry, SceneMesh, VolMesh } from './meshbuilder';
import { Doc, type EditOp, type Face, History, opIsEmpty } from './model';
import { Palette } from './palette';
import { Tileset } from './tileset';
import { type Vec3, add, dot, mul, norm, sub } from './vec';
import { VertexMode } from './vertex';
import { Viewport } from './viewport';
import { type VolFace, boundaryStats, buildSurface, parseCell } from './volume';

const AUTOSAVE_KEY = 'boxexplore.autosave.v1';
const GRID_STEPS = [1, 0.5, 0.25, 0.125];

const EMPTY_SHIFTS = new Map<string, Vec3>();

type ModeName = 'build' | 'vertex';

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
  build: `<b>Click a face</b> or <b>drag a rect</b> on its plane (overhang ok) to select, then <b>=</b> extrude out · <b>−</b> carve in<br>
<b>RMB</b> carve one cell · <b>Esc</b> clear · <b>+ Voxel</b> (toolbar) seeds a cell when the scene is empty`,
  vertex: `<b>Click/drag</b> move corners in the view plane (<b>Shift</b> along the corner's normal, <b>Alt</b> no snap) · offsets clamp to ±½<br>
<b>drag empty</b> box select (visible corners only) · brushes: <b>H</b> smooth · <b>U/J</b> inflate/deflate · <b>Y</b> noise · <b>O</b> reset`,
};

export class Editor {
  readonly doc = new Doc();
  readonly history = new History();
  readonly tileset = new Tileset();
  readonly viewport: Viewport;
  readonly palette: Palette;
  readonly sceneMesh: SceneMesh;
  readonly volMesh: VolMesh;

  /** Derived volume boundary (always sculpted), rebuilt when cells/shifts change. */
  surface: VolFace[] = [];
  surfaceMap = new Map<string, VolFace>();
  surfaceLattice = new Set<string>();
  /** What's on screen: sculpted surface, or raw voxels in the voxel view. */
  displaySurface: VolFace[] = [];
  displayMap = new Map<string, VolFace>();

  stamp: Stamp = { tx: 0, ty: 0, w: 1, h: 1 };
  selectedVerts = new Set<string>();
  /** Build mode's active rectangle selection. */
  boxSel: BoxSel | null = null;
  viewMode: 'sculpted' | 'voxels' = 'sculpted';

  /** Grid snap step is per-mode: vertex work defaults finer than cell layout. */
  private gridStepByMode: Record<ModeName, number> = { build: 1, vertex: 0.5 };

  get gridStep(): number {
    return this.gridStepByMode[this.mode?.name ?? 'build'] ?? 1;
  }

  set gridStep(v: number) {
    this.gridStepByMode[this.mode?.name ?? 'build'] = v;
  }

  private modes: Record<ModeName, Mode>;
  private mode: Mode;

  private ghostMesh: THREE.Mesh;
  private ghostMat: THREE.MeshBasicMaterial;
  private selMesh: THREE.Mesh;
  private selOutline: THREE.LineSegments;
  private volOutline: THREE.LineSegments;
  private vertPoints: THREE.Points;
  private lastGridKey = '';
  private lastVolVersion = -1;
  private lastCamKey = '';
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

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
    view: document.getElementById('btn-view') as HTMLButtonElement,
  };

  constructor() {
    const canvas = document.getElementById('viewport') as HTMLCanvasElement;
    this.viewport = new Viewport(canvas);

    // free detail quads (legacy scenes still render; texturing returns later)
    const mainMat = new THREE.MeshBasicMaterial({
      map: this.tileset.texture,
      side: THREE.DoubleSide,
      alphaTest: 0.5,
    });
    this.sceneMesh = new SceneMesh(mainMat);
    this.viewport.scene.add(this.sceneMesh.mesh);

    // derived volume surface: untextured, flat-shaded by normal + AO, pushed
    // back a hair so overlays win the depth fight
    const volMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.volMesh = new VolMesh(volMat);
    this.viewport.scene.add(this.volMesh.mesh);

    this.volOutline = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x0e1013, transparent: true, opacity: 0.4 }),
    );
    this.volOutline.frustumCulled = false;
    this.viewport.scene.add(this.volOutline);

    this.ghostMat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.ghostMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.ghostMat);
    this.ghostMesh.visible = false;
    this.ghostMesh.frustumCulled = false;
    this.ghostMesh.renderOrder = 5;
    this.viewport.scene.add(this.ghostMesh);

    this.selMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x4da3ff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.selMesh.visible = false;
    this.selMesh.frustumCulled = false;
    this.selMesh.renderOrder = 6;
    this.viewport.scene.add(this.selMesh);

    this.selOutline = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x7fc1ff }),
    );
    this.selOutline.visible = false;
    this.selOutline.frustumCulled = false;
    this.selOutline.renderOrder = 7;
    this.viewport.scene.add(this.selOutline);

    this.vertPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        size: 9,
        sizeAttenuation: false,
        vertexColors: true,
        depthTest: false,
        transparent: true,
      }),
    );
    this.vertPoints.visible = false;
    this.vertPoints.frustumCulled = false;
    this.vertPoints.renderOrder = 8;
    this.viewport.scene.add(this.vertPoints);

    // palette (tileset preview — texturing the volume comes later)
    this.palette = new Palette(document.getElementById('palette') as HTMLCanvasElement, this.tileset);
    this.palette.onSelect = (s) => {
      this.stamp = s;
    };

    this.modes = {
      build: new BuildMode(this),
      vertex: new VertexMode(this),
    };
    this.mode = this.modes.build;

    this.doc.subscribe(() => {
      this.rebuildSurface();
      this.sceneMesh.rebuild([...this.doc.faces.values()]);
      this.pruneSelection();
      this.refreshOverlays();
      this.scheduleAutosave();
    });
    this.tileset.subscribe(() => {
      this.tileset.texture.needsUpdate = true;
      this.el.tileSize.value = String(this.tileset.tileSize);
      this.scheduleAutosave();
    });

    this.bindPointer(canvas);
    this.bindKeys();
    this.bindToolbar();
    this.bindDragDrop();

    this.viewport.onTick = () => this.tick();
    this.sceneMesh.rebuild([]);
    this.rebuildSurface();
    this.setMode('build');
    this.restoreAutosave();
  }

  // -- derived volume surface ---------------------------------------------------

  private rebuildSurface(): void {
    if (this.doc.volVersion === this.lastVolVersion) return;
    this.lastVolVersion = this.doc.volVersion;
    this.surface = buildSurface(this.doc.cells, this.doc.shifts);
    this.surfaceMap.clear();
    this.surfaceLattice.clear();
    for (const f of this.surface) {
      this.surfaceMap.set(f.key, f);
      for (const lk of f.lattice) this.surfaceLattice.add(lk);
    }
    this.renderSurface();
  }

  /** (Re)build the displayed surface for the current view mode. */
  private renderSurface(): void {
    if (this.viewMode === 'voxels') {
      // debug view: raw voxels (offsets ignored), displaced corners tinted
      this.displaySurface = buildSurface(this.doc.cells, EMPTY_SHIFTS);
      this.volMesh.rebuild(this.displaySurface, this.doc.shifts);
    } else {
      this.displaySurface = this.surface;
      this.volMesh.rebuild(this.displaySurface);
    }
    this.displayMap.clear();
    for (const f of this.displaySurface) this.displayMap.set(f.key, f);
    buildOutlineGeometry(this.displaySurface, this.volOutline.geometry as THREE.BufferGeometry);
    this.volOutline.visible = this.displaySurface.length > 0;
  }

  toggleViewMode(): void {
    this.viewMode = this.viewMode === 'sculpted' ? 'voxels' : 'sculpted';
    this.el.view.textContent = this.viewMode === 'sculpted' ? 'Sculpted' : 'Voxels';
    this.renderSurface();
    this.refreshOverlays();
  }

  toggleCameraMode(): void {
    this.viewport.setCameraMode(this.viewport.mode === 'orbit' ? 'fly' : 'orbit');
    this.el.camera.textContent = this.viewport.mode === 'orbit' ? 'Orbit' : 'Fly';
  }

  /** Watertightness numbers for the derived surface (used by verify scripts). */
  surfaceStats(): { faces: number; oddEdges: number } {
    return boundaryStats(this.surface);
  }

  // -- edits ---------------------------------------------------------------------

  commit(op: EditOp): void {
    if (opIsEmpty(op)) return;
    this.doc.applyOp(op, 1);
    this.history.push(op);
  }

  /** Push an op whose changes were already applied live during a drag. */
  commitApplied(op: EditOp): void {
    if (opIsEmpty(op)) return;
    this.history.push(op);
    this.scheduleAutosave();
  }

  undo(): void {
    this.boxSel = null;
    this.history.undo(this.doc);
  }

  redo(): void {
    this.boxSel = null;
    this.history.redo(this.doc);
  }

  private pruneSelection(): void {
    for (const key of this.selectedVerts) {
      if (key.startsWith('L:')) {
        if (!this.surfaceLattice.has(key.slice(2))) this.selectedVerts.delete(key);
      } else {
        const id = Number(key.split(':')[0]);
        if (!this.doc.faces.has(id)) this.selectedVerts.delete(key);
      }
    }
  }

  // -- overlays --------------------------------------------------------------------

  /** `flat` drops the texture map — used for volume ghosts (plain tinted quads). */
  setGhost(faces: Face[] | null, erase = false, flat = true): void {
    if (!faces || faces.length === 0) {
      this.ghostMesh.visible = false;
      return;
    }
    const wantMap = flat ? null : this.tileset.texture;
    if (this.ghostMat.map !== wantMap) {
      this.ghostMat.map = wantMap;
      this.ghostMat.needsUpdate = true;
    }
    buildGeometry(faces, this.ghostMesh.geometry as THREE.BufferGeometry);
    this.ghostMat.color.set(erase ? 0xff5566 : flat ? 0x9fd0ff : 0xffffff);
    this.ghostMat.opacity = erase ? 0.45 : 0.35;
    this.ghostMesh.visible = true;
  }

  refreshOverlays(): void {
    const faces: Face[] =
      this.mode.name === 'build' ? (this.modes.build as BuildMode).selectionFaces() : [];
    if (faces.length) {
      buildGeometry(faces, this.selMesh.geometry as THREE.BufferGeometry);
      buildOutlineGeometry(faces, this.selOutline.geometry as THREE.BufferGeometry);
    }
    this.selMesh.visible = faces.length > 0;
    this.selOutline.visible = faces.length > 0;

    if (this.mode.name === 'vertex') {
      const handles = (this.modes.vertex as VertexMode).visibleHandles();
      const positions = new Float32Array(handles.length * 3);
      const colors = new Float32Array(handles.length * 3);
      handles.forEach((h, i) => {
        positions[i * 3] = h.pos.x;
        positions[i * 3 + 1] = h.pos.y;
        positions[i * 3 + 2] = h.pos.z;
        if (h.selected) {
          colors[i * 3] = 1;
          colors[i * 3 + 1] = 0.65;
          colors[i * 3 + 2] = 0.25;
        } else {
          colors[i * 3] = 0.85;
          colors[i * 3 + 1] = 0.88;
          colors[i * 3 + 2] = 0.95;
        }
      });
      const geo = this.vertPoints.geometry as THREE.BufferGeometry;
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeBoundingSphere();
      this.vertPoints.visible = handles.length > 0;
    } else {
      this.vertPoints.visible = false;
    }
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

  pickVolFace(e: PointerEvent): { vf: VolFace; point: Vec3 } | null {
    const hit = this.viewport.pickObject(e, this.volMesh.mesh);
    if (!hit) return null;
    const key = this.volMesh.keyAt(hit);
    const vf = key != null ? this.surfaceMap.get(key) : undefined;
    if (!vf) return null;
    return { vf, point: { x: hit.point.x, y: hit.point.y, z: hit.point.z } };
  }

  // -- modes ---------------------------------------------------------------------

  setMode(name: ModeName): void {
    this.mode.exit();
    this.mode = this.modes[name];
    this.mode.enter();
    document.querySelectorAll<HTMLButtonElement>('#mode-buttons button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === name);
    });
    this.el.status.innerHTML = MODE_HINTS[name];
    this.el.gridStep.value = String(this.gridStep);
    this.forceGridRebuild();
    this.refreshOverlays();
  }

  private forceGridRebuild(): void {
    this.lastGridKey = '';
  }

  // -- persistence ------------------------------------------------------------------

  private scheduleAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, serializeScene(this));
      } catch {
        // storage may be full or unavailable; skip silently
      }
    }, 600);
  }

  private async restoreAutosave(): Promise<void> {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return;
    try {
      await loadScene(this, raw);
    } catch (err) {
      console.warn('autosave restore failed', err);
    }
  }

  afterSceneLoad(): void {
    this.history.clear();
    this.selectedVerts.clear();
    this.boxSel = null;
    this.palette.refresh();
    this.el.tileSize.value = String(this.tileset.tileSize);
    this.refreshOverlays();
  }

  private newScene(): void {
    if ((this.doc.faces.size || this.doc.cells.size) && !confirm('Clear the whole scene?')) return;
    this.doc.clear();
    this.history.clear();
    this.selectedVerts.clear();
    this.boxSel = null;
    (this.modes.build as BuildMode).seedVoxel(); // never leave the user stuck
    this.refreshOverlays();
  }

  // -- input wiring -------------------------------------------------------------------

  private bindPointer(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
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

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;

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
            downloadText('scene.boxexplore.json', serializeScene(this));
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
          this.setMode('vertex');
          return;
        case 'tab': {
          e.preventDefault();
          this.setMode(this.mode.name === 'build' ? 'vertex' : 'build');
          return;
        }
        case '[':
          this.cycleGridStep(-1);
          return;
        case ']':
        case 'g':
          this.cycleGridStep(1);
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
          this.toggleViewMode();
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
    this.forceGridRebuild();
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
    if (this.doc.cells.size) {
      let c: Vec3 = { x: 0, y: 0, z: 0 };
      for (const key of this.doc.cells) {
        const [x, y, z] = parseCell(key);
        c = add(c, { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
      }
      this.viewport.centerOn(mul(c, 1 / this.doc.cells.size));
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
      this.forceGridRebuild();
    });
    this.el.camera.addEventListener('click', () => this.toggleCameraMode());
    this.el.view.addEventListener('click', () => this.toggleViewMode());
    document.getElementById('btn-seed')!.addEventListener('click', () => {
      (this.modes.build as BuildMode).seedVoxel();
    });
    document.getElementById('btn-undo')!.addEventListener('click', () => this.undo());
    document.getElementById('btn-redo')!.addEventListener('click', () => this.redo());
    document.getElementById('btn-new')!.addEventListener('click', () => this.newScene());
    document.getElementById('btn-save')!.addEventListener('click', () => {
      downloadText('scene.boxexplore.json', serializeScene(this));
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
          await loadScene(this, await file.text());
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
          await loadScene(this, await file.text());
        } catch (err) {
          alert(`Could not load scene: ${err}`);
        }
      }
    });
  }

  // -- per-frame ---------------------------------------------------------------------

  private tick(): void {
    // reference grid at y=0, centered where the view meets that plane
    const frame = axisFrame('y', 0);
    const eye = this.viewport.cameraPos();
    const fwd = this.viewport.forward();
    const n = norm(frame.n);
    const rel = dot(n, sub(frame.origin, eye)); // signed distance eye → plane
    const denom = dot(n, fwd);
    const t = Math.abs(denom) > 1e-4 ? rel / denom : Infinity;
    const center =
      t > 0.5 && t < 150
        ? add(eye, mul(fwd, t)) // where you're looking on the plane
        : add(eye, mul(n, rel)); // fallback: project the camera onto the plane
    const local = frameLocal(frame, center);
    const ca = Math.round(local.x);
    const cb = Math.round(local.y);
    const key = `${ca},${cb},${this.gridStep}`;
    if (key !== this.lastGridKey) {
      this.lastGridKey = key;
      this.viewport.rebuildGrid(frame, ca, cb, 16, this.gridStep);
    }

    // vertex handles are occlusion-filtered, so refresh them as the camera moves
    if (this.mode.name === 'vertex') {
      const camKey = `${eye.x.toFixed(2)},${eye.y.toFixed(2)},${eye.z.toFixed(2)},${this.viewport.yaw.toFixed(3)},${this.viewport.pitch.toFixed(3)}`;
      if (camKey !== this.lastCamKey) {
        this.lastCamKey = camKey;
        this.refreshOverlays();
      }
    }

    const parts = [
      this.mode.name,
      `cam ${this.viewport.mode}`,
      `view ${this.viewMode}`,
      `grid ${this.gridStep}`,
      `${this.doc.cells.size} cells`,
    ];
    if (this.doc.faces.size) parts.push(`${this.doc.faces.size} legacy faces`);
    const info = this.mode.statusInfo();
    if (info) parts.push(info);
    this.el.statusbar.textContent = parts.join('  ·  ');
  }
}
