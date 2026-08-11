'use strict';
/* ============================================================
   CANDY CRUNCH — script.js
   A complete match-3 engine written in vanilla JS.

   MODULE MAP
   1.  Config & constants
   2.  Audio engine (Web Audio API — no external files)
   3.  Candy factory (SVG art generated in code)
   4.  Board model & DOM layer
   5.  Board generation (no initial matches)
   6.  Match detection (runs of 3+) + match analysis
       (creates Striped / Wrapped / Color Bomb specials)
   7.  Special-swap combined effects (bomb+stripe, etc.)
   8.  Clear resolution (chain reactions, scoring, particles)
   9.  Gravity & respawn
   10. Possible-move search, hint system, shuffle
   11. Input handling (click/click + drag, pointer events)
   12. Turn flow & cascade orchestration
   13. Game state (score / moves / levels / win / lose)
   14. HUD & overlay wiring
   15. Boot
   ============================================================ */

/* ============================================================
   1. CONFIG & CONSTANTS
   ============================================================ */
const N = 8;                 // board is N x N
const NUM_COLORS = 6;        // number of candy colors
const START_MOVES = 30;      // moves per level
const HINT_DELAY = 8000;     // ms of inactivity before a hint pulses
const BASE_POINTS = 60;      // points per candy cleared

/* Candy palette: c1 = highlight, c2 = base, c3 = shadow, fx = particle color */
const CM = [
  { c1: '#ffb3c2', c2: '#ff4d6d', c3: '#c91842', fx: '#ff4d6d' }, // 0 red
  { c1: '#ffd28f', c2: '#ff9e2c', c3: '#e07105', fx: '#ff9e2c' }, // 1 orange
  { c1: '#fff3a0', c2: '#ffd93b', c3: '#dfa900', fx: '#ffd93b' }, // 2 yellow
  { c1: '#a5f2b8', c2: '#45d873', c3: '#179a41', fx: '#45d873' }, // 3 green
  { c1: '#a8dcff', c2: '#3fa7ff', c3: '#0f6fd0', fx: '#3fa7ff' }, // 4 blue
  { c1: '#e2b8ff', c2: '#b14ef5', c3: '#7d1fd0', fx: '#b14ef5' }, // 5 purple
];

/* DOM handles */
const $ = id => document.getElementById(id);
const boardEl   = $('board'),   cellsEl = $('cells'),  candiesEl = $('candies'), fxEl = $('fx');
const scoreEl   = $('scoreVal'), targetEl = $('targetVal'), progressEl = $('progressFill');
const movesEl   = $('movesVal'), movesBox = $('movesBox'), levelEl = $('levelVal');
const bannerEl  = $('banner'),  toastEl = $('toast');

/* Global mutable state */
const state = {
  level: 1, score: 0, displayedScore: 0, target: 4000,
  moves: START_MOVES, busy: true, paused: false, over: false,
  best: +(localStorage.getItem('cc_best') || 0),
};

let grid = [];        // grid[r][c] -> candy object | null
let gid = 0;          // unique candy id source
const rand = n => (Math.random() * n) | 0;
const key = (r, c) => r * N + c;                       // cell -> int key
const unkey = k => ({ r: (k / N) | 0, c: k % N });     // int key -> cell
const inBounds = (r, c) => r >= 0 && r < N && c >= 0 && c < N;
const sleep = ms => new Promise(res => setTimeout(res, ms));

function newCandy(color, special = null) {
  return { uid: gid++, color, special, row: -1, col: -1, el: null, clearing: false, noChain: false };
}

/* target score for a level — grows ~35% per level */
const targetFor = lvl => Math.round(4000 * Math.pow(1.35, lvl - 1) / 100) * 100;

/* ============================================================
   2. AUDIO ENGINE — everything is synthesized with WebAudio
   ============================================================ */
const Snd = {
  ctx: null, master: null, noiseBuf: null,
  muted: localStorage.getItem('cc_muted') === '1',

  /* create/resume the AudioContext (must be called from a user gesture) */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      /* 1s of reusable white noise for explosions */
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  },

  /* a single enveloped oscillator note */
  tone({ f = 440, d = 0.15, type = 'sine', v = 0.2, at = 0, slide = 0 }) {
    if (this.muted || !this.ensure()) return;
    const t = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + d);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + d + 0.05);
  },

  /* filtered noise burst → explosions */
  noise({ d = 0.35, v = 0.4, at = 0, f0 = 3000, f1 = 200 }) {
    if (this.muted || !this.ensure()) return;
    const t = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const flt = this.ctx.createBiquadFilter(); flt.type = 'lowpass';
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + d);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + d + 0.05);
  },

  click()   { this.tone({ f: 700, d: .05, type: 'square', v: .06 }); },
  swap()    { this.tone({ f: 480, d: .07, v: .15 }); this.tone({ f: 720, d: .08, v: .15, at: .05 }); },
  invalid() { this.tone({ f: 170, d: .14, type: 'sawtooth', v: .1 }); this.tone({ f: 120, d: .18, type: 'sawtooth', v: .09, at: .09 }); },

  /* match jingle — pitch climbs with the combo count */
  match(combo = 1) {
    const f0 = 440 * Math.pow(1.16, Math.min(combo, 9) - 1);
    [0, 4, 7].forEach((semi, i) =>
      this.tone({ f: f0 * Math.pow(2, semi / 12), d: .1, type: 'triangle', v: .18, at: i * .055 }));
  },

  boom(big = false) {
    this.noise({ d: big ? .55 : .35, v: big ? .5 : .32, f0: big ? 4000 : 2600, f1: 120 });
    this.tone({ f: 150, d: big ? .45 : .3, v: .3, slide: 45 });
  },

  bomb() {
    this.noise({ d: .7, v: .55, f0: 5000, f1: 60 });
    this.tone({ f: 100, d: .65, v: .4, slide: 28 });
    this.tone({ f: 55, d: .7, type: 'triangle', v: .35, at: .05, slide: 24 });
  },

  shuffle() { [500, 620, 480, 660, 540].forEach((f, i) => this.tone({ f, d: .07, v: .1, at: i * .06 })); },

  win() {
    [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) =>
      this.tone({ f, d: .18, type: 'triangle', v: .2, at: i * .12 }));
  },

  lose() { [392, 330, 262, 196].forEach((f, i) => this.tone({ f, d: .3, type: 'triangle', v: .18, at: i * .2 })); },
};

