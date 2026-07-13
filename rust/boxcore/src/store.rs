//! The volume store: a one-level VDB. The world is divided into 32³ chunks;
//! each present chunk is either fully solid (`Full`, O(1) storage) or a 4 KiB
//! bitmap (`Bits`). Absent chunks are empty. A 1000³ solid cube therefore
//! costs ~n² real storage (bitmaps only where the surface lives) plus a tag
//! per interior chunk, instead of n³ cells.
//!
//! Offsets (lattice-corner displacements) are sparse and only ever live on
//! surface corners (ops enforce hygiene), so they are O(surface) by nature.

use crate::{pack, unpack, IV, V3};
use rustc_hash::{FxHashMap, FxHashSet};

pub const S: i32 = 32; // chunk side
pub const WORDS: usize = (32 * 32 * 32) / 64;

pub enum Chunk {
    Full,
    Bits(Box<[u64; WORDS]>),
}

impl Chunk {
    #[inline]
    fn get(&self, li: usize) -> bool {
        match self {
            Chunk::Full => true,
            Chunk::Bits(b) => (b[li >> 6] >> (li & 63)) & 1 != 0,
        }
    }
}

#[inline]
pub fn cpos_of(c: IV) -> IV {
    (c.0 >> 5, c.1 >> 5, c.2 >> 5)
}

#[inline]
fn lidx(c: IV) -> usize {
    ((c.0 & 31) | ((c.1 & 31) << 5) | ((c.2 & 31) << 10)) as usize
}

#[derive(Default)]
pub struct ChunkStore {
    pub chunks: FxHashMap<IV, Chunk>,
    /// Chunks whose mesh needs rebuilding (edits mark the 3×3×3 cell
    /// neighborhood's chunks, since AO reaches across chunk borders).
    pub dirty: FxHashSet<IV>,
    /// Same, but for physics colliders (drained independently).
    pub dirty_phys: FxHashSet<IV>,
    cell_count: u64,
}

impl ChunkStore {
    pub fn new() -> Self {
        Self::default()
    }

    #[inline]
    pub fn get(&self, c: IV) -> bool {
        match self.chunks.get(&cpos_of(c)) {
            None => false,
            Some(ch) => ch.get(lidx(c)),
        }
    }

    pub fn cell_count(&self) -> u64 {
        self.cell_count
    }

    fn mark_dirty_around(&mut self, c: IV) {
        let lo = cpos_of((c.0 - 1, c.1 - 1, c.2 - 1));
        let hi = cpos_of((c.0 + 1, c.1 + 1, c.2 + 1));
        for x in lo.0..=hi.0 {
            for y in lo.1..=hi.1 {
                for z in lo.2..=hi.2 {
                    self.dirty.insert((x, y, z));
                    self.dirty_phys.insert((x, y, z));
                }
            }
        }
    }

    /// Mark the chunks touching a lattice point (its 8 incident cells).
    pub fn mark_lattice_dirty(&mut self, l: IV) {
        let lo = cpos_of((l.0 - 1, l.1 - 1, l.2 - 1));
        let hi = cpos_of(l);
        for x in lo.0..=hi.0 {
            for y in lo.1..=hi.1 {
                for z in lo.2..=hi.2 {
                    self.dirty.insert((x, y, z));
                    self.dirty_phys.insert((x, y, z));
                }
            }
        }
    }

    pub fn set(&mut self, c: IV, v: bool) {
        let cp = cpos_of(c);
        let li = lidx(c);
        match self.chunks.get_mut(&cp) {
            None => {
                if v {
                    let mut bits = Box::new([0u64; WORDS]);
                    bits[li >> 6] |= 1 << (li & 63);
                    self.chunks.insert(cp, Chunk::Bits(bits));
                    self.cell_count += 1;
                    self.mark_dirty_around(c);
                }
            }
            Some(Chunk::Full) => {
                if !v {
                    let mut bits = Box::new([u64::MAX; WORDS]);
                    bits[li >> 6] &= !(1 << (li & 63));
                    self.chunks.insert(cp, Chunk::Bits(bits));
                    self.cell_count -= 1;
                    self.mark_dirty_around(c);
                }
            }
            Some(Chunk::Bits(b)) => {
                let was = (b[li >> 6] >> (li & 63)) & 1 != 0;
                if was != v {
                    if v {
                        b[li >> 6] |= 1 << (li & 63);
                        self.cell_count += 1;
                    } else {
                        b[li >> 6] &= !(1 << (li & 63));
                        self.cell_count -= 1;
                    }
                    self.mark_dirty_around(c);
                    self.normalize(cp);
                }
            }
        }
    }

