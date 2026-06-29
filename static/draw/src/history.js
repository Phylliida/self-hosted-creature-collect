/**
 * Undo/redo via a command stack. Commands are plain objects with do()/undo().
 * Operating on the Scene rather than snapshotting keeps memory bounded even
 * for large drawings.
 */
export class History {
  constructor(scene, { limit = 500 } = {}) {
    this.scene = scene;
    this.undoStack = [];
    this.redoStack = [];
    this.limit = limit;
    this.onChange = null;
  }

  _notify() { if (this.onChange) this.onChange(); }

  /** Run a command and record it for undo. */
  push(cmd) {
    cmd.do();
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._notify();
  }

  /** Record an already-applied command without running do() again. */
  pushApplied(cmd) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._notify();
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    this._notify();
    return true;
  }
  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.do();
    this.undoStack.push(cmd);
    this._notify();
    return true;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._notify();
  }
}

// ---- command factories -------------------------------------------------

export function addItemsCmd(scene, items) {
  const list = items.slice();
  return {
    label: `add ${list.length}`,
    do() { scene.addMany(list); },
    undo() { scene.removeMany(list.map(i => i.id)); },
  };
}

export function removeItemsCmd(scene, items) {
  // Snapshot with their original z-order positions so undo restores order.
  const snapshot = items.map(it => ({ item: it, index: scene.items.indexOf(it) }))
                        .sort((a, b) => a.index - b.index);
  return {
    label: `delete ${items.length}`,
    do() { scene.removeMany(items.map(i => i.id)); },
    undo() {
      for (const { item, index } of snapshot) {
        const at = Math.min(index, scene.items.length);
        scene.items.splice(at, 0, item);
        scene._index.set(item.id, item);
      }
      scene._touch();
    },
  };
}

/** Move a set of items by (dx,dy); stores the delta for reversal. */
export function moveItemsCmd(scene, ids, dx, dy, translateFn) {
  return {
    label: `move ${ids.length}`,
    do() {
      for (const id of ids) { const it = scene.byId(id); if (it) translateFn(it, dx, dy); }
      scene._touch();
    },
    undo() {
      for (const id of ids) { const it = scene.byId(id); if (it) translateFn(it, -dx, -dy); }
      scene._touch();
    },
  };
}

/** Reorder the whole item list (z-order), reversible. */
export function reorderCmd(scene, beforeIds, afterIds) {
  return {
    label: 'reorder',
    do() { scene._applyOrder(afterIds); },
    undo() { scene._applyOrder(beforeIds); },
  };
}

/** Replace one item's fields with `after`, reversible to `before`. */
export function modifyItemCmd(scene, id, before, after) {
  return {
    label: `edit`,
    do() { Object.assign(scene.byId(id) || {}, after); scene._touch(); },
    undo() { Object.assign(scene.byId(id) || {}, before); scene._touch(); },
  };
}
