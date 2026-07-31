// commands.js — the canonical ACTION REGISTRY: a single source of truth for
// every user-facing thing Infinizoom can do.
//
// This is the spine of the "Transparency" design language (batch 26). The app
// has grown ~80 features behind glyph toolbars and memorised shortcuts; the cure
// is not fewer features but *visibility*. One registry feeds two surfaces:
//   • the COMMAND PALETTE (global) — search any command by name, see + learn its
//     shortcut, run it. Recognition + search instead of recall.
//   • the CONTEXTUAL HINT LINE (local) — `contextHint()` tells the user what the
//     current tool does and what the modifier keys would do *right now*.
//
// Each command is a plain descriptor:
//   { id, title, cat, icon, keys?, keywords?, run(app), enabled?(app), when?(app) }
//   - keys:   array of display tokens, 'Mod' = Ctrl/⌘ (rendered per-platform).
//             Display only — the real keybindings live in app.js; the palette
//             SHOWS them so it teaches the shortcut as you use it (search-to-learn).
//   - enabled: optional predicate; when false the row is shown but dimmed and not
//             runnable (so you still learn the command exists, and why it's off).
//   - when:   optional predicate; gates a command out of the list entirely until
//             its mode is active (keeps the palette from becoming a wall — the mode
//             toggles stay visible, their sub-commands appear once you're in them).

const hasSel    = app => app.selectedIds.size > 0;
const multiSel  = app => app.selectedIds.size >= 2;
const pixelMode = app => !!(app.pixel && app.pixel.editing);
const flipMode  = app => !!(app.anim && app.anim.on);
const vectorMode = app => !pixelMode(app);