/* ============================================================
   3. CANDY FACTORY — all candy art is generated SVG (no assets)
   ============================================================ */

/* Base shape per color id (viewBox 0 0 100 100, body inside 10..90) */
function shapeMarkup(color) {
  switch (color) {
    case 0: return '<circle cx="50" cy="52" r="38"/>';                                    // red: round
    case 1: return '<ellipse cx="50" cy="52" rx="41" ry="31"/>';                          // orange: oval
    case 2: return '<path d="M50 10 C72 40 86 52 86 68 C86 85 70 93 50 93 C30 93 14 85 14 68 C14 52 28 40 50 10 Z"/>'; // yellow: drop
    case 3: return '<ellipse cx="50" cy="52" rx="41" ry="27" transform="rotate(-28 50 52)"/>'; // green: bean
    case 4: return '<rect x="13" y="14" width="74" height="74" rx="24"/>';                // blue: square
    default: return '<path d="M50 9 L84 51 L50 91 L16 51 Z"/>';                           // purple: diamond
  }
}

/* sprinkle layout for the color bomb (pseudo-random but fixed layout) */
const SPRINKLES = [
  [34, 36, -20], [52, 30, 12], [66, 40, 28], [27, 55, 12], [46, 50, -34],
  [63, 58, 42], [39, 68, 6], [58, 71, -16], [50, 60, 62], [30, 44, 48],
];

function candySVG(candy) {
  const u = candy.uid;

  /* ---- Color bomb: chocolate sphere with sprinkles ---- */
  if (candy.special === 'bomb') {
    return `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bb${u}" cx="38%" cy="30%" r="88%">
          <stop offset="0%" stop-color="#8d6b52"/>
          <stop offset="55%" stop-color="#4a3324"/>
          <stop offset="100%" stop-color="#1c110a"/>
        </radialGradient>
      </defs>
      <circle cx="50" cy="52" r="39" fill="url(#bb${u})"/>
      ${SPRINKLES.map(([x, y, rot], i) =>
        `<rect x="${x}" y="${y}" width="10" height="4.5" rx="2.2"
           fill="${CM[i % NUM_COLORS].c2}" transform="rotate(${rot} ${x} ${y})"/>`).join('')}
      <ellipse cx="36" cy="30" rx="15" ry="8" fill="rgba(255,255,255,.45)" transform="rotate(-18 36 30)"/>
      <circle cx="50" cy="52" r="39" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
    </svg>`;
  }

  const M = CM[candy.color];
  const shape = shapeMarkup(candy.color);

  /* striped overlay: 3 glossy white bars clipped to the candy shape */
  let overlay = '';
  if (candy.special === 'row') {
    overlay = `<g clip-path="url(#cp${u})">
      ${[27, 46, 65].map(y => `<rect x="6" y="${y}" width="88" height="11" rx="5.5" fill="rgba(255,255,255,.92)"/>`).join('')}
    </g>`;
  } else if (candy.special === 'col') {
    overlay = `<g clip-path="url(#cp${u})">
      ${[27, 46, 65].map(x => `<rect x="${x}" y="6" width="11" height="88" rx="5.5" fill="rgba(255,255,255,.92)"/>`).join('')}
    </g>`;
  } else if (candy.special === 'wrap') {
    /* wrapped: white wrapper ring + sparkles */
    overlay = `
      <g fill="none" stroke="#fff" stroke-width="5" opacity=".9">
        <g transform="translate(50 52) scale(.86) translate(-50 -52)">${shape}</g>
      </g>
      <g fill="#fff">
        <circle cx="26" cy="26" r="3"/><circle cx="74" cy="30" r="2.4"/>
        <circle cx="30" cy="74" r="2.4"/><circle cx="72" cy="72" r="3"/>
      </g>`;
  }

  return `
  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="cg${u}" cx="35%" cy="26%" r="85%">
        <stop offset="0%" stop-color="${M.c1}"/>
        <stop offset="55%" stop-color="${M.c2}"/>
        <stop offset="100%" stop-color="${M.c3}"/>
      </radialGradient>
      <linearGradient id="sh${u}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="55%" stop-color="rgba(255,255,255,0)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,.20)"/>
      </linearGradient>
      <clipPath id="cp${u}">${shape}</clipPath>
    </defs>
    <g fill="url(#cg${u})">${shape}</g>
    <g fill="url(#sh${u})">${shape}</g>
    ${overlay}
    <ellipse cx="36" cy="28" rx="15" ry="8" fill="rgba(255,255,255,.55)" transform="rotate(-18 36 28)"/>
  </svg>`;
}

/* ============================================================
   4. BOARD MODEL & DOM LAYER
   Candies are absolutely-positioned <div>s moved with CSS
   transforms; `--x/--y` are grid coords, `--cell` is the pixel
   size of one grid cell, so CSS transitions animate movement.
   ============================================================ */

function makeCandyEl(candy) {
  const el = document.createElement('div');
  el.className = 'candy';
  const inner = document.createElement('div');
  inner.className = 'inner';
  inner.innerHTML = candySVG(candy);
  el.appendChild(inner);
  candy.el = el;
  return el;
}

/* push model coords → CSS vars (transition animates the change) */
function setPos(candy, instant = false) {
  if (instant) candy.el.style.setProperty('--td', '0ms');
  candy.el.style.setProperty('--x', candy.col);
  candy.el.style.setProperty('--y', candy.row);
}

