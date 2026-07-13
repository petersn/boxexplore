// Thin facade over the Rust wgpu renderer (gfx.rs) — view toggles, the LOD
// slider, and the debug/test counters the verify suite reads. All actual
// rendering, chunk meshing, LOD selection, and culling happen in the core.

import type { WorldHandle } from './world';

export interface ViewOpts {
  sculpted: boolean;
  tint: boolean;
  /** Show painted tiles (the "textured" view). */
  paint: boolean;
}

export class ChunkRenderer {
  private viewOpts: ViewOpts = { sculpted: true, tint: false, paint: true };
  private lodScaleValue = 1;

  constructor(private world: WorldHandle) {}

  get view(): ViewOpts {
    return this.viewOpts;
  }

  set view(v: ViewOpts) {
    this.viewOpts = v;
    this.world.raw.gfx_set_view(v.sculpted, v.tint, v.paint);
  }

  get lodScale(): number {
    return this.lodScaleValue;
  }

  set lodScale(k: number) {
    this.lodScaleValue = k;
    this.world.raw.gfx_set_lod_scale(k);
  }

  /** [chunks, regions, paintedFaces, pending, drawCalls, lod0..lod4] */
  private stats(): Uint32Array {
    return this.world.raw.gfx_stats();
  }

  chunkCount(): number {
    return this.stats()[0];
  }

  regionCount(): number {
    return this.stats()[1];
  }

  paintedFaceCount(): number {
    return this.stats()[2];
  }

  pending(): number {
    return this.stats()[3];
  }

  drawCalls(): number {
    return this.stats()[4];
  }

  lodCounts(): number[] {
    return [...this.stats().slice(5, 10)];
  }

  /** Test helper: raw-voxel-view geometry must be all-integer positions.
   *  Checks the core mesher output directly (the GPU buffers aren't readable). */
  allPositionsInteger(): boolean {
    const all = this.world.raw.all_chunk_positions();
    for (let i = 0; i < all.length; i += 3) {
      this.world.raw.mesh_chunk(all[i], all[i + 1], all[i + 2], false, false, false);
      const pos = this.world.raw.mesh_positions();
      for (let k = 0; k < pos.length; k++) {
        if (Math.abs(pos[k] - Math.round(pos[k])) > 1e-4) return false;
      }
    }
    return true;
  }
}