    /// Collapse a bitmap chunk to Full / absent when it became uniform.
    fn normalize(&mut self, cp: IV) {
        if let Some(Chunk::Bits(b)) = self.chunks.get(&cp) {
            if b.iter().all(|&w| w == u64::MAX) {
                self.chunks.insert(cp, Chunk::Full);
            } else if b.iter().all(|&w| w == 0) {
                self.chunks.remove(&cp);
            }
        }
    }

    /// Fill (or clear) an axis-aligned box, `min` inclusive, `max` exclusive.
    /// Chunks fully inside the box are set with O(1) tags.
    pub fn fill_box(&mut self, min: IV, max: IV, v: bool) {
        if min.0 >= max.0 || min.1 >= max.1 || min.2 >= max.2 {
            return;
        }
        let clo = cpos_of(min);
        let chi = cpos_of((max.0 - 1, max.1 - 1, max.2 - 1));
        for cx in clo.0..=chi.0 {
            for cy in clo.1..=chi.1 {
                for cz in clo.2..=chi.2 {
                    let cp = (cx, cy, cz);
                    let base = (cx * S, cy * S, cz * S);
                    let x0 = min.0.max(base.0);
                    let y0 = min.1.max(base.1);
                    let z0 = min.2.max(base.2);
                    let x1 = max.0.min(base.0 + S);
                    let y1 = max.1.min(base.1 + S);
                    let z1 = max.2.min(base.2 + S);
                    let covers_all = x0 == base.0
                        && y0 == base.1
                        && z0 == base.2
                        && x1 == base.0 + S
                        && y1 == base.1 + S
                        && z1 == base.2 + S;
                    if covers_all {
                        let before = match self.chunks.get(&cp) {
                            None => 0u64,
                            Some(Chunk::Full) => (S * S * S) as u64,
                            Some(Chunk::Bits(b)) => {
                                b.iter().map(|w| w.count_ones() as u64).sum()
                            }
                        };
                        if v {
                            self.chunks.insert(cp, Chunk::Full);
                            self.cell_count += (S * S * S) as u64 - before;
                        } else {
                            self.chunks.remove(&cp);
                            self.cell_count -= before;
                        }
                    } else {
                        // partial coverage: write the bitmap directly — the
                        // chunk-level dirty below covers invalidation, so a
                        // per-cell set() (27 dirty inserts each) would waste
                        // hundreds of millions of hash ops on big fills
                        let need_chunk = v || self.chunks.contains_key(&cp);
                        if need_chunk {
                            let chunk = self.chunks.entry(cp).or_insert_with(|| {
                                Chunk::Bits(Box::new([0u64; WORDS]))
                            });
                            if matches!(chunk, Chunk::Full) {
                                if v {
                                    // already all set — nothing to do
                                } else {
                                    *chunk = Chunk::Bits(Box::new([u64::MAX; WORDS]));
                                }
                            }
                            let mut delta: i64 = 0;
                            if let Chunk::Bits(b) = chunk {
                                for x in x0..x1 {
                                    for y in y0..y1 {
                                        for z in z0..z1 {
                                            let li = lidx((x, y, z));
                                            let (w, m) = (li >> 6, 1u64 << (li & 63));
                                            let was = b[w] & m != 0;
                                            if was != v {
                                                if v {
                                                    b[w] |= m;
                                                    delta += 1;
                                                } else {
                                                    b[w] &= !m;
                                                    delta -= 1;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            self.cell_count = (self.cell_count as i64 + delta) as u64;
                            self.normalize(cp);
                        }
                    }
                    // conservatively dirty this chunk and its neighbors
                    for dx in -1..=1 {
                        for dy in -1..=1 {
                            for dz in -1..=1 {
                                self.dirty.insert((cx + dx, cy + dy, cz + dz));
                                self.dirty_phys.insert((cx + dx, cy + dy, cz + dz));
                            }
                        }
                    }
                }
            }
        }
    }

    /// All solid cells inside [min, max) as packed keys. Skips absent
    /// chunks entirely, so scanning a huge empty region is O(present chunks).
    pub fn cells_in_box(&self, min: IV, max: IV) -> Vec<i64> {
        let mut out = Vec::new();
        if min.0 >= max.0 || min.1 >= max.1 || min.2 >= max.2 {
            return out;
        }
        let clo = cpos_of(min);
        let chi = cpos_of((max.0 - 1, max.1 - 1, max.2 - 1));
        for cx in clo.0..=chi.0 {
            for cy in clo.1..=chi.1 {
                for cz in clo.2..=chi.2 {
                    let Some(ch) = self.chunks.get(&(cx, cy, cz)) else {
                        continue;
                    };
                    let base = (cx * S, cy * S, cz * S);
                    let x0 = min.0.max(base.0);
                    let y0 = min.1.max(base.1);
                    let z0 = min.2.max(base.2);
                    let x1 = max.0.min(base.0 + S);
                    let y1 = max.1.min(base.1 + S);
                    let z1 = max.2.min(base.2 + S);
                    for x in x0..x1 {
                        for y in y0..y1 {
                            for z in z0..z1 {
                                if ch.get(lidx((x, y, z))) {
                                    out.push(crate::pack((x, y, z)));
                                }
                            }
                        }
                    }
                }
            }
        }
        out
    }

    /// Install a whole chunk (deserialization path): maintains the cell
    /// census, normalizes uniform bitmaps, and dirties the neighborhood.
    pub fn insert_chunk_raw(&mut self, cp: IV, chunk: Chunk) {
        let count = match &chunk {
            Chunk::Full => (S * S * S) as u64,
            Chunk::Bits(b) => b.iter().map(|w| w.count_ones() as u64).sum(),
        };
        if count == 0 {
            return;
        }
        let prev = match self.chunks.insert(cp, chunk) {
            None => 0u64,
            Some(Chunk::Full) => (S * S * S) as u64,
            Some(Chunk::Bits(b)) => b.iter().map(|w| w.count_ones() as u64).sum(),
        };
        self.cell_count = self.cell_count + count - prev;
        self.normalize(cp);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    self.dirty.insert((cp.0 + dx, cp.1 + dy, cp.2 + dz));
                    self.dirty_phys.insert((cp.0 + dx, cp.1 + dy, cp.2 + dz));
                }
            }
        }
    }

    pub fn clear(&mut self) {
        for cp in self.chunks.keys() {
            // dirty the chunk and border neighbors so meshes get removed
            let cp = *cp;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        self.dirty.insert((cp.0 + dx, cp.1 + dy, cp.2 + dz));
                        self.dirty_phys.insert((cp.0 + dx, cp.1 + dy, cp.2 + dz));
                    }
                }
            }
        }
        self.chunks.clear();
        self.cell_count = 0;
    }