/* re-render a candy's art (used when it becomes a special) */
function renderCandy(candy) {
  candy.el.firstChild.innerHTML = candySVG(candy);
}

/* pixel metrics for the FX layer */
function cellPx() { return boardEl.clientWidth / N; }
function cellCenter(r, c) { const s = cellPx(); return { x: (c + .5) * s, y: (r + .5) * s }; }

/* recompute --cell on resize (transitions disabled briefly) */
function fitBoard() {
  candiesEl.classList.add('noanim');
  boardEl.style.setProperty('--cell', cellPx() + 'px');
  requestAnimationFrame(() => requestAnimationFrame(() => candiesEl.classList.remove('noanim')));
}

/* build the checkerboard background once */
(function buildCells() {
  let html = '';
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++)
      html += `<div class="cell${(r + c) % 2 ? ' alt' : ''}"></div>`;
  cellsEl.innerHTML = html;
})();

/* ============================================================
   5. BOARD GENERATION
   Fill randomly, rejecting any choice that completes an
   immediate 3-run, and guarantee at least one possible move.
   ============================================================ */
function buildBoard(animate = true) {
  candiesEl.innerHTML = '';
  grid = [];
  for (let r = 0; r < N; r++) {
    grid[r] = [];
    for (let c = 0; c < N; c++) {
      let color;
      do {
        color = rand(NUM_COLORS);
      } while (
        (c >= 2 && grid[r][c - 1].color === color && grid[r][c - 2].color === color) ||
        (r >= 2 && grid[r - 1][c].color === color && grid[r - 2][c].color === color)
      );
      const cd = newCandy(color);
      cd.row = r; cd.col = c;
      grid[r][c] = cd;
      const el = makeCandyEl(cd);
      setPos(cd, true);
      if (animate) {                       // cheerful staggered pop-in
        el.classList.add('spawning');
        el.firstChild.style.animationDelay = ((r + c) * 28) + 'ms';
      }
      candiesEl.appendChild(el);
    }
  }
  if (!findPossibleMove()) buildBoard(false);   // vanishingly rare, but guarantee playability
}

/* ============================================================
   6. MATCH DETECTION
   findMatches(): scan rows & columns for runs of 3+ equal
   colors. Color bombs have color === null so they never match.
   ============================================================ */
function findMatches() {
  const runs = [];
  const pushRun = (cells, dir, color) => runs.push({ cells, dir, len: cells.length, color });

  /* horizontal runs */
  for (let r = 0; r < N; r++) {
    let c = 0;
    while (c < N) {
      const cd = grid[r][c];
      if (!cd || cd.color === null || cd.clearing) { c++; continue; }
      let len = 1;
      while (c + len < N) {
        const nx = grid[r][c + len];
        if (!nx || nx.color !== cd.color || nx.clearing) break;
        len++;
      }
      if (len >= 3) {
        const cells = [];
        for (let i = 0; i < len; i++) cells.push({ r, c: c + i });
        pushRun(cells, 'h', cd.color);
      }
      c += len;
    }
  }

  /* vertical runs */
  for (let c = 0; c < N; c++) {
    let r = 0;
    while (r < N) {
      const cd = grid[r][c];
      if (!cd || cd.color === null || cd.clearing) { r++; continue; }
      let len = 1;
      while (r + len < N) {
        const nx = grid[r + len][c];
        if (!nx || nx.color !== cd.color || nx.clearing) break;
        len++;
      }
      if (len >= 3) {
        const cells = [];
        for (let i = 0; i < len; i++) cells.push({ r: r + i, c });
        pushRun(cells, 'v', cd.color);
      }
      r += len;
    }
  }
  return runs;
}

/* ------------------------------------------------------------
   analyzeMatches(runs, anchors)
   Decides which specials a set of runs creates:
     - a cell shared by a horizontal AND vertical run → WRAPPED
     - a straight run of 5+                            → COLOR BOMB
     - a straight run of 4                             → STRIPED
   `anchors` = cells the player just moved (preferred spots for
   the created special). Returns:
     clearKeys  — Set of cell keys to remove,
     creations  — list of {r, c, type, color} specials to spawn.
   ------------------------------------------------------------ */
function analyzeMatches(runs, anchors) {
  const clearKeys = new Set();
  const creations = [];
  const taken = new Set();   // cells that already received a special

  /* index runs by cell for intersection (T/L) detection */
  const inH = {}, inV = {};
  runs.forEach(run => run.cells.forEach(p => {
    (run.dir === 'h' ? inH : inV)[key(p.r, p.c)] = run;
  }));

  const pickSpot = (cells) => {
    /* prefer the cell the player actually moved into */
    for (const a of anchors) {
      const k = key(a.r, a.c);
      if (!taken.has(k) && cells.some(p => p.r === a.r && p.c === a.c)) return a;
    }
    for (let i = Math.floor(cells.length / 2); i < cells.length; i++)
      if (!taken.has(key(cells[i].r, cells[i].c))) return cells[i];
    return cells[0];
  };

  /* 1) T / L shapes → wrapped candy at the intersection cell */
  const crosses = [];
  for (const k in inH) if (inV[k]) crosses.push(+k);
  crosses.sort((a, b) => (inH[b].len + inV[b].len) - (inH[a].len + inV[a].len));
  for (const k of crosses) {
    if (taken.has(k)) continue;
    const { r, c } = unkey(k);
    taken.add(k);
    creations.push({ r, c, type: 'wrap', color: inH[k].color });
  }

  /* 2) straight 5+ → color bomb, 3) straight 4 → striped */
  for (const run of runs) {
    if (run.len >= 5) {
      const spot = pickSpot(run.cells);
      taken.add(key(spot.r, spot.c));
      creations.push({ r: spot.r, c: spot.c, type: 'bomb', color: null });
    } else if (run.len === 4) {
      const spot = pickSpot(run.cells);
      taken.add(key(spot.r, spot.c));
      /* stripes indicate which axis it clears: horizontal match → row blaster */
      creations.push({ r: spot.r, c: spot.c, type: run.dir === 'h' ? 'row' : 'col', color: run.color });
    }
  }

  /* everything matched is cleared, except cells that spawn a special */
  const creationCells = new Set(creations.map(cr => key(cr.r, cr.c)));
  runs.forEach(run => run.cells.forEach(p => {
    const k = key(p.r, p.c);
    if (!creationCells.has(k)) clearKeys.add(k);
  }));

  return { clearKeys, creations };
}

