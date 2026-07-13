import * as THREE from 'three';
import { BuildMode } from './build';
import { axisFrame, frameLocal } from './frame';
import { downloadText, loadScene, serializeScene } from './io';
import { type Quad, buildOutlineGeometry, buildQuadGeometry } from './meshbuilder';
import { Palette, type Stamp } from './palette';
import { ChunkRenderer } from './render';
import { SculptMode, type SculptTool } from './sculpt';
import { Tileset } from './tileset';
import { type Vec3, add, dot, mul, norm, sub } from './vec';
import { Viewport } from './viewport';
import type { FaceRef, RectSel, WorldHandle } from './world';

const AUTOSAVE_KEY = 'boxexplore.autosave.v1';
const GRID_STEPS = [1, 0.5, 0.25, 0.125];

type ModeName = 'build' | 'sculpt';

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
<b>O</b> reset the rect's corner offsets · <b>Esc</b> clear · <b>+ Voxel</b> (toolbar) seeds a cell when the scene is empty`,
  sculpt: `Tools (left panel): <b>M</b> select · <b>B</b> smooth brush · <b>F</b> draw brush (<b>Alt</b> inverts) — brushes paint over a radius<br>
Select: <b>click</b> · <b>click again</b> drags · <b>drag</b> box (<b>Shift</b> add) · <b>Ctrl/Cmd+click</b> path · <b>X/Y/Z</b> constrain (<b>Shift</b> plane) · <b>=/−</b> nudge · <b>H/U/J/N/O</b> on selection`,
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
  brush = { radius: 2.5, strength: 0.5, topo: false };

  /** Grid snap step is per-mode: sculpt work defaults finer than cell layout. */
  private gridStepByMode: Record<ModeName, number> = { build: 1, sculpt: 0.5 };

  get gridStep(): number {
    return this.gridStepByMode[this.mode?.name ?? 'build'] ?? 1;
  }

  set gridStep(v: number) {
    this.gridStepByMode[this.mode?.name ?? 'build'] = v;
  }

  readonly modes: Record<ModeName, Mode>;
  mode: Mode;

  private ghostMesh: THREE.Mesh;
  private ghostMat: THREE.MeshBasicMaterial;
  private selMesh: THREE.Mesh;
  private selOutline: THREE.LineSegments;
  private vertPoints: THREE.Points;
  private constraintLines: THREE.LineSegments;
  private brushRing: THREE.LineLoop;
  private lastGridKey = '';
  private lastCamKey = '';
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private fpsEma = 60;
  private handleCentroid: Vec3 | null = null;

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
    geom: document.getElementById('btn-geom') as HTMLButtonElement,
    tex: document.getElementById('btn-tex') as HTMLButtonElement,
    sculptPanel: document.getElementById('sculpt-panel') as HTMLDivElement,
    brushRadius: document.getElementById('brush-radius') as HTMLInputElement,
    brushRadiusVal: document.getElementById('brush-radius-val') as HTMLSpanElement,
    brushStrength: document.getElementById('brush-strength') as HTMLInputElement,
    brushStrengthVal: document.getElementById('brush-strength-val') as HTMLSpanElement,
    brushTopo: document.getElementById('brush-topo') as HTMLInputElement,
  };

  constructor(world: WorldHandle) {
    this.world = world;
    const canvas = document.getElementById('viewport') as HTMLCanvasElement;
    this.viewport = new Viewport(canvas);

    this.renderer = new ChunkRenderer();
    this.viewport.scene.add(this.renderer.group);

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

    // blender-style axis/plane constraint widget (sculpt mode)
    this.constraintLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }),
    );
    this.constraintLines.visible = false;
    this.constraintLines.frustumCulled = false;
    this.constraintLines.renderOrder = 9;
    this.viewport.scene.add(this.constraintLines);

    // brush cursor: a unit ring oriented to the surface, scaled to the radius
    const ringGeo = new THREE.BufferGeometry();
    const ringPts: number[] = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      ringPts.push(Math.cos(a), Math.sin(a), 0);
    }
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(ringPts, 3));
    this.brushRing = new THREE.LineLoop(
      ringGeo,
      new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.brushRing.visible = false;
    this.brushRing.frustumCulled = false;
    this.brushRing.renderOrder = 10;
    this.viewport.scene.add(this.brushRing);

    // palette (tileset preview — texturing the volume comes later)
    this.palette = new Palette(document.getElementById('palette') as HTMLCanvasElement, this.tileset);
    this.palette.onSelect = (s) => {
      this.stamp = s;
    };

    this.modes = {
      build: new BuildMode(this),
      sculpt: new SculptMode(this),
    };
    this.mode = this.modes.build;

    this.world.subscribe(() => {
      this.renderer.sync(this.world);
      (this.modes.sculpt as SculptMode).invalidateVisible();
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
    };
    this.renderer.rebuildAll(this.world);
    this.refreshOverlays();
  }

  toggleCameraMode(): void {
    this.viewport.setCameraMode(this.viewport.mode === 'orbit' ? 'fly' : 'orbit');
    this.el.camera.textContent = this.viewport.mode === 'orbit' ? 'Orbit' : 'Fly';
  }

  /** Watertightness numbers for the derived surface (used by verify scripts). */
  surfaceStats(): { faces: number; oddEdges: number } {
    return this.world.stats();
  }

  // -- edits ---------------------------------------------------------------------

  undo(): void {
    this.boxSel = null;
    this.world.undo();
  }

  redo(): void {
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

  setGhost(quads: Quad[] | null, erase = false): void {
    if (!quads || quads.length === 0) {
      this.ghostMesh.visible = false;
      return;
    }
    buildQuadGeometry(quads, this.ghostMesh.geometry as THREE.BufferGeometry);
    this.ghostMat.color.set(erase ? 0xff5566 : 0x9fd0ff);
    this.ghostMat.opacity = erase ? 0.45 : 0.35;
    this.ghostMesh.visible = true;
  }

  refreshOverlays(): void {
    const quads: Quad[] =
      this.mode.name === 'build' ? (this.modes.build as BuildMode).selectionFaces() : [];
    if (quads.length) {
      buildQuadGeometry(quads, this.selMesh.geometry as THREE.BufferGeometry);
      buildOutlineGeometry(quads, this.selOutline.geometry as THREE.BufferGeometry);
    }
    this.selMesh.visible = quads.length > 0;
    this.selOutline.visible = quads.length > 0;

    this.refreshConstraintWidget();

    // corner handles are select-tool chrome — brushes don't need (or pay for) them
    const sculpt = this.modes.sculpt as SculptMode;
    if (this.mode.name === 'sculpt' && sculpt.tool === 'select') {
      const handles = sculpt.visibleHandles();
      const positions = new Float32Array(handles.length * 3);
      const colors = new Float32Array(handles.length * 3);
      let cx = 0;
      let cy = 0;
      let cz = 0;
      handles.forEach((h, i) => {
        positions[i * 3] = h.pos.x;
        positions[i * 3 + 1] = h.pos.y;
        positions[i * 3 + 2] = h.pos.z;
        cx += h.pos.x;
        cy += h.pos.y;
        cz += h.pos.z;
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
      this.handleCentroid = handles.length
        ? { x: cx / handles.length, y: cy / handles.length, z: cz / handles.length }
        : null;
      const geo = this.vertPoints.geometry as THREE.BufferGeometry;
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeBoundingSphere();
      this.vertPoints.visible = handles.length > 0;
    } else {
      this.vertPoints.visible = false;
    }
  }

  /** Position/orient the brush cursor ring, or hide it (point = null). */
  setBrushCursor(point: Vec3 | null, normal?: Vec3, radius = 1): void {
    if (!point || !normal) {
      this.brushRing.visible = false;
      return;
    }
    this.brushRing.position.set(point.x, point.y, point.z);
    this.brushRing.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(normal.x, normal.y, normal.z),
    );
    this.brushRing.scale.setScalar(radius);
    this.brushRing.visible = true;
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
      this.constraintLines.visible = false;
      return;
    }
    const AXIS_COLORS: Array<[number, number, number]> = [
      [0.95, 0.35, 0.35],
      [0.45, 0.85, 0.4],
      [0.35, 0.55, 0.95],
    ];
    const axes = c.plane ? [0, 1, 2].filter((a) => a !== c.axis) : [c.axis];
    const positions: number[] = [];
    const colors: number[] = [];
    const EXT = 64;
    for (const a of axes) {
      const dir = [0, 0, 0];
      dir[a] = 1;
      positions.push(
        centroid.x - dir[0] * EXT,
        centroid.y - dir[1] * EXT,
        centroid.z - dir[2] * EXT,
        centroid.x + dir[0] * EXT,
        centroid.y + dir[1] * EXT,
        centroid.z + dir[2] * EXT,
      );
      const [r, g, b] = AXIS_COLORS[a];
      colors.push(r, g, b, r, g, b);
    }
    const geo = this.constraintLines.geometry as THREE.BufferGeometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
    this.constraintLines.visible = true;
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
    const hit = this.viewport.pickGroup(e, this.renderer.group);
    if (!hit || hit.faceIndex == null) return null;
    const face = this.renderer.faceAt(hit.object, hit.faceIndex);
    if (!face) return null;
    return { face, point: { x: hit.point.x, y: hit.point.y, z: hit.point.z } };
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
    this.el.sculptPanel.hidden = name !== 'sculpt';
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
          this.setMode('sculpt');
          return;
        case 'tab': {
          e.preventDefault();
          this.setMode(this.mode.name === 'build' ? 'sculpt' : 'build');
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
    this.el.geom.addEventListener('click', () => this.toggleGeomView());
    this.el.tex.addEventListener('click', () => this.toggleTexView());
    document.getElementById('btn-seed')!.addEventListener('click', () => {
      (this.modes.build as BuildMode).seedVoxel();
    });
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

  private tick(dt: number): void {
    if (dt > 0) this.fpsEma = this.fpsEma * 0.95 + (1 / dt) * 0.05;
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

    // corner handles are occlusion-filtered, so refresh them as the camera moves
    const sculpt = this.modes.sculpt as SculptMode;
    if (this.mode.name === 'sculpt' && sculpt.tool === 'select') {
      const camKey = `${eye.x.toFixed(2)},${eye.y.toFixed(2)},${eye.z.toFixed(2)},${this.viewport.yaw.toFixed(3)},${this.viewport.pitch.toFixed(3)}`;
      if (camKey !== this.lastCamKey) {
        this.lastCamKey = camKey;
        sculpt.invalidateVisible();
        this.refreshOverlays();
      }
      // shrink the handle dots as you zoom out so they don't wash the view
      if (this.vertPoints.visible) {
        const c = this.handleCentroid;
        const d =
          this.viewport.mode === 'orbit'
            ? this.viewport.dist
            : c
              ? Math.hypot(eye.x - c.x, eye.y - c.y, eye.z - c.z)
              : 14;
        (this.vertPoints.material as THREE.PointsMaterial).size = Math.max(
          2.5,
          Math.min(9, 126 / Math.max(d, 1)),
        );
      }
    }

    // distance-based LOD for far chunks
    this.renderer.updateLod(this.world, new THREE.Vector3(eye.x, eye.y, eye.z));

    const parts = [
      `${Math.round(this.fpsEma)} fps`,
      this.mode.name,
      `cam ${this.viewport.mode}`,
      `view ${this.geomView}/${this.texView}`,
      `grid ${this.gridStep}`,
      `${this.world.cellCount()} cells`,
      `${this.renderer.chunkCount()} chunks`,
    ];
    const info = this.mode.statusInfo();
    if (info) parts.push(info);
    this.el.statusbar.textContent = parts.join('  ·  ');
  }
}
