// End-to-end drive of the volume editor (Rust/WASM core): seed voxel,
// rect-select + =/− with faces-only extrude and march-through-air carve,
// offset extrapolation & hygiene, ±0.5 clamping, vertex visibility (incl.
// concave corners), click-to-select-then-drag, axis constraints + nudges,
// shortest-path select, build→sculpt handoff, spatial brushes with topology
// growth, view toggles, cameras, undo, save/load.
import { chromium } from 'playwright';

const SHOTS = '/tmp/boxexplore-shots';
import { mkdirSync } from 'node:fs';
mkdirSync(SHOTS, { recursive: true });

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (err) => errors.push(err.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.editor !== undefined, { timeout: 15000 });
await page.waitForTimeout(300);
const freshScene = () =>
  page.evaluate(() => {
    localStorage.clear();
    window.editor.world.clear();
    window.editor.selectedVerts.clear();
    window.editor.boxSel = null;
  });
await freshScene();

const box = await page.locator('#viewport').boundingBox();
const cells = () => page.evaluate(() => window.editor.world.cellCount());
const shifts = () => page.evaluate(() => window.editor.world.shiftCount());
const stats = () => page.evaluate(() => window.editor.surfaceStats());
const screen = (p) => page.evaluate((pt) => window.editor.viewport.screenPoint(pt), p);

const log = [];
const check = (name, cond, extra = '') =>
  log.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);

const clickWorld = async (p) => {
  const s = await screen(p);
  await page.mouse.click(box.x + s.x, box.y + s.y);
};
const dragWorld = async (a, b, opts = {}) => {
  const sa = await screen(a);
  const sb = await screen(b);
  await page.mouse.move(box.x + sa.x, box.y + sa.y);
  await page.mouse.down();
  await page.mouse.move(box.x + sb.x, box.y + sb.y, { steps: opts.steps ?? 10 });
  await page.mouse.up();
};

// --- 1. removed concepts stay removed -----------------------------------------
check('plane picker UI is gone', (await page.locator('#plane-axis').count()) === 0);
check('option checkboxes are gone', (await page.locator('#opt-attach').count()) === 0);
await page.keyboard.press('4');
check(
  'modes are just build/sculpt',
  (await page.evaluate(() => window.editor.mode.name)) === 'build',
);

// --- 2. seed + click-select + = / − marching --------------------------------------
await page.locator('#btn-seed').click();
check('+ Voxel seeds a cell', (await cells()) === 1, `${await cells()} cells`);
await clickWorld({ x: 0.5, y: 0, z: 0.5 }); // top face of the seed
const sel0 = await page.evaluate(() => window.editor.boxSel && { ...window.editor.boxSel });
check('click selects a 1×1 rect', !!sel0 && sel0.axis === 1 && sel0.sign === 1 && sel0.plane === 0);
await page.keyboard.press('=');
check('= extrudes one cell up', (await cells()) === 2, `${await cells()} cells`);
check(
  'extruded cell is where expected',
  await page.evaluate(() => window.editor.world.getCell(0, 0, 0)),
);
await page.keyboard.press('-');
await page.keyboard.press('-');
check('− carves down through the stack', (await cells()) === 0, `${await cells()} cells`);
await page.keyboard.press('-');
const marched = await page.evaluate(() => window.editor.boxSel?.plane);
check('carve plane keeps marching through air', marched === -2, `plane ${marched}`);
await page.keyboard.press('=');
check('= with no faces present is a no-op', (await cells()) === 0, `${await cells()} cells`);

