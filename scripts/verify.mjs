// End-to-end drive of the volume editor: seed voxel, rect-select + =/− extrude
// and carve (with overhang), offset extrapolation & hygiene, ±0.5 clamping,
// exact vertex visibility, brushes, view modes, cameras, undo, save/load.
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
await page.evaluate(() => {
  localStorage.clear();
  window.editor.doc.clear();
  window.editor.history.clear();
});

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

// --- 2. seed voxel + click-select + =/− ----------------------------------------
await page.locator('#btn-seed').click();
check('+ Voxel seeds a cell', (await cells()) === 1, `${await cells()} cells`);
await clickWorld({ x: 0.5, y: 0, z: 0.5 }); // top face of the seed
const sel0 = await page.evaluate(() => window.editor.boxSel && { ...window.editor.boxSel });
check('click selects a 1×1 rect', !!sel0 && sel0.axis === 1 && sel0.sign === 1 && sel0.plane === 0);
await page.keyboard.press('=');
check('= extrudes one cell up', (await cells()) === 2, `${await cells()} cells`);
check(
  'extruded cell is where expected',
  await page.evaluate(() => window.editor.doc.cells.has('0,0,0')),
);
await page.keyboard.press('-');
check('− carves it back', (await cells()) === 1, `${await cells()} cells`);

// --- 3. rect (with air overhang) + extrude fills the whole rect ----------------
await dragWorld({ x: 0.5, y: 0, z: 0.5 }, { x: 5.5, y: 0, z: 3.5 });
await page.keyboard.press('=');
check('rect over air extrudes a 6×4 slab', (await cells()) === 25, `${await cells()} cells`);
let s = await stats();
check('watertight after slab', s.oddEdges === 0, `${s.oddEdges} odd edges`);
await page.screenshot({ path: `${SHOTS}/30-slab.png` });

// --- 4. side rect, repeated extrude, selection plane follows -------------------
await dragWorld({ x: 6, y: 0.5, z: 0.5 }, { x: 6, y: 0.5, z: 1.5 });
await page.keyboard.press('=');
await page.keyboard.press('=');
check('side rect extrudes twice (+4)', (await cells()) === 29, `${await cells()} cells`);
await page.keyboard.press('-');
await page.keyboard.press('-');
check('carving twice reverses it', (await cells()) === 25, `${await cells()} cells`);

// --- 5. overhang carve: rect past the edge shaves only what exists -------------
await page.keyboard.press('Escape');
await dragWorld({ x: 2.5, y: 1, z: 2.5 }, { x: 8.5, y: 1, z: 2.5 });
await page.keyboard.press('-');
check('overhang rect carves only solid cells', (await cells()) === 21, `${await cells()} cells`);
s = await stats();
check('watertight after overhang carve', s.oddEdges === 0, `${s.oddEdges} odd edges`);

// --- 6. undo clears the selection and restores cells ----------------------------
await page.keyboard.press('ControlOrMeta+z');
check('undo restores carved row', (await cells()) === 25, `${await cells()} cells`);
check('undo clears box selection', await page.evaluate(() => window.editor.boxSel === null));
for (let i = 0; i < 8; i++) await page.keyboard.press('ControlOrMeta+z');
check('undo chain empties the scene', (await cells()) === 0, `${await cells()} cells`);

// --- 7. extrusion extrapolates offsets; stale offsets get cleaned ----------------
await page.locator('#btn-seed').click();
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
s = await stats();
check('watertight after ramp extrude', s.oddEdges === 0, `${s.oddEdges} odd edges`);
await page.screenshot({ path: `${SHOTS}/31-ramp.png` });

// --- 8. manual drags hard-clamp offsets to ±0.5 ----------------------------------
await page.evaluate(() => {
  window.editor.doc.clear();
  window.editor.history.clear();
});
await page.locator('#btn-seed').click();
await page.keyboard.press('2'); // vertex mode
await page.waitForTimeout(150);
const corner = await screen({ x: 0, y: 0, z: 0 });
const wayUp = await screen({ x: 0, y: 4, z: 0 });
await page.mouse.move(box.x + corner.x, box.y + corner.y);
await page.mouse.down();
await page.mouse.move(box.x + wayUp.x, box.y + wayUp.y, { steps: 10 });
await page.mouse.up();
const clampCheck = await page.evaluate(() => {
  const v = window.editor.doc.shifts.get('0,0,0');
  return v && v.y === 0.5 && Math.abs(v.x) <= 0.5 && Math.abs(v.z) <= 0.5;
});
check('hand-dragged offsets clamp to ±0.5', !!clampCheck);

