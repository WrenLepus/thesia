document.addEventListener('DOMContentLoaded', () => {
  // ---- Mode switching ----
  const modeButtons = document.querySelectorAll('.mode-btn[data-mode]');
  const createPanel = document.getElementById('createPanel');
  const gamePanel = document.getElementById('gamePanel');
  const soundbankStatus = document.getElementById('soundbankStatus');
  const modeSubtitle = document.getElementById('modeSubtitle');
  const modeSwitch = document.querySelector('.mode-switch');
  const gameHeaderTitle = document.getElementById('gameHeaderTitle');
  const gameTimer = document.getElementById('gameTimer');

  function setGameHeader(isInRoom) {
    // A charades turn reuses the creation canvas, but it remains a game.
    // Hiding the switch prevents an accidental exit from an active room.
    if (modeSwitch) modeSwitch.hidden = isInRoom;
    if (gameHeaderTitle) gameHeaderTitle.hidden = !isInRoom;
    if (gameTimer) gameTimer.hidden = !isInRoom;
    document.body.classList.toggle('in-game', isInRoom);
    if (!isInRoom) document.body.removeAttribute('data-game-tool');
  }

  function setMode(mode) {
    document.body.setAttribute('data-mode', mode);
    modeButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
    createPanel.hidden = mode !== 'create';
    gamePanel.hidden = mode !== 'game';
    if (modeSubtitle) modeSubtitle.textContent = mode === 'game' ? 'Game mode' : 'Create mode';
    // Make sure the canvas resizes after the layout reflow when we switch back to Create mode.
    if (mode === 'create') requestAnimationFrame(resizeCanvas);
  }

  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // ---- Fallback synth map (used while the SF2 soundbank loads or if it fails) ----
  const FALLBACK_INSTRUMENTS = {
    '#E81B1B': { name: 'Violin', emoji: '🎻', type: 'sawtooth',  attack: 0.05, decay: 0.10, sustain: 0.60, release: 0.40 },
    '#F39C12': { name: 'Trumpet', emoji: '🎺', type: 'square',    attack: 0.02, decay: 0.10, sustain: 0.70, release: 0.30 },
    '#F1C40F': { name: 'Piano', emoji: '🎹', type: 'triangle',  attack: 0.005, decay: 0.20, sustain: 0.10, release: 0.30 },
    '#2ECC71': { name: 'Flute', emoji: '🪈', type: 'sine',      attack: 0.05, decay: 0.10, sustain: 0.60, release: 0.30 },
    '#1ABC9C': { name: 'Harp', emoji: '🎵', type: 'triangle',  attack: 0.005, decay: 0.30, sustain: 0.10, release: 0.60 },
    '#3498DB': { name: 'Cello', emoji: '🎻', type: 'sawtooth',  attack: 0.08, decay: 0.15, sustain: 0.70, release: 0.50 },
    '#9B59B6': { name: 'Clarinet', emoji: '🎷', type: 'square',    attack: 0.05, decay: 0.10, sustain: 0.60, release: 0.30 },
    '#E91E63': { name: 'Synth', emoji: '🎛️', type: 'sawtooth',  attack: 0.01, decay: 0.10, sustain: 0.50, release: 0.40 }
  };

  const PALETTE_COLORS = Object.keys(FALLBACK_INSTRUMENTS);

  // Keep these colours on the fallback synth even when the SF2 soundbank loads.
  const FORCE_SYNTH_COLORS = new Set();

  // ---- Soundbank state ----
  let soundbankManifest = null;
  const soundbankBuffers = {};
  let soundbankReady = false;

  // ---- Create tools: Draw / ASCII toggle ----
  const toolButtons = document.querySelectorAll('.tool-btn[data-tool]');
  const canvas = document.getElementById('drawCanvas');
  const asciiInput = document.getElementById('asciiInput');
  const asciiArea = document.getElementById('asciiArea');
  const symbolMappingsEl = document.getElementById('symbolMappings');
  const doneAsciiBtn = document.getElementById('doneAsciiBtn');
  const sideControls = document.querySelector('.side-controls');
  const guideToggle = document.getElementById('guideToggle');
  const eraserBtn = document.getElementById('eraserBtn');
  let currentTool = 'draw';
  let showGuideLines = false;
  let drawMode = 'pen';

  function setTool(tool) {
    currentTool = tool;
    document.body.setAttribute('data-tool', tool);
    toolButtons.forEach(btn => {
      const active = btn.dataset.tool === tool;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    asciiInput.hidden = tool !== 'ascii';
    sideControls.hidden = false;

    // In a multiplayer game, only the drawer can edit the canvas/ASCII.
    const canEdit = !roomCode || amDrawing;
    if (asciiArea) asciiArea.disabled = !canEdit;
    if (doneAsciiBtn) doneAsciiBtn.disabled = !canEdit;

    if (tool === 'draw') {
      resizeCanvas();
    } else if (tool === 'ascii') {
      resizeCanvas();
      analyzeASCII();
      renderASCII();
    }
    redraw(lineX);
  }

  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  if (guideToggle) {
    guideToggle.addEventListener('change', () => {
      showGuideLines = guideToggle.checked;
      redraw(lineX);
    });
  }

  // ---- Canvas setup ----
  const ctx = canvas.getContext('2d');
  const keyboardWidth = 72; // CSS pixels reserved for the piano keyboard (left side)
  const whiteKeyCount = 15; // 2 octaves C4 -> C6 inclusive
  let strokes = [];
  let currentStroke = null;
  let drawing = false;
  let currentColor = '#E81B1B';
  let currentInstrument = FALLBACK_INSTRUMENTS[currentColor];
  let lineWidth = 3;

  // ---- Colour swatches + tooltips ----
  const swatches = document.querySelectorAll('.swatch[data-color]');
  function updateSwatchTitles() {
    swatches.forEach(swatch => {
      const color = swatch.dataset.color;
      const sb = FORCE_SYNTH_COLORS.has(color) ? null : soundbankManifest?.instruments[color];
      const fb = FALLBACK_INSTRUMENTS[color];
      const inst = sb || fb;
      if (inst) {
        const emoji = inst.emoji || '●';
        swatch.title = `${emoji} ${inst.name}${soundbankReady && !FORCE_SYNTH_COLORS.has(color) ? ' (SF2)' : ''}`;
      }
    });
  }

  swatches.forEach(swatch => {
    swatch.addEventListener('click', () => {
      currentColor = swatch.dataset.color;
      currentInstrument = FALLBACK_INSTRUMENTS[currentColor] || currentInstrument;
      ctx.strokeStyle = currentColor;
      setDrawMode('pen');
    });
  });

  if (eraserBtn) {
    eraserBtn.addEventListener('click', () => setDrawMode('eraser'));
  }

  const ERASER_CURSOR = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='21' height='21'%3E%3Ccircle cx='10.5' cy='10.5' r='10' fill='none' stroke='%232A211F' stroke-width='1.5' opacity='0.7'/%3E%3C/svg%3E\") 10 10, auto";

  function setDrawMode(mode) {
    drawMode = mode;
    if (canvas) canvas.style.cursor = mode === 'eraser' ? ERASER_CURSOR : 'crosshair';
    if (eraserBtn) {
      eraserBtn.classList.toggle('active', mode === 'eraser');
      eraserBtn.setAttribute('aria-pressed', mode === 'eraser' ? 'true' : 'false');
    }
    swatches.forEach(s => s.classList.toggle('active', mode === 'pen' && s.dataset.color === currentColor));
  }

  const ERASE_RADIUS = 10;
  const ERASE_DIAMETER = ERASE_RADIUS * 2;
  const CANVAS_BG = '#F4ECD9';
  let erasePath = [];
  let lastErasePos = null;

  function paintEraseCircle(x, y) {
    ctx.save();
    ctx.fillStyle = CANVAS_BG;
    ctx.beginPath();
    ctx.arc(x, y, ERASE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function paintEraseLine(x0, y0, x1, y1) {
    ctx.save();
    ctx.strokeStyle = CANVAS_BG;
    ctx.lineWidth = ERASE_DIAMETER;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  }

  function commitErase() {
    const RADIUS = ERASE_RADIUS;
    const RADIUS_SQ = RADIUS * RADIUS;
    const CELL = RADIUS;

    // Spatial grid of sampled erase points for fast neighbour lookups.
    const cells = new Map();
    function addPoint(x, y) {
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      const key = `${cx},${cy}`;
      const list = cells.get(key);
      if (list) list.push({ x, y });
      else cells.set(key, [{ x, y }]);
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < erasePath.length; i++) {
      const p = erasePath[i];
      addPoint(p.x, p.y);
      minX = Math.min(minX, p.x - RADIUS);
      maxX = Math.max(maxX, p.x + RADIUS);
      minY = Math.min(minY, p.y - RADIUS);
      maxY = Math.max(maxY, p.y + RADIUS);
      if (i === 0) continue;
      const p0 = erasePath[i - 1];
      const p1 = p;
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(dist / 3));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        addPoint(p0.x + dx * t, p0.y + dy * t);
      }
    }

    function isInside(x, y) {
      const cx = Math.floor(x / CELL);
      const cy = Math.floor(y / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = cells.get(`${cx + dx},${cy + dy}`);
          if (!list) continue;
          for (const ep of list) {
            const ex = x - ep.x;
            const ey = y - ep.y;
            if (ex * ex + ey * ey <= RADIUS_SQ) return true;
          }
        }
      }
      return false;
    }

    const newStrokes = [];
    for (const stroke of strokes) {
      if (stroke === currentStroke) {
        newStrokes.push(stroke);
        continue;
      }
      // Quick bbox reject.
      if (stroke.maxX < minX || stroke.minX > maxX) {
        newStrokes.push(stroke);
        continue;
      }
      let piece = null;
      const pieces = [];
      for (const p of stroke.points) {
        const inside = p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY && isInside(p.x, p.y);
        if (!inside) {
          if (!piece) {
            piece = { color: stroke.color, points: [], minX: p.x, maxX: p.x };
            pieces.push(piece);
          }
          piece.points.push(p);
          piece.minX = Math.min(piece.minX, p.x);
          piece.maxX = Math.max(piece.maxX, p.x);
        } else {
          piece = null;
        }
      }
      for (const piece of pieces) {
        if (piece.points.length >= 2) {
          buildStrokeSegments(piece);
          newStrokes.push(piece);
        }
      }
    }

    strokes = newStrokes;
    erasePath = [];
    lastErasePos = null;
    redraw(lineX);
  }

  let keys = [];
  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;

  // ---- ASCII state ----
  let asciiMarks = [];
  let asciiRuns = [];
  let asciiRowCount = 1;
  let asciiMaxCol = 0;
  let asciiCharWidth = 0;
  const asciiSymbolMap = {};
  const asciiPlayedRuns = new Set();
  const activeKeys = new Map(); // semitone -> { color, until }

  // ---- Playback state ----
  let isPlaying = false;
  let lineX = keyboardWidth;
  let prevLineX = keyboardWidth - 1;
  let lastTs = null;

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.round(rect.width);
    const cssHeight = Math.round(rect.height);

    // Guard against zero-size layout passes and redundant resizes
    if (cssWidth === 0 || cssHeight === 0) return;
    if (cssWidth === lastCanvasWidth && cssHeight === lastCanvasHeight) return;

    lastCanvasWidth = cssWidth;
    lastCanvasHeight = cssHeight;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = lineWidth;
    buildKeys();
    renderASCII();
    redraw(lineX);
  }

  function initCanvas() {
    if (canvas.hidden) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      resizeCanvas();
    } else {
      requestAnimationFrame(initCanvas);
    }
  }
  initCanvas();
  window.addEventListener('resize', () => {
    if (!canvas.hidden) resizeCanvas();
  });

  // ---- Piano keyboard model (2 octaves C6 top -> C4 bottom) ----
  function buildKeys() {
    keys = [];
    const height = canvas.clientHeight;
    const whiteKeyHeight = height / whiteKeyCount;
    const blackKeyHeight = whiteKeyHeight * 0.62;
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const blackSet = new Set(['C#', 'D#', 'F#', 'G#', 'A#']);

    let whiteIndex = 0;
    for (let semitone = 24; semitone >= 0; semitone--) {
      const name = noteNames[semitone % 12];
      const type = blackSet.has(name) ? 'black' : 'white';

      if (type === 'white') {
        const top = whiteIndex * whiteKeyHeight;
        const bottom = (whiteIndex + 1) * whiteKeyHeight;
        keys.push({ semitone, type: 'white', top, bottom, center: (top + bottom) / 2 });
        whiteIndex++;
      } else {
        const center = whiteIndex * whiteKeyHeight;
        keys.push({ semitone, type: 'black', top: center - blackKeyHeight / 2, bottom: center + blackKeyHeight / 2, center });
      }
    }
  }

  function yToSemitone(y) {
    for (const key of keys) {
      if (key.type === 'black' && y >= key.top && y <= key.bottom) {
        return key.semitone;
      }
    }

    const height = canvas.clientHeight;
    const whiteKeyHeight = height / whiteKeyCount;
    let whiteIndex = Math.floor(y / whiteKeyHeight);
    if (whiteIndex < 0) whiteIndex = 0;
    if (whiteIndex > whiteKeyCount - 1) whiteIndex = whiteKeyCount - 1;

    let seen = 0;
    for (const key of keys) {
      if (key.type === 'white') {
        if (seen === whiteIndex) return key.semitone;
        seen++;
      }
    }
    return keys[keys.length - 1].semitone;
  }

  function buildStrokeSegments(stroke) {
    if (!stroke || stroke.points.length < 2) {
      if (stroke) stroke.segments = [];
      return;
    }
    const sorted = [...stroke.points].sort((a, b) => a.x - b.x);
    const segments = [];
    let current = {
      semitone: yToSemitone(sorted[0].y),
      minX: sorted[0].x,
      maxX: sorted[0].x
    };
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i];
      const semitone = yToSemitone(p.y);
      if (semitone === current.semitone) {
        current.maxX = p.x;
      } else {
        segments.push(current);
        current = { semitone, minX: p.x, maxX: p.x };
      }
    }
    segments.push(current);
    stroke.segments = segments;
  }

  // ---- Drawing (only on the right of the keyboard) ----
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function startDraw(e) {
    if (currentTool !== 'draw') return;
    // In a game, only the current drawer may draw.
    if (roomCode && !amDrawing) return;
    const { x, y } = getPos(e);
    if (x < keyboardWidth) return;

    drawing = true;
    if (drawMode === 'eraser') {
      erasePath = [{ x, y }];
      lastErasePos = { x, y };
      paintEraseCircle(x, y);
      return;
    }

    currentStroke = { color: currentColor, points: [], minX: x, maxX: x };
    strokes.push(currentStroke);
    currentStroke.points.push({ x, y });

    ctx.strokeStyle = currentColor;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function moveDraw(e) {
    if (!drawing || currentTool !== 'draw') return;
    // In a game, only the current drawer may draw.
    if (roomCode && !amDrawing) return;
    e.preventDefault();
    const { x, y } = getPos(e);
    if (x < keyboardWidth) {
      endDraw();
      return;
    }

    if (drawMode === 'eraser') {
      if (!lastErasePos) lastErasePos = { x, y };
      paintEraseLine(lastErasePos.x, lastErasePos.y, x, y);
      erasePath.push({ x, y });
      lastErasePos = { x, y };
      return;
    }

    currentStroke.points.push({ x, y });
    currentStroke.minX = Math.min(currentStroke.minX, x);
    currentStroke.maxX = Math.max(currentStroke.maxX, x);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function endDraw() {
    drawing = false;
    if (erasePath.length > 0) {
      commitErase();
      return;
    }
    if (currentStroke) {
      buildStrokeSegments(currentStroke);
    }
    currentStroke = null;
    ctx.beginPath();
  }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', moveDraw);
  window.addEventListener('mouseup', endDraw);

  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', moveDraw, { passive: false });
  window.addEventListener('touchend', endDraw);

  // ---- Rendering ----
  function drawKeyboard() {
    const height = canvas.clientHeight;
    const whiteKeyHeight = height / whiteKeyCount;

    ctx.fillStyle = '#E8E0D2';
    ctx.fillRect(0, 0, keyboardWidth, height);

    ctx.strokeStyle = '#8B7E6A';
    ctx.lineWidth = 1;
    for (let i = 0; i < whiteKeyCount; i++) {
      const y = i * whiteKeyHeight;
      let semitone = null;
      let seen = 0;
      for (const key of keys) {
        if (key.type === 'white') {
          if (seen === i) { semitone = key.semitone; break; }
          seen++;
        }
      }
      const active = activeKeys.get(semitone);
      ctx.fillStyle = active ? active.color : '#FFFCF5';
      ctx.fillRect(0, y, keyboardWidth, whiteKeyHeight);
      ctx.strokeRect(0, y, keyboardWidth, whiteKeyHeight);
    }

    const blackKeyHeight = whiteKeyHeight * 0.62;
    for (const key of keys) {
      if (key.type === 'black') {
        const active = activeKeys.get(key.semitone);
        ctx.fillStyle = active ? active.color : '#1a1a1a';
        // Draw the black key at its original visual size; the larger hit zone is invisible.
        ctx.fillRect(0, key.center - blackKeyHeight / 2, keyboardWidth * 0.62, blackKeyHeight);
      }
    }

    ctx.fillStyle = '#5A4F45';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const key of keys) {
      if (key.type === 'white') {
        const octave = Math.floor(key.semitone / 12) + 4;
        const name = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][key.semitone % 12];
        if (name === 'C') {
          ctx.fillText(`C${octave}`, keyboardWidth - 6, key.center);
        }
      }
    }

    ctx.strokeStyle = '#8B7E6A';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(keyboardWidth, 0);
    ctx.lineTo(keyboardWidth, height);
    ctx.stroke();
  }

  function drawStrokes() {
    for (const stroke of strokes) {
      if (stroke.points.length < 2) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = lineWidth;
  }

  function drawAsciiMarks() {
    if (!asciiMarks.length) return;
    const rowHeight = canvas.clientHeight / Math.max(1, asciiRowCount);
    const charW = asciiCharWidth;

    for (const mark of asciiMarks) {
      const x = keyboardWidth + mark.col * charW + charW / 2;
      const y = mark.row * rowHeight + rowHeight / 2;
      const color = getSymbolColor(mark.char);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, charW * 0.18), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2A211F';
      ctx.font = `bold ${Math.max(8, Math.min(14, charW * 0.5))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(mark.char, x, y);
    }
  }

  function drawGuideLines() {
    if (!showGuideLines || keys.length === 0) return;
    const height = canvas.clientHeight;
    const width = canvas.clientWidth;
    ctx.save();
    ctx.strokeStyle = 'rgba(43, 31, 28, 0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    for (const key of keys) {
      if (key.type === 'white') {
        // Half-step boundaries with no black key between them: B-C and E-F.
        const name = noteNames[key.semitone % 12];
        if (name === 'C' || name === 'F') {
          const y = key.bottom;
          if (y > 0 && y < height) {
            ctx.beginPath();
            ctx.moveTo(keyboardWidth, y);
            ctx.lineTo(width, y);
            ctx.stroke();
          }
        }
      } else {
        // Lines that line up with the visible black notes.
        if (key.top > 0 && key.top < height) {
          ctx.beginPath();
          ctx.moveTo(keyboardWidth, key.top);
          ctx.lineTo(width, key.top);
          ctx.stroke();
        }
        if (key.bottom > 0 && key.bottom < height) {
          ctx.beginPath();
          ctx.moveTo(keyboardWidth, key.bottom);
          ctx.lineTo(width, key.bottom);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawPlayLine(x) {
    if (x === null || x === undefined) return;
    ctx.strokeStyle = '#EF6905';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.clientHeight);
    ctx.stroke();
  }

  function redraw(playLineX) {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    drawKeyboard();
    drawGuideLines();
    if (currentTool === 'draw') {
      drawStrokes();
    } else {
      drawAsciiMarks();
    }
    drawPlayLine(playLineX);
  }

  // ---- Tempo slider + number input ----
  const speedSlider = document.getElementById('speedSlider');
  const speedInput = document.getElementById('speedInput');
  let scanSpeed = parseInt(speedSlider.value, 10);

  function setTempo(value) {
    let v = parseInt(value, 10);
    if (Number.isNaN(v)) return;
    v = Math.max(30, Math.min(600, v));
    scanSpeed = v;
    speedSlider.value = v;
    speedInput.value = v;
  }

  speedSlider.addEventListener('input', () => setTempo(speedSlider.value));
  speedInput.addEventListener('input', () => setTempo(speedInput.value));

  // ---- Audio engine ----
  let audioCtx = null;

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function getInstrumentConfig(color) {
    const buf = soundbankBuffers[color];
    if (buf) return { cfg: buf.fallback, sustain: buf.config.sustain, isSample: true };
    const fb = FALLBACK_INSTRUMENTS[color];
    if (fb) return { cfg: fb, sustain: false, isSample: false };
    return getInstrumentConfig(currentColor);
  }

  function applyEnvelope(gain, when, cfg, holdDuration) {
    const peak = 0.45;
    const sustainLevel = Math.max(peak * cfg.sustain, 0.0001);
    const attack = cfg.attack;
    const decay = cfg.decay;
    const release = cfg.release;

    let sustainEnd;
    if (typeof holdDuration === 'number' && holdDuration > attack + decay) {
      sustainEnd = when + holdDuration;
    } else {
      sustainEnd = when + attack + decay + 0.2;
    }
    const stopTime = sustainEnd + release;

    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(sustainLevel, when + attack + decay);
    gain.gain.setValueAtTime(sustainLevel, sustainEnd);
    gain.gain.exponentialRampToValueAtTime(0.0001, stopTime);

    return stopTime - when;
  }

  function playSampleTone(semitone, when, color, holdDuration) {
    const entry = soundbankBuffers[color] || soundbankBuffers[currentColor];
    if (!entry || !soundbankManifest) return false;

    const cfg = entry.fallback;
    const source = audioCtx.createBufferSource();
    source.buffer = entry.buffer;
    source.playbackRate.value = 1;

    const gain = audioCtx.createGain();
    source.connect(gain);
    gain.connect(audioCtx.destination);

    const offset = semitone * soundbankManifest.noteDuration;
    const noteDuration = applyEnvelope(gain, when, cfg, holdDuration);
    // Each note in the combined WAV is exactly noteDuration seconds long.
    const maxAvailable = soundbankManifest.noteDuration - 0.02;
    const sourceDuration = Math.max(0.05, Math.min(noteDuration, maxAvailable));

    source.start(when, offset, sourceDuration);
    source.stop(when + sourceDuration + 0.02);
    activeKeys.set(semitone, { color, until: when + Math.min(holdDuration, 0.15) + 0.05 });
    return true;
  }

  function playSynthTone(semitone, when, color, holdDuration) {
    const c4 = 261.625565;
    const { cfg } = getInstrumentConfig(color);

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.frequency.value = c4 * Math.pow(2, semitone / 12);
    osc.type = cfg.type;

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const noteDuration = applyEnvelope(gain, when, cfg, holdDuration);

    osc.start(when);
    osc.stop(when + noteDuration + 0.02);
    activeKeys.set(semitone, { color, until: when + Math.min(holdDuration, 0.15) + 0.05 });
  }

  function scheduleTone(semitone, when, color, holdDuration) {
    ensureAudio();
    if (soundbankReady && !FORCE_SYNTH_COLORS.has(color) && playSampleTone(semitone, when, color, holdDuration)) return;
    playSynthTone(semitone, when, color, holdDuration);
  }

  // ---- Load the extracted SF2 soundbank ----
  async function loadSoundbank() {
    if (soundbankStatus) soundbankStatus.textContent = 'Loading sounds…';
    try {
      ensureAudio();
      const res = await fetch('assets/soundbank/manifest.json');
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      soundbankManifest = await res.json();

      await Promise.all(
        Object.keys(soundbankManifest.instruments).map(async (color) => {
          const cfg = soundbankManifest.instruments[color];
          const r = await fetch(cfg.file);
          if (!r.ok) throw new Error(`${cfg.file} ${r.status}`);
          const arrayBuffer = await r.arrayBuffer();
          const buffer = await audioCtx.decodeAudioData(arrayBuffer);
          soundbankBuffers[color] = { buffer, config: cfg, fallback: soundbankManifest.fallback[color] };
        })
      );

      soundbankReady = true;
      if (soundbankStatus) soundbankStatus.textContent = '';
      updateSwatchTitles();
    } catch (err) {
      console.warn('Soundbank load failed, using fallback synth:', err);
      if (soundbankStatus) soundbankStatus.textContent = 'Using fallback synth';
      updateSwatchTitles();
    }
  }
  loadSoundbank();

  // ---- ASCII mode ----
  function parseASCII(text) {
    const lines = text.split('\n');
    const marks = [];
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row];
      for (let col = 0; col < line.length; col++) {
        const ch = line[col];
        if (ch !== ' ' && ch !== '\t') {
          marks.push({ row, col, char: ch });
        }
      }
    }
    return marks;
  }

  function computeASCIIRuns(marks) {
    // group by (row, char) consecutive columns
    const groups = {};
    for (const mark of marks) {
      const key = `${mark.row}|${mark.char}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(mark);
    }

    const runs = [];
    for (const key in groups) {
      const list = groups[key].sort((a, b) => a.col - b.col);
      let start = list[0].col;
      let end = list[0].col;
      for (let i = 1; i < list.length; i++) {
        if (list[i].col === end + 1) {
          end = list[i].col;
        } else {
          runs.push({ row: list[0].row, char: list[0].char, startCol: start, endCol: end });
          start = list[i].col;
          end = list[i].col;
        }
      }
      runs.push({ row: list[0].row, char: list[0].char, startCol: start, endCol: end });
    }

    return runs.map(r => ({
      ...r,
      semitone: yToSemitone((r.row + 0.5) * (canvas.clientHeight / Math.max(1, asciiRowCount))),
      color: getSymbolColor(r.char)
    }));
  }

  function getInstrumentOptions(selectedColor) {
    return PALETTE_COLORS.map(color => {
      const inst = FORCE_SYNTH_COLORS.has(color) ? FALLBACK_INSTRUMENTS[color] : (soundbankManifest?.instruments[color] || FALLBACK_INSTRUMENTS[color]);
      const selected = color === selectedColor ? ' selected' : '';
      const emoji = inst.emoji || '●';
      return `<option value="${color}"${selected}>${emoji} ${inst.name}</option>`;
    }).join('');
  }

  function analyzeASCII() {
    const text = asciiArea.value;
    const marks = parseASCII(text);
    const uniqueSymbols = [...new Set(marks.map(m => m.char))].sort();

    // preserve existing mappings for symbols still present
    for (const key in asciiSymbolMap) {
      if (!uniqueSymbols.includes(key)) delete asciiSymbolMap[key];
    }

    // assign default colors in palette order for new symbols
    uniqueSymbols.forEach((sym, i) => {
      if (!(sym in asciiSymbolMap)) {
        asciiSymbolMap[sym] = PALETTE_COLORS[i % PALETTE_COLORS.length];
      }
    });

    // build mapping UI
    symbolMappingsEl.innerHTML = uniqueSymbols.map(sym => `
      <div class="symbol-mapping">
        <code>${sym}</code>
        <select data-symbol="${sym}" aria-label="Instrument for ${sym}">${getInstrumentOptions(asciiSymbolMap[sym])}</select>
      </div>
    `).join('');

    const canEdit = !roomCode || amDrawing;
    symbolMappingsEl.querySelectorAll('select').forEach(select => {
      select.disabled = !canEdit;
      select.addEventListener('change', () => {
        asciiSymbolMap[select.dataset.symbol] = select.value;
        renderASCII();
      });
    });

    renderASCII();
  }

  function getSymbolColor(symbol) {
    return asciiSymbolMap[symbol] || currentColor;
  }

  function renderASCII() {
    const text = asciiArea.value;
    const lines = text.split('\n');
    asciiRowCount = Math.max(1, lines.length);
    asciiMarks = parseASCII(text);
    asciiMaxCol = asciiMarks.reduce((max, m) => Math.max(max, m.col), 0);

    const drawWidth = Math.max(1, canvas.clientWidth - keyboardWidth);
    asciiCharWidth = asciiMaxCol > 0 ? drawWidth / (asciiMaxCol + 1) : drawWidth / 16;

    asciiRuns = computeASCIIRuns(asciiMarks);
    asciiPlayedRuns.clear();
    redraw(lineX);
  }

  asciiArea.addEventListener('input', () => {
    // defer full analysis until Done, but update rendering with current mappings
    renderASCII();
  });
  doneAsciiBtn.addEventListener('click', analyzeASCII);

  // ---- Play / scanner ----
  function resetPlayedFlags() {
    for (const stroke of strokes) {
      for (const p of stroke.points) {
        delete p.played;
      }
      stroke.playing = false;
      delete stroke.playSemitone;
    }
    asciiPlayedRuns.clear();
  }

  function triggerNotesInRange(startX, endX) {
    if (!audioCtx) return;
    const when = audioCtx.currentTime;
    for (const stroke of strokes) {
      if (!stroke.segments?.length) continue;
      const intersecting = stroke.segments.filter(s => startX < s.maxX && endX >= s.minX);

      if (intersecting.length > 0) {
        const seg = intersecting[0];
        if (!stroke.playing || stroke.playSemitone !== seg.semitone) {
          const segIndex = stroke.segments.indexOf(seg);
          const nextX = segIndex < stroke.segments.length - 1
            ? stroke.segments[segIndex + 1].minX
            : (stroke.maxX || seg.maxX);
          const holdDuration = Math.max(0.05, (nextX - lineX) / scanSpeed);
          scheduleTone(seg.semitone, when, stroke.color, holdDuration);
          stroke.playing = true;
          stroke.playSemitone = seg.semitone;
        }
      } else if (stroke.playing && lineX > (stroke.maxX || -1)) {
        stroke.playing = false;
        delete stroke.playSemitone;
      }
    }
  }

  function triggerASCIINotes(startX, endX) {
    if (!asciiCharWidth || asciiRuns.length === 0 || !audioCtx) return;
    const when = audioCtx.currentTime;

    for (let i = 0; i < asciiRuns.length; i++) {
      if (asciiPlayedRuns.has(i)) continue;
      const run = asciiRuns[i];
      const runLeftX = keyboardWidth + run.startCol * asciiCharWidth;
      // Trigger once when the play line reaches the run's left edge.
      if (startX < runLeftX && endX >= runLeftX) {
        const runWidthPx = (run.endCol - run.startCol + 1) * asciiCharWidth;
        const holdDuration = Math.max(0.1, runWidthPx / scanSpeed);
        scheduleTone(run.semitone, when, run.color, holdDuration);
        asciiPlayedRuns.add(i);
      }
    }
  }

  function animate(ts) {
    if (!lastTs) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;

    const maxX = canvas.clientWidth;
    lineX += scanSpeed * dt;
    if (lineX > maxX) lineX = maxX;

    if (audioCtx) {
      const now = audioCtx.currentTime;
      for (const [semitone, entry] of activeKeys) {
        if (now >= entry.until) activeKeys.delete(semitone);
      }
    }

    if (currentTool === 'draw') {
      triggerNotesInRange(prevLineX, lineX);
    } else {
      triggerASCIINotes(prevLineX, lineX);
    }

    prevLineX = lineX;
    redraw(lineX);

    if (lineX < maxX) {
      requestAnimationFrame(animate);
    } else {
      isPlaying = false;
      lastTs = null;
    }
  }

  function playDraw() {
    if (strokes.length === 0) {
      alert('Draw something first!');
      return;
    }

    isPlaying = true;
    lineX = keyboardWidth;
    prevLineX = keyboardWidth - 1;
    lastTs = null;
    resetPlayedFlags();
    ensureAudio();

    requestAnimationFrame(animate);
  }

  function playASCII() {
    renderASCII();
    if (asciiRuns.length === 0) {
      alert('Type some ASCII notes first, then press Done!');
      return;
    }

    isPlaying = true;
    lineX = keyboardWidth;
    prevLineX = keyboardWidth - 1;
    lastTs = null;
    resetPlayedFlags();
    ensureAudio();

    requestAnimationFrame(animate);
  }

  document.getElementById('playBtn').addEventListener('click', () => {
    if (isPlaying) return;
    // During an active charades turn the Play button is locked for the first 30 s.
    if (roomCode && inTurn && !playUnlocked) return;
    if (currentTool === 'ascii') {
      playASCII();
    } else {
      playDraw();
    }
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    // In a game, only the drawer may clear the workspace.
    if (roomCode && !amDrawing) return;
    if (currentTool === 'ascii') {
      asciiArea.value = '';
      analyzeASCII();
    } else {
      strokes = [];
      currentStroke = null;
      if (isPlaying) {
        isPlaying = false;
        lastTs = null;
      }
      redraw();
    }
  });

  // ---- Multiplayer (Socket.IO) ----
  // Connect to the Socket.IO server on the same origin (works for localhost and
  // Render). If socket.io.js failed to load (e.g. on a static host like GitHub
  // Pages), fall back to a no-op socket so Create mode still works offline.
  const socket = typeof io === 'function' ? io() : { on: () => {}, emit: () => {}, connected: false };

  // Local state about the room we are in.
  let roomCode = null;
  let myRole = null;
  let currentChoiceType = null;
  let hasVoted = false;
  let timerInterval = null;

  // Lobby / waiting / customization DOM references.
  const gameStatus = document.getElementById('gameStatus');
  const pageTitle = document.getElementById('pageTitle');
  const joinCodeInput = document.getElementById('joinCodeInput');
  const guessSection = document.getElementById('guessSection');
  const guessInput = document.getElementById('guessInput');
  const sendGuessBtn = document.getElementById('sendGuessBtn');
  const guessBarInput = document.getElementById('guessBarInput');
  const guessBarBtn = document.getElementById('guessBarBtn');
  const chatInput = document.getElementById('chatInput');
  const hangmanSection = document.getElementById('hangmanSection');
  const hangmanBlanks = document.getElementById('hangmanBlanks');
  const chatLog = document.getElementById('chatLog');
  const chatLogList = document.getElementById('chatLogList');
  const playBtn = document.getElementById('playBtn');
  const gameLobby = document.getElementById('gameLobby');
  const waitingRoom = document.getElementById('waitingRoom');
  const customizeRoom = document.getElementById('customizeRoom');
  const displayRoomCode = document.getElementById('displayRoomCode');
  const copyCodeBtn = document.getElementById('copyCodeBtn');
  const playerNameInput = document.getElementById('playerNameInput');
  const setNameBtn = document.getElementById('setNameBtn');
  const playerCounter = document.getElementById('playerCounter');
  const playerList = document.getElementById('playerList');
  const goToCustomizeBtn = document.getElementById('goToCustomizeBtn');
  const scorePanel = document.getElementById('scorePanel');
  const scoreList = document.getElementById('scoreList');
  const choiceTitle = document.getElementById('choiceTitle');
  const choiceTimer = document.getElementById('choiceTimer');
  const choiceCards = document.getElementById('choiceCards');
  const choiceResult = document.getElementById('choiceResult');
  const chosenCard = document.getElementById('chosenCard');
  const podiumRoom = document.getElementById('podiumRoom');
  const podiumStandings = document.getElementById('podiumStandings');
  const confettiBtn = document.getElementById('confettiBtn');
  const podiumActions = document.getElementById('podiumActions');
  const rematchBtn = document.getElementById('rematchBtn');
  const podiumBackBtn = document.getElementById('podiumBackBtn');
  const finishVote = document.getElementById('finishVote');
  const finishGameBtn = document.getElementById('finishGameBtn');
  const finishVoteCount = document.getElementById('finishVoteCount');

  // ---- Classical charades state and UI ----
  let currentDrawerId = null;
  let currentRound = 0;
  let totalRounds = 0;
  let amDrawing = false;
  let chosenMode = 'draw'; // 'draw' or 'ascii', set by the customization vote
  let turnTimeRemaining = 0;
  let turnTimerInterval = null;
  let playUnlocked = false;
  let inTurn = false; // true only during an active charades turn (locks Play)
  let isUnlimited = false; // true when the room is playing unlimited rounds
  let lastPlayers = []; // most recent player list from the server
  let socketHasConnected = socket.connected;
  let podiumTimer = null;

  // Initialise the create-mode tools now that all state they close over is declared.
  setTool('draw');
  setDrawMode('pen');
  setPlayUnlocked(false);

  /**
   * Show a message in the room status banner. Errors are styled in burgundy
   * so duplicate-name / not-enough-players feedback is hard to miss.
   */
  function setRoomStatus(msg, { error = false } = {}) {
    if (!gameStatus) return;
    gameStatus.textContent = msg;
    if (msg) {
      setVisible(gameStatus, true);
    } else {
      setVisible(gameStatus, false);
    }
    if (error) {
      gameStatus.style.color = 'var(--burgundy)';
      gameStatus.style.fontWeight = '700';
    } else {
      gameStatus.style.color = '';
      gameStatus.style.fontWeight = '';
    }
  }

  // Prompt shown only to the drawer.
  const drawerPrompt = document.createElement('div');
  drawerPrompt.id = 'drawerPrompt';
  drawerPrompt.hidden = true;
  drawerPrompt.style.cssText = 'width:100%;max-width:720px;margin:0 auto 12px;padding:12px 16px;background:var(--panel-warm);border:1px solid var(--border);border-radius:12px;font-weight:700;text-align:center;color:var(--burgundy);';
  if (createPanel) createPanel.insertBefore(drawerPrompt, createPanel.firstChild);

  function setVisible(el, visible) {
    if (!el) return;
    // Some browsers need the attribute removed explicitly for elements that were
    // hidden in the initial HTML, so we do both the property and attribute.
    el.hidden = !visible;
    if (visible) el.removeAttribute('hidden');
  }

  function setGamePhase(phase) {
    // Show one of the game-mode sections and keep the guess box hidden
    // until the actual turn starts.
    setVisible(gameLobby, phase === 'lobby');
    setVisible(waitingRoom, phase === 'waiting');
    setVisible(customizeRoom, phase === 'customize');
    setVisible(podiumRoom, phase === 'podium');
    setVisible(guessSection, false);
    if (phase === 'play') {
      // During a turn hide the logo/title and show the charades UI.
      setVisible(gameLobby, false);
      setVisible(waitingRoom, false);
      setVisible(customizeRoom, false);
      setVisible(podiumRoom, false);
      if (pageTitle) setVisible(pageTitle, false);
      // The drawer already knows the answer, so they only see their prompt.
      if (hangmanSection) setVisible(hangmanSection, !amDrawing);
      if (chatLog) setVisible(chatLog, true);
      if (scorePanel) setVisible(scorePanel, true);
      // The input lives inside the chat log; only guessers need it.
      if (chatInput) chatInput.hidden = amDrawing;
    } else {
      if (pageTitle) setVisible(pageTitle, true);
      if (hangmanSection) setVisible(hangmanSection, false);
      if (chatLog) setVisible(chatLog, false);
      if (scorePanel) setVisible(scorePanel, false);
    }
  }

  function resetRoomUI() {
    roomCode = null;
    myRole = null;
    currentChoiceType = null;
    hasVoted = false;
    currentDrawerId = null;
    currentRound = 0;
    totalRounds = 0;
    amDrawing = false;
    chosenMode = 'draw';
    turnTimeRemaining = 0;
    playUnlocked = false;
    inTurn = false;
    isUnlimited = false;
    clearInterval(timerInterval);
    clearInterval(turnTimerInterval);
    clearTimeout(podiumTimer);
    if (drawerPrompt) drawerPrompt.hidden = true;
    if (playerList) playerList.innerHTML = '';
    if (scoreList) scoreList.innerHTML = '';
    if (playerCounter) playerCounter.textContent = '0';
    if (displayRoomCode) displayRoomCode.textContent = '----';
    if (goToCustomizeBtn) goToCustomizeBtn.hidden = true;
    if (choiceResult) choiceResult.hidden = true;
    if (gameStatus) setVisible(gameStatus, false);
    if (chatLogList) chatLogList.innerHTML = '';
    if (podiumStandings) podiumStandings.replaceChildren();
    if (finishVote) setVisible(finishVote, false);
    lastPlayers = [];
    setGameHeader(false);
    setPlayUnlocked(false);
    setGamePhase('lobby');
  }

  // Rooms live in server memory. If that server restarts, keep clients from
  // remaining on a stale board whose guesses can no longer be scored.
  socket.on('connect', () => {
    if (socketHasConnected && roomCode) {
      resetRoomUI();
      setMode('game');
      setRoomStatus('The game server restarted. Create or join a room to continue.', { error: true });
    }
    socketHasConnected = true;
  });

  function formatTime(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem.toString().padStart(2, '0')}`;
  }

  function setPlayUnlocked(unlocked) {
    playUnlocked = unlocked;
    if (!playBtn) return;
    // The Play button is locked for the first 30 s of an active charades turn.
    // In Create mode, and after a game ends, it should always work.
    playBtn.disabled = (roomCode && inTurn) ? !unlocked : false;
  }

  function startTurnTimer(seconds) {
    clearInterval(turnTimerInterval);
    turnTimeRemaining = seconds;
    setPlayUnlocked(false);
    if (gameTimer) gameTimer.textContent = formatTime(turnTimeRemaining);
    turnTimerInterval = setInterval(() => {
      turnTimeRemaining--;
      if (gameTimer) gameTimer.textContent = formatTime(turnTimeRemaining);
      if (turnTimeRemaining <= 0) clearInterval(turnTimerInterval);
    }, 1000);
  }

  function revealAnswer(answer) {
    if (hangmanBlanks) {
      const words = answer.split(' ').filter(w => w.length > 0);
      hangmanBlanks.replaceChildren();
      words.forEach(word => {
        const wordEl = document.createElement('span');
        wordEl.className = 'blank-word';
        wordEl.textContent = word.split('').join(' ');
        hangmanBlanks.appendChild(wordEl);
      });
      hangmanBlanks.classList.add('revealed');
    }
  }

  function addChatMessage(html, className = '') {
    if (!chatLogList) return;
    const li = document.createElement('li');
    if (className) li.className = className;
    li.innerHTML = html;
    chatLogList.appendChild(li);
    chatLogList.scrollTop = chatLogList.scrollHeight;
  }

  function copyRoomCode() {
    if (!roomCode) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(roomCode).then(() => {
        const original = copyCodeBtn.textContent;
        copyCodeBtn.textContent = 'Copied!';
        setTimeout(() => copyCodeBtn.textContent = original, 1200);
      });
    } else {
      // Fallback for browsers that don't support the Clipboard API.
      const temp = document.createElement('input');
      temp.value = roomCode;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      document.body.removeChild(temp);
    }
  }

  function setPlayerName() {
    if (!playerNameInput || !roomCode) return;
    const name = playerNameInput.value.trim();
    socket.emit('set-name', { code: roomCode, name });
  }

  function renderPlayerList(players, hostId) {
    if (!playerCounter || !playerList) return;
    playerCounter.textContent = String(players.length);
    playerList.innerHTML = '';

    for (const player of players) {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = player.name || 'Player';
      li.appendChild(nameSpan);

      if (player.id === hostId) {
        const hostTag = document.createElement('span');
        hostTag.textContent = 'host';
        hostTag.style.color = 'var(--muted)';
        hostTag.style.fontSize = '0.8rem';
        li.appendChild(hostTag);
      }

      // Only the host can kick, and they can't kick themselves.
      if (myRole === 'host' && player.id !== socket.id) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'kick-btn';
        kickBtn.textContent = 'Kick';
        kickBtn.addEventListener('click', () => {
          socket.emit('kick-player', { code: roomCode, playerId: player.id });
        });
        li.appendChild(kickBtn);
      }

      playerList.appendChild(li);
    }

    // Show the "Go to game" button only to the host.
    if (goToCustomizeBtn) goToCustomizeBtn.hidden = myRole !== 'host';
  }

  /**
   * Render the left-hand score table as a leaderboard: highest score first.
   * The current drawer gets a pencil icon, guessers get a question mark, and
   * the local player sees "You" instead of their name.
   */
  function renderScoreList(players, drawerId) {
    if (!scoreList) return;
    scoreList.innerHTML = '';
    const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const player of sorted) {
      const li = document.createElement('li');

      const iconSpan = document.createElement('span');
      iconSpan.className = 'drawer-icon';
      iconSpan.textContent = player.id === drawerId
        ? String.fromCodePoint(0x270F, 0xFE0F)
        : String.fromCodePoint(0x2753);
      iconSpan.title = player.id === drawerId ? 'Drawer' : 'Guesser';
      li.appendChild(iconSpan);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'score-name';
      nameSpan.textContent = player.id === socket.id ? 'You' : (player.name || 'Player');
      li.appendChild(nameSpan);

      const scoreSpan = document.createElement('span');
      scoreSpan.className = 'score-value';
      scoreSpan.textContent = String(player.score || 0);
      li.appendChild(scoreSpan);

      scoreList.appendChild(li);
    }
  }

  function updateFinishVoteUI(votes, total) {
    if (finishVoteCount) {
      finishVoteCount.textContent = `${votes.length}/${Math.max(1, total)}`;
    }
    if (finishGameBtn) {
      const hasVoted = votes.includes(socket.id);
      finishGameBtn.classList.toggle('pressed', hasVoted);
      finishGameBtn.setAttribute('aria-pressed', hasVoted ? 'true' : 'false');
    }
  }

  function renderPodium(players) {
    if (!podiumStandings) return;
    podiumStandings.replaceChildren();

    const topThree = [...players]
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 3);
    const displayOrder = [1, 0, 2]; // second, first, third: Kahoot-style podium

    displayOrder.forEach(index => {
      const player = topThree[index];
      if (!player) return;

      const rank = index + 1;
      const card = document.createElement('article');
      card.className = `podium-player podium-player--${rank}`;

      const rankEl = document.createElement('span');
      rankEl.className = 'podium-rank';
      rankEl.textContent = `${rank}${rank === 1 ? 'st' : rank === 2 ? 'nd' : 'rd'}`;

      const nameEl = document.createElement('strong');
      nameEl.className = 'podium-name';
      // Results use the player's actual display name, including for the local player.
      nameEl.textContent = player.name || 'Player';

      const scoreEl = document.createElement('span');
      scoreEl.className = 'podium-score';
      scoreEl.textContent = `${player.score || 0} pts`;

      const stepEl = document.createElement('div');
      stepEl.className = 'podium-step';
      stepEl.textContent = String(rank);

      card.append(rankEl, nameEl, scoreEl, stepEl);
      podiumStandings.appendChild(card);
    });
  }

  function fireConfetti() {
    if (typeof confetti !== 'function') return;
    const count = 200;
    const defaults = { origin: { y: 0.7 } };

    function fire(particleRatio, opts) {
      confetti(Object.assign({}, defaults, opts, { particleCount: Math.floor(count * particleRatio) }));
    }

    fire(0.25, { spread: 26, startVelocity: 55 });
    fire(0.2, { spread: 60 });
    fire(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
    fire(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
    fire(0.1, { spread: 120, startVelocity: 45 });
  }

  function startChoiceTimer(seconds) {
    clearInterval(timerInterval);
    if (!choiceTimer) return;
    let remaining = seconds;
    choiceTimer.textContent = String(remaining);
    timerInterval = setInterval(() => {
      remaining--;
      choiceTimer.textContent = String(Math.max(0, remaining));
      if (remaining <= 0) clearInterval(timerInterval);
    }, 1000);
  }

  function renderChoiceCards(options) {
    if (!choiceCards) return;
    choiceCards.innerHTML = '';
    options.forEach((option, index) => {
      const card = document.createElement('div');
      card.className = 'choice-card';
      card.textContent = option;
      // Live vote-count bar inside the card.
      const bar = document.createElement('div');
      bar.className = 'vote-bar';
      card.appendChild(bar);
      card.addEventListener('click', () => submitVote(index, card));
      choiceCards.appendChild(card);
    });
  }

  function submitVote(choiceIndex, cardEl) {
    if (hasVoted || !roomCode || !currentChoiceType) return;
    hasVoted = true;
    socket.emit('vote', { code: roomCode, choiceIndex });
    // Stop further clicks and highlight the picked card.
    document.querySelectorAll('.choice-card').forEach(c => c.style.pointerEvents = 'none');
    cardEl.classList.add('voted');
  }

  function updateVoteBars(votes) {
    const total = votes.reduce((a, b) => a + b, 0) || 1;
    document.querySelectorAll('.choice-card').forEach((card, index) => {
      const bar = card.querySelector('.vote-bar');
      if (!bar) return;
      const count = votes[index] || 0;
      bar.style.transform = `scaleX(${count / total})`;
      card.title = `${count} vote${count === 1 ? '' : 's'}`;
    });
  }

  function showChoiceResult(winner) {
    if (!choiceResult || !chosenCard) return;
    setVisible(choiceResult, true);
    chosenCard.textContent = winner;
  }

  function onChoiceStarted({ type, options, duration }) {
    currentChoiceType = type;
    hasVoted = false;
    if (choiceResult) setVisible(choiceResult, false);

    // Set the round title.
    if (choiceTitle) {
      if (type === 'mode') choiceTitle.textContent = 'Draw or ASCII?';
      else if (type === 'genre') choiceTitle.textContent = 'Pick a genre';
      else if (type === 'rounds') choiceTitle.textContent = 'How many rounds?';
      else choiceTitle.textContent = 'Pick a song';
    }

    setGamePhase('customize');
    renderChoiceCards(options);
    startChoiceTimer(duration);
  }

  function onCustomizeDone({ choices }) {
    clearInterval(timerInterval);
    currentChoiceType = null;
    amDrawing = false;
    if (drawerPrompt) drawerPrompt.hidden = true;
    // Remember whether the room chose Draw or ASCII for the drawer's turn.
    chosenMode = (choices.mode || '').toLowerCase().includes('ascii') ? 'ascii' : 'draw';
    document.body.setAttribute('data-game-tool', chosenMode);
    setGamePhase('waiting');
    setRoomStatus(`Ready! ${choices.mode} • ${choices.rounds}`);
    // Voting is over, hide the host's "Go to game" button.
    if (goToCustomizeBtn) goToCustomizeBtn.hidden = true;
    // The actual turn UI is set up when the server emits 'turn-started'.
  }

  // Ask the server to create a new room when the user clicks "Create room".
  document.getElementById('createRoomBtn').addEventListener('click', () => {
    socket.emit('create-room');
  });

  // Join an existing room using the code typed into the input.
  document.getElementById('joinRoomBtn').addEventListener('click', () => {
    const code = joinCodeInput.value.trim().toUpperCase();
    if (!code) {
      setRoomStatus('Enter a room code first.', { error: true });
      return;
    }
    socket.emit('join-room', code);
  });

  // Copy the room code to the clipboard.
  if (copyCodeBtn) copyCodeBtn.addEventListener('click', copyRoomCode);

  // Save the player's display name.
  if (setNameBtn) setNameBtn.addEventListener('click', setPlayerName);
  if (playerNameInput) {
    playerNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') setPlayerName();
    });
  }

  // Host starts the customization vote.
  if (goToCustomizeBtn) {
    goToCustomizeBtn.addEventListener('click', () => {
      if (roomCode) socket.emit('go-to-customize', roomCode);
    });
  }

  // Podium: run confetti on demand.
  if (confettiBtn) {
    confettiBtn.addEventListener('click', fireConfetti);
  }

  // Podium: host starts a rematch; everyone else sees the button disabled.
  if (rematchBtn) {
    rematchBtn.addEventListener('click', () => {
      if (!roomCode) return;
      if (myRole !== 'host') {
        setRoomStatus('Only the host can start a rematch.', { error: true });
        return;
      }
      socket.emit('rematch', roomCode);
    });
  }

  // Podium: go back to the Game Mode lobby.
  if (podiumBackBtn) {
    podiumBackBtn.addEventListener('click', () => {
      resetRoomUI();
      setMode('game');
    });
  }

  // Unlimited mode: toggle a vote to finish the game.
  if (finishGameBtn) {
    finishGameBtn.addEventListener('click', () => {
      if (!roomCode || !isUnlimited) {
        console.log('[finishGameBtn] ignored: no room or not unlimited', { roomCode, isUnlimited });
        return;
      }
      const wantsFinish = !finishGameBtn.classList.contains('pressed');
      // Optimistically toggle the pressed state so the button feels responsive.
      // The authoritative count comes back from the server on finish-votes-update.
      finishGameBtn.classList.toggle('pressed', wantsFinish);
      console.log('[finishGameBtn] emitting vote-finish', { roomCode, finish: wantsFinish });
      socket.emit('vote-finish', { code: roomCode, finish: wantsFinish }, (response) => {
        console.log('[finishGameBtn] server ack', response);
      });
    });
  }

  // Our name was accepted; clear any previous error message.
  socket.on('name-set', () => {
    setRoomStatus('');
  });

  // Server tells us a room was created and what our role is.
  socket.on('room-created', ({ code, role }) => {
    roomCode = code;
    myRole = role;
    if (displayRoomCode) displayRoomCode.textContent = code;
    setRoomStatus('Waiting for players...');
    setGamePhase('waiting');
  });

  // Server tells us we joined a room and sends the current drawing/ASCII state.
  socket.on('joined-room', ({ code, role, strokes: remoteStrokes, asciiText }) => {
    roomCode = code;
    myRole = role;
    if (displayRoomCode) displayRoomCode.textContent = code;
    setRoomStatus('Waiting for players...');

    // Apply the existing room state to our local canvas.
    if (remoteStrokes) {
      strokes = remoteStrokes;
      for (const stroke of strokes) buildStrokeSegments(stroke);
    }
    if (asciiText !== undefined && asciiText !== null) {
      asciiArea.value = asciiText;
      analyzeASCII();
    }
    redraw(lineX);
    setGamePhase('waiting');
  });

  // Server couldn't find the requested room or rejected an action (duplicate name,
  // not enough players, etc.). Show the message as clear error feedback.
  socket.on('room-error', (msg) => {
    setRoomStatus(msg, { error: true });
    if (/name/i.test(msg) && playerNameInput) {
      playerNameInput.focus();
      playerNameInput.select();
    }
  });

  // Updated player list from the server.
  socket.on('player-list', ({ players = [], hostId, drawerId }) => {
    lastPlayers = players;
    renderPlayerList(players, hostId);
    renderScoreList(players, drawerId);
  });

  // We became the new host because the original host left.
  socket.on('became-host', () => {
    myRole = 'host';
  });

  // The host kicked us out of the room.
  socket.on('kicked', () => {
    alert('You were removed from the room.');
    resetRoomUI();
  });

  // A new customization vote has started.
  socket.on('choice-started', onChoiceStarted);

  // Live vote counts update inside the cards.
  socket.on('vote-update', ({ votes }) => updateVoteBars(votes));

  // The winning card is revealed and enlarged in the centre.
  socket.on('choice-result', ({ winner, votes }) => {
    clearInterval(timerInterval);
    updateVoteBars(votes);
    showChoiceResult(winner);
  });

  // All customization votes are done.
  socket.on('customize-done', onCustomizeDone);

  // Host started a rematch: reset local game state and wait for the new vote.
  socket.on('rematch-started', () => {
    amDrawing = false;
    inTurn = false;
    isUnlimited = false;
    currentDrawerId = null;
    currentRound = 0;
    totalRounds = 0;
    playUnlocked = false;
    clearInterval(turnTimerInterval);
    clearTimeout(podiumTimer);
    if (drawerPrompt) setVisible(drawerPrompt, false);
    if (hangmanSection) setVisible(hangmanSection, false);
    if (chatLog) setVisible(chatLog, false);
    if (scorePanel) setVisible(scorePanel, false);
    if (podiumActions) setVisible(podiumActions, false);
    if (finishVote) setVisible(finishVote, false);
    setPlayUnlocked(false);
    setGameHeader(false);
    setRoomStatus('Rematch! Get ready to vote…');
    setMode('game');
    setGamePhase('waiting');
  });

  // Unlimited mode: live update of who has voted to finish.
  socket.on('finish-votes-update', ({ votes = [], total = 0 } = {}) => {
    console.log('[finish-votes-update]', { votes: votes.length, total, myVote: votes.includes(socket.id) });
    if (finishVote && isUnlimited) setVisible(finishVote, true);
    updateFinishVoteUI(votes, total);
  });

  // A new drawing turn has started. Everyone sees the Create-mode canvas; only
  // the drawer can edit it, and guessers see the bottom guessing bar + chat log.
  socket.on('turn-started', ({ drawerId, drawerName = '', round = 1, totalRounds: total = 0, blanks = '', blankWords, answerLength = 0, duration = 60, players = null, finishVotes = [] } = {}) => {
    currentDrawerId = drawerId;
    currentRound = round;
    totalRounds = total;
    isUnlimited = !totalRounds;
    amDrawing = drawerId === socket.id;
    inTurn = true;
    setGameHeader(true);

    // Game-mode turns always play at the default tempo, and the tempo control is hidden.
    setTempo(150);
    if (chosenMode) document.body.setAttribute('data-game-tool', chosenMode);

    // Refresh the scoreboard icon immediately so the drawer gets the pencil
    // without waiting for the follow-up player-list broadcast.
    const scorePlayers = Array.isArray(players) && players.length ? players : lastPlayers;
    if (scorePlayers.length) {
      lastPlayers = scorePlayers;
      renderScoreList(scorePlayers, currentDrawerId);
    }

    // Start each turn with a clean canvas and empty chat log.
    strokes = [];
    currentStroke = null;
    asciiArea.value = '';
    analyzeASCII();
    redraw(lineX);
    if (chatLogList) chatLogList.innerHTML = '';
    if (hangmanBlanks) {
      hangmanBlanks.replaceChildren();
      // `blanks` has an explicit 5-space delimiter between words. Always
      // prefer it: some legacy servers send `blankWords` as one item per
      // character, which would make every underline look like a separate word.
      const wordsFromBlanks = String(blanks).trim().split(/\s{3,}/).filter(Boolean);
      const wordsToRender = wordsFromBlanks.length
        ? wordsFromBlanks
        : (Array.isArray(blankWords) ? blankWords.filter(Boolean) : []);
      if (wordsToRender.length) {
        wordsToRender.forEach(word => {
          const wordEl = document.createElement('span');
          wordEl.className = 'blank-word';
          wordEl.textContent = word;
          hangmanBlanks.appendChild(wordEl);
        });
      } else {
        hangmanBlanks.textContent = '_'.repeat(answerLength);
      }
      hangmanBlanks.classList.remove('revealed');
    }
    if (guessBarInput) guessBarInput.value = '';
    if (chatInput) chatInput.hidden = amDrawing;

    const roundText = totalRounds ? `Round ${round} of ${totalRounds}` : `Round ${round}`;

    // In unlimited mode, show the "Finish game" vote in the top bar.
    if (finishVote) {
      setVisible(finishVote, isUnlimited);
      if (isUnlimited) {
        const playerTotal = scorePlayers.length || lastPlayers.length || 1;
        updateFinishVoteUI(finishVotes, playerTotal);
      }
    }

    // Show the canvas to everyone.
    setMode('create');
    startTurnTimer(duration);

    if (amDrawing) {
      setTool(chosenMode);
      setGamePhase('play');
      setVisible(drawerPrompt, true);
      setRoomStatus(`${roundText} — it's your turn to draw.`);
    } else {
      setTool('draw');
      setGamePhase('play');
      setVisible(drawerPrompt, false);
      setRoomStatus(`${roundText} — ${drawerName || 'The drawer'} is drawing. You are guessing.`);
    }
  });

  // Server sends the prompt only to the drawer.
  socket.on('your-prompt', ({ prompt = '' } = {}) => {
    if (drawerPrompt) {
      drawerPrompt.textContent = `You are drawing: ${prompt}`;
      setVisible(drawerPrompt, true);
    }
  });

  // The game has finished after every active player completed the selected rounds.
  socket.on('game-over', ({ players = lastPlayers } = {}) => {
    amDrawing = false;
    inTurn = false;
    isUnlimited = false;
    clearInterval(turnTimerInterval);
    clearTimeout(podiumTimer);
    if (drawerPrompt) setVisible(drawerPrompt, false);
    setVisible(guessSection, false);
    if (hangmanSection) setVisible(hangmanSection, false);
    if (chatLog) setVisible(chatLog, false);
    if (finishVote) setVisible(finishVote, false);
    setPlayUnlocked(false);
    setGameHeader(false);
    setRoomStatus('');
    renderPodium(Array.isArray(players) ? players : []);
    setMode('game');
    setGamePhase('podium');

    // Show the rematch / go-back actions to everyone.
    if (podiumActions) {
      setVisible(podiumActions, true);
      if (rematchBtn) {
        const isHost = myRole === 'host';
        rematchBtn.disabled = !isHost;
        rematchBtn.title = isHost ? '' : 'Only the host can start a rematch';
      }
    }

    // Fire confetti automatically once for the podium reveal.
    fireConfetti();
  });

  // Play button becomes active after the first 30 seconds of a turn.
  socket.on('play-unlocked', () => {
    setPlayUnlocked(true);
  });

  // Time is up or someone guessed correctly: reveal the answer and lock guessing.
  socket.on('answer-revealed', ({ answer = '' } = {}) => {
    inTurn = false;
    clearInterval(turnTimerInterval);
    revealAnswer(answer);
    // Once the answer is revealed, no one should be able to type more guesses.
    if (chatInput) chatInput.hidden = true;
    if (guessSection) setVisible(guessSection, false);
    setRoomStatus(`The answer was: ${answer}`);
  });

  // The turn timed out; the server will start the next turn automatically.
  socket.on('turn-timeout', () => {
    inTurn = false;
    clearInterval(turnTimerInterval);
    setPlayUnlocked(false);
  });

  // A guess was made and the server judged it.
  socket.on('guess-result', ({ playerName = 'Player', guess = '', correct = false, points = 0 } = {}) => {
    if (correct) {
      // Keep the answer hidden so other guessers can still play until the timer runs out.
      addChatMessage(`<span class="chat-player">${escapeHtml(playerName)}</span> <span class="chat-right">got the answer! +${points} pts</span>`, 'chat-right');
    } else {
      addChatMessage(`<span class="chat-player">${escapeHtml(playerName)}</span> guessed <span class="chat-wrong">"${escapeHtml(guess)}"</span>`);
    }
  });

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // The drawer updated the drawing or ASCII. Apply it locally.
  socket.on('state-update', ({ strokes: remoteStrokes, asciiText }) => {
    if (remoteStrokes) {
      strokes = remoteStrokes;
      for (const stroke of strokes) buildStrokeSegments(stroke);
    }
    if (asciiText !== undefined && asciiText !== null) {
      asciiArea.value = asciiText;
      analyzeASCII();
    }
    redraw(lineX);
  });

  // The host pressed Play. Start playback locally for everyone else.
  socket.on('play-sequence', () => {
    if (currentTool === 'ascii') {
      playASCII();
    } else {
      playDraw();
    }
  });

  // Helper: send the current canvas/ASCII state to everyone else in the room.
  function broadcastState() {
    if (!roomCode) return;
    const payload = { code: roomCode };
    if (currentTool === 'draw') {
      payload.strokes = strokes;
    } else {
      payload.asciiText = asciiArea.value;
    }
    socket.emit('state-update', payload);
  }

  // Broadcast when the user finishes a drawing action (mouse/touch release).
  // A short timeout lets any stroke rebuilding/erase commit finish first.
  window.addEventListener('mouseup', () => setTimeout(broadcastState, 10));
  window.addEventListener('touchend', () => setTimeout(broadcastState, 10));

  // Broadcast when ASCII analysis is done.
  doneAsciiBtn.addEventListener('click', () => setTimeout(broadcastState, 10));

  // Broadcast when the canvas is cleared.
  document.getElementById('clearBtn').addEventListener('click', () => {
    if (roomCode) setTimeout(broadcastState, 10);
  });

  // Broadcast Play so everyone in the room hears the sequence together.
  document.getElementById('playBtn').addEventListener('click', () => {
    if (!roomCode) return;
    socket.emit('play-sequence', { code: roomCode });
  });

  // Send a guess to the room.
  function sendGuess() {
    if (!roomCode) return;
    const input = guessBarInput || guessInput;
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    socket.emit('guess', { code: roomCode, text });
    input.value = '';
  }

  if (sendGuessBtn) sendGuessBtn.addEventListener('click', sendGuess);
  if (guessInput) {
    guessInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendGuess();
    });
  }
  if (guessBarBtn) guessBarBtn.addEventListener('click', sendGuess);
  if (guessBarInput) {
    guessBarInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendGuess();
    });
  }

  updateSwatchTitles();
});