// --- 3. build a floor by row extrusion (faces-only extrude) ------------------------
await freshScene();
await page.locator('#btn-seed').click();
await clickWorld({ x: 1, y: -0.5, z: 0.5 }); // +x face of the seed
for (let i = 0; i < 3; i++) await page.keyboard.press('=');
check('row extrudes to 4 cells', (await cells()) === 4, `${await cells()} cells`);
await dragWorld({ x: 0.5, y: -0.5, z: 0 }, { x: 3.5, y: -0.5, z: 0 }); // the row's −z wall
await page.keyboard.press('=');
await page.keyboard.press('=');
check('wall rect extrudes a 4×3 floor', (await cells()) === 12, `${await cells()} cells`);
let s = await stats();
check('watertight after floor', s.oddEdges === 0, `${s.oddEdges} odd edges`);

// --- 4. extrude fills only present faces, never the rect's air ----------------------
await dragWorld({ x: 0.5, y: 0, z: 0.5 }, { x: 6.5, y: 0, z: 0.5 }); // top row + air overhang
await page.keyboard.press('=');
check('overhanging = adds only over solid (+4)', (await cells()) === 16, `${await cells()} cells`);
await page.keyboard.press('ControlOrMeta+z');
check('undo restores the floor', (await cells()) === 12, `${await cells()} cells`);
check('undo clears the selection', await page.evaluate(() => window.editor.boxSel === null));

// --- 5. wall on the -x edge (multi-face rect, repeated extrude) ----------------------
await dragWorld({ x: 0.5, y: 0, z: 0.5 }, { x: 0.5, y: 0, z: -1.5 });
await page.keyboard.press('=');
await page.keyboard.press('=');
check('column rect extrudes a wall (+6)', (await cells()) === 18, `${await cells()} cells`);
s = await stats();
check('watertight with wall', s.oddEdges === 0, `${s.oddEdges} odd edges`);
await page.screenshot({ path: `${SHOTS}/50-floorwall.png` });

// --- 6. build rect hands its corners to sculpt mode on Tab ---------------------------
await dragWorld({ x: 1.5, y: 0, z: 0.5 }, { x: 2.5, y: 0, z: 0.5 }); // two floor-top faces
await page.keyboard.press('Tab');
const handoff = await page.evaluate(() => ({
  mode: window.editor.mode.name,
  n: window.editor.selectedVerts.size,
}));
check('Tab hands rect corners to sculpt mode', handoff.mode === 'sculpt' && handoff.n === 6, `${handoff.n} corners`);
await page.keyboard.press('Escape');

// --- 7. visibility: concave junction shown, buried corners hidden ---------------
const vis = await page.evaluate(() => {
  const vm = window.editor.modes.sculpt;
  const visible = new Set(vm.visibleHandles().map((h) => h.lattice));
  return {
    junction: visible.has('1,0,-1'), // wall-base meets floor-top (concave)
    buried: visible.has('2,-1,-1'), // interior floor-bottom corner
  };
});
check('concave wall/floor junction corner is visible', vis.junction);
check('buried bottom corner is hidden', !vis.buried);

// lone cube: exactly 7 of 8 corners visible
await freshScene();
await page.locator('#btn-seed').click();
await page.waitForTimeout(100);
const lone = await page.evaluate(() => ({
  all: window.editor.world.surfaceCornerCount(),
  visible: window.editor.modes.sculpt.visibleHandles().length,
}));
check('lone cube shows exactly 7 of 8 corners', lone.all === 8 && lone.visible === 7, `${lone.visible}/${lone.all}`);

// --- 8. extrusion extrapolates offsets; stale offsets get cleaned ----------------------
await page.keyboard.press('1'); // back to build mode (Tab test left us in sculpt)
await page.evaluate(() => {
  const w = window.editor.world;
  w.setShiftRaw(1, 0, 0, [0, -0.5, 0]);
  w.setShiftRaw(1, 0, 1, [0, -0.5, 0]);
  w.setShiftRaw(9, 9, 9, [0.3, 0.3, 0.3]); // stale offset floating in space
});
await clickWorld({ x: 1, y: -0.5, z: 0.5 }); // +x face of the seed (ramp side)
await page.keyboard.press('=');
const ramp = await page.evaluate(() => {
  const a = window.editor.world.getShift(2, 0, 0);
  const b = window.editor.world.getShift(2, 0, 1);
  return a && b && Math.abs(a[1] + 0.5) < 1e-6 && Math.abs(b[1] + 0.5) < 1e-6;
});
check('extrusion carries the ramp cross-section', !!ramp);
check(
  'stale off-surface offsets are cleaned up',
  await page.evaluate(() => window.editor.world.getShift(9, 9, 9) === null),
);

