/* tslint:disable */
/* eslint-disable */

/**
 * Async wgpu setup result, handed to `World::gfx_attach` (wasm_bindgen
 * cannot await inside a &mut self method).
 */
export class GfxInit {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
}

export class World {
    free(): void;
    [Symbol.dispose](): void;
    all_chunk_positions(): Int32Array;
    /**
     * Approximate document heap bytes (for the status/debug display).
     */
    approx_bytes(): number;
    /**
     * Stateless chase-camera boom (cone cast over sphere radii; see
     * `Phys::camera_boom` and docs/camera.md). Returns [boom, los].
     */
    camera_boom(fx: number, fy: number, fz: number, dx: number, dy: number, dz: number, dist: number): Float32Array;
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
    gfx_attach(init: GfxInit): void;
    /**
     * Render one frame (also drains document dirt into remesh work).
     */
    gfx_frame(ex: number, ey: number, ez: number, fx: number, fy: number, fz: number, fov_y: number, near: number, far: number): void;
    gfx_overlay_lines(which: number, points: Float32Array, r: number, gr: number, b: number, a: number): void;
    gfx_overlay_lines_colored(which: number, data: Float32Array): void;
    /**
     * Overlay slots: 0 ghost, 1 selection fill, 2 selection lines,
     * 3 constraint lines, 4 brush ring, 5 axes, 6 stamp ghost, 7 player.
     */
    gfx_overlay_quads(which: number, quads: Float32Array, uvs: Float32Array, r: number, gr: number, b: number, a: number): void;
    /**
     * Planning mode: draw only the plan preview (plus axes).
     */
    gfx_plan_mode(on: boolean): void;
    /**
     * Rebuild the 3D disc-world preview from the plan (step = decimation).
     */
    gfx_plan_preview(step: number): void;
    gfx_ready(): boolean;
    gfx_resize(w: number, h: number): void;
    /**
     * Corner handles (pos3, pixel size, rgba4 per instance); empty hides.
     */
    gfx_set_handles(data: Float32Array): void;
    gfx_set_lod_scale(k: number): void;
    /**
     * Player body triangles (pos3 + rgba4 per vertex); empty hides it.
     */
    gfx_set_player(data: Float32Array): void;
    gfx_set_tileset(w: number, h: number, rgba: Uint8Array): void;
    gfx_set_view(sculpted: boolean, tint: boolean, paint: boolean): void;
    /**
     * [chunks, regions, paintedFaces, pendingRebuilds, drawCalls, lod0..lod4]
     */
    gfx_stats(): Uint32Array;
    /**
     * Load a v6 binary document (replaces the current one entirely).
     */
    load_bin(data: Uint8Array): boolean;
    /**
     * sx × sz slab, `thickness` deep, centered in x/z, top at y = 0.
     */
    make_slab(sx: number, sz: number, thickness: number): boolean;
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
     * First face hit by a ray, exact against the rendered quads.
     * [] on miss, else [cellx, celly, cellz, dir, px, py, pz, t].
     */
    pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max_dist: number, sculpted: boolean): Float32Array;
    plan_brush(cx: number, cy: number, radius: number, delta: number, layer: number): void;
    /**
     * [w, h, scale]; zeros when no plan exists.
     */
    plan_dims(): Uint32Array;
    /**
     * Replace the world's volume with the plan's geometry (like Slab, but
     * shaped). Clears the document first; history is reset.
     */
    plan_generate(): boolean;
    plan_init(w: number, h: number): void;
    plan_mask_brush(cx: number, cy: number, radius: number, value: boolean): void;
    plan_redo(): boolean;
    /**
     * One RGBA pixel per plan cell (contour bands, coast, void checker).
     */
    plan_rgba(layer: number): Uint8Array;
    /**
     * [top, bottom, mask] at a plan cell (for the status readout).
     */
    plan_sample(x: number, y: number): Float32Array;
    plan_smooth(cx: number, cy: number, radius: number, strength: number, layer: number): void;
    plan_stroke_begin(): void;
    plan_stroke_end(): void;
    plan_undo(): boolean;
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
     * Serialize the whole document to the v6 binary format.
     */
    to_bin(): Uint8Array;
    undo(): boolean;
    /**
     * Interleaved [lat.x, lat.y, lat.z, pos.x, pos.y, pos.z] per visible corner.
     */
    visible_corners(ex: number, ey: number, ez: number, max_dist: number): Float32Array;
}

/**
 * Create the renderer for a canvas (async: adapter + device negotiation).
 */
export function gfx_create(canvas: HTMLCanvasElement, width: number, height: number): Promise<GfxInit>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_gfxinit_free: (a: number, b: number) => void;
    readonly __wbg_world_free: (a: number, b: number) => void;
    readonly gfx_create: (a: any, b: number, c: number) => any;
    readonly world_all_chunk_positions: (a: number) => [number, number];
    readonly world_approx_bytes: (a: number) => number;
    readonly world_camera_boom: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
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
    readonly world_gfx_attach: (a: number, b: number) => void;
    readonly world_gfx_frame: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly world_gfx_overlay_lines: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly world_gfx_overlay_lines_colored: (a: number, b: number, c: number, d: number) => void;
    readonly world_gfx_overlay_quads: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly world_gfx_plan_mode: (a: number, b: number) => void;
    readonly world_gfx_plan_preview: (a: number, b: number) => void;
    readonly world_gfx_ready: (a: number) => number;
    readonly world_gfx_resize: (a: number, b: number, c: number) => void;
    readonly world_gfx_set_handles: (a: number, b: number, c: number) => void;
    readonly world_gfx_set_lod_scale: (a: number, b: number) => void;
    readonly world_gfx_set_player: (a: number, b: number, c: number) => void;
    readonly world_gfx_set_tileset: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly world_gfx_set_view: (a: number, b: number, c: number, d: number) => void;
    readonly world_gfx_stats: (a: number) => [number, number];
    readonly world_load_bin: (a: number, b: number, c: number) => number;
    readonly world_make_slab: (a: number, b: number, c: number, d: number) => number;
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
    readonly world_pick: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly world_plan_brush: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly world_plan_dims: (a: number) => [number, number];
    readonly world_plan_generate: (a: number) => number;
    readonly world_plan_init: (a: number, b: number, c: number) => void;
    readonly world_plan_mask_brush: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly world_plan_redo: (a: number) => number;
    readonly world_plan_rgba: (a: number, b: number) => [number, number];
    readonly world_plan_sample: (a: number, b: number, c: number) => [number, number];
    readonly world_plan_smooth: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly world_plan_stroke_begin: (a: number) => void;
    readonly world_plan_stroke_end: (a: number) => void;
    readonly world_plan_undo: (a: number) => number;
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
    readonly world_to_bin: (a: number) => [number, number];
    readonly world_undo: (a: number) => number;
    readonly world_visible_corners: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h609039506a690efe: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h39705e9b39b7acd9: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h39705e9b39b7acd9_2: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h39705e9b39b7acd9_3: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h2a35fd21e48d687e: (a: number, b: number, c: any, d: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
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