/** Build the full registry, each handler bound to the live app instance. */
export function buildCommands(app) {
  return [
    // ---------------- Tools (vector) ----------------
    { id: 'tool.pen',     title: 'Pen',            cat: 'Tools', icon: '✏️', keys: ['P'], keywords: 'draw freehand pencil sketch', when: vectorMode, run: () => app.setTool('pen') },
    { id: 'tool.brush',   title: 'Brush',          cat: 'Tools', icon: '🖌️', keys: ['B'], keywords: 'pressure taper ribbon', when: vectorMode, run: () => app.setTool('brush') },
    { id: 'tool.line',    title: 'Line',           cat: 'Tools', icon: '╱',  keys: ['L'], keywords: 'straight segment', when: vectorMode, run: () => app.setTool('line') },
    { id: 'tool.arrow',   title: 'Arrow',          cat: 'Tools', icon: '➤',  keys: ['A'], keywords: 'pointer head', when: vectorMode, run: () => app.setTool('arrow') },
    { id: 'tool.rect',    title: 'Rectangle',      cat: 'Tools', icon: '▭',  keys: ['R'], keywords: 'box square', when: vectorMode, run: () => app.setTool('rect') },
    { id: 'tool.ellipse', title: 'Ellipse',        cat: 'Tools', icon: '◯',  keys: ['O'], keywords: 'circle oval', when: vectorMode, run: () => app.setTool('ellipse') },
    { id: 'tool.star',    title: 'Star / polygon', cat: 'Tools', icon: '★',  keys: ['S'], keywords: 'polygon shape points', when: vectorMode, run: () => app.setTool('star') },
    { id: 'tool.text',    title: 'Text',           cat: 'Tools', icon: 'T',  keys: ['T'], keywords: 'label type words', when: vectorMode, run: () => app.setTool('text') },
    { id: 'tool.connector', title: 'Connector',    cat: 'Tools', icon: '⇢',  keys: ['C'], keywords: 'link diagram glue between', when: vectorMode, run: () => app.setTool('connector') },
    { id: 'tool.fold',    title: 'Fold (mirror by reference)', cat: 'Tools', icon: '◧', keys: ['J'], keywords: 'mirror reflect symmetry line copy live reference fractal', when: vectorMode, run: () => app.setTool('fold') },
    { id: 'tool.spin',    title: 'Spin (rotate copies by reference)', cat: 'Tools', icon: '↻', keys: ['K'], keywords: 'rotate copies pivot angle rosette live reference fractal', when: vectorMode, run: () => app.setTool('spin') },
    { id: 'tool.select',  title: 'Select',         cat: 'Tools', icon: '⬚',  keys: ['V'], keywords: 'pick move marquee', when: vectorMode, run: () => app.setTool('select') },
    { id: 'tool.eraser',  title: 'Eraser',         cat: 'Tools', icon: '🩹', keys: ['E'], keywords: 'delete rub remove', when: vectorMode, run: () => app.setTool('eraser') },
    { id: 'tool.pan',     title: 'Pan',            cat: 'Tools', icon: '✋', keys: ['H'], keywords: 'hand move scroll', when: vectorMode, run: () => app.setTool('pan') },

    // ---------------- Modes ----------------
    { id: 'mode.mandala', title: 'Mandala / symmetry mode', cat: 'Modes', icon: '❋', keys: ['M'], keywords: 'radial kaleidoscope mirror symmetry wallpaper', run: () => { const on = app.toggleSymmetry().on; app._toast(on ? 'Mandala mode on' : 'Mandala mode off'); } },
    { id: 'mode.pixel',   title: 'Pixel-art mode',          cat: 'Modes', icon: '🟦', keywords: 'sprite raster bitmap retro 8-bit', run: () => app.togglePixelPanel() },
    { id: 'mode.flipbook', title: 'Flipbook / animation mode', cat: 'Modes', icon: '🎬', keywords: 'stop motion frames pages animate onion', run: () => app.toggleFlipbook() },

    // ---------------- Edit ----------------
    { id: 'edit.undo',   title: 'Undo',        cat: 'Edit', icon: '↶', keys: ['Mod', 'Z'],      keywords: 'back revert', enabled: a => a.history.canUndo(), run: () => app.undo() },
    { id: 'edit.redo',   title: 'Redo',        cat: 'Edit', icon: '↷', keys: ['Mod', '⇧', 'Z'], keywords: 'forward', enabled: a => a.history.canRedo(), run: () => app.redo() },
    { id: 'edit.cut',    title: 'Cut',         cat: 'Edit', icon: '✂', keys: ['Mod', 'X'], keywords: 'clipboard', enabled: hasSel, run: () => app.cutSelection() },
    { id: 'edit.copy',   title: 'Copy',        cat: 'Edit', icon: '⧉', keys: ['Mod', 'C'], keywords: 'clipboard duplicate', enabled: hasSel, run: () => app.copySelection() },
    { id: 'edit.paste',  title: 'Paste',       cat: 'Edit', icon: '📋', keys: ['Mod', 'V'], keywords: 'clipboard', run: () => app.paste() },
    { id: 'edit.dup',    title: 'Duplicate',   cat: 'Edit', icon: '⧉', keys: ['Mod', 'D'], keywords: 'clone copy', enabled: hasSel, run: () => app.duplicateSelection() },
    { id: 'edit.delete', title: 'Delete selection', cat: 'Edit', icon: '🗑', keys: ['Del'], keywords: 'remove erase', enabled: hasSel, run: () => app.deleteSelection() },
    { id: 'edit.all',    title: 'Select all',  cat: 'Edit', icon: '▦', keys: ['Mod', 'A'], keywords: 'everything', run: () => app.selectAll() },
    { id: 'edit.none',   title: 'Deselect',    cat: 'Edit', icon: '▢', keys: ['Esc'], keywords: 'clear selection nothing', enabled: hasSel, run: () => { app.selectedIds.clear(); app._activeId = null; app._updateHud(); app.requestRender(); } },

    // ---------------- Arrange (need a selection) ----------------
    { id: 'arr.front',  title: 'Bring to front', cat: 'Arrange', icon: '⤒', keys: [']'],        keywords: 'z-order raise top', enabled: hasSel, run: () => app.bringToFront() },
    { id: 'arr.back',   title: 'Send to back',   cat: 'Arrange', icon: '⤓', keys: ['['],        keywords: 'z-order lower bottom', enabled: hasSel, run: () => app.sendToBack() },
    { id: 'arr.raise',  title: 'Raise',          cat: 'Arrange', icon: '↑', keys: ['Mod', ']'], keywords: 'z-order up one', enabled: hasSel, run: () => app.raiseSelection() },
    { id: 'arr.lower',  title: 'Lower',          cat: 'Arrange', icon: '↓', keys: ['Mod', '['], keywords: 'z-order down one', enabled: hasSel, run: () => app.lowerSelection() },
    { id: 'arr.rotR',   title: 'Rotate +15°',    cat: 'Arrange', icon: '↻', keys: ['.'], keywords: 'turn spin clockwise', enabled: hasSel, run: () => app.rotateSelection(Math.PI / 12) },
    { id: 'arr.rotL',   title: 'Rotate −15°',    cat: 'Arrange', icon: '↺', keys: [','], keywords: 'turn spin counter', enabled: hasSel, run: () => app.rotateSelection(-Math.PI / 12) },
    { id: 'arr.grow',   title: 'Grow 10%',       cat: 'Arrange', icon: '⤢', keys: ['>'], keywords: 'scale up bigger enlarge', enabled: hasSel, run: () => app.scaleSelection(1.1) },
    { id: 'arr.shrink', title: 'Shrink 10%',     cat: 'Arrange', icon: '⤡', keys: ['<'], keywords: 'scale down smaller', enabled: hasSel, run: () => app.scaleSelection(1 / 1.1) },
    { id: 'arr.group',  title: 'Group',          cat: 'Arrange', icon: '⊞', keys: ['Mod', 'G'], keywords: 'combine unit', enabled: multiSel, run: () => app.groupSelection() },
    { id: 'arr.ungroup', title: 'Ungroup',       cat: 'Arrange', icon: '⊟', keys: ['Mod', '⇧', 'G'], keywords: 'split separate', enabled: hasSel, run: () => app.ungroupSelection() },
    { id: 'arr.parent', title: 'Parent to active item', cat: 'Arrange', icon: '🔗', keys: ['Mod', 'P'], keywords: 'hierarchy child attach', enabled: multiSel, run: () => app.parentSelection() },
    { id: 'arr.unparent', title: 'Unparent',     cat: 'Arrange', icon: '✂️', keys: ['⌥', 'P'], keywords: 'detach hierarchy', enabled: hasSel, run: () => app.unparentSelection() },
    { id: 'arr.lock',   title: 'Lock / unlock selection', cat: 'Arrange', icon: '🔒', keys: ['⇧', 'L'], keywords: 'freeze protect', enabled: hasSel, run: () => app.toggleLockSelection() },
    { id: 'arr.hide',   title: 'Hide / show selection',   cat: 'Arrange', icon: '👁', keys: ['⇧', 'H'], keywords: 'invisible visibility', enabled: hasSel, run: () => app.toggleHideSelection() },
    { id: 'arr.pivot',  title: 'Set / reset transform pivot', cat: 'Arrange', icon: '⊕', keys: ['⇧', 'P'], keywords: 'rotation centre anchor', enabled: hasSel, run: () => app.togglePivot() },
    { id: 'arr.stamp',  title: 'Recursive stamp (fractal)', cat: 'Arrange', icon: '♺', keywords: 'nested shrinking copies droste child zoom levels density vortex spin hue fade', enabled: hasSel, run: () => app.recursiveStamp({ factor: app.stampFactor, depth: app.stampDepth, spin: app.stampSpin, hue: app.stampHue, fade: app.stampFade / 100 }) },
    { id: 'arr.portal', title: 'Recursive portal (live ∞)', cat: 'Arrange', icon: '🌀', keywords: 'droste infinite zoom fractal frame nest self recursion child zoom vortex spin hue spiral rainbow tunnel', enabled: hasSel, run: () => app.createDroste({ factor: app.stampFactor, rot: app.stampSpin * Math.PI / 180, hue: app.stampHue }) },
    { id: 'arr.drosteloop', title: 'Export seamless Droste zoom-loop (GIF)', cat: 'Arrange', icon: '🎞', keywords: 'droste portal loop gif movie video infinite zoom dive seamless export animation', enabled: app => !!app._targetDroste(), run: () => app.downloadDrosteLoop() },
    { id: 'arr.showall', title: 'Show all hidden',  cat: 'Arrange', icon: '👁', keywords: 'reveal recover', run: () => app.showAll() },
    { id: 'arr.unlockall', title: 'Unlock all',     cat: 'Arrange', icon: '🔓', keywords: 'recover free', run: () => app.unlockAll() },

    // ---------------- Align & distribute (need 2+) ----------------
    { id: 'al.left',   title: 'Align left edges',        cat: 'Align', icon: '⇤', enabled: multiSel, keywords: 'snap edge', run: () => app.alignSelection('left') },
    { id: 'al.hcen',   title: 'Align horizontal centres', cat: 'Align', icon: '⇔', enabled: multiSel, keywords: 'middle', run: () => app.alignSelection('hcenter') },
    { id: 'al.right',  title: 'Align right edges',       cat: 'Align', icon: '⇥', enabled: multiSel, keywords: 'edge', run: () => app.alignSelection('right') },
    { id: 'al.top',    title: 'Align top edges',         cat: 'Align', icon: '⎴', enabled: multiSel, keywords: 'edge', run: () => app.alignSelection('top') },
    { id: 'al.vcen',   title: 'Align vertical centres',  cat: 'Align', icon: '⇕', enabled: multiSel, keywords: 'middle', run: () => app.alignSelection('vcenter') },
    { id: 'al.bottom', title: 'Align bottom edges',      cat: 'Align', icon: '⎵', enabled: multiSel, keywords: 'edge', run: () => app.alignSelection('bottom') },
    { id: 'al.distH',  title: 'Distribute horizontally', cat: 'Align', icon: '⬌', enabled: a => a.selectedIds.size >= 3, keywords: 'even spacing gap', run: () => app.distributeSelection('h') },
    { id: 'al.distV',  title: 'Distribute vertically',   cat: 'Align', icon: '⬍', enabled: a => a.selectedIds.size >= 3, keywords: 'even spacing gap', run: () => app.distributeSelection('v') },
    { id: 'al.lodNear', title: 'Show only when zoomed in (LOD near)', cat: 'Align', icon: '🔭', enabled: hasSel, keywords: 'level of detail visible zoom', run: () => app.setSelectionLOD('near') },
    { id: 'al.lodFar',  title: 'Show only when zoomed out (LOD far)', cat: 'Align', icon: '🔭', enabled: hasSel, keywords: 'level of detail visible zoom', run: () => app.setSelectionLOD('far') },
    { id: 'al.lodAll',  title: 'Always visible (LOD all)', cat: 'Align', icon: '🔭', enabled: hasSel, keywords: 'level of detail visible zoom', run: () => app.setSelectionLOD('all') },

    // ---------------- View / navigation ----------------
    { id: 'view.in',   title: 'Zoom in',       cat: 'View', icon: '+', keys: ['+'], keywords: 'magnify closer', run: () => app.zoomAtCenter(1.25) },
    { id: 'view.out',  title: 'Zoom out',      cat: 'View', icon: '−', keys: ['-'], keywords: 'shrink farther', run: () => app.zoomAtCenter(1 / 1.25) },
    { id: 'view.fit',  title: 'Zoom to fit',   cat: 'View', icon: '⤢', keys: ['F'], keywords: 'frame all everything', run: () => app.fitAll() },
    { id: 'view.reset', title: 'Reset view',   cat: 'View', icon: '⌂', keys: ['0'], keywords: 'home origin 100%', run: () => app.resetView() },
    { id: 'view.rotR',  title: 'Rotate canvas +15°', cat: 'View', icon: '↻', keys: ['.'], keywords: 'turn spin view paper orient tilt clockwise', run: () => app.rotateCanvas(Math.PI / 12) },
    { id: 'view.rotL',  title: 'Rotate canvas −15°', cat: 'View', icon: '↺', keys: [','], keywords: 'turn spin view paper orient tilt counter', run: () => app.rotateCanvas(-Math.PI / 12) },
    { id: 'view.rotReset', title: 'Reset canvas rotation (upright)', cat: 'View', icon: '⇧', keywords: 'straighten level north up 0 degrees unrotate untilt', enabled: a => !!a.camera.rot, run: () => app.resetRotation() },
    { id: 'view.grid', title: 'Toggle grid',   cat: 'View', icon: '#', keys: ['G'], keywords: 'lines dots background', run: () => { const t = document.getElementById('gridToggle'); if (t) { t.checked = !t.checked; t.onchange({ target: t }); } } },
    { id: 'view.minimap', title: 'Toggle minimap', cat: 'View', icon: '🗺', keywords: 'overview', run: () => { const t = document.getElementById('minimapToggle'); if (t) { t.checked = !t.checked; t.onchange({ target: t }); } } },
    { id: 'view.snap', title: 'Toggle snap grid', cat: 'View', icon: '⊹', keywords: 'align grid', run: () => { const t = document.getElementById('snapToggle'); if (t) { t.checked = !t.checked; t.onchange({ target: t }); } } },
    { id: 'view.guides', title: 'Toggle smart guides', cat: 'View', icon: '┊', keywords: 'snap align magenta', run: () => { const t = document.getElementById('guidesToggle'); if (t) { t.checked = !t.checked; t.onchange({ target: t }); } } },
    { id: 'view.bookmark', title: 'Bookmark this view', cat: 'View', icon: '🔖', keywords: 'save camera fly', run: () => app.addBookmark() },
    { id: 'view.focus', title: 'Focus mode (hide panels)', cat: 'View', icon: '⛶', keys: ['Tab'], keywords: 'zen distraction free hide chrome recede clean just draw fullscreen', run: () => app.toggleFocus() },
    { id: 'view.coach', title: 'Getting started…', cat: 'View', icon: '✨', keywords: 'help onboarding welcome tips coachmark onramp guide tour how begin first run intro', run: () => app.showCoach() },

    // ---------------- Create ----------------
    { id: 'gen.tree',   title: 'Generate: fractal tree',      cat: 'Create', icon: '🌳', keywords: 'procedural branch', run: () => app.generate('tree', {}, { clear: false, fit: true }) },
    { id: 'gen.spiral', title: 'Generate: spiral squares',    cat: 'Create', icon: '🌀', keywords: 'procedural deep zoom', run: () => app.generate('spiral', {}, { clear: false, fit: true }) },
    { id: 'gen.droste', title: 'Generate: Droste rings',      cat: 'Create', icon: '🎯', keywords: 'procedural recursive deep zoom', run: () => app.generate('droste', {}, { clear: false, fit: true }) },
    { id: 'gen.sier',   title: 'Generate: Sierpinski triangle', cat: 'Create', icon: '🔺', keywords: 'procedural fractal', run: () => app.generate('sierpinski', {}, { clear: false, fit: true }) },
    { id: 'gen.flowers', title: 'Generate: flower field',     cat: 'Create', icon: '🌸', keywords: 'procedural scatter', run: () => app.generate('flowers', {}, { clear: false, fit: true }) },
    { id: 'gen.penrose', title: 'Generate: Penrose tiling',   cat: 'Create', icon: '🔷', keywords: 'procedural aperiodic rhombus penrose tiling deep zoom non-repeating quasicrystal 5-fold', run: () => app.generate('penrose', {}, { clear: false, fit: true }) },
    { id: 'gen.ammann', title: 'Generate: Ammann–Beenker tiling', cat: 'Create', icon: '🔶', keywords: 'procedural aperiodic square rhombus ammann beenker tiling deep zoom non-repeating quasicrystal 8-fold octagonal silver ratio', run: () => app.generate('ammann', {}, { clear: false, fit: true }) },
    { id: 'gen.pinwheel', title: 'Generate: Pinwheel tiling', cat: 'Create', icon: '✴️', keywords: 'procedural aperiodic pinwheel conway radin triangle tiling deep zoom non-repeating infinitely many orientations', run: () => app.generate('pinwheel', {}, { clear: false, fit: true }) },
    { id: 'gen.hat',    title: 'Generate: the Hat (aperiodic monotile)', cat: 'Create', icon: '🎩', keywords: 'procedural aperiodic monotile einstein hat smith tiling deep zoom non-repeating single shape one tile spectre 2023', run: () => app.generate('hat', {}, { clear: false, fit: true }) },
    { id: 'gen.spectre', title: 'Generate: the Spectre (chiral aperiodic monotile)', cat: 'Create', icon: '👻', keywords: 'procedural aperiodic monotile chiral spectre ghost tile(1,1) smith kaplan tiling deep zoom non-repeating single shape one tile no reflection mirror 2023 einstein', run: () => app.generate('spectre', {}, { clear: false, fit: true }) },
    // The 11 uniform (regular + Archimedean) tilings — keyboard onramps to the whole
    // set (the visual onramp is the Generate-panel picker). One command per vertex config.
    ...[
      ['6.6.6', 'hexagonal honeycomb', '⬡'], ['4.4.4.4', 'square grid', '◻'], ['3.3.3.3.3.3', 'triangular', '△'],
      ['3.6.3.6', 'trihexagonal kagome', '✶'], ['3.4.6.4', 'rhombitrihexagonal', '✸'],
      ['4.8.8', 'truncated square octagon bathroom floor', '⯂'], ['3.12.12', 'truncated hexagonal dodecagon', '⬢'],
      ['4.6.12', 'truncated trihexagonal great rhombitrihexagonal', '✹'], ['3.3.3.4.4', 'elongated triangular', '▦'],
      ['3.3.4.3.4', 'snub square chiral', '❖'], ['3.3.3.3.6', 'snub hexagonal chiral', '❉'],
    ].map(([kind, kw, icon]) => ({
      id: `gen.uniform.${kind.replace(/\./g, '_')}`,
      title: `Generate: ${kind} tiling`, cat: 'Create', icon,
      keywords: `procedural uniform regular archimedean semiregular polygon edge-to-edge tiling ${kw} ${kind}`,
      run: () => app.generate('uniform', { kind }, { clear: false, fit: true }),
    })),
    // The Laves (dual) tilings — the isohedral inverse of the uniform set. The
    // Generate-panel "Dual" toggle dualises any of the 11; here are keyboard onramps
    // to the three most famous by name (the snub duals are the Cairo & Floret
    // pentagonal tilings; 3.6.3.6's dual is the rhombille / "tumbling blocks").
    ...[
      ['3.3.4.3.4', 'Cairo pentagonal', 'cairo pentagon dual laves catalan', '⬠'],
      ['3.3.3.3.6', 'Floret pentagonal', 'floret pentagon dual laves catalan rosette', '✿'],
      ['3.6.3.6', 'Rhombille', 'rhombille rhombus tumbling blocks dual laves catalan', '◆'],
    ].map(([kind, name, kw, icon]) => ({
      id: `gen.laves.${kind.replace(/\./g, '_')}`,
      title: `Generate: ${name} tiling (Laves dual)`, cat: 'Create', icon,
      keywords: `procedural laves catalan dual isohedral one tile shape tiling ${kw} ${kind}`,
      run: () => app.generate('laves', { kind }, { clear: false, fit: true }),
    })),
    { id: 'gen.image',  title: 'Place an image…',             cat: 'Create', icon: '🖼', keywords: 'photo picture import drop', run: () => { const el = document.getElementById('imageFile'); if (el) el.click(); } },

    // ---------------- File ----------------
    { id: 'file.png',  title: 'Export PNG',  cat: 'File', icon: '🖼', keywords: 'save image bitmap', run: () => document.getElementById('exportPng')?.click() },
    { id: 'file.svg',  title: 'Export SVG',  cat: 'File', icon: '✒', keywords: 'save vector', run: () => document.getElementById('exportSvg')?.click() },
    { id: 'file.json', title: 'Export JSON', cat: 'File', icon: '💾', keys: ['Mod', 'S'], keywords: 'save download', run: () => document.getElementById('exportJson')?.click() },
    { id: 'file.open', title: 'Open JSON…',  cat: 'File', icon: '📂', keywords: 'import load file', run: () => document.getElementById('importJson')?.click() },
    { id: 'file.clear', title: 'Clear everything', cat: 'File', icon: '🗑', keywords: 'delete reset empty new', run: () => app.clearAll() },

    // ---------------- Animation (only while flipbook is on) ----------------
    { id: 'anim.next', title: 'Next page',       cat: 'Animation', icon: '▶', keys: ['→'], when: flipMode, run: () => app.nextFrame() },
    { id: 'anim.prev', title: 'Previous page',   cat: 'Animation', icon: '◀', keys: ['←'], when: flipMode, run: () => app.prevFrame() },
    { id: 'anim.add',  title: 'Add page',        cat: 'Animation', icon: '＋', when: flipMode, keywords: 'frame insert', run: () => app.addFrame() },
    { id: 'anim.dup',  title: 'Duplicate page',  cat: 'Animation', icon: '⧉', when: flipMode, keywords: 'frame copy stop motion', run: () => app.duplicateFrame() },
    { id: 'anim.del',  title: 'Delete page',     cat: 'Animation', icon: '🗑', when: flipMode, keywords: 'frame remove', run: () => app.deleteFrame() },
    { id: 'anim.play', title: 'Play / pause',    cat: 'Animation', icon: '▶', when: flipMode, keywords: 'preview', run: () => app.togglePlay() },
    { id: 'anim.gif',  title: 'Export animated GIF', cat: 'Animation', icon: '🎞', when: flipMode, keywords: 'share movie', run: () => app.downloadGIF() },
    { id: 'anim.sheet', title: 'Export sprite sheet', cat: 'Animation', icon: '▦', when: flipMode, keywords: 'contact', run: () => app.downloadSpriteSheet() },

    // ---------------- Pixel-art tools (only while editing a sprite) ----------------
    { id: 'px.pencil', title: 'Pixel: pencil', cat: 'Pixel', icon: '✏️', keys: ['B'], when: pixelMode, run: () => app.setPixelTool('pencil') },
    { id: 'px.eraser', title: 'Pixel: eraser', cat: 'Pixel', icon: '🩹', keys: ['E'], when: pixelMode, run: () => app.setPixelTool('eraser') },
    { id: 'px.fill',   title: 'Pixel: fill bucket', cat: 'Pixel', icon: '🪣', keys: ['G'], when: pixelMode, run: () => app.setPixelTool('fill') },
    { id: 'px.eye',    title: 'Pixel: eyedropper', cat: 'Pixel', icon: '💧', keys: ['I'], when: pixelMode, run: () => app.setPixelTool('eyedropper') },
    { id: 'px.line',   title: 'Pixel: line',   cat: 'Pixel', icon: '╱', keys: ['L'], when: pixelMode, run: () => app.setPixelTool('line') },
    { id: 'px.rect',   title: 'Pixel: rectangle', cat: 'Pixel', icon: '▭', keys: ['R'], when: pixelMode, run: () => app.setPixelTool('rect') },
    { id: 'px.ell',    title: 'Pixel: ellipse', cat: 'Pixel', icon: '◯', keys: ['O'], when: pixelMode, run: () => app.setPixelTool('ellipse') },
    { id: 'px.sel',    title: 'Pixel: select / marquee', cat: 'Pixel', icon: '⬚', keys: ['M'], when: pixelMode, run: () => app.setPixelTool('select') },
    { id: 'px.wand',   title: 'Pixel: magic wand', cat: 'Pixel', icon: '🪄', keys: ['W'], when: pixelMode, keywords: 'select colour', run: () => app.setPixelTool('wand') },
    { id: 'px.invert', title: 'Pixel: invert selection', cat: 'Pixel', icon: '⇄', keys: ['Mod', 'I'], when: pixelMode, run: () => app.invertPixelSelection() },
    { id: 'px.flipH',  title: 'Pixel: flip sprite H', cat: 'Pixel', icon: '⬌', when: pixelMode, run: () => app.flipPixel('h') },
    { id: 'px.flipV',  title: 'Pixel: flip sprite V', cat: 'Pixel', icon: '⬍', when: pixelMode, run: () => app.flipPixel('v') },
    { id: 'px.rotCW',  title: 'Pixel: rotate sprite 90°', cat: 'Pixel', icon: '⟳', when: pixelMode, run: () => app.rotatePixel90('cw') },
    { id: 'px.png',    title: 'Pixel: export PNG', cat: 'Pixel', icon: '🖼', when: pixelMode, keywords: 'save sprite', run: () => app.downloadPixelPNG() },
    { id: 'px.done',   title: 'Finish pixel editing', cat: 'Pixel', icon: '✓', keys: ['Esc'], when: pixelMode, run: () => { app.endPixelEdit(); app._openPixelPanel(false); } },
  ];
}