// --- 8b. O in build mode clears the rect's corner offsets --------------------------------
await clickWorld({ x: 1.9, y: -0.3, z: 0.5 }); // the extruded ramp cell's face
const rampShiftsBefore = await shifts();
await page.keyboard.press('o');
check(
  'O in build mode clears the rect corner offsets',
  rampShiftsBefore > 0 && (await shifts()) < rampShiftsBefore,
  `${rampShiftsBefore} -> ${await shifts()}`,
);
await page.keyboard.press('ControlOrMeta+z');
check('O reset undoes', (await shifts()) === rampShiftsBefore, `${await shifts()} shifts`);

// --- 9. sculpt interactions: click selects, second click drags, clamp ±0.5 --------------
await freshScene();
await page.locator('#btn-seed').click();
await page.keyboard.press('2');
await page.waitForTimeout(150);
const corner = await screen({ x: 0, y: 0, z: 0 });
await page.mouse.click(box.x + corner.x, box.y + corner.y);
const afterClick = await page.evaluate(() => ({
  sel: [...window.editor.selectedVerts],
  shifts: window.editor.world.shiftCount(),
}));
check(
  'click selects without moving',
  afterClick.sel.length === 1 && afterClick.sel[0] === 'L:0,0,0' && afterClick.shifts === 0,
);
// drag from a *different, unselected* corner → box select, not a move
const other = await screen({ x: 1, y: 0, z: 0 });
await page.mouse.move(box.x + other.x, box.y + other.y);
await page.mouse.down();
await page.mouse.move(box.x + other.x + 60, box.y + other.y + 60, { steps: 6 });
await page.mouse.up();
check(
  'drag from unselected corner box-selects (no move)',
  (await shifts()) === 0,
);
// click the corner, then click-drag it far upward → clamped at +0.5
await page.mouse.click(box.x + corner.x, box.y + corner.y);
const wayUp = await screen({ x: 0, y: 4, z: 0 });
await page.mouse.move(box.x + corner.x, box.y + corner.y);
await page.mouse.down();
await page.mouse.move(box.x + wayUp.x, box.y + wayUp.y, { steps: 10 });
await page.mouse.up();
const clampCheck = await page.evaluate(() => {
  const v = window.editor.world.getShift(0, 0, 0);
  return v && v[1] === 0.5 && Math.abs(v[0]) <= 0.5 && Math.abs(v[2]) <= 0.5;
});
check('second-click drag moves, hard-clamped to ±0.5', !!clampCheck);
await page.keyboard.press('ControlOrMeta+z');

// --- 10. axis constraint + nudge -----------------------------------------------------------
await page.mouse.move(box.x + 200, box.y + 120);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 80, box.y + box.height - 80, { steps: 6 });
await page.mouse.up();
const nSel = await page.evaluate(() => window.editor.selectedVerts.size);
check('box select picks visible corners', nSel === 7, `${nSel} selected`);
await page.keyboard.press('y');
const con = await page.evaluate(() => window.editor.modes.sculpt.constraint);
check('Y sets the y-axis constraint', con && con.axis === 1 && !con.plane);
await page.keyboard.press('=');
const nudged = await page.evaluate(() => {
  const ed = window.editor;
  const keys = [...ed.selectedVerts].map((k) => k.slice(2).split(',').map(Number));
  return keys.every((k) => {
    const v = ed.world.getShift(k[0], k[1], k[2]);
    return v && Math.abs(v[1] - 0.5) < 1e-6;
  });
});
check('= nudges the selection up along y', nudged);
await page.keyboard.press('-');
check('− nudges back down', (await shifts()) === 0, `${await shifts()} shifts`);
await page.keyboard.press('Shift+y');
const conPlane = await page.evaluate(() => window.editor.modes.sculpt.constraint);
check('Shift+Y sets the plane constraint', conPlane && conPlane.axis === 1 && conPlane.plane);
await page.keyboard.press('Shift+y');
check(
  'same key clears the constraint',
  await page.evaluate(() => window.editor.modes.sculpt.constraint === null),
);

