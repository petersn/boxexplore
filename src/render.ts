// Per-chunk rendering of the wasm-produced surface meshes: three.js draws
// static buffers; the Rust core owns all geometry. Chunks remesh only when
// the core marks them dirty, and distant chunks can drop to LOD meshes.

import * as THREE from 'three';
import type { FaceRef, WorldHandle } from './world';

const CHUNK = 32;

interface ChunkEntry {
  mesh: THREE.Mesh;
  outline: THREE.LineSegments;
  faceKeys: Int32Array;
  /** 0 = full detail, 1/2 = LOD levels. */
  level: number;
  center: THREE.Vector3;
}

export interface ViewOpts {
  sculpted: boolean;
  tint: boolean;
  /** Show painted tiles (the "textured" view). */
  paint: boolean;
}

/** Distance thresholds (in world units) for LOD levels 1 and 2. */
const LOD_DISTS = [160, 320];
/** Cell outlines are editing chrome — hide them beyond this distance. */
const OUTLINE_DIST = 96;

export class ChunkRenderer {
  readonly group = new THREE.Group();
  view: ViewOpts = { sculpted: true, tint: false, paint: true };
  /** Enable distance-based LOD for far chunks. */
  lod = true;

  private chunks = new Map<string, ChunkEntry>();
  /** [0] flat-shaded faces, [1] painted faces sampling the tileset. */
  private materials: [THREE.MeshBasicMaterial, THREE.MeshBasicMaterial];
  private outlineMaterial: THREE.LineBasicMaterial;

  constructor(tilesetTexture: THREE.Texture) {
    this.materials = [
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
      new THREE.MeshBasicMaterial({
        map: tilesetTexture,
        vertexColors: true, // carries the lambert/AO shading for painted faces
        alphaTest: 0.5,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    ];
    this.outlineMaterial = new THREE.LineBasicMaterial({
      color: 0x0e1013,
      transparent: true,
      opacity: 0.4,
    });
  }

  /** Rebuild every chunk the core marked dirty. */
  sync(world: WorldHandle): void {
    const dirty = world.raw.take_dirty();
    for (let i = 0; i < dirty.length; i += 3) {
      this.buildChunk(world, dirty[i], dirty[i + 1], dirty[i + 2], 0);
    }
  }

  /** Rebuild everything (view toggles). */
  rebuildAll(world: WorldHandle): void {
    for (const key of [...this.chunks.keys()]) {
      this.removeChunk(key);
    }
    const all = world.raw.all_chunk_positions();
    for (let i = 0; i < all.length; i += 3) {
      this.buildChunk(world, all[i], all[i + 1], all[i + 2], 0);
    }
  }

  private removeChunk(key: string): void {
    const entry = this.chunks.get(key);
    if (!entry) return;
    this.group.remove(entry.mesh);
    this.group.remove(entry.outline);
    entry.mesh.geometry.dispose();
    entry.outline.geometry.dispose();
    this.chunks.delete(key);
  }

  private buildChunk(world: WorldHandle, cx: number, cy: number, cz: number, level: number): void {
    const key = `${cx},${cy},${cz}`;
    const faces =
      level === 0
        ? world.raw.mesh_chunk(cx, cy, cz, this.view.sculpted, this.view.tint, this.view.paint)
        : world.raw.mesh_chunk_lod(cx, cy, cz, level);
    if (faces === 0) {
      this.removeChunk(key);
      return;
    }
    const positions = world.raw.mesh_positions();
    const colors = world.raw.mesh_colors();
    const uvs = world.raw.mesh_uvs();
    const indices = world.raw.mesh_indices();
    const unpainted = level === 0 ? world.raw.mesh_unpainted_faces() : faces;
    const faceKeys = level === 0 ? new Int32Array(world.raw.mesh_face_keys()) : new Int32Array(0);

    let entry = this.chunks.get(key);
    if (!entry) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.materials);
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      const outline = new THREE.LineSegments(new THREE.BufferGeometry(), this.outlineMaterial);
      outline.frustumCulled = true;
      outline.matrixAutoUpdate = false;
      outline.raycast = () => {}; // picking targets the surface only
      this.group.add(mesh);
      this.group.add(outline);
      entry = {
        mesh,
        outline,
        faceKeys,
        level,
        center: new THREE.Vector3((cx + 0.5) * CHUNK, (cy + 0.5) * CHUNK, (cz + 0.5) * CHUNK),
      };
      entry.mesh.userData.chunkKey = key;
      this.chunks.set(key, entry);
    }
    entry.faceKeys = faceKeys;
    entry.level = level;
    const geo = entry.mesh.geometry;
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.clearGroups();
    geo.addGroup(0, unpainted * 6, 0); // flat-shaded faces
    if (faces > unpainted) geo.addGroup(unpainted * 6, (faces - unpainted) * 6, 1); // painted
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    // outline: the 4 edges of each quad (4 verts per face)
    const quadCount = positions.length / 12;
    const edges = new Float32Array(quadCount * 8 * 3);
    let pi = 0;
    for (let q = 0; q < quadCount; q++) {
      for (let k = 0; k < 4; k++) {
        const a = q * 4 + k;
        const b = q * 4 + ((k + 1) % 4);
        edges[pi++] = positions[a * 3];
        edges[pi++] = positions[a * 3 + 1];
        edges[pi++] = positions[a * 3 + 2];
        edges[pi++] = positions[b * 3];
        edges[pi++] = positions[b * 3 + 1];
        edges[pi++] = positions[b * 3 + 2];
      }
    }
    const ogeo = entry.outline.geometry;
    ogeo.setAttribute('position', new THREE.BufferAttribute(edges, 3));
    ogeo.computeBoundingSphere();
    // outlines get noisy at a distance; hide them for LOD chunks
    entry.outline.visible = level === 0;
  }