/* ============================================================
   7. SPECIAL-SWAP COMBOS
   Detected BEFORE normal match validation; combos always count
   as a legal move.
   ============================================================ */
const isStripe = cd => cd.special === 'row' || cd.special === 'col';

function comboType(a, b) {
  const sa = a.special, sb = b.special;
  if (sa === 'bomb' && sb === 'bomb') return 'bb';                 // bomb + bomb
  if (sa === 'bomb' || sb === 'bomb') {                            // bomb + anything
    const other = sa === 'bomb' ? b : a;
    if (!other.special) return 'bc';                               //  + plain candy
    if (isStripe(other)) return 'bs';                              //  + striped
    if (other.special === 'wrap') return 'bw';                     //  + wrapped
    return null;
  }
  if (isStripe(a) && isStripe(b)) return 'ss';                     // stripe + stripe
  if ((isStripe(a) && sb === 'wrap') || (sa === 'wrap' && isStripe(b))) return 'sw';
  if (sa === 'wrap' && sb === 'wrap') return 'ww';                 // wrap + wrap
  return null;
}

async function resolveSpecialCombo(type, A, B) {
  const set = new Set();
  const add = (r, c) => { if (inBounds(r, c)) set.add(key(r, c)); };
  const bomb = A.special === 'bomb' ? A : (B.special === 'bomb' ? B : null);
  const other = bomb ? (bomb === A ? B : A) : null;
  if (bomb) bomb.noChain = true;          // its effect is handled here, not re-chained
  if (other && other.special === 'bomb') other.noChain = true;
  const at = bomb ? { r: bomb.row, c: bomb.col } : { r: B.row, c: B.col };
  let msg = null, heavy = true;

  switch (type) {
    case 'bb':                                   /* clear the whole board */
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) add(r, c);
      msg = 'TOTAL CRUSH!'; Snd.bomb(); break;

    case 'bc': {                                 /* wipe every candy of one color */
      add(bomb.row, bomb.col); add(other.row, other.col);
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
        if (grid[r][c] && grid[r][c].color === other.color) { add(r, c); flashCell(r, c); }
      msg = 'COLOR BURST!'; Snd.bomb(); break;
    }

    case 'bs': {                                 /* every candy of that color becomes a stripe */
      add(bomb.row, bomb.col); add(other.row, other.col);
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const cd = grid[r][c];
        if (cd && cd.color === other.color) {
          cd.special = Math.random() < .5 ? 'row' : 'col';   // expansion loop fires them
          add(r, c); flashCell(r, c);
        }
      }
      msg = 'STRIPE STORM!'; Snd.bomb(); break;
    }

    case 'bw': {                                 /* color wipe + 3x3 blast */
      add(bomb.row, bomb.col); add(other.row, other.col);
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
        if (grid[r][c] && grid[r][c].color === other.color) add(r, c);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) add(at.r + dr, at.c + dc);
      msg = 'MEGA WRAP!'; Snd.bomb(); break;
    }

    case 'ss':                                   /* row + column cross */
      add(A.row, A.col); add(B.row, B.col);
      for (let c = 0; c < N; c++) add(at.r, c);
      for (let r = 0; r < N; r++) add(r, at.c);
      msg = 'LINE BLAST!'; Snd.boom(true); break;

    case 'sw':                                   /* 3 rows AND 3 columns */
      add(A.row, A.col); add(B.row, B.col);
      for (let dr = -1; dr <= 1; dr++) for (let c = 0; c < N; c++) add(at.r + dr, c);
      for (let dc = -1; dc <= 1; dc++) for (let r = 0; r < N; r++) add(r, at.c + dc);
      msg = 'CROSS BLAST!'; Snd.bomb(); break;

    case 'ww': {                                 /* huge 5x5 explosion */
      add(A.row, A.col); add(B.row, B.col);
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) add(at.r + dr, at.c + dc);
      msg = 'DOUBLE BLAST!'; Snd.boom(true); break;
    }
  }

  if (msg) showBanner(msg);
  if (heavy) shakeBoard(type === 'bb' || type === 'sw');
  await executeClear(set, 1, at);
}

/* ============================================================
   8. CLEAR RESOLUTION
   expandClears(): given the initial set, repeatedly trigger
   specials caught inside it (stripes add lines, wraps add a
   3x3, bombs wipe a random color) until nothing new is added —
   that's what produces chain reactions.
   ============================================================ */
function expandClears(set) {
  const arr = [...set];
  const fired = new Set();
  for (let i = 0; i < arr.length; i++) {
    const { r, c } = unkey(arr[i]);
    const cd = grid[r] && grid[r][c];
    if (!cd || cd.clearing || !cd.special || fired.has(cd.uid)) continue;
    fired.add(cd.uid);

    const add = (rr, cc) => {
      if (!inBounds(rr, cc)) return;
      const k = key(rr, cc);
      if (!set.has(k)) { set.add(k); arr.push(k); }
    };

    if (cd.special === 'row')      for (let cc = 0; cc < N; cc++) add(r, cc);
    else if (cd.special === 'col') for (let rr = 0; rr < N; rr++) add(rr, c);
    else if (cd.special === 'wrap')
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) add(r + dr, c + dc);
    else if (cd.special === 'bomb' && !cd.noChain) {
      /* chain-detonated bomb wipes all candies of a random color */
      const present = new Set();
      for (let rr = 0; rr < N; rr++) for (let cc = 0; cc < N; cc++)
        if (grid[rr][cc] && grid[rr][cc].color !== null) present.add(grid[rr][cc].color);
      const colors = [...present];
      if (!colors.length) continue;
      const pick = colors[rand(colors.length)];
      for (let rr = 0; rr < N; rr++) for (let cc = 0; cc < N; cc++)
        if (grid[rr][cc] && grid[rr][cc].color === pick) add(rr, cc);
    }
  }
  return arr;
}

