// End-to-end drive of the volume editor: seed voxel, rect-select + =/− with
// faces-only extrude and march-through-air carve, offset extrapolation &
// hygiene, ±0.5 clamping, exact vertex visibility (incl. concave corners),
// click-to-select-then-drag, axis constraints + nudges, shortest-path select,
// build→vertex selection handoff, brushes, view modes, cameras, undo, save/load.
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
await page.waitForTimeout(500);
const freshScene = () =>
  page.evaluate(() => {
    localStorage.clear();
    window.editor.doc.clear();
    window.editor.history.clear();
  });
await freshScene();

const box = await page.locator('#viewport').boundingBox();
const cells = () => page.evaluate(() => window.editor.doc.cells.size);
const shifts = () => page.evaluate(() => window.editor.doc.shifts.size);
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
  'modes are just build/vertex',
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
await page.screenshot({ path: `${SHOTS}/40-floorwall.png` });

// --- 6. build rect hands its corners to vertex mode on Tab ---------------------------
await dragWorld({ x: 1.5, y: 0, z: 0.5 }, { x: 2.5, y: 0, z: 0.5 }); // two floor-top faces
await page.keyboard.press('Tab');
const handoff = await page.evaluate(() => ({
  mode: window.editor.mode.name,
  n: window.editor.selectedVerts.size,
}));
check('Tab hands rect corners to vertex mode', handoff.mode === 'vertex' && handoff.n === 6, `${handoff.n} corners`);
await page.keyboard.press('Escape');

