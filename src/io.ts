import type { DocJSON } from './model';
import type { Editor } from './editor';

export interface SaveData {
  app: 'boxexplore';
  version: 3;
  tileSize: number;
  tileset: string; // data URL
  doc: DocJSON;
}

export function serializeScene(ed: Editor): string {
  const data: SaveData = {
    app: 'boxexplore',
    version: 3,
    tileSize: ed.tileset.tileSize,
    tileset: ed.tileset.toDataURL(),
    doc: ed.doc.toJSON(),
  };
  return JSON.stringify(data);
}

export async function loadScene(ed: Editor, json: string): Promise<void> {
  const data = JSON.parse(json) as SaveData;
  if (data.app !== 'boxexplore' || !data.doc) throw new Error('not a boxexplore scene file');
  await ed.tileset.loadImage(data.tileset);
  ed.tileset.tileSize = data.tileSize || 16;
  ed.doc.loadJSON(data.doc);
  ed.afterSceneLoad();
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