    /// Iterate every solid cell (used for serialization; O(cells)).
    pub fn for_each_cell(&self, mut f: impl FnMut(IV)) {
        for (cp, ch) in &self.chunks {
            let base = (cp.0 * S, cp.1 * S, cp.2 * S);
            match ch {
                Chunk::Full => {
                    for x in 0..S {
                        for y in 0..S {
                            for z in 0..S {
                                f((base.0 + x, base.1 + y, base.2 + z));
                            }
                        }
                    }
                }
                Chunk::Bits(b) => {
                    for li in 0..(S * S * S) as usize {
                        if (b[li >> 6] >> (li & 63)) & 1 != 0 {
                            let x = (li as i32) & 31;
                            let y = ((li as i32) >> 5) & 31;
                            let z = (li as i32) >> 10;
                            f((base.0 + x, base.1 + y, base.2 + z));
                        }
                    }
                }
            }
        }
    }

    /// Approximate heap bytes used by the volume itself.
    pub fn approx_bytes(&self) -> usize {
        let mut bytes = self.chunks.capacity() * (12 + 16 + 8);
        for ch in self.chunks.values() {
            if let Chunk::Bits(_) = ch {
                bytes += WORDS * 8;
            }
        }
        bytes
    }

    pub fn chunk_state_counts(&self) -> (usize, usize) {
        let mut full = 0;
        let mut bits = 0;
        for ch in self.chunks.values() {
            match ch {
                Chunk::Full => full += 1,
                Chunk::Bits(_) => bits += 1,
            }
        }
        (full, bits)
    }
}

