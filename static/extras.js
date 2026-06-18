// Extras — Settings → ✨ Extras: a bubble launcher for small bundled
// offline mini-tools. Tools: unit conversions, tip calculator,
// timezone converter, date calculator, sun times (sunrise / sunset /
// golden hour), moon phase, dice roller + D&D counters, decision wheel.
//
// Everything here must work fully offline — no network, in keeping
// with the zero-data design. This file injects its own CSS and the
// #extrasPanel markup so index.html stays uncluttered; the only
// things living there are the ✨ Extras launcher button inside
// #settingsPanel and the shared-theme selector lists that #extrasPanel
// participates in (the .sheet background rule and the cc-x-btn rules).
//
// To add a tool:
//   1. Add a .extras-bubble button (data-extra="myid") to the bubbles
//      div in PANEL_HTML, and a sibling <div id="extrasMyTool" hidden>.
//   2. Register it in the `tools` map below (optional onShow hook
//      runs every time the tool view is opened).
//   3. Wire it up in its own section at the bottom of this file.
//
// NOTE: the CSS and HTML below live inside template literals — never
// put a backtick inside them (even in a comment), it terminates the
// string and breaks the whole file.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve
  global._scriptVersions = global._scriptVersions || {};
  global._scriptVersions['extras.js'] = SCRIPT_VERSION;

  // ────────────────────────────────────────────────────────────
  // CSS
  // ────────────────────────────────────────────────────────────
  const s = document.createElement('style');
  s.textContent = `
  /* Extras panel — one layer above Settings (31 vs 30) so it stacks
     on top and closing it drops you back into Settings. */
  #extrasPanel {
    position: fixed; inset: 0; z-index: 31;
    background: rgba(0,0,0,0.45);
    display: none; align-items: center; justify-content: center;
  }
  #extrasPanel.show { display: flex; }
  #extrasPanel .sheet {
    position: relative;
    width: calc(100% - 40px); max-width: 360px;
    padding: 18px 20px 16px;
    max-height: 85vh; overflow-y: auto;
  }
  #extrasPanel h3 { margin: 0 0 14px; font-size: 16px; text-align: center; }
  /* X / back chevron — visual comes from the shared .cc-x-btn rule
     in index.html; only positioning lives here. */
  #extrasPanel button.close.cc-x-btn { position: absolute; top: 8px; }
  #extrasPanel #extrasXClose { right: 8px; }
  #extrasPanel #extrasBack { left: 8px; font-size: 22px; }
  /* Input/select theming. Restated here rather than joining the
     shared index.html rule because that one only covers text/number
     inputs and we also have type="time" / type="date". */
  #extrasPanel input, #extrasPanel select {
    background: var(--ui-input-bg);
    color: var(--ui-text);
    border: 1px solid var(--ui-border);
    border-radius: var(--ui-radius);
    font-family: inherit;
  }

  /* Launcher row in Settings. Accent-colored so it reads as a fun
     doorway rather than another config row. */
  #extrasBtn {
    display: block; width: 100%;
    margin: 0 0 12px;
    padding: 10px 12px;
    font-family: inherit; font-size: 14px; font-weight: 600;
    color: var(--ui-accent-text);
    background: var(--ui-accent);
    border: 1px solid var(--ui-accent-border);
    border-radius: var(--ui-radius);
    cursor: pointer;
  }
  #extrasBtn:hover { filter: brightness(1.08); }

  /* Bubble grid — round buttons, icon over label. They pop in with
     a small stagger when the panel opens. */
  #extrasBubbles {
    display: flex; flex-wrap: wrap; gap: 14px;
    justify-content: center;
    padding: 6px 0 10px;
  }
  /* display:flex above would defeat the hidden attribute's
     display:none — restate it so view switching works. */
  #extrasBubbles[hidden] { display: none; }
  @keyframes cc-bubble-pop {
    from { transform: scale(0.5); opacity: 0; }
    70% { transform: scale(1.06); }
    to { transform: scale(1); opacity: 1; }
  }
  .extras-bubble {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 5px;
    width: 96px; height: 96px;
    padding: 8px;
    border-radius: 50%;
    border: 2px solid var(--ui-accent-border);
    background: radial-gradient(circle at 30% 28%, var(--ui-hover), var(--ui-bg) 75%);
    color: var(--ui-text);
    font-family: inherit; font-size: 11px; line-height: 1.15;
    text-align: center;
    cursor: pointer;
    box-shadow: var(--ui-shadow);
    transition: transform 0.08s ease;
    animation: cc-bubble-pop 0.25s ease backwards;
  }
  .extras-bubble:nth-child(2) { animation-delay: 0.04s; }
  .extras-bubble:nth-child(3) { animation-delay: 0.08s; }
  .extras-bubble:nth-child(4) { animation-delay: 0.12s; }
  .extras-bubble:nth-child(5) { animation-delay: 0.16s; }
  .extras-bubble:nth-child(6) { animation-delay: 0.2s; }
  .extras-bubble:nth-child(7) { animation-delay: 0.24s; }
  .extras-bubble:nth-child(8) { animation-delay: 0.28s; }
  .extras-bubble:hover { transform: translateY(-2px) scale(1.04); }
  .extras-bubble .bubble-icon { font-size: 28px; line-height: 1; }

  /* Shared tool bits */
  .xt-row { display: flex; gap: 8px; margin: 10px 0; align-items: center; }
  .xt-lbl { font-size: 14px; flex: 0 0 auto; min-width: 52px; }
  .xt-card {
    background: var(--ui-hover);
    border-radius: var(--ui-radius);
    padding: 10px 12px;
    margin-top: 12px;
  }
  .xt-muted { color: var(--ui-muted); font-size: 12px; }
  .xt-subhead {
    font-size: 11px; font-weight: 600;
    color: var(--ui-muted);
    text-transform: uppercase; letter-spacing: 0.4px;
    margin: 14px 0 4px;
  }
  .xt-divider { border-top: 1px solid var(--ui-hairline, rgba(0,0,0,0.08)); margin: 14px 0 10px; }
  .xt-chip {
    padding: 8px 10px;
    border-radius: 999px;
    border: 1px solid var(--ui-border);
    background: var(--ui-input-bg);
    color: var(--ui-text);
    cursor: pointer;
    font-family: inherit; font-size: 13px; line-height: 1;
  }
  .xt-chip:hover { border-color: var(--ui-accent); }
  .xt-chip.active {
    background: var(--ui-accent);
    color: var(--ui-accent-text);
    border-color: var(--ui-accent-border);
    font-weight: 600;
  }
  .xt-step {
    width: 32px; height: 32px; flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid var(--ui-border);
    background: var(--ui-input-bg);
    color: var(--ui-text);
    font-family: inherit; font-size: 16px; line-height: 1;
    cursor: pointer;
  }
  .xt-step:hover { border-color: var(--ui-accent); color: var(--ui-accent); }
  .xt-mini {
    padding: 6px 10px;
    font-family: inherit; font-size: 12px;
    border-radius: var(--ui-radius);
    border: 1px solid var(--ui-border);
    background: var(--ui-input-bg);
    color: var(--ui-text);
    cursor: pointer;
  }
  .xt-mini:hover { border-color: var(--ui-accent); }

  /* Unit converter */
  #extrasUnitConv #ucCategory { width: 100%; padding: 8px; font-size: 14px; }
  #extrasUnitConv .uc-row input { flex: 1 1 45%; min-width: 0; padding: 9px 10px; font-size: 16px; }
  #extrasUnitConv .uc-row select { flex: 1 1 55%; min-width: 0; padding: 8px; font-size: 13px; }
  .uc-row { display: flex; gap: 8px; margin: 10px 0; align-items: center; }
  .uc-swap-row { display: flex; justify-content: center; margin: 2px 0; }
  .uc-swap-btn {
    width: 34px; height: 34px;
    border-radius: 50%;
    border: 1px solid var(--ui-border);
    background: var(--ui-input-bg);
    color: var(--ui-text);
    font-family: inherit; font-size: 16px; line-height: 1;
    cursor: pointer;
  }
  .uc-swap-btn:hover { border-color: var(--ui-accent); color: var(--ui-accent); }
  #ucHint {
    margin-top: 10px;
    font-size: 12px; text-align: center;
    color: var(--ui-muted);
    min-height: 15px;
  }

  /* Tip calculator */
  #tipBill { flex: 1; min-width: 0; padding: 9px 10px; font-size: 16px; }
  .tip-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 10px 0; }
  .tip-custom { width: 58px; padding: 7px 6px; text-align: center; font-size: 13px; }
  .tip-emoji { text-align: center; font-size: 13px; margin: 8px 0 2px; min-height: 22px; color: var(--ui-muted); }
  .tip-emoji .big { font-size: 20px; margin-right: 6px; vertical-align: middle; }
  .tip-split-n { min-width: 28px; text-align: center; font-size: 15px; font-weight: 600; }
  .tip-results .r { display: flex; justify-content: space-between; margin: 4px 0; font-size: 14px; }
  .tip-results .r .v { font-weight: 600; font-variant-numeric: tabular-nums; }
  .tip-results .r.total { font-size: 16px; }
  .tip-results .r.total .v { font-size: 20px; }

  /* Timezone converter */
  #tzTime { flex: 1; min-width: 0; padding: 8px 10px; font-size: 16px; }
  #extrasTz select { width: 100%; min-width: 0; padding: 8px; font-size: 13px; }
  .tz-result { text-align: center; }
  .tz-time { font-size: 30px; font-weight: 700; line-height: 1.2; }
  .tz-sub { font-size: 12px; color: var(--ui-muted); margin-top: 4px; line-height: 1.4; }

  /* Date calculator */
  #extrasDate input[type="date"] { flex: 1; min-width: 0; padding: 8px; font-size: 14px; }
  #extrasDate select { padding: 8px; font-size: 14px; }
  #dcN { width: 64px; padding: 8px; font-size: 14px; text-align: center; }
  .date-res { text-align: center; font-size: 14px; line-height: 1.5; }
  .date-res .big { font-size: 19px; font-weight: 700; }

  /* Sun times */
  #extrasSun input[type="date"] { flex: 1; min-width: 0; padding: 8px; font-size: 14px; }
  #extrasSun input[type="number"] { flex: 1; min-width: 0; padding: 8px; font-size: 13px; }
  .sun-row { display: flex; justify-content: space-between; margin: 4px 0; font-size: 14px; }
  .sun-row .v { font-weight: 600; font-variant-numeric: tabular-nums; }
  .sun-note { text-align: center; font-size: 13px; margin: 2px 0; }

  /* Moon phase */
  #extrasMoon input[type="date"] { flex: 1; min-width: 0; padding: 8px; font-size: 14px; }
  .moon-wrap { display: flex; justify-content: center; margin: 12px 0 8px; }
  .moon-name { text-align: center; font-size: 17px; font-weight: 700; }
  .moon-meta { text-align: center; margin-top: 4px; line-height: 1.5; }
  .moon-next { text-align: center; font-size: 13px; line-height: 1.7; }

  /* Dice & D&D */
  .dnd-row { display: flex; gap: 4px; margin: 6px 0; align-items: center; }
  .dnd-row .dnd-name { flex: 1; min-width: 0; padding: 7px 8px; font-size: 13px; }
  .dnd-row .dnd-val {
    width: 52px; padding: 7px 4px;
    font-size: 15px; font-weight: 600; text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .dnd-btn {
    width: 28px; height: 32px; flex-shrink: 0;
    border-radius: var(--ui-radius);
    border: 1px solid var(--ui-border);
    background: var(--ui-input-bg);
    color: var(--ui-text);
    font-family: inherit; font-size: 15px; line-height: 1;
    cursor: pointer;
  }
  .dnd-btn:hover { border-color: var(--ui-accent); color: var(--ui-accent); }
  .dnd-del { border-color: transparent; background: transparent; color: var(--ui-muted); width: 24px; }
  .dnd-del:hover { color: var(--ui-danger); border-color: transparent; }
  .dice-chips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin: 4px 0 10px; }
  .dice-chip {
    min-width: 44px; padding: 9px 6px;
    border-radius: 10px;
    border: 1px solid var(--ui-border);
    background: var(--ui-input-bg);
    color: var(--ui-text);
    font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1;
    cursor: pointer;
  }
  .dice-chip:hover { border-color: var(--ui-accent); color: var(--ui-accent); }
  .dice-pool {
    display: flex; gap: 6px; flex-wrap: wrap;
    justify-content: center; align-items: center;
    min-height: 32px; margin: 8px 0;
  }
  .dice-roll-btn {
    display: block; width: 100%;
    margin-top: 10px;
    padding: 12px;
    font-family: inherit; font-size: 16px; font-weight: 700;
    color: var(--ui-accent-text);
    background: var(--ui-accent);
    border: 1px solid var(--ui-accent-border);
    border-radius: var(--ui-radius);
    cursor: pointer;
  }
  .dice-roll-btn:hover { filter: brightness(1.08); }
  .dice-advrow { display: flex; gap: 8px; justify-content: center; margin-top: 8px; }
  .dice-flair { text-align: center; font-size: 14px; min-height: 20px; margin-top: 8px; }
  .dice-tiles { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 6px; }
  @keyframes cc-die-pop {
    0% { transform: scale(0.3) rotate(-170deg); opacity: 0; }
    70% { transform: scale(1.12) rotate(8deg); }
    100% { transform: scale(1) rotate(0deg); opacity: 1; }
  }
  .dice-tile {
    width: 46px; height: 46px;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    border-radius: 10px;
    border: 2px solid var(--ui-accent-border);
    background: var(--ui-bg);
    animation: cc-die-pop 0.45s ease backwards;
  }
  .dice-tile .val { font-size: 18px; font-weight: 700; line-height: 1; }
  .dice-tile .lbl { font-size: 9px; color: var(--ui-muted); margin-top: 2px; }
  .dice-tile.nat20 {
    border-color: #e6b800;
    box-shadow: 0 0 10px rgba(255, 200, 0, 0.55);
  }
  .dice-tile.nat1 { border-color: var(--ui-danger); opacity: 0.85; }
  .dice-tile.dropped { opacity: 0.35; }
  .dice-tile.dropped .val { text-decoration: line-through; }
  .dice-total { text-align: center; font-size: 24px; font-weight: 700; margin-top: 8px; min-height: 30px; }
  .dice-history {
    margin-top: 8px;
    font-size: 11px; color: var(--ui-muted);
    text-align: center; line-height: 1.6;
    white-space: pre-line;
  }

  /* Decision wheel */
  #wheelNew { flex: 1; min-width: 0; padding: 9px 10px; font-size: 14px; }
  .wheel-opts {
    display: flex; gap: 6px; flex-wrap: wrap;
    justify-content: center; align-items: center;
    min-height: 24px; margin: 8px 0;
  }
  .wheel-wrap { position: relative; width: 260px; margin: 8px auto 0; }
  .wheel-wrap canvas { display: block; width: 260px; height: 260px; }
  .wheel-pointer {
    position: absolute; top: -4px; left: 50%;
    transform: translateX(-50%);
    width: 0; height: 0;
    border-left: 11px solid transparent;
    border-right: 11px solid transparent;
    border-top: 18px solid var(--ui-text);
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4));
  }
  .wheel-result {
    text-align: center; font-size: 20px; font-weight: 700;
    margin-top: 10px; min-height: 26px;
  }
  .wheel-actions { display: flex; justify-content: center; margin-top: 6px; }
  .extras-bubble:nth-child(9) { animation-delay: 0.32s; }

  /* Fractals: a full-screen window holding the bundled mandelbrot
     viewer in its own isolated iframe. Sits above the extras sheet
     (z-index ladder elsewhere: settings/transit=30, extras=31,
     favPanel=32; this overlays them all at 60). */
  #fractalsWindow {
    position: fixed; inset: 0; z-index: 60; background: #000;
    display: none;
  }
  #fractalsWindow.show { display: block; }
  #fractalsWindow iframe {
    position: absolute; inset: 0; width: 100%; height: 100%;
    border: 0; display: block;
    /* Black during navigation so reloading a saved fractal doesn't flash
       white before the new document paints. */
    background: #000;
  }
  #fractalsBar {
    position: absolute; z-index: 2;
    top: max(8px, env(safe-area-inset-top));
    right: max(8px, env(safe-area-inset-right));
    display: flex; gap: 6px;
  }
  #fractalsBar button {
    width: 38px; height: 38px; border-radius: 50%;
    border: none; background: rgba(0, 0, 0, 0.55); color: #fff;
    font-size: 18px; line-height: 1; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    -webkit-tap-highlight-color: transparent;
  }
  #fractalsBar button:hover { background: rgba(0, 0, 0, 0.75); }
  #fractalsBar #fracMenu.active { background: rgba(80, 140, 255, 0.85); }
  #fractalsBar #fractalsClose { font-size: 24px; }

  #fracSavePrompt, #fracBrowsePanel, #fracDelConfirm {
    position: absolute; inset: 0; display: flex;
  }
  #fracSavePrompt, #fracBrowsePanel { z-index: 3; }
  #fracDelConfirm { z-index: 4; }  /* above the browse panel it opens from */
  #fracSavePrompt[hidden], #fracBrowsePanel[hidden], #fracDelConfirm[hidden] { display: none; }
  #fracSavePrompt, #fracDelConfirm {
    align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.55);
  }
  #fracSavePrompt .frac-card, #fracDelConfirm .frac-card {
    background: var(--ui-bg, #fff); color: var(--ui-text, #111);
    border-radius: 12px; padding: 16px; width: min(320px, 86vw);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
  }
  .frac-card-title { font-size: 15px; font-weight: 600; margin-bottom: 10px; text-align: center; }
  #fracName {
    width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 15px;
    border: 1px solid var(--ui-border, rgba(0, 0, 0, 0.2)); border-radius: 8px;
    background: var(--ui-input-bg, #fff); color: inherit;
  }
  .frac-card-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  .frac-card-actions button {
    padding: 7px 14px; border-radius: 8px; font: inherit; cursor: pointer;
    border: 1px solid var(--ui-border, rgba(0, 0, 0, 0.2));
    background: var(--ui-input-bg, #f2f2f2); color: inherit;
  }
  .frac-card-actions button.primary { background: #4f8cff; color: #fff; border-color: #4f8cff; }

  /* Hold-to-delete confirm */
  .frac-card-sub {
    font-size: 13px; color: var(--ui-muted, #888); text-align: center; margin-bottom: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .frac-hold {
    position: relative; overflow: hidden; width: 100%; display: block;
    padding: 12px 14px; border-radius: 8px; border: none;
    background: #e0524b; color: #fff; font: inherit; font-weight: 600;
    cursor: pointer; user-select: none; -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent; touch-action: none;
  }
  .frac-hold-fill { position: absolute; top: 0; left: 0; bottom: 0; width: 0; background: #9e1c16; }
  .frac-hold.holding .frac-hold-fill { width: 100%; transition: width 2s linear; }
  .frac-hold-label { position: relative; z-index: 1; }

  #fracBrowsePanel { flex-direction: column; background: rgba(0, 0, 0, 0.82); }
  .frac-browse-head {
    display: flex; align-items: center; justify-content: space-between; color: #fff;
    padding: max(10px, env(safe-area-inset-top)) 14px 10px; font-size: 16px; font-weight: 600;
  }
  .frac-browse-head button { background: none; border: none; color: #fff; font-size: 26px; cursor: pointer; }
  #fracList {
    flex: 1; overflow-y: auto; padding: 8px 12px 16px; align-content: start;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px;
  }
  .frac-empty { color: #ccc; padding: 20px; text-align: center; grid-column: 1 / -1; }
  .frac-item {
    position: relative; background: rgba(255, 255, 255, 0.08);
    border-radius: 10px; overflow: hidden; cursor: pointer;
  }
  .frac-thumb { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; display: block; background: #000; }
  .frac-meta { padding: 6px 8px; color: #fff; }
  .frac-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .frac-date { font-size: 11px; color: #bbb; }
  .frac-del {
    position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; border-radius: 50%;
    border: none; background: rgba(0, 0, 0, 0.6); color: #fff; font-size: 15px; line-height: 1; cursor: pointer;
  }

  @media (prefers-reduced-motion: reduce) {
    .extras-bubble, .dice-tile { animation: none; }
  }
  `;
  document.head.appendChild(s);

  // ────────────────────────────────────────────────────────────
  // Markup
  // ────────────────────────────────────────────────────────────
  const PANEL_HTML = `
  <div class="sheet">
    <button class="close cc-x-btn" id="extrasBack" type="button" aria-label="back" hidden>&lsaquo;</button>
    <button class="close cc-x-btn" id="extrasXClose" type="button" aria-label="close">&times;</button>
    <h3 id="extrasTitle">Extras</h3>
    <div id="extrasBubbles">
      <button class="extras-bubble" data-extra="unitconv" type="button">
        <span class="bubble-icon">&#9878;&#65039;</span>
        <span>Unit<br>conversions</span>
      </button>
      <button class="extras-bubble" data-extra="tip" type="button">
        <span class="bubble-icon">&#128184;</span>
        <span>Tip<br>calculator</span>
      </button>
      <button class="extras-bubble" data-extra="tz" type="button">
        <span class="bubble-icon">&#128338;</span>
        <span>Time<br>zones</span>
      </button>
      <button class="extras-bubble" data-extra="date" type="button">
        <span class="bubble-icon">&#128197;</span>
        <span>Date<br>calculator</span>
      </button>
      <button class="extras-bubble" data-extra="sun" type="button">
        <span class="bubble-icon">&#127749;</span>
        <span>Sun<br>times</span>
      </button>
      <button class="extras-bubble" data-extra="moon" type="button">
        <span class="bubble-icon">&#127769;</span>
        <span>Moon<br>phase</span>
      </button>
      <button class="extras-bubble" data-extra="dice" type="button">
        <span class="bubble-icon">&#127922;</span>
        <span>Dice &amp;<br>D&amp;D</span>
      </button>
      <button class="extras-bubble" data-extra="wheel" type="button">
        <span class="bubble-icon">&#127905;&#65039;</span>
        <span>Decision<br>wheel</span>
      </button>
      <button class="extras-bubble" data-extra="fractals" type="button">
        <span class="bubble-icon">&#127744;</span>
        <span>Fractals</span>
      </button>
    </div>

    <div id="extrasUnitConv" hidden>
      <select id="ucCategory" aria-label="conversion category"></select>
      <div class="uc-row">
        <input id="ucFromVal" type="number" step="any" inputmode="decimal" placeholder="0" aria-label="from value">
        <select id="ucFromUnit" aria-label="from unit"></select>
      </div>
      <div class="uc-swap-row">
        <button id="ucSwap" class="uc-swap-btn" type="button" title="swap units" aria-label="swap units">&#8645;</button>
      </div>
      <div class="uc-row">
        <input id="ucToVal" type="number" step="any" inputmode="decimal" placeholder="0" aria-label="to value">
        <select id="ucToUnit" aria-label="to unit"></select>
      </div>
      <div id="ucHint"></div>
    </div>

    <div id="extrasTip" hidden>
      <div class="xt-row">
        <label class="xt-lbl" for="tipBill">Bill</label>
        <input id="tipBill" type="number" step="any" min="0" inputmode="decimal" placeholder="0.00">
      </div>
      <div class="tip-chips" id="tipChips">
        <button class="xt-chip" data-pct="10" type="button">10%</button>
        <button class="xt-chip" data-pct="15" type="button">15%</button>
        <button class="xt-chip" data-pct="18" type="button">18%</button>
        <button class="xt-chip" data-pct="20" type="button">20%</button>
        <button class="xt-chip" data-pct="25" type="button">25%</button>
        <input id="tipCustom" class="tip-custom" type="number" min="0" max="999" inputmode="numeric" placeholder="%" aria-label="custom tip percent">
      </div>
      <div class="tip-emoji" id="tipEmoji"></div>
      <div class="xt-row">
        <span class="xt-lbl">Split</span>
        <button class="xt-step" id="tipSplitMinus" type="button" aria-label="fewer people">&minus;</button>
        <span class="tip-split-n" id="tipSplitN">1</span>
        <button class="xt-step" id="tipSplitPlus" type="button" aria-label="more people">+</button>
      </div>
      <div class="xt-card tip-results">
        <div class="r"><span>Tip</span><span class="v" id="tipTipV">0.00</span></div>
        <div class="r total"><span>Total</span><span class="v" id="tipTotalV">0.00</span></div>
        <div class="r" id="tipEachRow" hidden><span>Each</span><span class="v" id="tipEachV">0.00</span></div>
      </div>
    </div>

    <div id="extrasTz" hidden>
      <div class="xt-row">
        <input id="tzTime" type="time" aria-label="time to convert">
        <button id="tzNow" class="xt-mini" type="button">now</button>
      </div>
      <div class="xt-row"><select id="tzFrom" aria-label="from time zone"></select></div>
      <div class="uc-swap-row">
        <button id="tzSwap" class="uc-swap-btn" type="button" title="swap zones" aria-label="swap zones">&#8645;</button>
      </div>
      <div class="xt-row"><select id="tzTo" aria-label="to time zone"></select></div>
      <div class="xt-card tz-result">
        <div class="tz-time" id="tzResTime">&mdash;</div>
        <div class="tz-sub" id="tzResSub"></div>
      </div>
    </div>

    <div id="extrasDate" hidden>
      <div class="xt-subhead">Days between</div>
      <div class="xt-row">
        <input type="date" id="dcA" aria-label="first date">
        <input type="date" id="dcB" aria-label="second date">
      </div>
      <div class="xt-card date-res" id="dcBetweenRes">&mdash;</div>
      <div class="xt-subhead">Add or subtract</div>
      <div class="xt-row"><input type="date" id="dcStart" aria-label="start date"></div>
      <div class="xt-row">
        <select id="dcDir" aria-label="direction">
          <option value="1">+</option>
          <option value="-1">&minus;</option>
        </select>
        <input type="number" id="dcN" value="2" min="0" inputmode="numeric" aria-label="amount">
        <select id="dcUnit" aria-label="unit">
          <option value="d">days</option>
          <option value="wk" selected>weeks</option>
          <option value="mo">months</option>
          <option value="yr">years</option>
        </select>
      </div>
      <div class="xt-card date-res" id="dcAddRes">&mdash;</div>
    </div>

    <div id="extrasSun" hidden>
      <div class="xt-row">
        <input type="date" id="sunDate" aria-label="date">
        <button class="xt-mini" id="sunToday" type="button">today</button>
      </div>
      <div class="xt-row">
        <input type="number" id="sunLat" step="any" min="-90" max="90" inputmode="decimal" placeholder="latitude" aria-label="latitude">
        <input type="number" id="sunLon" step="any" min="-180" max="180" inputmode="decimal" placeholder="longitude" aria-label="longitude">
        <button class="xt-mini" id="sunMapLoc" type="button" title="use map position">&#128205;</button>
      </div>
      <div class="xt-card" id="sunRes"><span class="xt-muted">pan the map to your spot, then tap &#128205;</span></div>
    </div>

    <div id="extrasMoon" hidden>
      <div class="xt-row">
        <input type="date" id="moonDate" aria-label="date">
        <button class="xt-mini" id="moonToday" type="button">today</button>
      </div>
      <div class="moon-wrap" id="moonSvgWrap"></div>
      <div class="moon-name" id="moonName"></div>
      <div class="xt-muted moon-meta" id="moonMeta"></div>
      <div class="xt-card moon-next" id="moonNext"></div>
    </div>

    <div id="extrasDice" hidden>
      <div class="xt-subhead">Counters &mdash; HP, gold, ki, anything</div>
      <div id="dndCounters"></div>
      <button class="xt-mini" id="dndAdd" type="button">+ counter</button>
      <div class="xt-divider"></div>
      <div class="dice-chips" id="diceChips">
        <button class="dice-chip" data-d="4" type="button">d4</button>
        <button class="dice-chip" data-d="6" type="button">d6</button>
        <button class="dice-chip" data-d="8" type="button">d8</button>
        <button class="dice-chip" data-d="10" type="button">d10</button>
        <button class="dice-chip" data-d="12" type="button">d12</button>
        <button class="dice-chip" data-d="20" type="button">d20</button>
        <button class="dice-chip" data-d="100" type="button">d100</button>
      </div>
      <div class="dice-pool" id="dicePool"></div>
      <div class="xt-row">
        <span class="xt-lbl">Modifier</span>
        <button class="xt-step" id="diceModMinus" type="button" aria-label="decrease modifier">&minus;</button>
        <span class="tip-split-n" id="diceModV">+0</span>
        <button class="xt-step" id="diceModPlus" type="button" aria-label="increase modifier">+</button>
        <button class="xt-mini" id="diceClear" type="button" style="margin-left:auto">clear</button>
      </div>
      <button class="dice-roll-btn" id="diceRoll" type="button">&#127922; Roll!</button>
      <div class="dice-advrow">
        <button class="xt-mini" id="diceAdv" type="button" title="2d20, keep highest">&#11014;&#65039; advantage</button>
        <button class="xt-mini" id="diceDis" type="button" title="2d20, keep lowest">&#11015;&#65039; disadvantage</button>
      </div>
      <div class="dice-flair" id="diceFlair"></div>
      <div class="dice-tiles" id="diceTiles"></div>
      <div class="dice-total" id="diceTotal"></div>
      <div class="dice-history" id="diceHistory"></div>
    </div>

    <div id="extrasWheel" hidden>
      <div class="xt-row">
        <input id="wheelNew" type="text" maxlength="40" placeholder="add an option" aria-label="new option">
        <button class="xt-mini" id="wheelAdd" type="button">add</button>
      </div>
      <div class="wheel-opts" id="wheelOpts"></div>
      <div class="wheel-wrap">
        <canvas id="wheelCanvas"></canvas>
        <div class="wheel-pointer"></div>
      </div>
      <button class="dice-roll-btn" id="wheelSpin" type="button">&#127905;&#65039; Spin!</button>
      <div class="wheel-result" id="wheelResult"></div>
      <div class="wheel-actions">
        <button class="xt-mini" id="wheelRemoveWinner" type="button" hidden>remove winner &amp; spin again</button>
      </div>
    </div>
  </div>
  `;
  const panel = document.createElement('div');
  panel.id = 'extrasPanel';
  panel.innerHTML = PANEL_HTML;
  document.body.appendChild(panel);

  // Fractals window: the bundled mandelbrot viewer (static/mandelbrot/)
  // in an isolated iframe. Its own top-level element so it can cover the
  // whole screen rather than live inside the small extras sheet. Fully
  // self-contained here — no other file needs to know it exists. The
  // iframe src is set lazily on first open so the fractal worker/WebGPU
  // only spin up if the user actually opens it; once loaded we keep it
  // (just hide/show) so the zoom state survives reopening.
  const FRACTALS_SRC = '/static/mandelbrot/index.html';

  // ── Saved-fractals store (IndexedDB) ──
  // PNG previews can't live in localStorage (that's the very quota the
  // creature collection was moved out of), so saved fractals get their
  // own tiny IDB store. Record shape:
  //   { id, name, search ('?params=...' permalink), preview (small PNG
  //     data URL), createdAt }
  // Exposed via window.ExtrasFractals so index.html's backup export/import
  // can carry saved fractals inside the creature-collect save file.
  const FRAC_DB = 'cc-extras-v1';
  const FRAC_STORE = 'fractals';
  let _fracDbP = null;
  function _fracDb() {
    if (_fracDbP) return _fracDbP;
    _fracDbP = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(FRAC_DB, 1); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FRAC_STORE)) {
          db.createObjectStore(FRAC_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _fracDbP;
  }
  function _fracAll() {
    return _fracDb().then((db) => new Promise((resolve) => {
      const out = [];
      const tx = db.transaction(FRAC_STORE, 'readonly');
      const cur = tx.objectStore(FRAC_STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); resolve(out); return; }
        out.push(c.value); c.continue();
      };
      cur.onerror = () => resolve(out);
    })).catch(() => []);
  }
  function _fracPut(rec) {
    return _fracDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(FRAC_STORE, 'readwrite');
      tx.objectStore(FRAC_STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }
  function _fracDelete(id) {
    return _fracDb().then((db) => new Promise((resolve) => {
      const tx = db.transaction(FRAC_STORE, 'readwrite');
      tx.objectStore(FRAC_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    }));
  }
  // Backup hook: carry saved fractals in the creature-collect save file.
  // index.html's buildBackupPayload/importData call these.
  window.ExtrasFractals = {
    all: _fracAll,
    importMerge: async (recs) => {
      if (!Array.isArray(recs)) return;
      const existing = await _fracAll();
      const ids = new Set(existing.map((r) => r && r.id));
      for (const r of recs) {
        if (!r || !r.id || ids.has(r.id)) continue;
        try { await _fracPut(r); } catch (e) { /* skip bad record */ }
      }
    },
  };

  // ── Window markup: iframe + a small top-right toolbar, a save-name
  // prompt, and a browse panel (all overlaid within the window). ──
  const fractalsWin = document.createElement('div');
  fractalsWin.id = 'fractalsWindow';
  fractalsWin.innerHTML =
    '<iframe id="fractalsFrame" title="Fractal viewer"></iframe>' +
    '<div id="fractalsBar">' +
      '<button id="fracMenu" type="button" title="show/hide controls" aria-label="controls">&#9776;</button>' +
      '<button id="fracSave" type="button" title="save this view" aria-label="save fractal">&#128190;</button>' +
      '<button id="fracBrowse" type="button" title="saved fractals" aria-label="saved fractals">&#128193;</button>' +
      '<button id="fractalsClose" type="button" title="close" aria-label="close fractals">&times;</button>' +
    '</div>' +
    '<div id="fracSavePrompt" hidden>' +
      '<div class="frac-card">' +
        '<div class="frac-card-title">Save this fractal</div>' +
        '<input id="fracName" type="text" maxlength="60" placeholder="name it…" aria-label="fractal name">' +
        '<div class="frac-card-actions">' +
          '<button id="fracSaveCancel" type="button">Cancel</button>' +
          '<button id="fracSaveOk" type="button" class="primary">Save</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div id="fracBrowsePanel" hidden>' +
      '<div class="frac-browse-head"><span>Saved fractals</span>' +
        '<button id="fracBrowseClose" type="button" aria-label="close">&times;</button></div>' +
      '<div id="fracList"></div>' +
    '</div>' +
    '<div id="fracDelConfirm" hidden>' +
      '<div class="frac-card">' +
        '<div class="frac-card-title">Delete this fractal?</div>' +
        '<div class="frac-card-sub" id="fracDelName"></div>' +
        '<button id="fracDelHold" type="button" class="frac-hold">' +
          '<span class="frac-hold-fill"></span>' +
          '<span class="frac-hold-label">Hold to delete</span>' +
        '</button>' +
        '<div class="frac-card-actions">' +
          '<button id="fracDelCancel" type="button">Cancel</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(fractalsWin);
  const fractalsFrame = fractalsWin.querySelector('#fractalsFrame');
  const fracMenuBtn = fractalsWin.querySelector('#fracMenu');
  const fracSavePrompt = fractalsWin.querySelector('#fracSavePrompt');
  const fracNameInput = fractalsWin.querySelector('#fracName');
  const fracBrowsePanel = fractalsWin.querySelector('#fracBrowsePanel');
  const fracList = fractalsWin.querySelector('#fracList');
  const _show = (el) => { el.hidden = false; };
  const _hide = (el) => { el.hidden = true; };

  // Same-origin reach into the fractal iframe (both are served from the
  // app origin, so this is allowed and needs no postMessage).
  function _idoc() {
    try {
      return fractalsFrame.contentDocument ||
        (fractalsFrame.contentWindow && fractalsFrame.contentWindow.document) || null;
    } catch (e) { return null; }
  }
  // Immersive layout: reuse the mandelbrot app's own .fullscreen CSS
  // classes (canvas fills the window, settings float, footer hidden, dark
  // theme) WITHOUT requestFullscreen — iOS blocks fullscreen on non-video
  // elements, but toggling the classes works everywhere. The app's
  // ResizeObserver on the canvas redraws at the new size. Start with the
  // settings menu hidden so it's fractal-first.
  function _applyImmersive() {
    const d = _idoc();
    if (!d) return;
    ['mandelbrot', 'palette-canvas', 'settings', 'footer'].forEach((id) => {
      const el = d.getElementById(id);
      if (el) el.classList.add('fullscreen');
    });
    if (d.documentElement) d.documentElement.setAttribute('data-bs-theme', 'dark');
    const s = d.getElementById('settings');
    if (s) s.classList.add('hidden');
    fracMenuBtn.classList.remove('active');
  }
  function toggleFracMenu() {
    const d = _idoc();
    if (!d) return;
    const s = d.getElementById('settings');
    if (!s) return;
    const nowHidden = s.classList.toggle('hidden');
    fracMenuBtn.classList.toggle('active', !nowHidden);
  }
  fractalsFrame.addEventListener('load', _applyImmersive);

  // Last-viewed fractal state (the live '?params=' permalink), so closing
  // and reopening the app returns to the same view. Tiny string (~300
  // chars) → fine in localStorage; also exported in the save file
  // (index.html reads cc.fractalLast.v1) so it travels across devices.
  const LAST_KEY = 'cc.fractalLast.v1';
  function _readLast() { try { return localStorage.getItem(LAST_KEY) || ''; } catch (e) { return ''; } }
  function _saveLastState() {
    const s = _currentSearch();
    if (s) { try { localStorage.setItem(LAST_KEY, s); } catch (e) { /* ignore */ } }
  }
  function openFractals() {
    if (!fractalsFrame.getAttribute('src')) {
      // Resume the last-viewed fractal if we have one.
      fractalsFrame.setAttribute('src', FRACTALS_SRC + (_readLast() || ''));
    }
    fractalsWin.classList.add('show');
  }
  function closeFractals() {
    _saveLastState();
    fractalsWin.classList.remove('show');
    _hide(fracSavePrompt);
    _hide(fracBrowsePanel);
  }
  // The fractal app rewrites its URL (history.replaceState) as you pan/
  // zoom — there's no event for that, so snapshot it on a light timer
  // while the window is open, plus when the app is backgrounded/closed.
  setInterval(() => { if (fractalsWin.classList.contains('show')) _saveLastState(); }, 4000);
  window.addEventListener('pagehide', _saveLastState);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && fractalsWin.classList.contains('show')) _saveLastState();
  });

  // ── Save: snapshot the permalink + a small PNG of the 2D canvas ──
  function _currentSearch() {
    try {
      return (fractalsFrame.contentWindow && fractalsFrame.contentWindow.location.search) || '';
    } catch (e) { return ''; }
  }
  function _captureThumb() {
    const d = _idoc();
    if (!d) return null;
    const src = d.getElementById('mandelbrot-canvas');
    if (!src || !src.width || !src.height) return null;
    const MAXW = 192;  // small on purpose so previews don't bloat the save
    const scale = Math.min(1, MAXW / src.width);
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    try {
      c.getContext('2d').drawImage(src, 0, 0, w, h);
      // JPEG (not PNG): a 192px fractal PNG is ~38 KB — fractals are too
      // detail-dense for PNG. JPEG at this size is visually identical and
      // ~5× smaller (~6 KB), which matters since previews ride along in
      // the exported save file. Same-origin canvas → not tainted.
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) { return null; }
  }
  function openSavePrompt() {
    fracNameInput.value = '';
    _show(fracSavePrompt);
    setTimeout(() => { try { fracNameInput.focus(); } catch (e) {} }, 30);
  }
  async function doSaveFractal() {
    const rec = {
      id: 'frac-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      name: (fracNameInput.value || '').trim() || 'Untitled fractal',
      search: _currentSearch(),
      preview: _captureThumb(),
      createdAt: Date.now(),
    };
    _hide(fracSavePrompt);
    try { await _fracPut(rec); } catch (e) { /* best-effort */ }
  }

  // ── Browse: list saved fractals; tap to load, × to delete ──
  function loadFractal(rec) {
    fractalsFrame.setAttribute('src', FRACTALS_SRC + (rec.search || ''));
    _hide(fracBrowsePanel);
  }
  async function renderBrowse() {
    const recs = await _fracAll();
    fracList.innerHTML = '';
    if (!recs.length) {
      const empty = document.createElement('div');
      empty.className = 'frac-empty';
      empty.textContent = 'No saved fractals yet. Frame a view you like, then tap the disk icon.';
      fracList.appendChild(empty);
      return;
    }
    for (const rec of recs) {
      const card = document.createElement('div');
      card.className = 'frac-item';
      const img = document.createElement('img');
      img.className = 'frac-thumb';
      img.alt = rec.name || 'fractal';
      if (rec.preview) img.src = rec.preview;
      const meta = document.createElement('div');
      meta.className = 'frac-meta';
      const nm = document.createElement('div');
      nm.className = 'frac-name';
      nm.textContent = rec.name || 'Untitled';
      const dt = document.createElement('div');
      dt.className = 'frac-date';
      dt.textContent = new Date(rec.createdAt || Date.now()).toLocaleDateString();
      meta.appendChild(nm);
      meta.appendChild(dt);
      const del = document.createElement('button');
      del.className = 'frac-del';
      del.type = 'button';
      del.setAttribute('aria-label', 'delete');
      del.innerHTML = '&times;';
      card.appendChild(img);
      card.appendChild(meta);
      card.appendChild(del);
      card.addEventListener('click', (e) => {
        if (e.target === del) return;
        loadFractal(rec);
      });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        openDelConfirm(rec);
      });
      fracList.appendChild(card);
    }
  }
  function openBrowse() { _show(fracBrowsePanel); renderBrowse(); }

  fracMenuBtn.addEventListener('click', toggleFracMenu);
  fractalsWin.querySelector('#fracSave').addEventListener('click', openSavePrompt);
  fractalsWin.querySelector('#fracBrowse').addEventListener('click', openBrowse);
  fractalsWin.querySelector('#fractalsClose').addEventListener('click', closeFractals);
  fractalsWin.querySelector('#fracSaveOk').addEventListener('click', doSaveFractal);
  fractalsWin.querySelector('#fracSaveCancel').addEventListener('click', () => _hide(fracSavePrompt));
  fractalsWin.querySelector('#fracBrowseClose').addEventListener('click', () => _hide(fracBrowsePanel));
  fracNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSaveFractal(); });

  // Delete needs a deliberate 2-second hold (not a single tap) so a saved
  // fractal can't be lost by an accidental press. Releasing early cancels;
  // the button fills as a progress cue.
  const fracDelConfirm = fractalsWin.querySelector('#fracDelConfirm');
  const fracDelName = fractalsWin.querySelector('#fracDelName');
  const fracDelHold = fractalsWin.querySelector('#fracDelHold');
  let _delTarget = null;
  let _delTimer = null;
  function _resetHold() {
    if (_delTimer) { clearTimeout(_delTimer); _delTimer = null; }
    fracDelHold.classList.remove('holding');
  }
  function openDelConfirm(rec) {
    _delTarget = rec;
    fracDelName.textContent = rec.name || 'Untitled';
    _resetHold();
    _show(fracDelConfirm);
  }
  function _startHold() {
    if (_delTimer) return;
    void fracDelHold.offsetWidth;  // restart the fill transition from 0
    fracDelHold.classList.add('holding');
    _delTimer = setTimeout(async () => {
      _delTimer = null;
      fracDelHold.classList.remove('holding');
      const rec = _delTarget;
      _delTarget = null;
      _hide(fracDelConfirm);
      if (rec) { try { await _fracDelete(rec.id); } catch (e) {} renderBrowse(); }
    }, 2000);
  }
  fracDelHold.addEventListener('pointerdown', (e) => { e.preventDefault(); _startHold(); });
  fracDelHold.addEventListener('pointerup', _resetHold);
  fracDelHold.addEventListener('pointerleave', _resetHold);
  fracDelHold.addEventListener('pointercancel', _resetHold);
  fractalsWin.querySelector('#fracDelCancel').addEventListener('click', () => { _resetHold(); _hide(fracDelConfirm); });

  const $ = (id) => document.getElementById(id);

  // ────────────────────────────────────────────────────────────
  // Launcher wiring: bubble grid <-> tool views
  // ────────────────────────────────────────────────────────────
  const title = $('extrasTitle');
  const bubbles = $('extrasBubbles');
  const backBtn = $('extrasBack');
  const tools = {
    unitconv: { name: 'Unit conversions', el: $('extrasUnitConv') },
    tip: { name: 'Tip calculator', el: $('extrasTip') },
    tz: { name: 'Time zones', el: $('extrasTz') },
    date: { name: 'Date calculator', el: $('extrasDate') },
    sun: { name: 'Sun times', el: $('extrasSun') },
    moon: { name: 'Moon phase', el: $('extrasMoon') },
    dice: { name: 'Dice & D&D', el: $('extrasDice') },
    wheel: { name: 'Decision wheel', el: $('extrasWheel') },
  };

  function showBubbles() {
    title.textContent = 'Extras';
    backBtn.hidden = true;
    bubbles.hidden = false;
    for (const t of Object.values(tools)) t.el.hidden = true;
  }
  function showTool(id) {
    const t = tools[id];
    if (!t) return;
    title.textContent = t.name;
    backBtn.hidden = false;
    bubbles.hidden = true;
    for (const [tid, tt] of Object.entries(tools)) tt.el.hidden = (tid !== id);
    if (t.onShow) t.onShow();
  }
  $('extrasBtn').onclick = () => {
    showBubbles();
    panel.classList.add('show');
  };
  const closeExtras = () => panel.classList.remove('show');
  $('extrasXClose').onclick = closeExtras;
  backBtn.onclick = showBubbles;
  panel.addEventListener('click', (e) => {
    if (e.target === panel) closeExtras();
  });
  bubbles.addEventListener('click', (e) => {
    const b = e.target.closest('.extras-bubble');
    if (!b) return;
    // Fractals opens its own full-screen window rather than an inline
    // tool view inside the extras sheet.
    if (b.dataset.extra === 'fractals') { openFractals(); return; }
    showTool(b.dataset.extra);
  });

  // ────────────────────────────────────────────────────────────
  // External-tool registration hook
  // ────────────────────────────────────────────────────────────
  // Lets a separate, self-contained script (loaded AFTER this one) add its own
  // Extras tool without bloating this file. The module supplies a bubble
  // icon/label and a build(view) callback that populates + wires its own view.
  // Generic on purpose — nothing tool-specific lives here.
  //   def = { id, name, icon (HTML entity ok), label (HTML), build(view), onShow? }
  global.ExtrasRegisterTool = function registerExtraTool(def) {
    if (!def || !def.id || tools[def.id]) return null;
    const btn = document.createElement('button');
    btn.className = 'extras-bubble';
    btn.type = 'button';
    btn.dataset.extra = def.id;
    btn.innerHTML = '<span class="bubble-icon">' + (def.icon || '&#10024;') +
      '</span><span>' + (def.label || def.name || def.id) + '</span>';
    bubbles.appendChild(btn);

    const view = document.createElement('div');
    view.id = 'extras_' + def.id;
    view.hidden = true;
    panel.querySelector('.sheet').appendChild(view);

    tools[def.id] = { name: def.name || def.id, el: view, onShow: def.onShow };
    try { if (typeof def.build === 'function') def.build(view); }
    catch (e) { console.error('ExtrasRegisterTool: build failed for ' + def.id, e); }
    return view;
  };

  // ────────────────────────────────────────────────────────────
  // Shared helpers
  // ────────────────────────────────────────────────────────────
  function fmtNum(n) {
    if (!isFinite(n)) return '';
    if (n === 0) return '0';
    const a = Math.abs(n);
    // Extremes go exponential; everything else gets float noise
    // trimmed via toPrecision so 0.1+0.2-style artifacts and
    // 1.6093440000000001 never show up.
    if (a >= 1e15 || a < 1e-9) return n.toExponential(6).replace(/\.?0+e/, 'e');
    return String(parseFloat(n.toPrecision(10)));
  }

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const appTz = () => localStorage.getItem('cc.timezone') || browserTz;
  const clock12 = () => (localStorage.getItem('cc.clockFormat') || '24h') === '12h';

  // Wall-clock components of an instant, in a zone. hourCycle h23
  // (not hour12:false) because the latter can yield hour "24".
  function wallParts(epoch, zone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(epoch);
    const g = {};
    for (const p of parts) g[p.type] = p.value;
    return { y: +g.year, mo: +g.month, d: +g.day, h: +g.hour, mi: +g.minute };
  }
  // Epoch for a wall-clock time in a zone. JS can't parse zoned
  // datetimes directly, so iterate: guess the epoch as if the wall
  // time were UTC, see what the zone actually shows there, and
  // nudge by the difference. Converges in 1-2 steps; DST-skipped
  // times land on a sane neighbour.
  function epochFromWall(zone, y, mo, d, h, mi) {
    const want = Date.UTC(y, mo - 1, d, h, mi);
    let t = want;
    for (let i = 0; i < 3; i++) {
      const w = wallParts(t, zone);
      const diff = want - Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
      if (!diff) break;
      t += diff;
    }
    return t;
  }
  function fmtClock(epoch, zone) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: clock12(),
    }).format(epoch);
  }

  // Map position from the URL hash — MapLibre runs with hash:true so
  // the URL is always "#zoom/lat/lng(/bearing/pitch)". Zero-permission
  // location source; returns null if the hash isn't in that shape.
  function getMapLoc() {
    const m = location.hash.match(/^#?\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  // Today's date in the app timezone as a yyyy-mm-dd string (for
  // seeding date inputs).
  function todayStr() {
    const w = wallParts(Date.now(), appTz());
    return w.y + '-' + String(w.mo).padStart(2, '0') + '-' + String(w.d).padStart(2, '0');
  }
  // Parse a date input's yyyy-mm-dd into {y, mo, d} or null.
  function parseDateInput(v) {
    const m = (v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
  }

  // ────────────────────────────────────────────────────────────
  // Unit converter
  // ────────────────────────────────────────────────────────────
  // Linear units carry a factor to the category's base unit
  // (value × factor → base). Temperature is affine, so its units
  // get explicit toBase/fromBase instead. Both directions are
  // editable; typing in either field recomputes the other.
  const lin = (id, label, f) => ({
    id, label, toBase: (v) => v * f, fromBase: (v) => v / f,
  });
  const UC_CATEGORIES = [
    { id: 'length', name: 'Length', def: ['ft', 'm'], units: [
      lin('mm', 'millimetres (mm)', 0.001),
      lin('cm', 'centimetres (cm)', 0.01),
      lin('m', 'metres (m)', 1),
      lin('km', 'kilometres (km)', 1000),
      lin('in', 'inches (in)', 0.0254),
      lin('ft', 'feet (ft)', 0.3048),
      lin('yd', 'yards (yd)', 0.9144),
      lin('mi', 'miles (mi)', 1609.344),
    ] },
    { id: 'mass', name: 'Weight / mass', def: ['lb', 'kg'], units: [
      lin('mg', 'milligrams (mg)', 1e-6),
      lin('g', 'grams (g)', 0.001),
      lin('kg', 'kilograms (kg)', 1),
      lin('t', 'tonnes (t)', 1000),
      lin('oz', 'ounces (oz)', 0.028349523125),
      lin('lb', 'pounds (lb)', 0.45359237),
      lin('st', 'stone (st)', 6.35029318),
    ] },
    { id: 'temp', name: 'Temperature', def: ['f', 'c'], affine: true, units: [
      { id: 'c', label: 'Celsius (°C)', toBase: (v) => v, fromBase: (v) => v },
      { id: 'f', label: 'Fahrenheit (°F)',
        toBase: (v) => (v - 32) * 5 / 9, fromBase: (v) => v * 9 / 5 + 32 },
      { id: 'k', label: 'Kelvin (K)',
        toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
    ] },
    { id: 'volume', name: 'Volume / cooking', def: ['cup', 'ml'], units: [
      lin('ml', 'millilitres (mL)', 0.001),
      lin('l', 'litres (L)', 1),
      lin('tsp', 'teaspoons US (tsp)', 0.00492892159375),
      lin('tbsp', 'tablespoons US (tbsp)', 0.01478676478125),
      lin('floz', 'fluid ounces US (fl oz)', 0.0295735295625),
      lin('cup', 'cups US (cup)', 0.2365882365),
      lin('pt', 'pints US (pt)', 0.473176473),
      lin('qt', 'quarts US (qt)', 0.946352946),
      lin('gal', 'gallons US (gal)', 3.785411784),
      lin('m3', 'cubic metres (m³)', 1000),
    ] },
    { id: 'area', name: 'Area', def: ['sqft', 'sqm'], units: [
      lin('sqcm', 'square centimetres (cm²)', 0.0001),
      lin('sqm', 'square metres (m²)', 1),
      lin('sqin', 'square inches (in²)', 0.00064516),
      lin('sqft', 'square feet (ft²)', 0.09290304),
      lin('acre', 'acres', 4046.8564224),
      lin('ha', 'hectares (ha)', 10000),
      lin('sqkm', 'square kilometres (km²)', 1e6),
      lin('sqmi', 'square miles (mi²)', 2589988.110336),
    ] },
    { id: 'speed', name: 'Speed', def: ['mph', 'kmh'], units: [
      lin('ms', 'metres/second (m/s)', 1),
      lin('kmh', 'kilometres/hour (km/h)', 1 / 3.6),
      lin('mph', 'miles/hour (mph)', 0.44704),
      lin('kn', 'knots (kn)', 463 / 900),
      lin('fts', 'feet/second (ft/s)', 0.3048),
    ] },
    { id: 'time', name: 'Time', def: ['h', 'min'], units: [
      lin('ms2', 'milliseconds (ms)', 0.001),
      lin('s', 'seconds (s)', 1),
      lin('min', 'minutes (min)', 60),
      lin('h', 'hours (h)', 3600),
      lin('d', 'days (d)', 86400),
      lin('wk', 'weeks (wk)', 604800),
      lin('yr', 'years (365.25 d)', 31557600),
    ] },
    { id: 'data', name: 'Data', def: ['mb', 'mib'], units: [
      lin('bit', 'bits (b)', 0.125),
      lin('byte', 'bytes (B)', 1),
      lin('kb', 'kilobytes (kB)', 1e3),
      lin('mb', 'megabytes (MB)', 1e6),
      lin('gb', 'gigabytes (GB)', 1e9),
      lin('tb', 'terabytes (TB)', 1e12),
      lin('kib', 'kibibytes (KiB)', 1024),
      lin('mib', 'mebibytes (MiB)', 1048576),
      lin('gib', 'gibibytes (GiB)', 1073741824),
      lin('tib', 'tebibytes (TiB)', 1099511627776),
    ] },
  ];

  (() => {
    const catSel = $('ucCategory');
    const fromVal = $('ucFromVal');
    const fromUnit = $('ucFromUnit');
    const toVal = $('ucToVal');
    const toUnit = $('ucToUnit');
    const hint = $('ucHint');
    let cat = UC_CATEGORIES[0];

    // Short display name for the hint line — the bit in parens if
    // the label has one ("miles (mi)" → "mi"), else the full label.
    const unitShort = (u) => {
      const m = u.label.match(/\(([^)]+)\)$/);
      return m ? m[1] : u.label;
    };
    const unitById = (id) => cat.units.find((u) => u.id === id) || cat.units[0];
    function updateHint() {
      // "1 mi = 1.609344 km". Skipped for temperature — affine
      // scales make the "1 unit =" framing misleading there.
      if (cat.affine) { hint.textContent = ''; return; }
      const fu = unitById(fromUnit.value);
      const tu = unitById(toUnit.value);
      hint.textContent =
        '1 ' + unitShort(fu) + ' = ' + fmtNum(tu.fromBase(fu.toBase(1))) + ' ' + unitShort(tu);
    }
    function convert(reverse) {
      const src = reverse ? toVal : fromVal;
      const dst = reverse ? fromVal : toVal;
      const su = unitById(reverse ? toUnit.value : fromUnit.value);
      const du = unitById(reverse ? fromUnit.value : toUnit.value);
      const v = parseFloat(src.value);
      dst.value = isFinite(v) ? fmtNum(du.fromBase(su.toBase(v))) : '';
      updateHint();
    }
    function populateUnits(fromId, toId) {
      for (const sel of [fromUnit, toUnit]) {
        sel.innerHTML = '';
        for (const u of cat.units) {
          const o = document.createElement('option');
          o.value = u.id;
          o.textContent = u.label;
          sel.appendChild(o);
        }
      }
      fromUnit.value = fromId && cat.units.some((u) => u.id === fromId) ? fromId : cat.def[0];
      toUnit.value = toId && cat.units.some((u) => u.id === toId) ? toId : cat.def[1];
    }
    function savePrefs() {
      try {
        localStorage.setItem('cc.unitconv', JSON.stringify({
          cat: cat.id, from: fromUnit.value, to: toUnit.value,
        }));
      } catch (_) {}
    }

    for (const c of UC_CATEGORIES) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      catSel.appendChild(o);
    }
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('cc.unitconv') || 'null'); } catch (_) {}
    if (saved && UC_CATEGORIES.some((c) => c.id === saved.cat)) {
      cat = UC_CATEGORIES.find((c) => c.id === saved.cat);
    }
    catSel.value = cat.id;
    populateUnits(saved && saved.from, saved && saved.to);
    updateHint();

    catSel.addEventListener('change', () => {
      cat = UC_CATEGORIES.find((c) => c.id === catSel.value) || UC_CATEGORIES[0];
      populateUnits();
      convert(false);
      savePrefs();
    });
    fromVal.addEventListener('input', () => convert(false));
    toVal.addEventListener('input', () => convert(true));
    fromUnit.addEventListener('change', () => { convert(false); savePrefs(); });
    toUnit.addEventListener('change', () => { convert(false); savePrefs(); });
    $('ucSwap').onclick = () => {
      const f = fromUnit.value;
      fromUnit.value = toUnit.value;
      toUnit.value = f;
      // Carry the result up into the input so swapping reads as
      // "keep converting what I see" rather than clearing.
      if (toVal.value !== '') fromVal.value = toVal.value;
      convert(false);
      savePrefs();
    };
  })();

  // ────────────────────────────────────────────────────────────
  // Tip calculator
  // ────────────────────────────────────────────────────────────
  (() => {
    const billEl = $('tipBill');
    const chips = $('tipChips');
    const customEl = $('tipCustom');
    const emojiEl = $('tipEmoji');
    const splitN = $('tipSplitN');
    const eachRow = $('tipEachRow');
    let pct = 18;
    let split = 1;

    const money = (n) => (isFinite(n) ? n.toFixed(2) : '0.00');
    function emojiFor(p) {
      if (p <= 0) return ['', ''];
      if (p < 10) return ['😬', 'a little light...'];
      if (p < 15) return ['🙂', 'fair enough'];
      if (p < 18) return ['😊', 'nice'];
      if (p < 22) return ['😄', 'generous!'];
      if (p < 30) return ['🤩', 'very generous!!'];
      return ['🥹', 'angel behavior'];
    }
    function markChips() {
      for (const b of chips.querySelectorAll('.xt-chip')) {
        b.classList.toggle('active', Number(b.dataset.pct) === pct && customEl.value === '');
      }
    }
    function compute() {
      const bill = parseFloat(billEl.value);
      const b = isFinite(bill) && bill > 0 ? bill : 0;
      const tip = b * pct / 100;
      const total = b + tip;
      $('tipTipV').textContent = money(tip);
      $('tipTotalV').textContent = money(total);
      eachRow.hidden = split < 2;
      $('tipEachV').textContent = money(total / split);
      splitN.textContent = String(split);
      const [face, word] = emojiFor(pct);
      emojiEl.innerHTML = face
        ? '<span class="big">' + face + '</span>' + pct + '% — ' + word
        : '';
      try {
        localStorage.setItem('cc.tipcalc', JSON.stringify({ pct, split, custom: customEl.value !== '' }));
      } catch (_) {}
    }

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('cc.tipcalc') || 'null'); } catch (_) {}
    if (saved && isFinite(saved.pct) && saved.pct >= 0) pct = saved.pct;
    if (saved && isFinite(saved.split) && saved.split >= 1) split = Math.floor(saved.split);
    if (saved && saved.custom) customEl.value = String(pct);
    markChips();
    compute();

    billEl.addEventListener('input', compute);
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.xt-chip');
      if (!b) return;
      pct = Number(b.dataset.pct);
      customEl.value = '';
      markChips();
      compute();
    });
    customEl.addEventListener('input', () => {
      const v = parseFloat(customEl.value);
      if (isFinite(v) && v >= 0) pct = v;
      markChips();
      compute();
    });
    $('tipSplitMinus').onclick = () => { split = Math.max(1, split - 1); compute(); };
    $('tipSplitPlus').onclick = () => { split = Math.min(99, split + 1); compute(); };
  })();

  // ────────────────────────────────────────────────────────────
  // Timezone converter
  // ────────────────────────────────────────────────────────────
  (() => {
    const timeEl = $('tzTime');
    const fromSel = $('tzFrom');
    const toSel = $('tzTo');
    const resTime = $('tzResTime');
    const resSub = $('tzResSub');

    const tzList = (typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [browserTz, 'UTC', 'America/Montreal', 'America/Toronto', 'America/Vancouver',
         'America/New_York', 'America/Chicago', 'America/Los_Angeles',
         'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo']);
    const zones = [browserTz, ...tzList.filter((z) => z !== browserTz)];
    if (!zones.includes('UTC')) zones.splice(1, 0, 'UTC');
    for (const sel of [fromSel, toSel]) {
      for (const z of zones) {
        const o = document.createElement('option');
        o.value = z;
        o.textContent = z === browserTz ? z + ' (device)' : z;
        sel.appendChild(o);
      }
    }

    function dayEmoji(h) {
      if (h >= 5 && h < 8) return '🌅';
      if (h >= 8 && h < 18) return '☀️';
      if (h >= 18 && h < 21) return '🌆';
      return '🌙';
    }
    function setTimeToNow() {
      const w = wallParts(Date.now(), fromSel.value);
      timeEl.value = String(w.h).padStart(2, '0') + ':' + String(w.mi).padStart(2, '0');
    }
    function compute() {
      const m = (timeEl.value || '').match(/^(\d{1,2}):(\d{2})/);
      if (!m) { resTime.textContent = '—'; resSub.textContent = ''; return; }
      const from = fromSel.value;
      const to = toSel.value;
      // Date is assumed "today in the from zone" — day rollovers
      // show up as a ±1 day note in the result.
      const today = wallParts(Date.now(), from);
      const epoch = epochFromWall(from, today.y, today.mo, today.d, +m[1], +m[2]);
      const w = wallParts(epoch, to);
      const dateStr = new Intl.DateTimeFormat('en-US', {
        timeZone: to, weekday: 'short', month: 'short', day: 'numeric',
        timeZoneName: 'short',
      }).format(epoch);
      const dayDiff = Math.round(
        (Date.UTC(w.y, w.mo - 1, w.d) - Date.UTC(today.y, today.mo - 1, today.d)) / 86400000);
      const diffStr = dayDiff === 0 ? '' : ' · ' + (dayDiff > 0 ? '+' : '−') + Math.abs(dayDiff) + ' day';
      resTime.textContent = dayEmoji(w.h) + ' ' + fmtClock(epoch, to);
      resSub.textContent = dateStr + diffStr;
      try {
        localStorage.setItem('cc.tzconv', JSON.stringify({ from, to }));
      } catch (_) {}
    }

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('cc.tzconv') || 'null'); } catch (_) {}
    fromSel.value = saved && zones.includes(saved.from) ? saved.from
      : (zones.includes(appTz()) ? appTz() : browserTz);
    toSel.value = saved && zones.includes(saved.to) ? saved.to : 'UTC';
    setTimeToNow();
    compute();

    timeEl.addEventListener('input', compute);
    fromSel.addEventListener('change', compute);
    toSel.addEventListener('change', compute);
    $('tzNow').onclick = () => { setTimeToNow(); compute(); };
    $('tzSwap').onclick = () => {
      const f = fromSel.value;
      fromSel.value = toSel.value;
      toSel.value = f;
      compute();
    };
  })();

  // ────────────────────────────────────────────────────────────
  // Date calculator
  // ────────────────────────────────────────────────────────────
  // All math on UTC-midnight epochs so timezones and DST can't
  // skew day counts.
  function daysBetween(a, b) {
    return Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86400000);
  }
  function addToDate(start, n, unit) {
    if (unit === 'd') return new Date(Date.UTC(start.y, start.mo - 1, start.d + n));
    if (unit === 'wk') return new Date(Date.UTC(start.y, start.mo - 1, start.d + n * 7));
    if (unit === 'mo') return new Date(Date.UTC(start.y, start.mo - 1 + n, start.d));
    return new Date(Date.UTC(start.y + n, start.mo - 1, start.d));  // 'yr'
  }

  (() => {
    const aEl = $('dcA');
    const bEl = $('dcB');
    const startEl = $('dcStart');
    const dirEl = $('dcDir');
    const nEl = $('dcN');
    const unitEl = $('dcUnit');
    const betweenRes = $('dcBetweenRes');
    const addRes = $('dcAddRes');

    function computeBetween() {
      const a = parseDateInput(aEl.value);
      const b = parseDateInput(bEl.value);
      if (!a || !b) { betweenRes.textContent = '—'; return; }
      const days = daysBetween(a, b);
      const abs = Math.abs(days);
      const wk = Math.floor(abs / 7);
      const rem = abs % 7;
      let sub = '';
      if (abs >= 7) {
        sub = wk + ' week' + (wk === 1 ? '' : 's') + (rem ? ' ' + rem + ' day' + (rem === 1 ? '' : 's') : '');
      }
      betweenRes.innerHTML = '';
      const big = document.createElement('span');
      big.className = 'big';
      big.textContent = abs === 0 ? 'same day!' : abs + ' day' + (abs === 1 ? '' : 's');
      betweenRes.appendChild(big);
      if (sub || days < 0) {
        betweenRes.appendChild(document.createElement('br'));
        const small = document.createElement('span');
        small.className = 'xt-muted';
        small.textContent = (sub || '') + (days < 0 ? (sub ? ' · ' : '') + 'second date is earlier' : '');
        betweenRes.appendChild(small);
      }
    }
    function computeAdd() {
      const start = parseDateInput(startEl.value);
      const n = parseInt(nEl.value, 10);
      if (!start || !isFinite(n)) { addRes.textContent = '—'; return; }
      const res = addToDate(start, n * Number(dirEl.value), unitEl.value);
      // Format the UTC-midnight epoch in UTC so the calendar date
      // doesn't shift with the viewer's timezone.
      const str = new Intl.DateTimeFormat(undefined, {
        timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
      }).format(res);
      addRes.innerHTML = '';
      const big = document.createElement('span');
      big.className = 'big';
      big.textContent = str;
      addRes.appendChild(big);
    }
    function computeAll() { computeBetween(); computeAdd(); }

    aEl.value = todayStr();
    bEl.value = todayStr();
    startEl.value = todayStr();
    computeAll();
    for (const el of [aEl, bEl, startEl, nEl]) el.addEventListener('input', computeAll);
    for (const el of [dirEl, unitEl]) el.addEventListener('change', computeAll);
  })();

  // ────────────────────────────────────────────────────────────
  // Sun times — sunrise / sunset / golden hour / twilight
  // ────────────────────────────────────────────────────────────
  // NOAA solar position approximation (±2 min). Returns UTC minutes
  // for rise/set at the given zenith angle, or a polar marker when
  // the sun never crosses it that day. Longitude is east-positive.
  function sunTimesUTC(y, mo, d, lat, lon, zenithDeg) {
    const rad = Math.PI / 180;
    const N = Math.floor((Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
    const g = 2 * Math.PI / 365 * (N - 1 + 0.5);
    const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
      - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
      - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
      - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const cosHA = (Math.cos(zenithDeg * rad) - Math.sin(lat * rad) * Math.sin(decl))
      / (Math.cos(lat * rad) * Math.cos(decl));
    if (cosHA > 1) return { polar: 'below' };   // sun never gets that high
    if (cosHA < -1) return { polar: 'above' };  // sun never gets that low
    const ha = Math.acos(cosHA) / rad;
    return {
      rise: 720 - 4 * (lon + ha) - eqtime,
      set: 720 - 4 * (lon - ha) - eqtime,
      noon: 720 - 4 * lon - eqtime,
    };
  }

  (() => {
    const dateEl = $('sunDate');
    const latEl = $('sunLat');
    const lonEl = $('sunLon');
    const res = $('sunRes');

    function fillFromMap() {
      const loc = getMapLoc();
      if (!loc) return false;
      latEl.value = loc.lat.toFixed(4);
      lonEl.value = loc.lon.toFixed(4);
      return true;
    }
    function row(label, value) {
      const r = document.createElement('div');
      r.className = 'sun-row';
      const l = document.createElement('span');
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = value;
      r.appendChild(l);
      r.appendChild(v);
      return r;
    }
    function note(text) {
      const n = document.createElement('div');
      n.className = 'sun-note';
      n.textContent = text;
      return n;
    }
    function compute() {
      const dt = parseDateInput(dateEl.value);
      const lat = parseFloat(latEl.value);
      const lon = parseFloat(lonEl.value);
      res.innerHTML = '';
      if (!dt || !isFinite(lat) || !isFinite(lon)) {
        const hintEl = document.createElement('span');
        hintEl.className = 'xt-muted';
        hintEl.textContent = 'pan the map to your spot, then tap 📍 — or type a lat/lon';
        res.appendChild(hintEl);
        return;
      }
      const dayMs = Date.UTC(dt.y, dt.mo - 1, dt.d);
      const t = (min) => fmtClock(dayMs + min * 60000, appTz());
      const official = sunTimesUTC(dt.y, dt.mo, dt.d, lat, lon, 90.833);
      const civil = sunTimesUTC(dt.y, dt.mo, dt.d, lat, lon, 96);
      const golden = sunTimesUTC(dt.y, dt.mo, dt.d, lat, lon, 84);

      if (official.polar === 'below') {
        res.appendChild(note('🌙 polar night — the sun stays below the horizon'));
        if (!civil.polar) {
          res.appendChild(row('🌄 twilight begins', t(civil.rise)));
          res.appendChild(row('🌆 twilight ends', t(civil.set)));
        }
        return;
      }
      if (official.polar === 'above') {
        res.appendChild(note('☀️ midnight sun — the sun never sets today'));
        if (!golden.polar) {
          res.appendChild(row('✨ golden ends', t(golden.rise)));
          res.appendChild(row('✨ golden begins', t(golden.set)));
        }
        return;
      }
      if (!civil.polar) res.appendChild(row('🌄 dawn', t(civil.rise)));
      res.appendChild(row('🌅 sunrise', t(official.rise)));
      if (golden.polar === 'below') {
        res.appendChild(note('✨ the sun stays low — golden light all day'));
      } else if (!golden.polar) {
        res.appendChild(row('✨ golden hour ends', t(golden.rise)));
        res.appendChild(row('✨ golden hour begins', t(golden.set)));
      }
      res.appendChild(row('🌇 sunset', t(official.set)));
      if (!civil.polar) res.appendChild(row('🌆 dusk', t(civil.set)));
      const len = official.set - official.rise;
      res.appendChild(row('⏱ day length',
        Math.floor(len / 60) + ' h ' + String(Math.round(len % 60)).padStart(2, '0') + ' min'));
    }

    dateEl.value = todayStr();
    tools.sun.onShow = () => {
      if (latEl.value === '' && lonEl.value === '') fillFromMap();
      compute();
    };
    $('sunToday').onclick = () => { dateEl.value = todayStr(); compute(); };
    $('sunMapLoc').onclick = () => { fillFromMap(); compute(); };
    for (const el of [dateEl, latEl, lonEl]) el.addEventListener('input', compute);
  })();

  // ────────────────────────────────────────────────────────────
  // Moon phase
  // ────────────────────────────────────────────────────────────
  // Mean synodic month from a known new moon (2000-01-06 18:14 UTC).
  // Good to ~half a day, plenty for a phase display.
  const SYNODIC = 29.530588853;
  const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14);
  function moonAge(epoch) {
    let age = ((epoch - NEW_MOON_EPOCH) / 86400000) % SYNODIC;
    if (age < 0) age += SYNODIC;
    return age;
  }
  // SVG of the lit moon shape for phase p (0=new .. 0.5=full .. 1=new),
  // northern-hemisphere orientation (waxing lights up the right side);
  // pass mirror=true for the southern-hemisphere view. The terminator
  // is a half-ellipse whose x-radius shrinks to 0 at the quarters.
  function moonSvg(p, size, mirror) {
    const c = size / 2;
    const r = c - 3;
    const cosp = Math.cos(2 * Math.PI * p);
    const rx = Math.abs(cosp) * r;
    const waxing = p < 0.5;
    // Lit-side semicircle (top→bottom): right side is a clockwise
    // arc (sweep 1), left side counterclockwise (sweep 0). Then the
    // terminator closes bottom→top; its sweep picks which way the
    // ellipse bulges (toward the lit edge for crescents, away for
    // gibbous phases).
    const semiSweep = waxing ? 1 : 0;
    const termSweep = waxing ? (cosp > 0 ? 0 : 1) : (cosp > 0 ? 1 : 0);
    const d = 'M ' + c + ' ' + (c - r)
      + ' A ' + r + ' ' + r + ' 0 0 ' + semiSweep + ' ' + c + ' ' + (c + r)
      + ' A ' + rx.toFixed(2) + ' ' + r + ' 0 0 ' + termSweep + ' ' + c + ' ' + (c - r) + ' Z';
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '"'
      + (mirror ? ' style="transform:scaleX(-1)"' : '') + '>'
      + '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="#39404e" stroke="#5a6273" stroke-width="1.5"/>'
      + '<path d="' + d + '" fill="#f2e3ae"/>'
      + '</svg>';
  }

  (() => {
    const dateEl = $('moonDate');
    const wrap = $('moonSvgWrap');
    const nameEl = $('moonName');
    const metaEl = $('moonMeta');
    const nextEl = $('moonNext');

    const NAMES = [
      [0.02, '🌑', 'New moon'],
      [0.23, '🌒', 'Waxing crescent'],
      [0.27, '🌓', 'First quarter'],
      [0.48, '🌔', 'Waxing gibbous'],
      [0.52, '🌕', 'Full moon'],
      [0.73, '🌖', 'Waning gibbous'],
      [0.77, '🌗', 'Last quarter'],
      [0.98, '🌘', 'Waning crescent'],
      [1.01, '🌑', 'New moon'],
    ];
    function phaseName(p) {
      for (const [limit, emoji, name] of NAMES) {
        if (p < limit) return [emoji, name];
      }
      return ['🌑', 'New moon'];
    }
    const fmtDate = (epoch) => new Intl.DateTimeFormat(undefined, {
      timeZone: appTz(), month: 'short', day: 'numeric',
    }).format(epoch);

    function compute() {
      const dt = parseDateInput(dateEl.value);
      if (!dt) return;
      // Evaluate at local noon so "today" reads as mid-day phase.
      const epoch = epochFromWall(appTz(), dt.y, dt.mo, dt.d, 12, 0);
      const age = moonAge(epoch);
      const p = age / SYNODIC;
      const illum = (1 - Math.cos(2 * Math.PI * p)) / 2;
      const south = (getMapLoc() || { lat: 45 }).lat < 0;
      wrap.innerHTML = moonSvg(p, 140, south);
      const [emoji, name] = phaseName(p);
      nameEl.textContent = emoji + ' ' + name;
      metaEl.textContent = Math.round(illum * 100) + '% illuminated · '
        + age.toFixed(1) + ' days old'
        + (south ? ' · southern-sky view' : '');
      // Next full and new moons from this date.
      const daysToFull = ((0.5 - p) * SYNODIC + SYNODIC) % SYNODIC;
      const daysToNew = ((1 - p) * SYNODIC) % SYNODIC;
      nextEl.textContent = 'next 🌕 full — ' + fmtDate(epoch + daysToFull * 86400000)
        + ' · next 🌑 new — ' + fmtDate(epoch + daysToNew * 86400000);
    }

    dateEl.value = todayStr();
    tools.moon.onShow = compute;
    $('moonToday').onclick = () => { dateEl.value = todayStr(); compute(); };
    dateEl.addEventListener('input', compute);
    compute();
  })();

  // ────────────────────────────────────────────────────────────
  // Dice & D&D — counters, dice pool, advantage/disadvantage
  // ────────────────────────────────────────────────────────────
  (() => {
    const DICE = [4, 6, 8, 10, 12, 20, 100];
    const MAX_DICE = 12;
    const poolEl = $('dicePool');
    const flairEl = $('diceFlair');
    const tilesEl = $('diceTiles');
    const totalEl = $('diceTotal');
    const histEl = $('diceHistory');
    const modV = $('diceModV');
    const countersEl = $('dndCounters');
    const pool = {};
    let mod = 0;
    const history = [];

    // ── Counters (HP, gold, anything) — these persist, because a
    // party's HP should survive switching apps mid-session. ──
    let counters = [{ n: 'HP', v: 20 }];
    try {
      const saved = JSON.parse(localStorage.getItem('cc.dnd') || 'null');
      if (saved && Array.isArray(saved.counters)) {
        counters = saved.counters
          .filter((c) => c && typeof c.n === 'string' && isFinite(c.v))
          .map((c) => ({ n: c.n.slice(0, 24), v: Math.round(c.v) }));
      }
    } catch (_) {}
    function saveCounters() {
      try { localStorage.setItem('cc.dnd', JSON.stringify({ counters })); } catch (_) {}
    }
    function renderCounters() {
      countersEl.innerHTML = '';
      counters.forEach((c, i) => {
        const row = document.createElement('div');
        row.className = 'dnd-row';
        const name = document.createElement('input');
        name.type = 'text';
        name.className = 'dnd-name';
        name.maxLength = 24;
        name.placeholder = 'name';
        name.value = c.n;
        name.addEventListener('input', () => { c.n = name.value; saveCounters(); });
        const minus = document.createElement('button');
        minus.type = 'button';
        minus.className = 'dnd-btn';
        minus.textContent = '−';
        minus.title = 'minus 1 (hold shift for 5)';
        const val = document.createElement('input');
        val.type = 'number';
        val.className = 'dnd-val';
        val.inputMode = 'numeric';
        val.value = String(c.v);
        val.addEventListener('input', () => {
          const v = parseInt(val.value, 10);
          if (isFinite(v)) { c.v = v; saveCounters(); }
        });
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.className = 'dnd-btn';
        plus.textContent = '+';
        plus.title = 'plus 1 (hold shift for 5)';
        const bump = (sign) => (e) => {
          c.v += sign * (e.shiftKey ? 5 : 1);
          val.value = String(c.v);
          saveCounters();
        };
        minus.addEventListener('click', bump(-1));
        plus.addEventListener('click', bump(1));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'dnd-btn dnd-del';
        del.textContent = '✕';
        del.title = 'remove counter';
        del.addEventListener('click', () => {
          counters.splice(i, 1);
          saveCounters();
          renderCounters();
        });
        row.appendChild(name);
        row.appendChild(minus);
        row.appendChild(val);
        row.appendChild(plus);
        row.appendChild(del);
        countersEl.appendChild(row);
      });
    }
    $('dndAdd').onclick = () => {
      counters.push({ n: '', v: 0 });
      saveCounters();
      renderCounters();
      const inputs = countersEl.querySelectorAll('.dnd-name');
      if (inputs.length) inputs[inputs.length - 1].focus();
    };
    renderCounters();

    // ── Dice ──
    const poolSize = () => Object.values(pool).reduce((a, b) => a + b, 0);
    function modSuffix() {
      if (mod > 0) return ' + ' + mod;
      if (mod < 0) return ' − ' + (-mod);
      return '';
    }
    function renderPool() {
      poolEl.innerHTML = '';
      const active = DICE.filter((n) => pool[n]);
      if (!active.length) {
        const span = document.createElement('span');
        span.className = 'xt-muted';
        span.textContent = 'tap a die above to add it';
        poolEl.appendChild(span);
        return;
      }
      for (const n of active) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'xt-chip';
        b.dataset.d = String(n);
        b.title = 'tap to remove one';
        b.textContent = pool[n] + '×d' + n + ' ✕';
        poolEl.appendChild(b);
      }
    }
    function makeTile(n, v, extraClass, delayIdx) {
      const tile = document.createElement('div');
      tile.className = 'dice-tile'
        + (n === 20 && v === 20 ? ' nat20' : '')
        + (n === 20 && v === 1 ? ' nat1' : '')
        + (extraClass ? ' ' + extraClass : '');
      tile.style.animationDelay = (delayIdx * 0.05) + 's';
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = String(v);
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = 'd' + n;
      tile.appendChild(val);
      tile.appendChild(lbl);
      return tile;
    }
    function histAdd(line) {
      history.unshift(line);
      if (history.length > 5) history.pop();
      histEl.textContent = history.join('\n');
    }
    function showTotal(sum) {
      const total = sum + mod;
      totalEl.textContent = mod !== 0
        ? sum + ' ' + (mod > 0 ? '+ ' + mod : '− ' + (-mod)) + ' = ' + total
        : '= ' + total;
      return total;
    }
    function roll() {
      if (!poolSize()) {
        flairEl.textContent = '🎲 add some dice first!';
        return;
      }
      const rolls = [];
      for (const n of DICE) {
        for (let i = 0; i < (pool[n] || 0); i++) {
          rolls.push({ n, v: 1 + Math.floor(Math.random() * n) });
        }
      }
      tilesEl.innerHTML = '';
      rolls.forEach((r, i) => tilesEl.appendChild(makeTile(r.n, r.v, '', i)));
      const sum = rolls.reduce((a, r) => a + r.v, 0);
      const total = showTotal(sum);
      if (rolls.some((r) => r.n === 20 && r.v === 20)) {
        flairEl.textContent = '✨ NAT 20! ✨';
      } else if (rolls.every((r) => r.v === r.n)) {
        flairEl.textContent = '💥 MAX ROLL!';
      } else if (rolls.some((r) => r.n === 20 && r.v === 1)) {
        flairEl.textContent = '💀 oof, nat 1';
      } else if (rolls.every((r) => r.v === 1)) {
        flairEl.textContent = '🫠 all ones...';
      } else {
        flairEl.textContent = '';
      }
      const desc = DICE.filter((n) => pool[n]).map((n) => pool[n] + 'd' + n).join(' + ');
      histAdd(desc + modSuffix() + ' → ' + total);
    }
    // Advantage/disadvantage: 2d20 keep highest/lowest, plus the
    // modifier. Independent of the dice pool.
    function rollAdvDis(keepHigh) {
      const a = 1 + Math.floor(Math.random() * 20);
      const b = 1 + Math.floor(Math.random() * 20);
      const kept = keepHigh ? Math.max(a, b) : Math.min(a, b);
      tilesEl.innerHTML = '';
      [a, b].forEach((v, i) => {
        const isKept = (v === kept) && (i === [a, b].indexOf(kept));
        tilesEl.appendChild(makeTile(20, v, isKept ? '' : 'dropped', i));
      });
      const total = showTotal(kept);
      if (kept === 20) flairEl.textContent = '✨ NAT 20! ✨';
      else if (kept === 1) flairEl.textContent = '💀 oof, nat 1';
      else flairEl.textContent = '';
      histAdd((keepHigh ? 'adv' : 'dis') + modSuffix() + ' → ' + total);
    }

    renderPool();
    $('diceChips').addEventListener('click', (e) => {
      const b = e.target.closest('.dice-chip');
      if (!b) return;
      if (poolSize() >= MAX_DICE) {
        flairEl.textContent = '🎲 that’s plenty of dice! (max ' + MAX_DICE + ')';
        return;
      }
      const n = Number(b.dataset.d);
      pool[n] = (pool[n] || 0) + 1;
      renderPool();
    });
    poolEl.addEventListener('click', (e) => {
      const b = e.target.closest('.xt-chip');
      if (!b) return;
      const n = Number(b.dataset.d);
      pool[n] = (pool[n] || 0) - 1;
      if (pool[n] <= 0) delete pool[n];
      renderPool();
    });
    const fmtMod = (m) => (m < 0 ? '−' + (-m) : '+' + m);
    $('diceModMinus').onclick = () => { mod = Math.max(-99, mod - 1); modV.textContent = fmtMod(mod); };
    $('diceModPlus').onclick = () => { mod = Math.min(99, mod + 1); modV.textContent = fmtMod(mod); };
    $('diceClear').onclick = () => {
      for (const k of Object.keys(pool)) delete pool[k];
      mod = 0;
      modV.textContent = '+0';
      tilesEl.innerHTML = '';
      totalEl.textContent = '';
      flairEl.textContent = '';
      renderPool();
    };
    $('diceRoll').onclick = roll;
    $('diceAdv').onclick = () => rollAdvDis(true);
    $('diceDis').onclick = () => rollAdvDis(false);
  })();

  // ────────────────────────────────────────────────────────────
  // Decision wheel
  // ────────────────────────────────────────────────────────────
  // Which segment sits under the top pointer for a given wheel
  // rotation. Segment i is drawn from angle rot+i*seg to rot+(i+1)*seg
  // (canvas angles, y-down); the pointer is at 3π/2 (straight up).
  function wheelWinner(rot, count) {
    const seg = 2 * Math.PI / count;
    const a = ((3 * Math.PI / 2 - rot) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    return Math.floor(a / seg) % count;
  }

  (() => {
    const MAX_OPTS = 12;
    const canvas = $('wheelCanvas');
    const newEl = $('wheelNew');
    const optsEl = $('wheelOpts');
    const resultEl = $('wheelResult');
    const removeBtn = $('wheelRemoveWinner');
    const SIZE = 260;
    const dpr = Math.min(global.devicePixelRatio || 1, 3);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    let opts = ['yes', 'no'];
    try {
      const saved = JSON.parse(localStorage.getItem('cc.wheel') || 'null');
      if (saved && Array.isArray(saved.opts) && saved.opts.length) {
        opts = saved.opts.map((o) => String(o).slice(0, 40)).slice(0, MAX_OPTS);
      }
    } catch (_) {}
    const save = () => {
      try { localStorage.setItem('cc.wheel', JSON.stringify({ opts })); } catch (_) {}
    };

    let rot = 0;
    let spinning = false;
    let lastWinner = -1;

    function draw() {
      const c = SIZE / 2;
      const r = c - 4;
      ctx.clearRect(0, 0, SIZE, SIZE);
      const n = opts.length;
      if (n === 0) {
        ctx.beginPath();
        ctx.arc(c, c, r, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(128,128,128,0.15)';
        ctx.fill();
        return;
      }
      const seg = 2 * Math.PI / n;
      for (let i = 0; i < n; i++) {
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.arc(c, c, r, rot + i * seg, rot + (i + 1) * seg);
        ctx.closePath();
        // Spaced hues read as distinct on any theme; fixed s/l keeps
        // white labels legible.
        ctx.fillStyle = 'hsl(' + Math.round(i * 360 / n) + ', 62%, 48%)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = '600 13px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 3;
      for (let i = 0; i < n; i++) {
        ctx.save();
        ctx.translate(c, c);
        ctx.rotate(rot + (i + 0.5) * seg);
        let label = opts[i];
        if (label.length > 14) label = label.slice(0, 13) + '…';
        ctx.fillText(label, r - 10, 0);
        ctx.restore();
      }
      ctx.shadowBlur = 0;
      // hub
      ctx.beginPath();
      ctx.arc(c, c, 14, 0, 2 * Math.PI);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
    }
    function renderOpts() {
      optsEl.innerHTML = '';
      if (!opts.length) {
        const span = document.createElement('span');
        span.className = 'xt-muted';
        span.textContent = 'add at least two options';
        optsEl.appendChild(span);
      }
      opts.forEach((o, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'xt-chip';
        b.title = 'tap to remove';
        b.textContent = o + ' ✕';
        b.addEventListener('click', () => {
          if (spinning) return;
          opts.splice(i, 1);
          lastWinner = -1;
          removeBtn.hidden = true;
          save();
          renderOpts();
          draw();
        });
        optsEl.appendChild(b);
      });
      draw();
    }
    function addOpt() {
      const v = newEl.value.trim();
      if (!v) return;
      if (opts.length >= MAX_OPTS) {
        resultEl.textContent = 'wheel is full! (max ' + MAX_OPTS + ')';
        return;
      }
      opts.push(v);
      newEl.value = '';
      save();
      renderOpts();
    }
    function spin() {
      if (spinning || opts.length < 2) {
        if (opts.length < 2) resultEl.textContent = 'add at least two options!';
        return;
      }
      spinning = true;
      removeBtn.hidden = true;
      resultEl.textContent = '...';
      const reduced = global.matchMedia
        && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const duration = reduced ? 1 : 3400;
      const start = rot;
      const target = rot + (5 + Math.random() * 3) * 2 * Math.PI + Math.random() * 2 * Math.PI;
      const t0 = performance.now();
      function frame(now) {
        const t = Math.min(1, (now - t0) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        rot = start + (target - start) * ease;
        draw();
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          rot = rot % (2 * Math.PI);
          spinning = false;
          lastWinner = wheelWinner(rot, opts.length);
          resultEl.textContent = '🎉 ' + opts[lastWinner];
          removeBtn.hidden = false;
        }
      }
      requestAnimationFrame(frame);
    }

    renderOpts();
    $('wheelAdd').onclick = addOpt;
    newEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addOpt(); }
    });
    $('wheelSpin').onclick = spin;
    removeBtn.onclick = () => {
      if (spinning || lastWinner < 0 || lastWinner >= opts.length) return;
      opts.splice(lastWinner, 1);
      lastWinner = -1;
      removeBtn.hidden = true;
      resultEl.textContent = '';
      save();
      renderOpts();
      if (opts.length >= 2) spin();
    };
  })();
})(typeof window !== 'undefined' ? window : globalThis);
