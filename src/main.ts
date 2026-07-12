import './style.css';
import { Editor } from './editor';

const editor = new Editor();
// handy for poking around in the devtools console
(window as unknown as { editor: Editor }).editor = editor;