/// A 3×3×3 chunk cache for fast neighborhood queries during meshing and ops.
pub struct Neighborhood<'a> {
    store: &'a ChunkStore,
    base: IV,
    cache: [Option<Option<&'a Chunk>>; 27],
}

impl<'a> Neighborhood<'a> {
    pub fn new(store: &'a ChunkStore, center: IV) -> Self {
        Self {
            store,
            base: center,
            cache: [None; 27],
        }
    }

    #[inline]
    pub fn get(&mut self, c: IV) -> bool {
        let cp = cpos_of(c);
        let dx = cp.0 - self.base.0 + 1;
        let dy = cp.1 - self.base.1 + 1;
        let dz = cp.2 - self.base.2 + 1;
        if (0..3).contains(&dx) && (0..3).contains(&dy) && (0..3).contains(&dz) {
            let idx = (dx + dy * 3 + dz * 9) as usize;
            let entry = self.cache[idx].get_or_insert_with(|| self.store.chunks.get(&cp));
            match entry {
                None => false,
                Some(ch) => ch.get(lidx(c)),
            }
        } else {
            self.store.get(c)
        }
    }
}

/// A face's paint: tile column/row plus orientation, packed into a u32
/// (tx 12 bits | ty 12 bits | rot 2 bits | flipH | flipV).
pub fn pack_paint(tx: u32, ty: u32, rot: u32, fh: bool, fv: bool) -> u32 {
    (tx & 0xFFF) | ((ty & 0xFFF) << 12) | ((rot & 3) << 24) | ((fh as u32) << 26) | ((fv as u32) << 27)
}

pub fn unpack_paint(p: u32) -> (u32, u32, u32, bool, bool) {
    (
        p & 0xFFF,
        (p >> 12) & 0xFFF,
        (p >> 24) & 3,
        (p >> 26) & 1 != 0,
        (p >> 27) & 1 != 0,
    )
}

/// Per-face tile assignments, keyed by (packed cell, dir).
#[derive(Default)]
pub struct Paints {
    pub map: FxHashMap<(i64, u8), u32>,
}

impl Paints {
    pub fn get(&self, cell_key: i64, dir: u8) -> Option<u32> {
        self.map.get(&(cell_key, dir)).copied()
    }

    pub fn set(&mut self, cell_key: i64, dir: u8, v: Option<u32>) {
        match v {
            None => {
                self.map.remove(&(cell_key, dir));
            }
            Some(p) => {
                self.map.insert((cell_key, dir), p);
            }
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// Sparse lattice-corner displacements, hard-clamped to ±0.5 per axis.
#[derive(Default)]
pub struct Offsets {
    pub map: FxHashMap<i64, V3>,
}

pub fn clamp_shift(v: V3) -> V3 {
    [
        v[0].clamp(-0.5, 0.5),
        v[1].clamp(-0.5, 0.5),
        v[2].clamp(-0.5, 0.5),
    ]
}

impl Offsets {
    #[inline]
    pub fn get(&self, l: IV) -> V3 {
        self.map.get(&pack(l)).copied().unwrap_or([0.0; 3])
    }

    #[inline]
    pub fn get_opt(&self, l: IV) -> Option<V3> {
        self.map.get(&pack(l)).copied()
    }

    /// Set (clamped) or clear a displacement. Near-zero values are deleted.
    pub fn set(&mut self, l: IV, v: Option<V3>) {
        match v {
            None => {
                self.map.remove(&pack(l));
            }
            Some(raw) => {
                let c = clamp_shift(raw);
                if c[0].abs() < 1e-9 && c[1].abs() < 1e-9 && c[2].abs() < 1e-9 {
                    self.map.remove(&pack(l));
                } else {
                    self.map.insert(pack(l), c);
                }
            }
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn keys(&self) -> impl Iterator<Item = IV> + '_ {
        self.map.keys().map(|k| unpack(*k))
    }
}
