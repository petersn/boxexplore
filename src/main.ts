import './style.css';
import { Editor } from './editor';
import { WorldHandle, gfx_create, initWasm } from './world';

(async () => {
  await initWasm();
  const world = new WorldHandle();

  // WebGPU init before the editor: size the canvas, negotiate a device.
  // Wait for first layout so the initial surface is created at full size.
  await new Promise((r) => requestAnimationFrame(r));
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const parent = canvas.parentElement!;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(parent.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(parent.clientHeight * dpr));
  try {
    world.raw.gfx_attach(await gfx_create(canvas, canvas.width, canvas.height));
  } catch (err) {
    document.body.innerHTML =
      '<div style="padding:2em;font:14px system-ui;color:#ddd;background:#15171b;height:100vh">' +
      '<h2>WebGPU unavailable</h2><p>boxexplore needs a WebGPU-capable browser ' +
      '(Chrome, Edge, Firefox, or Safari 18.2+).</p><pre>' +
      String(err) +
      '</pre></div>';
    return;
  }

  const editor = new Editor(world);
  // handy for poking around in the devtools console (and for verify scripts)
  (window as unknown as { editor: Editor }).editor = editor;
})();