// --- 11. shortest-path selection -----------------------------------------------------------
await freshScene();
await page.locator('#btn-seed').click();
await page.keyboard.press('1');
await clickWorld({ x: 1, y: -0.5, z: 0.5 });
for (let i = 0; i < 3; i++) await page.keyboard.press('=');
await page.keyboard.press('2');
await page.waitForTimeout(150);
const pA = await screen({ x: 0, y: 0, z: 0 });
await page.mouse.click(box.x + pA.x, box.y + pA.y);
const pB = await screen({ x: 4, y: 0, z: 0 });
await page.keyboard.down('Meta');
await page.mouse.click(box.x + pB.x, box.y + pB.y);
await page.keyboard.up('Meta');
const path = await page.evaluate(() => [...window.editor.selectedVerts].sort());
check(
  'Ctrl/Cmd+click selects the shortest edge path',
  path.length === 5 &&
    ['L:0,0,0', 'L:1,0,0', 'L:2,0,0', 'L:3,0,0', 'L:4,0,0'].every((k) => path.includes(k)),
  path.join(' '),
);

// --- 12. selection ops under the clamp + view toggles ------------------------------------------
await page.keyboard.press('Escape');
await page.mouse.move(box.x + 200, box.y + 120);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 80, box.y + box.height - 80, { steps: 6 });
await page.mouse.up();
for (let i = 0; i < 4; i++) await page.keyboard.press('u');
const maxShift = await page.evaluate(() => window.editor.world.raw.max_shift_abs());
check('inflate respects the clamp', (await shifts()) > 0 && maxShift <= 0.5 + 1e-6, `${await shifts()} shifts, max ${maxShift.toFixed(3)}`);
await page.keyboard.press('h');
s = await stats();
check('watertight after selection ops', s.oddEdges === 0, `${s.oddEdges} odd edges`);

await page.keyboard.press('v');
const voxelView = await page.evaluate(
  () => window.editor.geomView === 'voxels' && window.editor.renderer.allPositionsInteger(),
);
check('voxel geometry view displays raw integer geometry', voxelView);
await page.keyboard.press('t');
const texState = await page.evaluate(() => ({
  tex: window.editor.texView,
  geom: window.editor.geomView,
}));
check(
  'texture toggle is independent of geometry toggle',
  texState.tex === 'untextured' && texState.geom === 'voxels',
);
await page.screenshot({ path: `${SHOTS}/51-voxel-untextured.png` });
await page.keyboard.press('v');
check(
  'untextured view survives geometry toggle (sculpted+untextured)',
  await page.evaluate(
    () => window.editor.geomView === 'sculpted' && window.editor.texView === 'untextured',
  ),
);
await page.keyboard.press('t');
check(
  'view button labels restored',
  (await page.locator('#btn-geom').textContent()) === 'Sculpted' &&
    (await page.locator('#btn-tex').textContent()) === 'Textured',
);

// --- 12b. spatial sculpt brushes -----------------------------------------------------------
await freshScene();
await page.locator('#btn-seed').click();
await page.keyboard.press('1');
// small plateau: row of 3, widened to 3×3, plus a box on top (hard edges to smooth)
await clickWorld({ x: 1, y: -0.5, z: 0.5 });
await page.keyboard.press('=');
await page.keyboard.press('=');
await dragWorld({ x: 0.5, y: -0.5, z: 0 }, { x: 2.5, y: -0.5, z: 0 });
await page.keyboard.press('=');
await page.keyboard.press('=');
await clickWorld({ x: 1.5, y: 0, z: -0.5 }); // top of the middle cell
await page.keyboard.press('=');
check('plateau + box built', (await cells()) === 10, `${await cells()} cells`);
await page.keyboard.press('2');
await page.waitForTimeout(150);