/* resolve a plain match set (creates specials, then clears) */
async function resolveMatches(runs, anchors, combo = 1) {
  const { clearKeys, creations } = analyzeMatches(runs, anchors);

  /* transform anchor candies into their new special form */
  for (const cr of creations) {
    const cd = grid[cr.r][cr.c];
    if (!cd) continue;
    cd.special = cr.type;
    cd.color = cr.type === 'bomb' ? null : cr.color;
    renderCandy(cd);
    cd.el.classList.remove('transforming');
    void cd.el.offsetWidth;                  // restart the pop animation
    cd.el.classList.add('transforming');
    Snd.tone({ f: 880, d: .12, type: 'triangle', v: .18 });
    Snd.tone({ f: 1320, d: .15, type: 'triangle', v: .15, at: .08 });
  }

  const origin = creations.length ? { r: creations[0].r, c: creations[0].c }
    : (anchors[0] || { r: N / 2, c: N / 2 });
  await executeClear(clearKeys, combo, origin);
}

/* the shared clear pipeline: expand → score → animate → remove → gravity */
async function executeClear(set, combo, origin) {
  if (!set.size) { await applyGravity(); return; }
  const cells = [...set].map(unkey);

  /* specials caught in the blast fire their effects (chain reaction) */
  expandClears(set);
  const finalCells = [...set].map(unkey);

  /* ---- scoring ---- */
  let specialsHit = 0;
  finalCells.forEach(({ r, c }) => { const cd = grid[r][c]; if (cd && cd.special) specialsHit++; });
  const pts = finalCells.length * BASE_POINTS * combo + specialsHit * 150;
  addScore(pts);
  const avg = finalCells.reduce((a, p) => ({ r: a.r + p.r / finalCells.length, c: a.c + p.c / finalCells.length }), { r: 0, c: 0 });
  floatText(avg.r, avg.c, '+' + pts + (combo > 1 ? `  x${combo}` : ''));

  /* ---- sounds & screen feel ---- */
  const hasBomb = finalCells.some(({ r, c }) => grid[r][c] && grid[r][c].special === 'bomb');
  const hasSpecial = hasBomb || specialsHit > 0;
  if (hasBomb) Snd.bomb();
  else if (hasSpecial) Snd.boom(finalCells.length >= 14);
  else Snd.match(combo);
  if (finalCells.length >= 12 || hasSpecial) shakeBoard(hasBomb || finalCells.length >= 18);

  /* ---- mark candies clearing with a ripple delay from the blast origin ---- */
  let maxDelay = 0;
  for (const { r, c } of finalCells) {
    const cd = grid[r][c];
    if (!cd || cd.clearing) continue;
    cd.clearing = true;
    const d = (Math.abs(r - origin.r) + Math.abs(c - origin.c)) * 24 + rand(40);
    maxDelay = Math.max(maxDelay, d);
    cd.el.classList.add('clearing');
    cd.el.firstChild.style.transitionDelay = d + 'ms';
    popParticles(r, c, cd.special === 'bomb' ? '#ffe9c9' : CM[cd.color ?? rand(NUM_COLORS)].fx,
      cd.special ? 14 : 7);
    if (cd.special) ringFx(r, c);
  }

  await sleep(maxDelay + 300);

  /* ---- remove DOM nodes & free grid cells ---- */
  for (const { r, c } of finalCells) {
    const cd = grid[r] && grid[r][c];
    if (cd && cd.clearing) {
      cd.el.remove();
      grid[r][c] = null;
    }
  }

  await applyGravity();
}

/* ============================================================
   9. GRAVITY & RESPAWN
   Compact each column downward; spawn fresh candies above the
   board and let them drop in. One batched reflow keeps the
   whole fall on the compositor (pure CSS transform animation).
   ============================================================ */
async function applyGravity() {
  const movers = [];   // {cd, dist}
  const fresh = [];    // {cd, fromRow}

  for (let c = 0; c < N; c++) {
    /* survivors, bottom-up */
    const surv = [];
    for (let r = N - 1; r >= 0; r--) if (grid[r][c]) surv.push(grid[r][c]);
    const missing = N - surv.length;

    const colArr = new Array(N);
    let idx = N - 1;
    for (const cd of surv) {
      colArr[idx] = cd;
      const dist = idx - cd.row;
      cd.row = idx; cd.col = c;
      if (dist > 0) movers.push({ cd, dist });
      idx--;
    }
    /* spawn new candies for the empty slots at the top */
    for (; idx >= 0; idx--) {
      const cd = newCandy(rand(NUM_COLORS));
      cd.row = idx; cd.col = c;
      colArr[idx] = cd;
      fresh.push({ cd, fromRow: idx - missing });
      makeCandyEl(cd);
    }
    for (let r = 0; r < N; r++) grid[r][c] = colArr[r];
  }

  /* place newcomers above the board without animating */
  for (const { cd, fromRow } of fresh) {
    cd.el.style.setProperty('--td', '0ms');
    cd.el.style.setProperty('--x', cd.col);
    cd.el.style.setProperty('--y', fromRow);
    candiesEl.appendChild(cd.el);
  }

  /* one forced reflow so every start position is committed... */
  void boardEl.offsetWidth;

  /* ...then animate everyone to their destination */
  let maxDur = 0;
  for (const { cd, dist } of movers) {
    const dur = Math.min(620, 140 + 70 * dist);
    maxDur = Math.max(maxDur, dur);
    cd.el.style.setProperty('--td', dur + 'ms');
    setPos(cd);
  }
  for (const { cd, fromRow } of fresh) {
    const dist = cd.row - fromRow;
    const dur = Math.min(680, 160 + 70 * dist);
    maxDur = Math.max(maxDur, dur);
    cd.el.style.setProperty('--td', dur + 'ms');
    setPos(cd);
  }

  await sleep(maxDur + 50);
}