// ---------------------------------------------------------------------------
// Contextual hint line — the LOCAL half of Transparency. Given the live app and
// the currently-held modifier keys, describe what the current tool does and what
// each relevant modifier would do *now*. Modifier hints are always listed (so the
// user learns they exist) and flagged `active` when the key is down (so the line
// reacts — dim until pressed, lit while held). See app._updateHint().

const TOOL_BASE = {
  pen:     'draw freehand — drag to sketch',
  brush:   'pressure brush — drag; faster = thinner',
  line:    'drag from start to end',
  arrow:   'drag from tail to head',
  rect:    'drag to size a rectangle',
  ellipse: 'drag to size an ellipse',
  star:    'drag to size a star / polygon',
  text:    'click to place, then type',
  connector: 'drag between two objects to link them',
  fold:    'drag a mirror line — reflects the selection (or everything) across it, live by reference',
  spin:    'click a pivot, then drag to sweep the copy angle — rotated copies, live by reference',
  select:  'click to pick · drag a marquee · drag to move',
  eraser:  'click or drag across strokes to remove',
  pan:     'drag to move the canvas',
};

const PX_BASE = {
  pencil: 'click or drag to paint cells',
  eraser: 'click or drag to clear cells',
  fill:   'click to flood-fill a colour',
  eyedropper: 'click a cell to pick its colour',
  line:   'drag a pixel line',
  rect:   'drag a pixel rectangle',
  ellipse: 'drag a pixel ellipse',
  select: 'drag a region · drag inside to move it',
  wand:   'click a colour to select it',
};