await page.keyboard.press('b');
check(
  'B activates the smooth brush',
  (await page.evaluate(() => window.editor.modes.sculpt.tool)) === 'smooth',
);
await page.evaluate(() => {
  window.editor.brush.radius = 2;
  window.editor.brush.strength = 0.8;
});
const boxTop = { x: 1.5, y: 1, z: -0.5 };
await dragWorld(boxTop, { x: 2.5, y: 0, z: -0.5 }, { steps: 14 });
check(
  'smooth brush rounds hard voxel edges (offsets appear)',
  (await shifts()) > 4,
  `${await shifts()} shifts`,
);
s = await stats();
check('watertight after smooth brush', s.oddEdges === 0, `${s.oddEdges} odd edges`);
await page.screenshot({ path: `${SHOTS}/52-smoothed.png` });

// draw brush with topology: strokes grow new voxels, Alt digs them away
await page.keyboard.press('f');
check(
  'F activates the draw brush',
  (await page.evaluate(() => window.editor.modes.sculpt.tool)) === 'draw',
);
await page.locator('#brush-topo').check();
check('topology checkbox wires up', await page.evaluate(() => window.editor.brush.topo === true));
await page.locator('#brush-strength').fill('1');
check(
  'strength slider wires up',
  await page.evaluate(() => window.editor.brush.strength === 1),
);
const beforeGrow = await cells();
const spot = { x: 0.5, y: 0, z: -1.5 }; // flat corner of the plateau
for (let i = 0; i < 3; i++) await dragWorld(spot, { x: 1, y: 0, z: -1.5 }, { steps: 8 });
const afterGrow = await cells();
check('draw brush with topology grows new voxels', afterGrow > beforeGrow, `${beforeGrow} -> ${afterGrow}`);
s = await stats();
check('watertight after brush growth', s.oddEdges === 0, `${s.oddEdges} odd edges`);
await page.screenshot({ path: `${SHOTS}/53-grown.png` });

await page.keyboard.down('Alt');
for (let i = 0; i < 4; i++) await dragWorld({ x: 1, y: 1, z: -1.5 }, { x: 0.5, y: 1, z: -1.5 }, { steps: 8 });
await page.keyboard.up('Alt');
const afterDig = await cells();
check('Alt+draw digs voxels away', afterDig < afterGrow, `${afterGrow} -> ${afterDig}`);
s = await stats();
check('watertight after digging', s.oddEdges === 0, `${s.oddEdges} odd edges`);

// a single stroke (cells + offsets) is a single undo step
await freshScene();
await page.locator('#btn-seed').click();
const oneBefore = await cells();
await dragWorld({ x: 0.5, y: 0, z: 0.5 }, { x: 0.5, y: 0, z: 0.4 }, { steps: 10 });
const oneAfter = await cells();
await page.keyboard.press('ControlOrMeta+z');
check(
  'brush stroke undoes as one op',
  oneAfter > oneBefore && (await cells()) === oneBefore && (await shifts()) === 0,
  `${oneBefore} -> ${oneAfter} -> ${await cells()}`,
);

// --- 12c. face painting ------------------------------------------------------------------
await freshScene();
await page.locator('#btn-seed').click();
await page.keyboard.press('1');
// small floor: row + widen
await clickWorld({ x: 1, y: -0.5, z: 0.5 });
for (let i = 0; i < 3; i++) await page.keyboard.press('=');
await dragWorld({ x: 0.5, y: -0.5, z: 0 }, { x: 3.5, y: -0.5, z: 0 });
await page.keyboard.press('=');
await page.keyboard.press('=');
check('paint test floor built', (await cells()) === 12, `${await cells()} cells`);

