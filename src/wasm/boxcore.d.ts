/* tslint:disable */
/* eslint-disable */

export class World {
    free(): void;
    [Symbol.dispose](): void;
    all_chunk_positions(): Int32Array;
    /**
     * Approximate document heap bytes (for the status/debug display).
     */
    approx_bytes(): number;
    /**
     * How far the chase camera can pull back before hitting geometry.
     */
    camera_clearance(fx: number, fy: number, fz: number, dx: number, dy: number, dz: number, dist: number, radius: number): number;
    cell_count(): number;
    clear(): void;
    clear_history(): void;
    clear_shift_raw(x: number, y: number, z: number): void;
    corner_normal(x: number, y: number, z: number): Float32Array;
    corner_pos(x: number, y: number, z: number): Float32Array;
    drag_begin(keys: Int32Array): void;
    drag_end(): boolean;
    drag_update(dx: number, dy: number, dz: number): void;
    erase_paint_face(x: number, y: number, z: number, d: number): boolean;
    extrude_rect(axis: number, sign: number, plane: number, a0: number, a1: number, b0: number, b1: number, dir: number): boolean;
    /**
     * [12 floats] for an exposed face's quad, [] if the face isn't exposed.
     */
    face_quad(x: number, y: number, z: number, d: number, sculpted: boolean): Float32Array;
    /**
     * Exposed faces within `radius` of a point (4 ints per face: cell + dir),
     * excluding faces opposite `hit_dir`.
     */
    faces_in_radius(px: number, py: number, pz: number, radius: number, hit_dir: number): Int32Array;
    /**
     * Bulk fill (no history) — world generation and stress testing.
     */
    fill_box_raw(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, v: boolean): void;
    get_cell(x: number, y: number, z: number): boolean;
    /**
     * [tx, ty, rot, flipH, flipV] for a painted face, [] when unpainted.
     */
    get_paint(x: number, y: number, z: number, d: number): Int32Array;
    /**
     * [] when absent, [x, y, z] when present.
     */
    get_shift(x: number, y: number, z: number): Float32Array;
    load_json(json: string): boolean;
    /**
     * Largest |component| over all offsets (test hook for the ±0.5 clamp).
     */
    max_shift_abs(): number;
    /**
     * Mesh one chunk into an internal buffer; returns the face count.
     */
    mesh_chunk(cx: number, cy: number, cz: number, sculpted: boolean, tint: boolean, paint: boolean): number;
    mesh_chunk_lod(cx: number, cy: number, cz: number, level: number): number;
    mesh_colors(): Float32Array;
    mesh_face_keys(): Int32Array;
    mesh_indices(): Uint32Array;
    mesh_positions(): Float32Array;
    mesh_unpainted_faces(): number;
    mesh_uvs(): Float32Array;
    constructor();
    paint_count(): number;
    /**
     * Paint one face; returns false if the face isn't exposed.
     */
    paint_face(x: number, y: number, z: number, d: number, tx: number, ty: number, rot: number, fh: boolean, fv: boolean): boolean;
    paint_stroke_begin(): void;
    paint_stroke_end(): boolean;
    /**
     * Drop the player onto the ground near (x, z); returns [x, y, z].
     */
    player_spawn(x: number, z: number): Float32Array;
    /**
     * Step the character controller. `wish` is the camera-relative input
     * direction. Returns [x, y, z, facing, onGround].
     */
    player_update(dt: number, wish_x: number, wish_z: number, jump: boolean): Float32Array;
    rect_corners(axis: number, sign: number, plane: number, a0: number, a1: number, b0: number, b1: number): Int32Array;
    redo(): boolean;
    reset_rect_offsets(axis: number, sign: number, plane: number, a0: number, a1: number, b0: number, b1: number): boolean;
    seed_voxel(): boolean;
    /**
     * kind: 0 smooth · 1 inflate · 2 deflate · 3 noise · 4 reset · 5 nudge(d).
     */
    selection_op(keys: Int32Array, kind: number, dx: number, dy: number, dz: number): boolean;
    /**
     * Test/scripting hook (no history): set or clear one offset.
     */
    set_shift_raw(x: number, y: number, z: number, sx: number, sy: number, sz: number): void;
    set_tileset_grid(cols: number, rows: number): void;
    shift_count(): number;
    shortest_path(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Int32Array;
    /**
     * [face_count, odd_edges] — watertightness diagnostics.
     */
    stats(): Float64Array;
    /**
     * tool: 0 smooth · 1 draw. A non-zero (dx,dy,dz) locks the Draw brush's
     * push direction (the sculpt axis constraint).
     */
    stroke_begin(tool: number, invert: boolean, radius: number, strength: number, topo: boolean, dx: number, dy: number, dz: number): void;
    stroke_dab(px: number, py: number, pz: number): void;
    stroke_end(): boolean;
    surface_corner_count(): number;
    surface_has_corner(x: number, y: number, z: number): boolean;
    take_dirty(): Int32Array;
    /**
     * The doc as v4 JSON:
     * {"cells": [...], "shifts": {...}, "paints": {"x,y,z:d": [tx,ty,rot,fh,fv]}}.
     */
    to_json(): string;
    undo(): boolean;
    /**
     * Interleaved [lat.x, lat.y, lat.z, pos.x, pos.y, pos.z] per visible corner.
     */
    visible_corners(ex: number, ey: number, ez: number, max_dist: number): Float32Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_world_free: (a: number, b: number) => void;
    readonly world_all_chunk_positions: (a: number) => [number, number];
    readonly world_approx_bytes: (a: number) => number;
    readonly world_camera_clearance: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly world_cell_count: (a: number) => number;
    readonly world_clear: (a: number) => void;
    readonly world_clear_history: (a: number) => void;
    readonly world_clear_shift_raw: (a: number, b: number, c: number, d: number) => void;
    readonly world_corner_normal: (a: number, b: number, c: number, d: number) => [number, number];
    readonly world_corner_pos: (a: number, b: number, c: number, d: number) => [number, number];
    readonly world_drag_begin: (a: number, b: number, c: number) => void;
    readonly world_drag_end: (a: number) => number;
    readonly world_drag_update: (a: number, b: number, c: number, d: number) => void;
    readonly world_erase_paint_face: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly world_extrude_rect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly world_face_quad: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly world_faces_in_radius: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly world_fill_box_raw: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly world_get_cell: (a: number, b: number, c: number, d: number) => number;
    readonly world_get_paint: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly world_get_shift: (a: number, b: number, c: number, d: number) => [number, number];
    readonly world_load_json: (a: number, b: number, c: number) => number;
    readonly world_max_shift_abs: (a: number) => number;
    readonly world_mesh_chunk: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly world_mesh_chunk_lod: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly world_mesh_colors: (a: number) => [number, number];
    readonly world_mesh_face_keys: (a: number) => [number, number];
    readonly world_mesh_indices: (a: number) => [number, number];
    readonly world_mesh_positions: (a: number) => [number, number];
    readonly world_mesh_unpainted_faces: (a: number) => number;
    readonly world_mesh_uvs: (a: number) => [number, number];
    readonly world_new: () => number;
    readonly world_paint_count: (a: number) => number;
    readonly world_paint_face: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly world_paint_stroke_begin: (a: number) => void;
    readonly world_paint_stroke_end: (a: number) => number;
    readonly world_player_spawn: (a: number, b: number, c: number) => [number, number];
    readonly world_player_update: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly world_rect_corners: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly world_redo: (a: number) => number;
    readonly world_reset_rect_offsets: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly world_seed_voxel: (a: number) => number;
    readonly world_selection_op: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly world_set_shift_raw: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly world_set_tileset_grid: (a: number, b: number, c: number) => void;
    readonly world_shift_count: (a: number) => number;
    readonly world_shortest_path: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly world_stats: (a: number) => [number, number];
    readonly world_stroke_begin: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly world_stroke_dab: (a: number, b: number, c: number, d: number) => void;
    readonly world_stroke_end: (a: number) => number;
    readonly world_surface_corner_count: (a: number) => number;
    readonly world_surface_has_corner: (a: number, b: number, c: number, d: number) => number;
    readonly world_take_dirty: (a: number) => [number, number];
    readonly world_to_json: (a: number) => [number, number];
    readonly world_undo: (a: number) => number;
    readonly world_visible_corners: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
