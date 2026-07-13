/* @ts-self-types="./boxcore.d.ts" */

export class World {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WorldFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_world_free(ptr, 0);
    }
    /**
     * @returns {Int32Array}
     */
    all_chunk_positions() {
        const ret = wasm.world_all_chunk_positions(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Approximate document heap bytes (for the status/debug display).
     * @returns {number}
     */
    approx_bytes() {
        const ret = wasm.world_approx_bytes(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    cell_count() {
        const ret = wasm.world_cell_count(this.__wbg_ptr);
        return ret;
    }
    clear() {
        wasm.world_clear(this.__wbg_ptr);
    }
    clear_history() {
        wasm.world_clear_history(this.__wbg_ptr);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    clear_shift_raw(x, y, z) {
        wasm.world_clear_shift_raw(this.__wbg_ptr, x, y, z);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Float32Array}
     */
    corner_normal(x, y, z) {
        const ret = wasm.world_corner_normal(this.__wbg_ptr, x, y, z);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Float32Array}
     */
    corner_pos(x, y, z) {
        const ret = wasm.world_corner_pos(this.__wbg_ptr, x, y, z);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {Int32Array} keys
     */
    drag_begin(keys) {
        const ptr0 = passArray32ToWasm0(keys, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.world_drag_begin(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {boolean}
     */
    drag_end() {
        const ret = wasm.world_drag_end(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {number} dx
     * @param {number} dy
     * @param {number} dz
     */
    drag_update(dx, dy, dz) {
        wasm.world_drag_update(this.__wbg_ptr, dx, dy, dz);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} d
     * @returns {boolean}
     */
    erase_paint_face(x, y, z, d) {
        const ret = wasm.world_erase_paint_face(this.__wbg_ptr, x, y, z, d);
        return ret !== 0;
    }
    /**
     * @param {number} axis
     * @param {number} sign
     * @param {number} plane
     * @param {number} a0
     * @param {number} a1
     * @param {number} b0
     * @param {number} b1
     * @param {number} dir
     * @returns {boolean}
     */
    extrude_rect(axis, sign, plane, a0, a1, b0, b1, dir) {
        const ret = wasm.world_extrude_rect(this.__wbg_ptr, axis, sign, plane, a0, a1, b0, b1, dir);
        return ret !== 0;
    }
    /**
     * [12 floats] for an exposed face's quad, [] if the face isn't exposed.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} d
     * @param {boolean} sculpted
     * @returns {Float32Array}
     */
    face_quad(x, y, z, d, sculpted) {
        const ret = wasm.world_face_quad(this.__wbg_ptr, x, y, z, d, sculpted);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Bulk fill (no history) — world generation and stress testing.
     * @param {number} x0
     * @param {number} y0
     * @param {number} z0
     * @param {number} x1
     * @param {number} y1
     * @param {number} z1
     * @param {boolean} v
     */
    fill_box_raw(x0, y0, z0, x1, y1, z1, v) {
        wasm.world_fill_box_raw(this.__wbg_ptr, x0, y0, z0, x1, y1, z1, v);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {boolean}
     */
    get_cell(x, y, z) {
        const ret = wasm.world_get_cell(this.__wbg_ptr, x, y, z);
        return ret !== 0;
    }
    /**
     * [tx, ty, rot, flipH, flipV] for a painted face, [] when unpainted.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} d
     * @returns {Int32Array}
     */
    get_paint(x, y, z, d) {
        const ret = wasm.world_get_paint(this.__wbg_ptr, x, y, z, d);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * [] when absent, [x, y, z] when present.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {Float32Array}
     */
    get_shift(x, y, z) {
        const ret = wasm.world_get_shift(this.__wbg_ptr, x, y, z);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {string} json
     * @returns {boolean}
     */
    load_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.world_load_json(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Largest |component| over all offsets (test hook for the ±0.5 clamp).
     * @returns {number}
     */
    max_shift_abs() {
        const ret = wasm.world_max_shift_abs(this.__wbg_ptr);
        return ret;
    }
    /**
     * Mesh one chunk into an internal buffer; returns the face count.
     * @param {number} cx
     * @param {number} cy
     * @param {number} cz
     * @param {boolean} sculpted
     * @param {boolean} tint
     * @param {boolean} paint
     * @returns {number}
     */
    mesh_chunk(cx, cy, cz, sculpted, tint, paint) {
        const ret = wasm.world_mesh_chunk(this.__wbg_ptr, cx, cy, cz, sculpted, tint, paint);
        return ret >>> 0;
    }
    /**
     * @param {number} cx
     * @param {number} cy
     * @param {number} cz
     * @param {number} level
     * @returns {number}
     */
    mesh_chunk_lod(cx, cy, cz, level) {
        const ret = wasm.world_mesh_chunk_lod(this.__wbg_ptr, cx, cy, cz, level);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    mesh_colors() {
        const ret = wasm.world_mesh_colors(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Int32Array}
     */
    mesh_face_keys() {
        const ret = wasm.world_mesh_face_keys(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    mesh_indices() {
        const ret = wasm.world_mesh_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    mesh_positions() {
        const ret = wasm.world_mesh_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    mesh_unpainted_faces() {
        const ret = wasm.world_mesh_unpainted_faces(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    mesh_uvs() {
        const ret = wasm.world_mesh_uvs(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    constructor() {
        const ret = wasm.world_new();
        this.__wbg_ptr = ret;
        WorldFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    paint_count() {
        const ret = wasm.world_paint_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Paint one face; returns false if the face isn't exposed.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} d
     * @param {number} tx
     * @param {number} ty
     * @param {number} rot
     * @param {boolean} fh
     * @param {boolean} fv
     * @returns {boolean}
     */
    paint_face(x, y, z, d, tx, ty, rot, fh, fv) {
        const ret = wasm.world_paint_face(this.__wbg_ptr, x, y, z, d, tx, ty, rot, fh, fv);
        return ret !== 0;
    }
    paint_stroke_begin() {
        wasm.world_paint_stroke_begin(this.__wbg_ptr);
    }
    /**
     * @returns {boolean}
     */
    paint_stroke_end() {
        const ret = wasm.world_paint_stroke_end(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {number} axis
     * @param {number} sign
     * @param {number} plane
     * @param {number} a0
     * @param {number} a1
     * @param {number} b0
     * @param {number} b1
     * @returns {Int32Array}
     */
    rect_corners(axis, sign, plane, a0, a1, b0, b1) {
        const ret = wasm.world_rect_corners(this.__wbg_ptr, axis, sign, plane, a0, a1, b0, b1);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {boolean}
     */
    redo() {
        const ret = wasm.world_redo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {number} axis
     * @param {number} sign
     * @param {number} plane
     * @param {number} a0
     * @param {number} a1
     * @param {number} b0
     * @param {number} b1
     * @returns {boolean}
     */
    reset_rect_offsets(axis, sign, plane, a0, a1, b0, b1) {
        const ret = wasm.world_reset_rect_offsets(this.__wbg_ptr, axis, sign, plane, a0, a1, b0, b1);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    seed_voxel() {
        const ret = wasm.world_seed_voxel(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * kind: 0 smooth · 1 inflate · 2 deflate · 3 noise · 4 reset · 5 nudge(d).
     * @param {Int32Array} keys
     * @param {number} kind
     * @param {number} dx
     * @param {number} dy
     * @param {number} dz
     * @returns {boolean}
     */
    selection_op(keys, kind, dx, dy, dz) {
        const ptr0 = passArray32ToWasm0(keys, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.world_selection_op(this.__wbg_ptr, ptr0, len0, kind, dx, dy, dz);
        return ret !== 0;
    }
    /**
     * Test/scripting hook (no history): set or clear one offset.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} sx
     * @param {number} sy
     * @param {number} sz
     */
    set_shift_raw(x, y, z, sx, sy, sz) {
        wasm.world_set_shift_raw(this.__wbg_ptr, x, y, z, sx, sy, sz);
    }
    /**
     * @param {number} cols
     * @param {number} rows
     */
    set_tileset_grid(cols, rows) {
        wasm.world_set_tileset_grid(this.__wbg_ptr, cols, rows);
    }
    /**
     * @returns {number}
     */
    shift_count() {
        const ret = wasm.world_shift_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} x0
     * @param {number} y0
     * @param {number} z0
     * @param {number} x1
     * @param {number} y1
     * @param {number} z1
     * @returns {Int32Array}
     */
    shortest_path(x0, y0, z0, x1, y1, z1) {
        const ret = wasm.world_shortest_path(this.__wbg_ptr, x0, y0, z0, x1, y1, z1);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * [face_count, odd_edges] — watertightness diagnostics.
     * @returns {Float64Array}
     */
    stats() {
        const ret = wasm.world_stats(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * tool: 0 smooth · 1 draw.
     * @param {number} tool
     * @param {boolean} invert
     * @param {number} radius
     * @param {number} strength
     * @param {boolean} topo
     */
    stroke_begin(tool, invert, radius, strength, topo) {
        wasm.world_stroke_begin(this.__wbg_ptr, tool, invert, radius, strength, topo);
    }
    /**
     * @param {number} px
     * @param {number} py
     * @param {number} pz
     */
    stroke_dab(px, py, pz) {
        wasm.world_stroke_dab(this.__wbg_ptr, px, py, pz);
    }
    /**
     * @returns {boolean}
     */
    stroke_end() {
        const ret = wasm.world_stroke_end(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    surface_corner_count() {
        const ret = wasm.world_surface_corner_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {boolean}
     */
    surface_has_corner(x, y, z) {
        const ret = wasm.world_surface_has_corner(this.__wbg_ptr, x, y, z);
        return ret !== 0;
    }
    /**
     * @returns {Int32Array}
     */
    take_dirty() {
        const ret = wasm.world_take_dirty(this.__wbg_ptr);
        var v1 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The doc as v4 JSON:
     * {"cells": [...], "shifts": {...}, "paints": {"x,y,z:d": [tx,ty,rot,fh,fv]}}.
     * @returns {string}
     */
    to_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.world_to_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {boolean}
     */
    undo() {
        const ret = wasm.world_undo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Interleaved [lat.x, lat.y, lat.z, pos.x, pos.y, pos.z] per visible corner.
     * @param {number} ex
     * @param {number} ey
     * @param {number} ez
     * @param {number} max_dist
     * @returns {Float32Array}
     */
    visible_corners(ex, ey, ez, max_dist) {
        const ret = wasm.world_visible_corners(this.__wbg_ptr, ex, ey, ez, max_dist);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) World.prototype[Symbol.dispose] = World.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_9c75d47bf9e7731e: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./boxcore_bg.js": import0,
    };
}

const WorldFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_world_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('boxcore_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