await page.keyboard.press('3');
check('3 switches to paint mode', (await page.evaluate(() => window.editor.mode.name)) === 'paint');
check(
  'paint mode forces the textured view',
  (await page.evaluate(() => window.editor.texView)) === 'textured',
);
const paints = () => page.evaluate(() => window.editor.world.paintCount());

// single-tile paint on a top face
await page.evaluate(() => {
  window.editor.stamp = { tx: 2, ty: 1, w: 1, h: 1 };
});
await clickWorld({ x: 1.5, y: 0, z: -0.5 });
check('click paints one face', (await paints()) === 1, `${await paints()} paints`);
const p0 = await page.evaluate(() =>
  window.editor.world.getPaint({ cell: [1, -1, -1], dir: 2 }),
);
check('painted face has the stamp tile', !!p0 && p0[0] === 2 && p0[1] === 1, JSON.stringify(p0));
check('painted faces render in a textured group', (await page.evaluate(() => window.editor.renderer.paintedFaceCount())) === 1);

// drag paints a stroke as ONE op; multi-tile stamps lay a pattern
await page.evaluate(() => {
  window.editor.stamp = { tx: 0, ty: 0, w: 2, h: 1 };
});
await dragWorld({ x: 0.5, y: 0, z: -0.5 }, { x: 3.5, y: 0, z: -0.5 }, { steps: 20 });
const nPaint = await paints();
check('drag paints multiple faces', nPaint >= 4, `${nPaint} paints`);
const pattern = await page.evaluate(() => {
  const a = window.editor.world.getPaint({ cell: [0, -1, -1], dir: 2 });
  const b = window.editor.world.getPaint({ cell: [1, -1, -1], dir: 2 });
  return a && b && a[0] !== b[0]; // 2-wide stamp alternates tile columns
});
check('multi-tile stamp lays a grid-locked pattern', !!pattern);
await page.keyboard.press('ControlOrMeta+z');
check('paint stroke undoes as one op', (await paints()) === 1, `${await paints()} paints`);
await page.keyboard.press('ControlOrMeta+Shift+z');

// eyedrop
await page.evaluate(() => {
  window.editor.stamp = { tx: 7, ty: 7, w: 1, h: 1 };
});
await page.keyboard.down('Alt');
await clickWorld({ x: 1.5, y: 0, z: -0.5 });
await page.keyboard.up('Alt');
const dropped = await page.evaluate(() => ({ ...window.editor.stamp }));
check('Alt+click eyedrops the tile', dropped.tx === 0 || dropped.tx === 1, JSON.stringify(dropped));

// erase with RMB
const beforeErase = await paints();
const eraseAt = await screen({ x: 1.5, y: 0, z: -0.5 });
await page.mouse.click(box.x + eraseAt.x, box.y + eraseAt.y, { button: 'right' });
check('right-click erases paint', (await paints()) === beforeErase - 1, `${beforeErase} -> ${await paints()}`);

// paint hygiene: extruding a painted face carries the paint
await page.evaluate(() => {
  window.editor.stamp = { tx: 3, ty: 2, w: 1, h: 1 };
});
await clickWorld({ x: 2.5, y: 0, z: -0.5 }); // paint top of cell (2,-1,-1)
check('hygiene setup painted', await page.evaluate(() =>
  !!window.editor.world.getPaint({ cell: [2, -1, -1], dir: 2 }),
));
await page.keyboard.press('1');
await clickWorld({ x: 2.5, y: 0, z: -0.5 }); // select that face
await page.keyboard.press('=');
const carried = await page.evaluate(() => window.editor.world.getPaint({ cell: [2, 0, -1], dir: 2 }));
check('extrusion carries paint to the new face', !!carried && carried[0] === 3 && carried[1] === 2, JSON.stringify(carried));
const oldCleared = await page.evaluate(() => window.editor.world.getPaint({ cell: [2, -1, -1], dir: 2 }));
check('buried face paint is cleaned', oldCleared === null);
await page.keyboard.press('-');
const inherited = await page.evaluate(() => window.editor.world.getPaint({ cell: [2, -1, -1], dir: 2 }));
check('carving inherits paint back down', !!inherited && inherited[0] === 3, JSON.stringify(inherited));