/* ============================================================
   10. POSSIBLE MOVES, HINTS, SHUFFLE
   ============================================================ */

/* would swapping these two cells create a match? (local check) */
function matchesAt(r, c) {
  const cd = grid[r][c];
  if (!cd || cd.color === null) return false;
  let h = 1;
  for (let cc = c - 1; cc >= 0 && grid[r][cc] && grid[r][cc].color === cd.color; cc--) h++;
  for (let cc = c + 1; cc < N && grid[r][cc] && grid[r][cc].color === cd.color; cc++) h++;
  if (h >= 3) return true;
  let v = 1;
  for (let rr = r - 1; rr >= 0 && grid[rr][c] && grid[rr][c].color === cd.color; rr--) v++;
  for (let rr = r + 1; rr < N && grid[rr][c] && grid[rr][c].color === cd.color; rr++) v++;
  return v >= 3;
}

/* scan for any legal move; with wantPair, return the move for hints */
function findPossibleMove(wantPair = false) {
  const dirs = [[0, 1], [1, 0]];
  const cells = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cells.push({ r, c });
  /* random scan order keeps hints varied */
  for (let i = cells.length - 1; i > 0; i--) { const j = rand(i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }

  for (const { r, c } of cells) {
    for (const [dr, dc] of dirs) {
      const r2 = r + dr, c2 = c + dc;
      if (!inBounds(r2, c2)) continue;
      const a = grid[r][c], b = grid[r2][c2];
      if (!a || !b) continue;
      if (a.special === 'bomb' || b.special === 'bomb')           // bomb swaps always legal
        return wantPair ? [{ r, c }, { r: r2, c: c2 }] : true;
      if (a.special && b.special)                                  // special combos always legal
        return wantPair ? [{ r, c }, { r: r2, c: c2 }] : true;
      /* plain swap — try it, look, revert */
      grid[r][c] = b; grid[r2][c2] = a;
      const ok = matchesAt(r, c) || matchesAt(r2, c2);
      grid[r][c] = a; grid[r2][c2] = b;
      if (ok) return wantPair ? [{ r, c }, { r: r2, c: c2 }] : true;
    }
  }
  return wantPair ? null : false;
}

/* ---- hint system: pulse a suggested move after inactivity ---- */
let hintTimer = null, hintEls = [];

function clearHint() {
  hintEls.forEach(el => el.classList.remove('hint'));
  hintEls = [];
}
function scheduleHint() {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(showHint, HINT_DELAY);
}
function showHint() {
  if (state.busy || state.paused || state.over) return;
  clearHint();
  const pair = findPossibleMove(true);
  if (!pair) return;
  pair.forEach(({ r, c }) => {
    const cd = grid[r][c];
    if (cd) { cd.el.classList.add('hint'); hintEls.push(cd.el); }
  });
  Snd.tone({ f: 980, d: .1, type: 'sine', v: .08 });
}

/* ---- shuffle: full regenerate with a spin (guarantees a valid board) ---- */
async function shuffleBoard(manual = false) {
  if (state.busy && manual) return;
  state.busy = true;
  clearHint();
  toast(manual ? 'Shuffling… 🔀' : 'No moves left — shuffling! 🔀');
  Snd.shuffle();
  boardEl.classList.add('spinning');
  await sleep(480);
  buildBoard(true);
  fitBoard();
  boardEl.classList.remove('spinning');
  await sleep(400);
}

/* ============================================================
   11. INPUT — pointer events (mouse + touch unified)
   - tap a candy, then tap an adjacent candy, OR
   - press and drag a candy toward a neighbor.
   ============================================================ */
let selected = null;                 // {r, c} of the tapped candy
let drag = null;                     // active press info

function candyFromEvent(e) {
  const el = e.target.closest && e.target.closest('.candy');
  if (!el) return null;
  /* find which model candy owns this element */
  const x = parseFloat(el.style.getPropertyValue('--x'));
  const y = parseFloat(el.style.getPropertyValue('--y'));
  const c = Math.round(x), r = Math.round(y);
  if (!inBounds(r, c)) return null;
  return { r, c };
}

function deselect() {
  if (selected) {
    const cd = grid[selected.r] && grid[selected.r][selected.c];
    if (cd) cd.el.classList.remove('selected');
    selected = null;
  }
}

candiesEl.addEventListener('pointerdown', e => {
  if (state.busy || state.paused || state.over) return;
  Snd.ensure();                                    // unlock audio on first gesture
  clearHint(); scheduleHint();
  const pos = candyFromEvent(e);
  if (!pos) return;
  const cd = grid[pos.r][pos.c];
  if (!cd) return;
  e.preventDefault();
  drag = { ...pos, x: e.clientX, y: e.clientY, moved: false };
});

window.addEventListener('pointermove', e => {
  if (!drag || state.busy || state.paused || state.over) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  const threshold = cellPx() * 0.38;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;
  /* dominant axis decides the swap direction */
  const dir = Math.abs(dx) > Math.abs(dy)
    ? { dr: 0, dc: dx > 0 ? 1 : -1 }
    : { dr: dy > 0 ? 1 : -1, dc: 0 };
  const from = { r: drag.r, c: drag.c };
  const to = { r: drag.r + dir.dr, c: drag.c + dir.dc };
  drag = null;
  deselect();
  if (inBounds(to.r, to.c)) trySwap(from, to);
});

window.addEventListener('pointerup', e => {
  if (!drag) return;
  const pos = { r: drag.r, c: drag.c };
  drag = null;
  if (state.busy || state.paused || state.over) return;
  const cd = grid[pos.r][pos.c];
  if (!cd) return;

  /* tap-tap swapping */
  if (selected) {
    const adjacent = Math.abs(selected.r - pos.r) + Math.abs(selected.c - pos.c) === 1;
    if (adjacent) { const from = selected; deselect(); trySwap(from, pos); return; }
    deselect();
  }
  if (selected === null || !selected || selected.r !== pos.r || selected.c !== pos.c) {
    selected = pos;
    cd.el.classList.add('selected');
    Snd.click();
  }
});

/* pointer cancel (e.g. touch stolen by the OS) */
window.addEventListener('pointercancel', () => { drag = null; });

/* ============================================================
   12. TURN FLOW & CASCADES
   ============================================================ */
async function trySwap(from, to) {
  if (state.busy) return;
  const A = grid[from.r][from.c], B = grid[to.r][to.c];
  if (!A || !B) return;
  state.busy = true;
  clearHint();

  const combo = comboType(A, B);           // special combos are always legal

  /* swap in the model + animate */
  grid[from.r][from.c] = B; grid[to.r][to.c] = A;
  A.row = to.r; A.col = to.c; B.row = from.r; B.col = from.c;
  A.el.style.setProperty('--td', '240ms'); B.el.style.setProperty('--td', '240ms');
  setPos(A); setPos(B);
  Snd.swap();
  await sleep(260);

  if (combo) {
    consumeMove();
    await resolveSpecialCombo(combo, A, B);
    await cascade(1);
    await endTurn();
    return;
  }

  const runs = findMatches();
  if (!runs.length) {                      // illegal → swap back
    grid[from.r][from.c] = A; grid[to.r][to.c] = B;
    A.row = from.r; A.col = from.c; B.row = to.r; B.col = to.c;
    setPos(A); setPos(B);
    Snd.invalid();
    await sleep(260);
    state.busy = false;
    scheduleHint();
    return;
  }

  consumeMove();
  /* anchors: prefer the destination cell for spawning specials */
  await resolveMatches(runs, [{ r: A.row, c: A.col }, { r: B.row, c: B.col }], 1);
  await cascade(1);
  await endTurn();
}

/* resolve subsequent automatic matches (combo chains) */
const COMBO_WORDS = ['', '', 'Sweet! 🍬', 'Tasty! 🍭', 'Delicious! 🧁', 'Divine! 🍩'];
async function cascade(combo) {
  let runs = findMatches();
  while (runs.length) {
    combo++;
    showBanner(COMBO_WORDS[Math.min(combo, COMBO_WORDS.length - 1)]);
    await resolveMatches(runs, [], combo);
    runs = findMatches();
  }
}

/* after a player turn settles: win/lose checks, no-move shuffle */
async function endTurn() {
  updateHUD();
  if (state.score >= state.target) { victory(); return; }
  if (state.moves <= 0) { gameOver(); return; }
  if (!findPossibleMove()) await shuffleBoard(false);
  state.busy = false;
  scheduleHint();
}

function consumeMove() {
  state.moves--;
  updateHUD();
}

/* ============================================================
   13. GAME STATE / LEVELS / WIN & LOSE
   ============================================================ */
function startLevel(lvl) {
  state.level = lvl;
  state.score = 0; state.displayedScore = 0;
  state.target = targetFor(lvl);
  state.moves = START_MOVES;
  state.over = false; state.paused = false;
  levelEl.textContent = lvl;
  targetEl.textContent = state.target.toLocaleString();
  scoreEl.textContent = '0';
  progressEl.style.width = '0%';
  updateHUD();
  hideOverlays();
  buildBoard(true);
  fitBoard();
  state.busy = false;
  scheduleHint();
}

function victory() {
  state.over = true; state.busy = true;
  clearTimeout(hintTimer); clearHint();
  const bonus = state.moves * 100;                 // leftover-move bonus
  if (bonus > 0) {
    addScore(bonus);
    $('winBonus').textContent = `+${bonus.toLocaleString()} bonus for ${state.moves} leftover moves!`;
  } else $('winBonus').textContent = '';
  updateBest();
  $('winScore').textContent = state.displayedScore.toLocaleString();

  /* 1–3 stars based on how far past the target we got */
  const s = state.score;
  const stars = [s >= state.target, s >= state.target * 1.5, s >= state.target * 2];
  [...$('winStars').children].forEach((el, i) => {
    el.textContent = stars[i] ? '★' : '☆';
    el.classList.toggle('dim', !stars[i]);
  });

  Snd.win();
  setTimeout(() => { $('ovWin').classList.remove('hidden'); confetti(); }, 500);
}

function gameOver() {
  state.over = true; state.busy = true;
  clearTimeout(hintTimer); clearHint();
  updateBest();
  $('loseScore').textContent = state.score.toLocaleString();
  $('loseTarget').textContent = state.target.toLocaleString();
  $('loseBest').textContent = state.best.toLocaleString();
  Snd.lose();
  setTimeout(() => $('ovLose').classList.remove('hidden'), 500);
}

function updateBest() {
  if (state.score > state.best) {
    state.best = state.score;
    localStorage.setItem('cc_best', String(state.best));
  }
}

function addScore(pts) {
  state.score += pts;
  /* animated number counting */
  const from = state.displayedScore, to = state.score, t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / 450);
    state.displayedScore = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    scoreEl.textContent = state.displayedScore.toLocaleString();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  progressEl.style.width = Math.min(100, (to / state.target) * 100) + '%';
}