// --- 7. exact visibility: concave junction shown, buried corners hidden ---------------
const vis = await page.evaluate(() => {
  const vm = window.editor.modes.vertex;
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
const lone = await page.evaluate(() => {
  const vm = window.editor.modes.vertex;
  return { all: vm.handles().length, visible: vm.visibleHandles().length };
});
check('lone cube shows exactly 7 of 8 corners', lone.all === 8 && lone.visible === 7, `${lone.visible}/${lone.all}`);

// --- 8. extrusion extrapolates offsets; stale offsets get cleaned ----------------------
await page.keyboard.press('1'); // back to build mode (Tab test left us in vertex)
await page.evaluate(() => {
  window.editor.doc.writeShiftsLive([
    ['1,0,0', { x: 0, y: -0.5, z: 0 }],
    ['1,0,1', { x: 0, y: -0.5, z: 0 }],
    ['9,9,9', { x: 0.3, y: 0.3, z: 0.3 }], // stale offset floating in space
  ]);
});
await clickWorld({ x: 1, y: -0.5, z: 0.5 }); // +x face of the seed (ramp side)
await page.keyboard.press('=');
const ramp = await page.evaluate(() => {
  const a = window.editor.doc.shifts.get('2,0,0');
  const b = window.editor.doc.shifts.get('2,0,1');
  return a && b && Math.abs(a.y + 0.5) < 1e-9 && Math.abs(b.y + 0.5) < 1e-9;
});
check('extrusion carries the ramp cross-section', !!ramp);
check(
  'stale off-surface offsets are cleaned up',
  await page.evaluate(() => !window.editor.doc.shifts.has('9,9,9')),
);

// --- 9. vertex interactions: click selects, second click drags, clamp ±0.5 --------------
await freshScene();
await page.locator('#btn-seed').click();
await page.keyboard.press('2');
await page.waitForTimeout(150);
const corner = await screen({ x: 0, y: 0, z: 0 });
await page.mouse.click(box.x + corner.x, box.y + corner.y);
const afterClick = await page.evaluate(() => ({
  sel: [...window.editor.selectedVerts],
  shifts: window.editor.doc.shifts.size,
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
  await page.evaluate(() => window.editor.doc.shifts.size === 0),
);
// click the corner, then click-drag it far upward → clamped at +0.5
await page.mouse.click(box.x + corner.x, box.y + corner.y);
const wayUp = await screen({ x: 0, y: 4, z: 0 });
await page.mouse.move(box.x + corner.x, box.y + corner.y);
await page.mouse.down();
await page.mouse.move(box.x + wayUp.x, box.y + wayUp.y, { steps: 10 });
await page.mouse.up();
const clampCheck = await page.evaluate(() => {
  const v = window.editor.doc.shifts.get('0,0,0');
  return v && v.y === 0.5 && Math.abs(v.x) <= 0.5 && Math.abs(v.z) <= 0.5;
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
const con = await page.evaluate(() => window.editor.modes.vertex.constraint);
check('Y sets the y-axis constraint', con && con.axis === 1 && !con.plane);
await page.keyboard.press('=');
const nudged = await page.evaluate(() => {
  const ed = window.editor;
  const keys = [...ed.selectedVerts].map((k) => k.slice(2));
  return keys.every((lk) => Math.abs((ed.doc.shifts.get(lk)?.y ?? 0) - 0.5) < 1e-9);
});
check('= nudges the selection up along y', nudged);
await page.keyboard.press('-');
check('− nudges back down', (await shifts()) === 0, `${await shifts()} shifts`);
await page.keyboard.press('Shift+y');
const conPlane = await page.evaluate(() => window.editor.modes.vertex.constraint);
check('Shift+Y sets the plane constraint', conPlane && conPlane.axis === 1 && conPlane.plane);
await page.keyboard.press('Shift+y');
check(
  'same key clears the constraint',
  await page.evaluate(() => window.editor.modes.vertex.constraint === null),
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

// --- 12. brushes under the clamp + views ------------------------------------------------------
await page.keyboard.press('Escape');
await page.mouse.move(box.x + 200, box.y + 120);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 80, box.y + box.height - 80, { steps: 6 });
await page.mouse.up();
for (let i = 0; i < 4; i++) await page.keyboard.press('u');
const clamped = await page.evaluate(() =>
  [...window.editor.doc.shifts.values()].every(
    (v) => Math.abs(v.x) <= 0.5 && Math.abs(v.y) <= 0.5 && Math.abs(v.z) <= 0.5,
  ),
);
check('inflate brush respects the clamp', (await shifts()) > 0 && clamped, `${await shifts()} shifts`);
await page.keyboard.press('h');
s = await stats();
check('watertight after brushes', s.oddEdges === 0, `${s.oddEdges} odd edges`);
await page.screenshot({ path: `${SHOTS}/41-sculpt.png` });

await page.keyboard.press('v');
const voxelView = await page.evaluate(() => {
  const ed = window.editor;
  if (ed.viewMode !== 'voxels') return false;
  for (const f of ed.displaySurface) {
    for (const v of f.verts) {
      if (
        Math.abs(v.x - Math.round(v.x)) > 1e-9 ||
        Math.abs(v.y - Math.round(v.y)) > 1e-9 ||
        Math.abs(v.z - Math.round(v.z)) > 1e-9
      )
        return false;
    }
  }
  return true;
});
check('voxel view displays raw integer geometry', voxelView);
await page.keyboard.press('v');
check(
  'sculpted view label restored',
  (await page.locator('#btn-view').textContent()) === 'Sculpted',
);

// --- 13. cameras (fly uses Q/E for down/up now) ------------------------------------------------
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

// --- 14. save/load roundtrip (format v3: cells + shifts only) ----------------------------------
const savedCells = await cells();
const savedShifts = await shifts();
const json = await page.evaluate(async () => {
  const { serializeScene } = await import('/src/io.ts');
  return serializeScene(window.editor);
});
check('save format is v3 without faces', JSON.parse(json).version === 3 && !('faces' in JSON.parse(json).doc));
await page.evaluate(() => window.editor.doc.clear());
await page.evaluate(async (data) => {
  const { loadScene } = await import('/src/io.ts');
  await loadScene(window.editor, data);
}, json);
check(
  'save/load keeps cells and shifts',
  (await cells()) === savedCells && (await shifts()) === savedShifts,
  `${await cells()} cells, ${await shifts()} shifts`,
);

await browser.close();
console.log(log.join('\n'));
if (errors.length) console.log('\nBROWSER ERRORS:\n' + errors.join('\n'));
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed}/${log.length} checks passed, ${errors.length} browser errors`);
process.exit(failed || errors.length ? 1 : 0);
