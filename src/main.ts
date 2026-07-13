import './style.css';
import { Editor } from './editor';
import { WorldHandle, initWasm } from './world';

(async () => {
  await initWasm();
  const editor = new Editor(new WorldHandle());
  // handy for poking around in the devtools console (and for verify scripts)
  (window as unknown as { editor: Editor }).editor = editor;
})();