  /** Distance-based LOD: swap far chunks to coarse meshes. Call per frame. */
  updateLod(world: WorldHandle, eye: THREE.Vector3): void {
    if (!this.lod) return;
    let budget = 12; // remesh at most a few chunks per frame
    for (const [key, entry] of this.chunks) {
      const d = entry.center.distanceTo(eye);
      entry.outline.visible = entry.level === 0 && d < OUTLINE_DIST;
      const want = d > LOD_DISTS[1] ? 2 : d > LOD_DISTS[0] ? 1 : 0;
      if (want !== entry.level && budget > 0) {
        const [cx, cy, cz] = key.split(',').map(Number);
        this.buildChunk(world, cx, cy, cz, want);
        budget--;
      }
    }
  }

  /** Resolve a raycast hit to a (cell, dir) face reference. */
  faceAt(object: THREE.Object3D, faceIndex: number): FaceRef | null {
    const key = object.userData.chunkKey as string | undefined;
    if (!key) return null;
    const entry = this.chunks.get(key);
    if (!entry || entry.level !== 0) return null;
    const fi = faceIndex >> 1; // two triangles per quad
    if (fi * 4 + 3 >= entry.faceKeys.length) return null;
    return {
      cell: [entry.faceKeys[fi * 4], entry.faceKeys[fi * 4 + 1], entry.faceKeys[fi * 4 + 2]],
      dir: entry.faceKeys[fi * 4 + 3],
    };
  }

  /** Debug/test helper: are all rendered positions integers (raw voxel view)? */
  allPositionsInteger(): boolean {
    for (const entry of this.chunks.values()) {
      const pos = entry.mesh.geometry.getAttribute('position');
      if (!pos) continue;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < arr.length; i++) {
        if (Math.abs(arr[i] - Math.round(arr[i])) > 1e-4) return false;
      }
    }
    return true;
  }

  chunkCount(): number {
    return this.chunks.size;
  }

  /** Debug/test helper: total painted faces currently rendered. */
  paintedFaceCount(): number {
    let n = 0;
    for (const entry of this.chunks.values()) {
      const groups = entry.mesh.geometry.groups;
      if (groups.length > 1) n += groups[1].count / 6;
    }
    return n;
  }

  /** Debug/test helper: how many chunks are at each LOD level. */
  lodCounts(): [number, number, number] {
    const counts: [number, number, number] = [0, 0, 0];
    for (const entry of this.chunks.values()) counts[entry.level]++;
    return counts;
  }
}
