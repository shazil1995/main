// Pure navigation helpers for the grid, kept free of React so they can be unit-tested.

export interface Pos { row: number; col: number }
export interface Dim { rows: number; cols: number; page: number }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Returns the new active position for a navigation key, or null if the key is not a navigation key. */
export function nextPos(p: Pos, key: string, d: Dim, mods: { ctrl?: boolean; shift?: boolean } = {}): Pos | null {
  if (d.rows === 0 || d.cols === 0) return null;
  const last = { row: d.rows - 1, col: d.cols - 1 };
  switch (key) {
    case 'ArrowUp': return { row: mods.ctrl ? 0 : clamp(p.row - 1, 0, last.row), col: p.col };
    case 'ArrowDown': return { row: mods.ctrl ? last.row : clamp(p.row + 1, 0, last.row), col: p.col };
    case 'ArrowLeft': return { row: p.row, col: mods.ctrl ? 0 : clamp(p.col - 1, 0, last.col) };
    case 'ArrowRight': return { row: p.row, col: mods.ctrl ? last.col : clamp(p.col + 1, 0, last.col) };
    case 'Tab': {
      if (mods.shift) return p.col > 0 ? { row: p.row, col: p.col - 1 } : p.row > 0 ? { row: p.row - 1, col: last.col } : p;
      return p.col < last.col ? { row: p.row, col: p.col + 1 } : p.row < last.row ? { row: p.row + 1, col: 0 } : p;
    }
    case 'Home': return { row: mods.ctrl ? 0 : p.row, col: 0 };
    case 'End': return { row: mods.ctrl ? last.row : p.row, col: last.col };
    case 'PageUp': return { row: clamp(p.row - d.page, 0, last.row), col: p.col };
    case 'PageDown': return { row: clamp(p.row + d.page, 0, last.row), col: p.col };
    default: return null;
  }
}

/** A printable key that should start editing with that character (not a shortcut). */
export function isTypingKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** Inclusive row range for shift-click selection between an anchor and a target index. */
export function rangeIds(ids: string[], anchor: number, target: number): string[] {
  const [a, b] = anchor <= target ? [anchor, target] : [target, anchor];
  return ids.slice(a, b + 1);
}

/** Where a pasted block lands: clips to the loaded rows/visible columns and reports what was cut. */
export function pasteTargets(start: Pos, block: string[][], dim: { rows: number; cols: number }) {
  const cells: { row: number; col: number; text: string }[] = [];
  let clippedRows = 0, clippedCols = 0;
  block.forEach((line, r) => {
    if (start.row + r >= dim.rows) { clippedRows++; return; }
    line.forEach((text, c) => { if (start.col + c >= dim.cols) { if (r === 0) clippedCols++; return; } cells.push({ row: start.row + r, col: start.col + c, text }); });
  });
  return { cells, clippedRows, clippedCols };
}