/**
 * @param {App} app
 * @param {{shift?:boolean, alt?:boolean, meta?:boolean, space?:boolean}} mods
 * @returns {{base:string, mods:Array<{key:string,label:string,active:boolean}>}}
 */
export function contextHint(app, mods = {}) {
  const { shift = false, alt = false, space = false } = mods;
  // Pixel-edit mode has its own tool vocabulary.
  if (pixelMode(app)) {
    const t = app.pixel.tool || 'pencil';
    const out = { base: `${t}: ${PX_BASE[t] || ''}`, mods: [] };
    if (t === 'wand') {
      out.mods.push({ key: '⇧', label: 'add to selection', active: shift });
      out.mods.push({ key: '⌥', label: 'subtract', active: alt });
    } else if (['pencil', 'eraser', 'line', 'rect', 'ellipse', 'fill'].includes(t)) {
      out.mods.push({ key: '⌥', label: 'eyedrop colour', active: alt });
    }
    return out;
  }

  const t = app.tool || 'pen';
  const out = { base: `${t}: ${TOOL_BASE[t] || ''}`, mods: [] };
  const sel = app.selectedIds.size;

  if (t === 'line' || t === 'arrow' || t === 'fold' || t === 'spin') {
    out.mods.push({ key: '⇧', label: 'snap angle', active: shift });
  } else if (t === 'rect' || t === 'ellipse' || t === 'star') {
    out.mods.push({ key: '⇧', label: 'keep square', active: shift });
  }

  if (t === 'select') {
    if (sel) {
      out.base = `${sel} selected — drag to move · handles to rotate / scale · arrows nudge`;
      out.mods.push({ key: '⇧', label: 'add to selection · ×10 nudge', active: shift });
      out.mods.push({ key: '⌥', label: 'free (no snapping)', active: alt });
    } else {
      out.mods.push({ key: '⇧', label: 'add to selection', active: shift });
    }
  }

  // The hidden eyedropper: Alt+click anywhere samples a colour. Surfacing it on
  // every drawing tool is pure "make the invisible visible".
  if (['pen', 'brush', 'line', 'arrow', 'rect', 'ellipse', 'star'].includes(t)) {
    out.mods.push({ key: '⌥', label: 'click to eyedrop a colour', active: alt });
  }

  // Space-to-pan works in every tool; show it lit while held.
  out.mods.push({ key: 'Space', label: 'hold to pan', active: space });

  return out;
}