function updateHUD() {
  movesEl.textContent = state.moves;
  movesBox.classList.toggle('low', state.moves <= 5 && !state.over);
}

function hideOverlays() {
  ['ovStart', 'ovPause', 'ovWin', 'ovLose'].forEach(id => $(id).classList.add('hidden'));
}

/* ============================================================
   FX helpers — particles, floating score text, rings, banner
   ============================================================ */
function popParticles(r, c, color, count = 8) {
  const { x, y } = cellCenter(r, c);
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = x + 'px'; p.style.top = y + 'px';
    p.style.background = color; p.style.color = color;
    fxEl.appendChild(p);
    const ang = Math.random() * Math.PI * 2;
    const dist = 24 + Math.random() * 58;
    p.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px)) scale(.1)`, opacity: 0 },
    ], { duration: 380 + Math.random() * 300, easing: 'cubic-bezier(.1,.8,.3,1)' })
      .onfinish = () => p.remove();
  }
}

function floatText(r, c, text) {
  const { x, y } = cellCenter(r, c);
  const t = document.createElement('div');
  t.className = 'fx-float';
  t.textContent = text;
  t.style.left = x + 'px'; t.style.top = y + 'px';
  fxEl.appendChild(t);
  t.animate([
    { transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 },
    { transform: 'translate(-50%,-90%) scale(1.1)', opacity: 1, offset: .3 },
    { transform: 'translate(-50%,-190%) scale(1)', opacity: 0 },
  ], { duration: 950, easing: 'ease-out' }).onfinish = () => t.remove();
}

function ringFx(r, c) {
  const { x, y } = cellCenter(r, c);
  const ring = document.createElement('div');
  ring.className = 'fx-ring';
  ring.style.left = x + 'px'; ring.style.top = y + 'px';
  fxEl.appendChild(ring);
  setTimeout(() => ring.remove(), 550);
}

/* brief white flash on a cell (used by bomb conversions) */
function flashCell(r, c) { ringFx(r, c); }

let bannerTimer = null;
function showBanner(text) {
  bannerEl.textContent = text;
  bannerEl.classList.remove('hidden');
  bannerEl.style.animation = 'none';
  void bannerEl.offsetWidth;
  bannerEl.style.animation = '';
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.add('hidden'), 950);
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 1600);
}

function shakeBoard(big = false) {
  const cls = big ? 'shake-big' : 'shake';
  boardEl.classList.remove('shake', 'shake-big');
  void boardEl.offsetWidth;
  boardEl.classList.add(cls);
  setTimeout(() => boardEl.classList.remove(cls), big ? 520 : 380);
}

/* celebration confetti over the whole screen on victory */
function confetti() {
  const colors = CM.map(m => m.fx).concat('#fff', '#ffe066');
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.position = 'fixed';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.top = '-12px';
    p.style.background = colors[rand(colors.length)];
    p.style.color = p.style.background;
    p.style.borderRadius = Math.random() < .5 ? '50%' : '3px';
    p.style.zIndex = 60;
    document.body.appendChild(p);
    p.animate([
      { transform: 'translateY(0) rotate(0)', opacity: 1 },
      { transform: `translateY(${110 + Math.random() * 30}vh) rotate(${rand(720) - 360}deg)`, opacity: .6 },
    ], { duration: 1800 + Math.random() * 1400, easing: 'cubic-bezier(.3,.6,.6,1)', delay: Math.random() * 500 })
      .onfinish = () => p.remove();
  }
}

/* ============================================================
   14. HUD & OVERLAY WIRING
   ============================================================ */
function setPaused(v) {
  if (state.over) return;
  if (v && state.busy) return;   /* never pause mid-cascade; wait for the turn to settle */
  state.paused = v;
  $('ovPause').classList.toggle('hidden', !v);
  if (v) { clearTimeout(hintTimer); clearHint(); deselect(); }
  else scheduleHint();
  Snd.click();
}

$('playBtn').addEventListener('click', () => { Snd.ensure(); Snd.click(); startLevel(1); });
$('pauseBtn').addEventListener('click', () => { if (!state.over) setPaused(true); });
$('resumeBtn').addEventListener('click', () => setPaused(false));
$('restartBtn').addEventListener('click', () => { if (!state.busy || state.over) { Snd.click(); startLevel(state.level); } });
$('restartBtn2').addEventListener('click', () => { Snd.click(); startLevel(state.level); });
$('retryBtn').addEventListener('click', () => { Snd.click(); startLevel(state.level); });
$('replayBtn').addEventListener('click', () => { Snd.click(); startLevel(state.level); });
$('nextBtn').addEventListener('click', () => { Snd.click(); startLevel(state.level + 1); });
$('hintBtn').addEventListener('click', () => { if (!state.busy && !state.paused && !state.over) { Snd.click(); showHint(); scheduleHint(); } });
$('shuffleBtn').addEventListener('click', async () => {
  if (state.busy || state.paused || state.over) return;
  Snd.click();
  await shuffleBoard(true);
  state.busy = false;
  scheduleHint();
});
$('muteBtn').addEventListener('click', () => {
  Snd.muted = !Snd.muted;
  localStorage.setItem('cc_muted', Snd.muted ? '1' : '0');
  $('muteIco').textContent = Snd.muted ? '🔇' : '🔊';
  $('muteBtn').classList.toggle('off', Snd.muted);
  if (!Snd.muted) Snd.click();
});

/* keyboard shortcuts */
window.addEventListener('keydown', e => {
  if (e.key === 'p' || e.key === 'P') setPaused(!state.paused);
  if (e.key === 'm' || e.key === 'M') $('muteBtn').click();
  if (e.key === 'h' || e.key === 'H') $('hintBtn').click();
});

window.addEventListener('resize', fitBoard);

/* ============================================================
   15. BOOT
   ============================================================ */
$('muteIco').textContent = Snd.muted ? '🔇' : '🔊';
$('muteBtn').classList.toggle('off', Snd.muted);
targetEl.textContent = state.target.toLocaleString();
movesEl.textContent = START_MOVES;
buildBoard(false);          // prefilled board visible behind the start card
fitBoard();