// paints roundtrip through save/load
const pJson = await page.evaluate(async () => {
  const { serializeScene } = await import('/src/io.ts');
  return serializeScene(window.editor);
});
const beforeRT = await paints();
await page.evaluate(() => window.editor.world.clear());
await page.evaluate(async (data) => {
  const { loadScene } = await import('/src/io.ts');
  await loadScene(window.editor, data);
}, pJson);
check('paints survive save/load', (await paints()) === beforeRT, `${await paints()} paints`);
await page.screenshot({ path: `${SHOTS}/57-painted.png` });

// R rotates, F flips; Q/E stay reserved for the fly camera
await page.keyboard.press('3');
await page.evaluate(() => { window.editor.modes.paint.orient = { rot: 0, flipH: false, flipV: false }; });
await page.keyboard.press('r');
await page.keyboard.press('f');
await page.keyboard.press('q');
await page.keyboard.press('e');
const orient = await page.evaluate(() => window.editor.modes.paint.orient);
check('R rotates and F flips the stamp (Q/E ignored)', orient.rot === 1 && orient.flipH === true && orient.flipV === false, JSON.stringify(orient));

// --- 12d. play mode: land, run, jump, climb a 45° ramp -------------------------------------
await freshScene();
await page.evaluate(() => {
  const ed = window.editor, w = ed.world;
  w.raw.fill_box_raw(-10, -1, -10, 20, 0, 10, true); // floor
  for (let i = 0; i < 4; i++) w.raw.fill_box_raw(5 + i, 0, -2, 6 + i, 1 + i, 2, true);
  for (let i = 0; i < 4; i++) {
    for (let z = -2; z <= 2; z++) {
      w.setShiftRaw(5 + i, 1 + i, z, [0, -0.5, 0]);
      w.setShiftRaw(6 + i, 1 + i, z, [0, 0.5, 0]);
    }
  }
  ed.renderer.rebuildAll(w);
  w.raw.take_dirty();
  ed.viewport.target.set(0, 0.5, 0);
});
await page.keyboard.press('g');
check('G enters play mode', await page.evaluate(() => window.editor.playing === true));
await page.waitForTimeout(800);
const landed = await page.evaluate(() => ({
  y: window.editor.play.pos.y,
  g: window.editor.play.onGround,
}));
check('player falls and lands on the floor', Math.abs(landed.y) < 0.05 && landed.g, JSON.stringify(landed));

await page.evaluate(() => { window.editor.viewport.yaw = Math.PI; }); // W = +x
await page.keyboard.down('w');
await page.waitForTimeout(600);
await page.keyboard.up('w');
const ran = await page.evaluate(() => window.editor.play.pos.x);
check('WASD runs the player', ran > 2, `x=${ran.toFixed(1)}`);

// back away from the ramp base so the jump tests flat ground
await page.keyboard.down('s');
await page.waitForTimeout(400);
await page.keyboard.up('s');
await page.waitForTimeout(300);
await page.keyboard.down(' ');
await page.waitForTimeout(120);
await page.keyboard.up(' ');
await page.waitForTimeout(200);
const jumpY = await page.evaluate(() => window.editor.play.pos.y);
check('Space jumps', jumpY > 0.8, `y=${jumpY.toFixed(2)}`);
await page.waitForTimeout(900);
check(
  'player lands after the jump',
  await page.evaluate(() => window.editor.play.onGround && Math.abs(window.editor.play.pos.y) < 0.05),
);