// --- 9. exact vertex visibility: a lone cube shows exactly 7 of 8 corners --------
await page.evaluate(() => {
  window.editor.doc.clear();
  window.editor.history.clear();
});
await page.locator('#btn-seed').click();
await page.waitForTimeout(100);
const vis = await page.evaluate(() => {
  const vm = window.editor.modes.vertex;
  return { all: vm.handles().length, visible: vm.visibleHandles().length };
});
check(
  'lone cube shows exactly the 7 visible corners',
  vis.all === 8 && vis.visible === 7,
  `${vis.visible}/${vis.all}`,
);

// 1-thick slab: bottom interior corners hidden from above
await page.keyboard.press('1');
await clickWorld({ x: 0.5, y: 0, z: 0.5 });
await dragWorld({ x: 0.5, y: 0, z: 0.5 }, { x: 3.5, y: 0, z: 2.5 });
await page.keyboard.press('=');
await page.keyboard.press('2');
await page.waitForTimeout(100);
const vis2 = await page.evaluate(() => {
  const vm = window.editor.modes.vertex;
  return {
    all: vm.handles().length,
    visible: vm.visibleHandles().length,
    hidBottomMid: !vm.visibleHandles().some((h) => h.lattice === '2,0,1'),
  };
});
check(
  'thin-slab bottom corners are hidden',
  vis2.visible < vis2.all && vis2.hidBottomMid,
  `${vis2.visible}/${vis2.all} visible`,
);

// --- 10. brushes still work under the clamp --------------------------------------
await page.mouse.move(box.x + 200, box.y + 120);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 80, box.y + box.height - 80, { steps: 6 });
await page.mouse.up();
const nSel = await page.evaluate(() => window.editor.selectedVerts.size);
check('box select picks visible corners', nSel > 6, `${nSel} selected`);
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
await page.screenshot({ path: `${SHOTS}/32-sculpt.png` });

// --- 11. voxel view drives display, previews, and overlays raw --------------------
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
await page.screenshot({ path: `${SHOTS}/33-voxelview.png` });
await page.keyboard.press('v');
check(
  'sculpted view label restored',
  (await page.locator('#btn-view').textContent()) === 'Sculpted',
);

// --- 12. cameras -------------------------------------------------------------------
await page.keyboard.press('p');
check('P switches to fly', (await page.evaluate(() => window.editor.viewport.mode)) === 'fly');
const p1 = await page.evaluate(() => window.editor.viewport.cameraPos());
await page.keyboard.down('w');
await page.waitForTimeout(350);
await page.keyboard.up('w');
const p2 = await page.evaluate(() => window.editor.viewport.cameraPos());
check(
  'W flies the camera',
  Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z) > 0.5,
);
const yaw1 = await page.evaluate(() => window.editor.viewport.yaw);
await page.mouse.move(box.x + 700, box.y + 450);
await page.mouse.down({ button: 'right' });
await page.mouse.move(box.x + 860, box.y + 450, { steps: 8 });
await page.mouse.up({ button: 'right' });
const yaw2 = await page.evaluate(() => window.editor.viewport.yaw);
check('RMB mouselooks in fly mode', Math.abs(yaw2 - yaw1) > 0.05);
await page.keyboard.press('p');
check('P returns to orbit', (await page.evaluate(() => window.editor.viewport.mode)) === 'orbit');

// --- 13. RMB carve + save/load roundtrip ---------------------------------------------
await page.keyboard.press('1');
await page.evaluate(() => {
  // restore a known camera after the fly excursion
  const vp = window.editor.viewport;
  vp.target.set(2, 0, 1.5);
  vp.yaw = -Math.PI / 4;
  vp.pitch = 0.55;
  vp.dist = 14;
});
const nBefore = await cells();
const anyTop = await page.evaluate(() => {
  const ed = window.editor;
  const vf = ed.surface.find((f) => f.dir === 2);
  const c = vf.verts.reduce(
    (a, v) => ({ x: a.x + v.x / 4, y: a.y + v.y / 4, z: a.z + v.z / 4 }),
    { x: 0, y: 0, z: 0 },
  );
  return ed.viewport.screenPoint(c);
});
await page.mouse.click(box.x + anyTop.x, box.y + anyTop.y, { button: 'right' });
check('right-click carves one cell', (await cells()) === nBefore - 1, `${await cells()} cells`);

const savedCells = await cells();
const savedShifts = await shifts();
const json = await page.evaluate(async () => {
  const { serializeScene } = await import('/src/io.ts');
  return serializeScene(window.editor);
});
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
