/* SPHEREx Blink Tree - front end. Plain script, no build step. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  // Opened from disk (file://) the page talks to a local server; otherwise to its own origin.
  const API = query.get('api') || (location.protocol === 'file:' ? 'http://localhost:8000' : '');
  const TARGETS = window.BLINK_TARGETS || [];
  const BANDS = { 1: [0.75, 1.10], 2: [1.10, 1.63], 3: [1.63, 2.42], 4: [2.42, 3.82], 5: [3.82, 4.42], 6: [4.42, 5.00] };
  const ALL_BANDS = '1,2,3,4,5,6';
  const SURVEY_YEAR = 2026.0;            // moving targets are centred where they are around this date
  const D2R = Math.PI / 180;
  const ASEC = 3600 * 180 / Math.PI;     // arcseconds per radian
  const DEFAULTS = { fov: 240, bands: '2', mode: 'blink', ref: 'auto', speed: 600, white: 60, black: 3, smooth: 0 };
  const MODE_HINTS = {
    blink: 'Frames are lined up on the sky. Anything that shifts or flickers between epochs is worth a closer look.',
    diff: 'Stars that do not change cancel out. A moving object leaves a dark spot where it was and a bright spot where it went.',
    sum: 'All epochs averaged together: deeper, but anything that moves is smeared.'
  };

  const state = {
    target: '', name: '', ra: null, dec: null,
    track: null,                         // {ra, dec, epoch, pmra, pmdec} of a moving target
    fov: DEFAULTS.fov, bands: DEFAULTS.bands, mode: DEFAULTS.mode, ref: DEFAULTS.ref,
    speed: DEFAULTS.speed, white: DEFAULTS.white, black: DEFAULTS.black, smooth: DEFAULTS.smooth,
    invert: false, interp: true, marks: true,
    playing: true, frame: 0,
    data: null, summary: null,
    shown: []                            // frames after applying the view mode and smoothing
  };

  const memo = new Map();
  const canvas = $('view');
  const off = document.createElement('canvas');
  let loadToken = 0;
  let summaryKey = '';
  let timer = null;
  let hovering = false;
  let startFrame = null;
  let shownPosition = '';                // sky position of the frames currently on screen
  // The sky map is optional: it is skipped in embed mode and if its library cannot be loaded.
  let sky = query.get('embed') === '1' ? null : (window.BlinkSkyMap || null);
  let skyKey = '';
  let skyBands = '';
  let mapPointer = null;                 // sky position under the pointer on the map

  // ---------------------------------------------------------------- helpers

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const yearOf = (mjd) => 2000 + (mjd - 51544.5) / 365.25;

  function sexagesimal(value, decimals) {
    const scale = Math.pow(10, decimals);
    let total = Math.round(Math.abs(value) * 3600 * scale);
    const s = total % (60 * scale);
    total = (total - s) / (60 * scale);
    const m = total % 60;
    const d = (total - m) / 60;
    const pad = (x) => String(x).padStart(2, '0');
    return [pad(d), pad(m), (s / scale).toFixed(decimals).padStart(decimals + 3, '0')];
  }
  function fmtRa(ra) {
    const p = sexagesimal(ra / 15, 2);
    return p[0] + 'h' + p[1] + 'm' + p[2] + 's';
  }
  function fmtDec(dec) {
    const p = sexagesimal(dec, 1);
    return (dec < 0 ? '−' : '+') + p[0] + '°' + p[1] + '′' + p[2] + '″';
  }
  function fmtAngle(arcsec) {
    return arcsec >= 60 ? (arcsec / 60).toFixed(arcsec % 60 ? 1 : 0) + '′' : arcsec + '″';
  }
  function bandName(bands) {
    return bands === ALL_BANDS ? 'All detectors' : bands.split(',').map((b) => 'D' + b).join('+');
  }
  function bandRange(bands) {
    const list = bands.split(',').map(Number);
    return BANDS[list[0]][0].toFixed(2) + '–' + BANDS[list[list.length - 1]][1].toFixed(2) + ' µm';
  }

  /* "133.795 -7.245", "08h55m10.8s -07d14m42.5s", "08 55 10.8 -07 14 42.5" -> degrees. */
  function parseCoords(text) {
    const s = text.replace(/[−–]/g, '-').replace(/[,;]/g, ' ').trim();
    const num = '[+-]?\\d+(?:\\.\\d*)?';
    const check = (ra, dec) => (ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)
      ? { ra: ra, dec: dec }
      : { error: 'Those coordinates are outside the sky: RA must be 0–360° (or 0–24h) and Dec −90° to +90°.' };
    const m = s.match(new RegExp('^(' + num + ')\\s*(?:deg|d|°)?\\s+(' + num + ')\\s*(?:deg|d|°)?$', 'i'));
    if (m) return check(parseFloat(m[1]), parseFloat(m[2]));
    const t = s.replace(/[hmsd°'"′″:]/gi, ' ').trim().split(/\s+/);
    const isNum = new RegExp('^' + num + '$');
    if (t.length === 6 && t.every((x) => isNum.test(x))) {
      const ra = (Math.abs(+t[0]) + t[1] / 60 + t[2] / 3600) * 15;
      const dec = (t[3].charAt(0) === '-' ? -1 : 1) * (Math.abs(+t[3]) + t[4] / 60 + t[5] / 3600);
      return check(ra, dec);
    }
    return null;                          // not coordinates: treat as an object name
  }

  /* Move a catalogue position to another date using its proper motion. */
  function propagate(t, year) {
    const dt = year - t.epoch;
    const dec = t.dec + t.pmdec * dt / 3.6e6;
    const ra = t.ra + t.pmra * dt / 3.6e6 / Math.cos(t.dec * D2R);
    return { ra: (ra % 360 + 360) % 360, dec: dec };
  }

  /* Tangent-plane geometry of the frames: east is left, north is up, row 0 at the top. */
  function geometry(d) {
    return { ra0: d.ra, dec0: d.dec, n: d.n, scale: d.scale, c: (d.n - 1) / 2 };
  }
  function skyToPixel(ra, dec, g) {
    const a = (ra - g.ra0) * D2R, d = dec * D2R, d0 = g.dec0 * D2R;
    const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a);
    const xi = Math.cos(d) * Math.sin(a) / cosc;
    const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a)) / cosc;
    return { x: g.c - xi * ASEC / g.scale, y: g.c - eta * ASEC / g.scale };
  }
  function pixelToSky(x, y, g) {
    const xi = (g.c - x) * g.scale / ASEC, eta = (g.c - y) * g.scale / ASEC, d0 = g.dec0 * D2R;
    const rho = Math.hypot(xi, eta);
    if (rho === 0) return { ra: g.ra0, dec: g.dec0 };
    const c = Math.atan(rho);
    const dec = Math.asin(Math.cos(c) * Math.sin(d0) + eta * Math.sin(c) * Math.cos(d0) / rho);
    const ra = g.ra0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c)) / D2R;
    return { ra: (ra % 360 + 360) % 360, dec: dec / D2R };
  }

  // ---------------------------------------------------------------- pixel math

  /* Gaussian smoothing that ignores missing (NaN) pixels. */
  function blur(src, n, sigma) {
    const r = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float32Array(2 * r + 1);
    for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-0.5 * i * i / (sigma * sigma));
    const sum = new Float32Array(n * n), wt = new Float32Array(n * n), out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let s = 0, w = 0;
        for (let i = -r; i <= r; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= n) continue;
          const v = src[y * n + xx];
          if (v === v) { s += v * k[i + r]; w += k[i + r]; }
        }
        sum[y * n + x] = s;
        wt[y * n + x] = w;
      }
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v0 = src[y * n + x];
        if (v0 !== v0) { out[y * n + x] = NaN; continue; }
        let s = 0, w = 0;
        for (let i = -r; i <= r; i++) {
          const yy = y + i;
          if (yy < 0 || yy >= n) continue;
          s += sum[yy * n + x] * k[i + r];
          w += wt[yy * n + x] * k[i + r];
        }
        out[y * n + x] = w > 1e-6 ? s / w : NaN;
      }
    }
    return out;
  }

  /* Weighted average of frames, ignoring missing pixels. */
  function average(frames, weights) {
    const len = frames[0].length, out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let s = 0, c = 0;
      for (let f = 0; f < frames.length; f++) {
        const v = frames[f][i];
        if (v === v) { s += v * weights[f]; c += weights[f]; }
      }
      out[i] = c ? s / c : NaN;
    }
    return out;
  }

  function subtract(a, b) {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
    return out;
  }

  // ---------------------------------------------------------------- server

  async function getJSON(path) {
    const r = await fetch(API + path);
    if (!r.ok) throw new Error(await errorText(r));
    return r.json();
  }

  async function errorText(r) {
    try {
      const body = await r.json();
      return typeof body.detail === 'string' ? body.detail : 'The server rejected the request (' + r.status + ').';
    } catch (e) {
      return 'The server answered with an error (' + r.status + ').';
    }
  }

  function decodeFrames(buf) {
    const view = new DataView(buf);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'SBT1') throw new Error('Unexpected answer from the server.');
    const headLen = view.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headLen)));
    const size = head.n * head.n;
    const all = new Float32Array(buf, 8 + headLen, head.n_frames * size);
    head.frames = [];
    for (let i = 0; i < head.n_frames; i++) head.frames.push(all.subarray(i * size, (i + 1) * size));
    return head;
  }

  async function fetchFrames(ra, dec, fov, bands, onProgress) {
    const job = Math.random().toString(36).slice(2);
    const poll = setInterval(() => {
      getJSON('/api/progress?job=' + job).then(onProgress).catch(() => {});
    }, 400);
    try {
      const r = await fetch(API + '/api/frames?ra=' + ra + '&dec=' + dec + '&fov=' + fov + '&bands=' + bands + '&job=' + job);
      if (!r.ok) throw new Error(await errorText(r));
      return decodeFrames(await r.arrayBuffer());
    } finally {
      clearInterval(poll);
    }
  }

  function explain(err) {
    const text = String((err && err.message) || err);
    if (/failed to fetch|networkerror|load failed/i.test(text)) {
      return 'Cannot reach the Blink Tree server.\nStart it from the project folder with\npython -m uvicorn backend.app:app --port 8000';
    }
    return text;
  }

  // ---------------------------------------------------------------- loading

  function setMessage(text) {
    const el = $('message');
    el.textContent = text || '';
    el.hidden = !text;
  }
  function showProgress(fraction, label) {
    $('progress').hidden = false;
    $('bar').style.width = Math.round(100 * clamp(fraction, 0, 1)) + '%';
    $('progress-label').textContent = label;
  }
  function hideProgress() { $('progress').hidden = true; }

  function progressText(label) {
    const parts = label.split(' ');
    return parts[1] === 'headers'
      ? 'Finding the target on each ' + parts[0] + ' image…'
      : 'Reading ' + parts[0] + ' pixels from the NASA archive…';
  }

  function loadSummary() {
    const key = state.ra.toFixed(5) + '|' + state.dec.toFixed(5);
    if (key === summaryKey) return;
    summaryKey = key;
    state.summary = null;
    renderTree();
    if (sky) sky.setFootprints([]);
    getJSON('/api/search?ra=' + state.ra + '&dec=' + state.dec).then((s) => {
      if (key !== summaryKey) return;
      state.summary = s;
      if (sky) sky.setFootprints(s.footprints || []);
      renderTree();
      renderFacts();
    }).catch(() => {});
  }

  async function load() {
    if (state.ra === null) return;
    const token = ++loadToken;
    const key = [state.ra.toFixed(5), state.dec.toFixed(5), state.fov, state.bands].join('|');
    syncUrl();
    syncControls();
    setMessage('');
    loadSummary();
    if (sky) {
      sky.setTarget(state.ra, state.dec, state.fov);
      if (skyBands !== state.bands) { skyBands = state.bands; sky.setBand(state.bands); }
    }
    const position = state.ra.toFixed(5) + '|' + state.dec.toFixed(5);
    let data = memo.get(key);
    if (!data) {
      if (state.data && shownPosition !== position) {   // a different field: do not leave the old one up
        state.data = null;
        rebuild();
      }
      canvas.classList.add('stale');
      showProgress(0, 'Asking the SPHEREx archive which images cover this spot…');
      try {
        data = await fetchFrames(state.ra, state.dec, state.fov, state.bands, (p) => {
          if (token === loadToken && p.label) showProgress(p.fraction, progressText(p.label));
        });
        memo.set(key, data);
      } catch (err) {
        if (token !== loadToken) return;
        hideProgress();
        canvas.classList.remove('stale');
        state.data = null;
        rebuild();
        setMessage(explain(err));
        return;
      }
    }
    if (token !== loadToken) return;
    hideProgress();
    canvas.classList.remove('stale');
    const keep = currentEpoch();
    state.data = data;
    shownPosition = position;
    rebuild(keep);
  }

  function currentEpoch() {
    const f = state.shown[state.frame];
    return f ? f.meta.epoch : null;
  }

  /* The "Subtract" menu: fixed choices plus every epoch of the loaded data. */
  function renderRefOptions() {
    const d = state.data;
    const fixed = [['auto', 'the deepest earlier epoch'], ['first', 'the first epoch'],
      ['prev', 'the previous epoch'], ['mean', 'the average of all epochs']];
    let html = fixed.map((o) => '<option value="' + o[0] + '">' + o[1] + '</option>').join('');
    if (d && d.n_frames) {
      html += d.epochs.map((e) =>
        '<option value="e' + e.epoch + '">' + e.date + ' (' + e.n_exposures + ' exposures)</option>').join('');
    }
    $('ref').innerHTML = html;
    $('ref').value = state.ref;
    if ($('ref').value !== state.ref) { state.ref = DEFAULTS.ref; $('ref').value = state.ref; }
  }

  /* Index of the frame to subtract, or -1 when it changes per frame ("prev") or is an average. */
  function referenceIndex(d) {
    if (state.ref === 'first') return 0;
    if (state.ref === 'auto') {            // most exposures, the latest epoch excluded
      let best = 0;
      for (let i = 1; i < d.n_frames - 1; i++) {
        if (d.epochs[i].n_exposures > d.epochs[best].n_exposures) best = i;
      }
      return best;
    }
    if (state.ref.charAt(0) === 'e') {
      const ep = Number(state.ref.slice(1));
      return Math.max(0, d.epochs.findIndex((e) => e.epoch === ep));
    }
    return -1;
  }

  /* Derive the frames to show from the loaded data, the view mode and the smoothing. */
  function rebuild(keepEpoch) {
    if (keepEpoch === undefined) keepEpoch = currentEpoch();
    const d = state.data;
    state.shown = [];
    renderRefOptions();
    if (d && d.n_frames) {
      const base = d.frames.map((f) => (state.smooth > 0 ? blur(f, d.n, state.smooth) : f));
      const weights = d.epochs.map((e) => e.n_exposures);
      const mode = (state.mode === 'diff' && d.n_frames < 2) ? 'blink' : state.mode;
      const sigma = d.stats.noise || 1;
      if (mode === 'blink') {
        base.forEach((px, i) => state.shown.push({ px: px, meta: d.epochs[i], kind: 'image', sigma: sigma }));
      } else if (mode === 'sum') {
        state.shown.push({
          px: average(base, weights), kind: 'image', sigma: sigma / Math.sqrt(d.n_frames),
          meta: {
            epoch: -1, date: 'All epochs',
            mjd: d.epochs.reduce((s, e) => s + e.mjd, 0) / d.n_frames,
            date_start: d.epochs[0].date_start, date_end: d.epochs[d.n_frames - 1].date_end,
            n_exposures: d.epochs.reduce((s, e) => s + e.n_exposures, 0)
          }
        });
      } else {
        const mean = state.ref === 'mean' ? average(base, weights) : null;
        const fixed = referenceIndex(d);
        base.forEach((px, i) => {
          let j = fixed;
          if (!mean && state.ref === 'prev') {
            if (i === 0) return;
            j = i - 1;
          } else if (!mean && i === fixed) {
            return;
          }
          state.shown.push({
            px: subtract(px, mean || base[j]), meta: d.epochs[i], kind: 'diff', sigma: sigma,
            minus: mean ? 'average' : d.epochs[j].date
          });
        });
      }
    }
    const idx = state.shown.findIndex((f) => f.meta.epoch === keepEpoch);
    state.frame = idx >= 0 ? idx : 0;
    if (startFrame !== null && state.shown.length) {      // ?frame=N opens on a given frame
      state.frame = clamp(startFrame, 0, state.shown.length - 1);
      startFrame = null;
    }
    if (d && !d.n_frames) {
      setMessage(d.n_found
        ? 'SPHEREx has only ' + d.n_used + ' usable ' + bandName(state.bands) + ' exposure' + (d.n_used === 1 ? '' : 's') +
          ' here, too few to build an epoch.\nTry another detector.'
        : 'SPHEREx has no ' + bandName(state.bands) + ' images of this position yet.\nTry another detector.');
    }
    renderTimeline();
    renderFacts();
    draw();
    schedule();
  }

  // ---------------------------------------------------------------- drawing

  function paint(f, n) {
    if (off.width !== n) { off.width = n; off.height = n; }
    const octx = off.getContext('2d');
    const img = octx.createImageData(n, n);
    const out = img.data, px = f.px, invert = state.invert;
    const isDiff = f.kind === 'diff';
    const range = Math.max(state.white / 4, 1) * f.sigma;
    const lo = -state.black * f.sigma, span = (state.white + state.black) * f.sigma;
    const a = 10, norm = Math.asinh(a);
    for (let i = 0, j = 0; i < px.length; i++, j += 4) {
      const v = px[i];
      out[j + 3] = 255;
      if (v !== v) { out[j] = 16; out[j + 1] = 22; out[j + 2] = 36; continue; }   // no data
      let g = isDiff ? 0.5 + 0.5 * v / range : (v - lo) / span;
      g = g < 0 ? 0 : g > 1 ? 1 : g;
      if (!isDiff) g = Math.asinh(a * g) / norm;
      if (invert) g = 1 - g;
      const c = Math.round(255 * g);
      out[j] = c; out[j + 1] = c; out[j + 2] = c;
    }
    octx.putImageData(img, 0, 0);
  }

  function outlined(ctx, text, x, y) {
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  function overlays(ctx, W, dpr, f) {
    const d = state.data, g = geometry(d), s = W / d.n;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (state.marks) {
      let p = { x: g.c, y: g.c };
      if (state.track && f.meta.mjd) {
        const sky = propagate(state.track, yearOf(f.meta.mjd));
        p = skyToPixel(sky.ra, sky.dec, g);
      }
      const cx = (p.x + 0.5) * s, cy = (p.y + 0.5) * s, gap = 11 * dpr, len = 10 * dpr;
      ctx.lineWidth = 3.5 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach((v) => {
          ctx.moveTo(cx + v[0] * gap, cy + v[1] * gap);
          ctx.lineTo(cx + v[0] * (gap + len), cy + v[1] * (gap + len));
        });
        ctx.stroke();
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = state.track ? '#5ad19a' : '#ffb454';
      }
    }

    if (mapPointer) {
      const q = skyToPixel(mapPointer.ra, mapPointer.dec, g);
      if (insideFrame(q, d.n)) {
        const qx = (q.x + 0.5) * s, qy = (q.y + 0.5) * s, arm = 9 * dpr;
        ctx.lineWidth = 4 * dpr;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        for (let pass = 0; pass < 2; pass++) {
          ctx.beginPath();
          ctx.moveTo(qx - arm, qy); ctx.lineTo(qx + arm, qy);
          ctx.moveTo(qx, qy - arm); ctx.lineTo(qx, qy + arm);
          ctx.stroke();
          ctx.lineWidth = 1.6 * dpr;
          ctx.strokeStyle = '#ffffff';
        }
      }
    }

    ctx.font = '600 ' + Math.round(13 * dpr) + 'px system-ui, sans-serif';
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.fillStyle = '#ffd98a';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const title = f.kind === 'diff' ? f.meta.date + '  −  ' + f.minus : f.meta.date;
    outlined(ctx, title, 10 * dpr, 9 * dpr);
    ctx.font = Math.round(12 * dpr) + 'px system-ui, sans-serif';
    ctx.fillStyle = '#e7eaf2';
    outlined(ctx, bandName(state.bands) + '  ' + bandRange(state.bands) + '  ·  ' + f.meta.n_exposures + ' exposures', 10 * dpr, 27 * dpr);

    // compass: north up, east left
    const L = 24 * dpr, ox = 16 * dpr + L, oy = W - 16 * dpr;
    ctx.lineWidth = 3.5 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      ctx.moveTo(ox - L, oy); ctx.lineTo(ox, oy); ctx.lineTo(ox, oy - L);
      ctx.stroke();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#e7eaf2';
    }
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    outlined(ctx, 'N', ox, oy - L - 9 * dpr);
    outlined(ctx, 'E', ox - L - 9 * dpr, oy);

    // scale bar
    const nice = [5, 10, 20, 30, 60, 120, 300, 600];
    let bar = nice[0];
    nice.forEach((v) => { if (v <= d.fov / 4) bar = v; });
    const barPx = bar / d.scale * s, bx = W - 16 * dpr, by = W - 18 * dpr;
    ctx.lineWidth = 3.5 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      ctx.moveTo(bx - barPx, by); ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#e7eaf2';
    }
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.textBaseline = 'bottom';
    outlined(ctx, fmtAngle(bar), bx - barPx / 2, by - 5 * dpr);
  }

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(64, Math.round(rect.width * dpr));
    if (canvas.width !== W || canvas.height !== W) { canvas.width = W; canvas.height = W; }
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#04060b';
    ctx.fillRect(0, 0, W, W);
    const f = state.shown[state.frame];
    if (f) {
      paint(f, state.data.n);
      ctx.imageSmoothingEnabled = state.interp;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off, 0, 0, W, W);
      overlays(ctx, W, dpr, f);
    }
    markTimeline();
    markTree();
    syncSky();
    if (!hovering) defaultReadout();
  }

  function insideFrame(p, n) {
    return p.x >= 0 && p.y >= 0 && p.x <= n - 1 && p.y <= n - 1;
  }

  /* The pointer moved on the sky map: show the same spot on the blink image. */
  function setMapPointer(pos) {
    const d = state.data;
    const visible = (p) => !!(p && d && insideFrame(skyToPixel(p.ra, p.dec, geometry(d)), d.n));
    const redraw = visible(mapPointer) || visible(pos);
    mapPointer = pos;
    if (redraw) draw();
  }

  function setSkyExpanded(on) {
    $('sky').classList.toggle('expanded', on);
    document.body.classList.toggle('sky-open', on);
    $('sky-full').textContent = on ? 'Exit full screen' : 'Full screen';
  }

  function footprintNote(ev) {
    if (!ev.total) return 'SPHEREx exposures of the epoch on screen (none to show right now).';
    const count = ev.total === 1 ? '1 SPHEREx exposure' : ev.total + ' SPHEREx exposures';
    const drawn = ev.drawn && ev.drawn < ev.total ? ' (' + ev.drawn + ' drawn)' : '';
    return count + drawn + ' from the epoch on screen. Each green square is one 3.5\u00b0-wide image ' +
      'that contains the field; stacked together they make the blink frame.';
  }

  /* Tell the sky map which epoch is on screen so it can show that epoch's footprints. */
  function syncSky() {
    if (!sky) return;
    const f = state.shown[state.frame];
    const key = (f ? f.meta.epoch : 'none') + '|' + state.bands;
    if (key === skyKey) return;
    skyKey = key;
    sky.showEpoch(f ? f.meta.epoch : -2, state.bands);
  }

  function initSky() {
    if (!sky) { document.body.classList.add('no-sky'); return; }
    const survey = $('sky-survey');
    Object.keys(sky.surveys).forEach((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = sky.surveys[id].label;
      survey.appendChild(opt);
    });
    survey.addEventListener('change', () => sky.setSurvey(survey.value));
    $('sky-wave').max = String(sky.channels - 1);
    $('sky-wave').addEventListener('input', () => sky.setSlice(Number($('sky-wave').value)));
    $('sky-feet').addEventListener('change', () => sky.setFootprintsVisible($('sky-feet').checked));
    $('sky-zoom').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (btn) sky.zoom(btn.dataset.zoom);
    });
    $('sky-blink').addEventListener('click', () => {
      const c = sky.centre();
      if (!c) return;
      setSkyExpanded(false);
      $('q').value = c.ra.toFixed(5) + ' ' + c.dec.toFixed(5);
      submit($('q').value);
    });
    $('sky-full').addEventListener('click', () => setSkyExpanded(!$('sky').classList.contains('expanded')));
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && $('sky').classList.contains('expanded')) setSkyExpanded(false);
    });
    sky.init('#skymap', (ev) => {
      if (ev.type === 'slice') {
        $('sky-wave').value = ev.slice;
        $('sky-wave').disabled = !ev.cube;
        $('sky-wave-out').textContent = ev.cube
          ? ev.wavelength.toFixed(2) + ' \u00b5m (D' + ev.detector + ')'
          : 'not a SPHEREx map';
      } else if (ev.type === 'footprints') {
        $('sky-feet-note').textContent = footprintNote(ev);
      } else if (ev.type === 'hover') {
        setMapPointer({ ra: ev.ra, dec: ev.dec });
      } else if (ev.type === 'leave') {
        setMapPointer(null);
      }
    }).catch(() => {                      // offline, blocked CDN or no WebGL2: carry on without the map
      sky = null;
      document.body.classList.add('no-sky');
      draw();
    });
  }

  function defaultReadout() {
    const f = state.shown[state.frame];
    if (!f) { $('readout').innerHTML = '&nbsp;'; return; }
    const span = f.meta.date_start === f.meta.date_end ? f.meta.date_start : f.meta.date_start + ' to ' + f.meta.date_end;
    $('readout').textContent = 'Frame ' + (state.frame + 1) + ' of ' + state.shown.length + ' · observed ' + span +
      ' · hover over the image for coordinates';
  }

  // ---------------------------------------------------------------- playback

  function schedule() {
    clearTimeout(timer);
    if (!state.playing || state.shown.length < 2) return;
    timer = setTimeout(() => {
      state.frame = (state.frame + 1) % state.shown.length;
      draw();
      schedule();
    }, state.speed);
  }
  function setPlaying(on) {
    state.playing = on;
    $('play').textContent = on ? 'Pause' : 'Play';
    schedule();
  }
  function step(delta) {
    if (!state.shown.length) return;
    setPlaying(false);
    state.frame = (state.frame + delta + state.shown.length) % state.shown.length;
    draw();
  }

  // ---------------------------------------------------------------- panels

  function renderTimeline() {
    const el = $('timeline');
    el.innerHTML = '';
    state.shown.forEach((f, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      const sub = f.kind === 'diff' ? 'minus ' + f.minus : f.meta.n_exposures + ' exposures';
      b.innerHTML = esc(f.meta.date) + '<small>' + esc(sub) + '</small>';
      b.addEventListener('click', () => { setPlaying(false); state.frame = i; draw(); });
      el.appendChild(b);
    });
  }
  function markTimeline() {
    const kids = $('timeline').children;
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('active', i === state.frame);
  }

  function renderFacts() {
    const d = state.data, s = state.summary, rows = [];
    if (state.name) rows.push(['Target', state.name]);
    if (state.ra !== null) rows.push(['Centre', fmtRa(state.ra) + ' ' + fmtDec(state.dec)]);
    if (state.track) {
      rows.push(['Proper motion', (Math.hypot(state.track.pmra, state.track.pmdec) / 1000).toFixed(2) + '″ per year']);
    }
    if (d) {
      rows.push(['Field of view', fmtAngle(d.fov) + ', ' + d.scale.toFixed(2) + '″ per pixel']);
      rows.push(['Wavelengths', bandRange(state.bands)]);
      rows.push(['Exposures used', d.n_used + ' of ' + d.n_found]);
      rows.push(['Epochs', String(d.n_frames)]);
    }
    if (s) {
      rows.push(['Images of this spot', String(s.n_images)]);
      if (s.latest_date) rows.push(['Newest image', s.latest_date]);
    }
    $('facts').innerHTML = rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('');
  }

  function renderTree() {
    const s = state.summary, wrap = $('tree-wrap');
    if (!s || !s.epochs.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const head = s.epochs.map((e) =>
      '<th data-epoch="' + e.index + '" title="' + e.date_start + ' to ' + e.date_end + '">' + e.date_start.slice(0, 7) + '</th>').join('');
    const body = Object.keys(BANDS).map((b) => {
      let total = 0;
      const cells = s.epochs.map((e) => {
        const c = e.counts[b] || 0;
        total += c;
        return '<td data-epoch="' + e.index + '"' + (c ? '' : ' class="empty"') + '>' + (c || '·') + '</td>';
      }).join('');
      return '<tr data-band="' + b + '"><th>D' + b + '<span>' + bandRange(b) + '</span></th>' + cells + '<td>' + total + '</td></tr>';
    }).join('');
    $('tree').innerHTML = '<table><thead><tr><th>Detector</th>' + head + '<th>Total</th></tr></thead><tbody>' + body + '</tbody></table>';
    markTree();
  }
  function markTree() {
    const f = state.shown[state.frame];
    const ep = f ? f.meta.epoch : -99;
    $('tree').querySelectorAll('tr[data-band]').forEach((tr) => tr.classList.toggle('active', tr.dataset.band === state.bands));
    $('tree').querySelectorAll('[data-epoch]').forEach((c) => c.classList.toggle('now', Number(c.dataset.epoch) === ep));
  }

  // ---------------------------------------------------------------- controls

  const whiteToSlider = (w) => Math.round(100 * Math.log10(w / 5) / 3);
  const sliderToWhite = (v) => Math.round(5 * Math.pow(10, 3 * v / 100));

  function syncControls() {
    $('fov').value = String(state.fov);
    if ($('fov').value !== String(state.fov)) {          // a size that is not in the list
      const opt = document.createElement('option');
      opt.value = String(state.fov);
      opt.textContent = fmtAngle(state.fov);
      $('fov').appendChild(opt);
      $('fov').value = String(state.fov);
    }
    document.querySelectorAll('#bands button').forEach((b) => b.classList.toggle('active', b.dataset.bands === state.bands));
    document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    document.querySelectorAll('#examples .chip').forEach((b) => b.classList.toggle('active', b.dataset.target === state.target));
    $('ref-row').hidden = state.mode !== 'diff';
    $('mode-hint').textContent = MODE_HINTS[state.mode];
    $('speed').value = state.speed;
    $('speed-out').textContent = state.speed + ' ms';
    $('white').value = whiteToSlider(state.white);
    $('white-out').textContent = state.white + ' σ';
    $('black').value = state.black;
    $('black-out').textContent = '−' + state.black + ' σ';
    $('smooth').value = state.smooth;
    $('smooth-out').textContent = state.smooth ? state.smooth + ' px' : 'off';
    $('invert').checked = state.invert;
    $('interp').checked = state.interp;
    $('marks').checked = state.marks;
    $('play').textContent = state.playing ? 'Pause' : 'Play';
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.target) {
      p.set('target', state.target);
    } else if (state.ra !== null) {
      p.set('ra', state.ra.toFixed(5));
      p.set('dec', state.dec.toFixed(5));
      if (state.name) p.set('name', state.name);
      if (state.track) {
        const t = state.track;
        p.set('track', [t.ra, t.dec, t.epoch, t.pmra, t.pmdec].join(','));
      }
    }
    p.set('fov', state.fov);
    p.set('bands', state.bands);
    Object.keys(DEFAULTS).forEach((k) => {
      if (k !== 'fov' && k !== 'bands' && state[k] !== DEFAULTS[k]) p.set(k, state[k]);
    });
    if (state.invert) p.set('invert', '1');
    ['api', 'embed'].forEach((k) => { if (query.get(k)) p.set(k, query.get(k)); });
    try {
      history.replaceState(null, '', location.pathname + '?' + p.toString());
    } catch (e) { /* not allowed for some file:// pages; the view still works */ }
  }

  function setBands(bands) {
    if (bands === state.bands) return;
    state.bands = bands;
    load();
  }
  function setMode(mode) {
    state.mode = mode;
    syncControls();
    syncUrl();
    rebuild();
  }

  function openTarget(t, keepView) {
    const track = { ra: t.ra, dec: t.dec, epoch: t.epoch, pmra: t.pmra, pmdec: t.pmdec };
    const pos = propagate(track, SURVEY_YEAR);
    state.target = t.id;
    state.name = t.name;
    state.ra = pos.ra;
    state.dec = pos.dec;
    state.track = track;
    if (!keepView) { state.bands = t.bands; state.fov = t.fov; }
    $('q').value = t.name;
    load();
  }

  async function submit(text) {
    text = text.trim();
    if (!text) return;
    const lower = text.toLowerCase();
    const preset = TARGETS.find((t) => t.name.toLowerCase() === lower || t.aliases.indexOf(lower) >= 0);
    if (preset) { openTarget(preset, false); return; }
    const c = parseCoords(text);
    if (c && c.error) { setMessage(c.error); return; }
    if (c) {
      state.target = ''; state.name = ''; state.track = null;
      state.ra = c.ra; state.dec = c.dec;
      load();
      return;
    }
    ++loadToken;
    setMessage('');
    showProgress(0, 'Looking up “' + text + '”…');
    try {
      const r = await getJSON('/api/resolve?name=' + encodeURIComponent(text));
      let pos = { ra: r.ra, dec: r.dec }, track = null;
      if (r.epoch && (r.pmra || r.pmdec)) {
        track = { ra: r.ra, dec: r.dec, epoch: r.epoch, pmra: r.pmra || 0, pmdec: r.pmdec || 0 };
        pos = propagate(track, SURVEY_YEAR);
      }
      state.target = ''; state.name = r.name; state.track = track;
      state.ra = pos.ra; state.dec = pos.dec;
      load();
    } catch (err) {
      hideProgress();
      setMessage(explain(err));
    }
  }

  function buildControls() {
    const ex = $('examples');
    ex.appendChild(document.createTextNode('Try:'));
    TARGETS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.target = t.id;
      b.textContent = t.name;
      b.title = t.blurb;
      b.addEventListener('click', () => openTarget(t, false));
      ex.appendChild(b);
    });

    const bands = $('bands');
    Object.keys(BANDS).forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.bands = b;
      btn.innerHTML = 'D' + b + '<small>' + bandRange(b) + '</small>';
      bands.appendChild(btn);
    });
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'wide';
    all.dataset.bands = ALL_BANDS;
    all.innerHTML = 'All six combined<small>slower: reads every image</small>';
    bands.appendChild(all);
    bands.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (btn) setBands(btn.dataset.bands);
    });

    $('modes').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (btn) setMode(btn.dataset.mode);
    });
    $('ref').addEventListener('change', () => { state.ref = $('ref').value; syncUrl(); rebuild(); });
    $('tree').addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-band]');
      if (tr) setBands(tr.dataset.band);
    });

    $('search').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fov = Number($('fov').value);
      if (Number.isFinite(fov)) state.fov = fov;
      submit($('q').value);
    });
    $('fov').addEventListener('change', () => { state.fov = Number($('fov').value); load(); });

    $('speed').addEventListener('input', () => { state.speed = Number($('speed').value); syncControls(); syncUrl(); schedule(); });
    $('white').addEventListener('input', () => { state.white = sliderToWhite(Number($('white').value)); syncControls(); syncUrl(); draw(); });
    $('black').addEventListener('input', () => { state.black = Number($('black').value); syncControls(); syncUrl(); draw(); });
    $('smooth').addEventListener('input', () => { state.smooth = Number($('smooth').value); syncControls(); syncUrl(); rebuild(); });
    $('invert').addEventListener('change', () => { state.invert = $('invert').checked; syncUrl(); draw(); });
    $('interp').addEventListener('change', () => { state.interp = $('interp').checked; draw(); });
    $('marks').addEventListener('change', () => { state.marks = $('marks').checked; draw(); });

    $('play').addEventListener('click', () => setPlaying(!state.playing));
    $('prev').addEventListener('click', () => step(-1));
    $('next').addEventListener('click', () => step(1));

    document.addEventListener('keydown', (ev) => {
      const tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === ' ') { ev.preventDefault(); setPlaying(!state.playing); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
      else if (ev.key >= '1' && ev.key <= '6') setBands(ev.key);
      else if (ev.key === 'd' || ev.key === 'D') setMode(state.mode === 'diff' ? 'blink' : 'diff');
    });

    canvas.addEventListener('mousemove', (ev) => {
      const d = state.data, f = state.shown[state.frame];
      if (!d || !f) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.floor((ev.clientX - r.left) / r.width * d.n);
      const y = Math.floor((ev.clientY - r.top) / r.height * d.n);
      if (x < 0 || y < 0 || x >= d.n || y >= d.n) return;
      hovering = true;
      const pos = pixelToSky(x, y, geometry(d));
      if (sky) sky.setCursor(pos.ra, pos.dec);
      const v = f.px[y * d.n + x];
      $('readout').textContent = fmtRa(pos.ra) + '  ' + fmtDec(pos.dec) + '  ·  ' +
        (v !== v ? 'no data' : !isFinite(v) ? 'saturated'
          : v.toFixed(3) + ' MJy/sr' + (f.kind === 'diff' ? ' (difference)' : ''));
    });
    canvas.addEventListener('mouseleave', () => {
      hovering = false;
      if (sky) sky.setCursor(null);
      defaultReadout();
    });
    window.addEventListener('resize', draw);
  }

  function initFromUrl() {
    const num = (k, fallback, lo, hi) => {
      const v = parseFloat(query.get(k));
      return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
    };
    state.fov = num('fov', DEFAULTS.fov, 60, 1800);
    if (/^[1-6](,[1-6])*$/.test(query.get('bands') || '')) state.bands = query.get('bands');
    if (MODE_HINTS[query.get('mode')]) state.mode = query.get('mode');
    if (/^(auto|first|prev|mean|e\d+)$/.test(query.get('ref') || '')) state.ref = query.get('ref');
    state.speed = num('speed', DEFAULTS.speed, 100, 2000);
    state.white = num('white', DEFAULTS.white, 5, 5000);
    state.black = num('black', DEFAULTS.black, 0, 10);
    state.smooth = num('smooth', DEFAULTS.smooth, 0, 2);
    state.invert = query.get('invert') === '1';
    if (query.get('embed') === '1') document.body.classList.add('embed');
    if (query.get('play') === '0') state.playing = false;
    if (/^\d+$/.test(query.get('frame') || '')) startFrame = Number(query.get('frame'));

    const ra = parseFloat(query.get('ra')), dec = parseFloat(query.get('dec'));
    const preset = TARGETS.find((t) => t.id === query.get('target'));
    if (preset) {
      if (!query.has('bands')) state.bands = preset.bands;
      if (!query.has('fov')) state.fov = preset.fov;
      openTarget(preset, true);
    } else if (Number.isFinite(ra) && Number.isFinite(dec) && ra >= 0 && ra < 360 && Math.abs(dec) <= 90) {
      state.ra = ra;
      state.dec = dec;
      state.name = query.get('name') || '';
      const t = (query.get('track') || '').split(',').map(Number);
      if (t.length === 5 && t.every(Number.isFinite)) state.track = { ra: t[0], dec: t[1], epoch: t[2], pmra: t[3], pmdec: t[4] };
      $('q').value = state.name || ra + ' ' + dec;
      load();
    } else if (TARGETS.length) {
      openTarget(TARGETS[0], false);
    } else {
      syncControls();
      setMessage('Enter coordinates or an object name to start.');
    }
  }

  buildControls();
  initSky();
  initFromUrl();
})();