// the run continues past the ramp top, so judge the peak height reached
await page.evaluate(() => {
  window.__peak = 0;
  window.__peakTimer = setInterval(() => {
    window.__peak = Math.max(window.__peak, window.editor.play?.pos.y ?? 0);
  }, 16);
});
await page.keyboard.down('w');
await page.waitForTimeout(1800);
await page.keyboard.up('w');
const climbed = await page.evaluate(() => {
  clearInterval(window.__peakTimer);
  return { x: window.editor.play.pos.x, peak: window.__peak };
});
check('player climbs the 45° ramp', climbed.peak > 3, JSON.stringify(climbed));

// chase camera: the Rust spherecast feeds the boom clamp every frame
const clamp = await page.evaluate(() => window.editor.viewport.distClamp);
check('camera clearance clamp is live', typeof clamp === 'number' && clamp > 0 && clamp <= 16, `clamp=${clamp}`);
await page.screenshot({ path: `${SHOTS}/61-play.png` });

await page.keyboard.press('Escape');
check(
  'Esc exits play and restores the camera',
  await page.evaluate(
    () => window.editor.playing === false && window.editor.play === null && window.editor.viewport.mode === 'orbit',
  ),
);

// --- 13. cameras (fly uses Q/E for down/up) ------------------------------------------------
await page.keyboard.press('p');
check('P switches to fly', (await page.evaluate(() => window.editor.viewport.mode)) === 'fly');
const p1 = await page.evaluate(() => window.editor.viewport.cameraPos());
await page.keyboard.down('w');
await page.waitForTimeout(350);
await page.keyboard.up('w');
const p2 = await page.evaluate(() => window.editor.viewport.cameraPos());
check('W flies the camera', Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z) > 0.5);
await page.keyboard.down('q');
await page.waitForTimeout(250);
await page.keyboard.up('q');
const p3 = await page.evaluate(() => window.editor.viewport.cameraPos());
check('Q descends', p3.y < p2.y - 0.3, `Δy ${(p3.y - p2.y).toFixed(2)}`);
await page.keyboard.press('p');
check('P returns to orbit', (await page.evaluate(() => window.editor.viewport.mode)) === 'orbit');

// --- 14. save/load roundtrip (format v3) ----------------------------------------------------
await page.evaluate(() => {
  const vp = window.editor.viewport;
  vp.target.set(0, 0.5, 0);
  vp.yaw = -Math.PI / 4;
  vp.pitch = 0.55;
  vp.dist = 14;
});
await freshScene();
await page.locator('#btn-seed').click();
await page.evaluate(() => window.editor.world.setShiftRaw(0, 0, 0, [0.25, 0.5, -0.25]));
const savedCells = await cells();
const savedShifts = await shifts();
const json = await page.evaluate(async () => {
  const { serializeScene } = await import('/src/io.ts');
  return serializeScene(window.editor);
});
const parsed = JSON.parse(json);
check(
  'save format is v3 with cells+shifts',
  parsed.version === 3 && Array.isArray(parsed.doc.cells) && !('faces' in parsed.doc),
);
await page.evaluate(() => window.editor.world.clear());
await page.evaluate(async (data) => {
  const { loadScene } = await import('/src/io.ts');
  await loadScene(window.editor, data);
}, json);
const shiftBack = await page.evaluate(() => window.editor.world.getShift(0, 0, 0));
check(
  'save/load keeps cells and shifts',
  (await cells()) === savedCells &&
    (await shifts()) === savedShifts &&
    shiftBack &&
    Math.abs(shiftBack[0] - 0.25) < 1e-6,
  `${await cells()} cells, ${await shifts()} shifts`,
);

await browser.close();
console.log(log.join('\n'));
if (errors.length) console.log('\nBROWSER ERRORS:\n' + errors.join('\n'));
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed}/${log.length} checks passed, ${errors.length} browser errors`);
process.exit(failed || errors.length ? 1 : 0);
