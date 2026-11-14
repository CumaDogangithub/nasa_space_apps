/* SPHEREx Blink Tree - front end. Plain script, no build step. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const I18N = window.BlinkI18n;
  const T = I18N.t, TN = I18N.tn;        // texts in the page's language, see i18n.js
  const query = new URLSearchParams(location.search);
  // Opened from disk (file://) the page talks to a local server; otherwise to its own origin.
  const API = query.get('api') || (location.protocol === 'file:' ? 'http://localhost:8000' : '');
  const TARGETS = window.BLINK_TARGETS || [];
  const BANDS = { 1: [0.75, 1.10], 2: [1.10, 1.63], 3: [1.63, 2.42], 4: [2.42, 3.82], 5: [3.82, 4.42], 6: [4.42, 5.00] };
  const ALL_BANDS = '1,2,3,4,5,6';
  const SURVEY_YEAR = 2026.0;            // moving targets are centred where they are around this date
  const D2R = Math.PI / 180;
  const ASEC = 3600 * 180 / Math.PI;     // arcseconds per radian
  // limit: the most exposures of one detector read for each visit (0 = all); the server's default is the same
  const DEFAULTS = { fov: 240, bands: '2', limit: 40, mode: 'blink', ref: 'auto', speed: 600, white: 60, black: 3, smooth: 0 };
  const MODES = ['blink', 'diff', 'sum'];

  const state = {
    target: '', name: '', ra: null, dec: null,
    track: null,                         // {ra, dec, epoch, pmra, pmdec} of a moving target
    fov: DEFAULTS.fov, bands: DEFAULTS.bands, limit: DEFAULTS.limit, mode: DEFAULTS.mode, ref: DEFAULTS.ref,
    speed: DEFAULTS.speed, white: DEFAULTS.white, black: DEFAULTS.black, smooth: DEFAULTS.smooth,
    invert: false, interp: true, marks: true,
    gaia: false, gaiaData: null,         // overlay of Gaia DR3 stars: on/off and the stars around the field
    flags: false, flagData: null,        // SPHEREx quality flags: on/off and the flag maps of the frames
    playing: true, frame: 0,
    data: null, summary: null,
    shown: []                            // frames after applying the view mode and smoothing
  };

  const memo = new Map();
  const gaiaMemo = new Map();
  const FAST_MOVER = 150;                // proper motion in mas/yr above which a Gaia star is highlighted
  const ARROW_YEARS = 5;                 // length of a fast mover's arrow, in years of motion
  let gaiaToken = 0;
  const flagMemo = new Map();
  const flagCanvas = document.createElement('canvas');
  let flagToken = 0;
  let flagCanvasKey = '';
  let exposureKey = '';
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
    return bands === ALL_BANDS ? T('band.all.name') : bands.split(',').map((b) => 'D' + b).join('+');
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
      : { error: T('msg.coords') };
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

  // ---------------------------------------------------------------- offline demo
  //
  // If the server cannot be reached (the page was opened straight from disk, or
  // the server is down) the five example targets are shown from recorded answers
  // in web/demo/<id>.js, made by scripts/build_demo.py. ?demo=1 forces this mode.

  const noServer = () => T('demo.start');
  let demo = query.get('demo') === '1';
  const bundles = {};

  function showDemoBanner(made) {
    const el = $('demo-banner');
    el.hidden = false;
    el.textContent = made
      ? T('demo.banner', { date: made, start: noServer() })
      : T('demo.banner.nodate', { start: noServer() });
  }

  /* The recorded data of the example target on screen (loaded on first use). */
  function demoBundle() {
    const id = state.target;
    if (!id) return Promise.reject(new Error(T('demo.only', { start: noServer() })));
    if (!bundles[id]) {
      bundles[id] = new Promise((resolve, reject) => {
        const have = () => window.BLINK_DEMO && window.BLINK_DEMO[id];
        if (have()) { resolve(have()); return; }
        const tag = document.createElement('script');
        tag.src = 'demo/' + id + '.js';
        tag.onload = () => (have() ? resolve(have()) : reject(new Error(T('demo.unreadable'))));
        tag.onerror = () => reject(new Error(T('demo.missing', { id: id })));
        document.head.appendChild(tag);
      });
      bundles[id].then((b) => showDemoBanner(b.made), () => { delete bundles[id]; });
    }
    return bundles[id];
  }

  function base64ToBuffer(text) {
    const bin = atob(text), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  /* Answer a request to the server from the recorded data. */
  async function demoAnswer(path) {
    const what = path.split('?')[0].replace('/api/', '');
    const q = new URLSearchParams(path.split('?')[1] || '');
    if (what === 'progress') return { label: '', fraction: 0 };
    if (what === 'resolve') throw new Error(T('demo.resolve', { start: noServer() }));
    const b = await demoBundle();
    if (what === 'search') return b.search;
    if (what === 'gaia') return b.gaia;
    if (what === 'spectrum') {
      if (q.get('track')) return b.spectrum;
      throw new Error(T('demo.spectrum', { start: noServer() }));
    }
    if (what === 'frames' || what === 'flags') {
      if (Math.abs(Number(q.get('fov')) - b.fov) > 0.5) {
        throw new Error(T('demo.fov', { fov: fmtAngle(b.fov), start: noServer() }));
      }
      const recorded = b[what][q.get('bands')];
      if (!recorded) {
        throw new Error(what === 'flags' ? T('demo.flags', { band: bandName(b.bands) }) : T('demo.view', { start: noServer() }));
      }
      return base64ToBuffer(recorded);
    }
    throw new Error(T('demo.na'));
  }

  async function getJSON(path) {
    if (demo) return demoAnswer(path);
    const r = await fetch(API + path);
    if (!r.ok) throw new Error(await errorText(r));
    return r.json();
  }

  async function getBinary(path) {
    if (demo) return demoAnswer(path);
    const r = await fetch(API + path);
    if (!r.ok) throw new Error(await errorText(r));
    return r.arrayBuffer();
  }

  /* The server explains its errors in English; say the ones we know in the page's language. */
  const SERVER_TEXT = [
    [/^archive_unavailable$/, 'server.archive'],
    [/^SPHEREx image search failed: ([\s\S]*)$/, 'server.search'],
    [/^Could not build frames: ([\s\S]*)$/, 'server.frames'],
    // the page itself says that these two failed, so only the reason is kept
    [/^Could not read the quality flags: ([\s\S]*)$/, null],
    [/^Could not measure the spectrum: ([\s\S]*)$/, null],
    [/^The Gaia archive did not answer: ([\s\S]*)$/, 'server.gaia'],
    [/^'([\s\S]*)' was not found in SIMBAD$/, 'server.notfound'],
    [/^SIMBAD has no coordinates for '([\s\S]*)'$/, 'server.nocoords'],
    [/^Name lookup failed: ([\s\S]*)$/, 'server.lookup']
  ];

  function serverText(detail) {
    for (let i = 0; i < SERVER_TEXT.length; i++) {
      const m = SERVER_TEXT[i][0].exec(detail);
      if (m) return SERVER_TEXT[i][1] ? T(SERVER_TEXT[i][1], { x: m[1] }) : m[1];
    }
    return detail;
  }

  async function errorText(r) {
    try {
      const body = await r.json();
      return typeof body.detail === 'string' ? serverText(body.detail) : T('msg.rejected', { status: r.status });
    } catch (e) {
      return T('msg.error', { status: r.status });
    }
  }

  function decodeFrames(buf) {
    const view = new DataView(buf);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'SBT1') throw new Error(T('msg.unexpected'));
    const headLen = view.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headLen)));
    const size = head.n * head.n;
    const all = new Float32Array(buf, 8 + headLen, head.n_frames * size);
    head.frames = [];
    for (let i = 0; i < head.n_frames; i++) head.frames.push(all.subarray(i * size, (i + 1) * size));
    return head;
  }

  async function fetchFrames(ra, dec, fov, bands, limit, onProgress) {
    const job = Math.random().toString(36).slice(2);
    const poll = setInterval(() => {
      getJSON('/api/progress?job=' + job).then(onProgress).catch(() => {});
    }, 400);
    try {
      return decodeFrames(await getBinary(
        '/api/frames?ra=' + ra + '&dec=' + dec + '&fov=' + fov + '&bands=' + bands + '&limit=' + limit + '&job=' + job));
    } finally {
      clearInterval(poll);
    }
  }

  /* The archive's image search is sometimes down. The server then works from the lists it stored
     earlier; say so, because the newest images, or a few of them, may be missing. */
  function noteArchive(info) {
    const el = $('archive-note'), source = info && info.source;
    el.hidden = source !== 'stale' && source !== 'incomplete';
    if (!el.hidden) el.textContent = T('archive.' + source);
  }

  function explain(err) {
    const text = String((err && err.message) || err);
    return /failed to fetch|networkerror|load failed/i.test(text) ? T('msg.noserver') : text;
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
    return T(parts[1] === 'headers' ? 'prog.headers' : 'prog.pixels', { band: parts[0] });
  }

  function loadSummary() {
    const key = state.ra.toFixed(5) + '|' + state.dec.toFixed(5);
    if (key === summaryKey) return;
    summaryKey = key;
    state.summary = null;
    noteArchive(null);                 // a note about the previous field says nothing about this one
    renderTree();
    if (sky) sky.setFootprints([]);
    getJSON('/api/search?ra=' + state.ra + '&dec=' + state.dec).then((s) => {
      if (key !== summaryKey) return;
      state.summary = s;
      noteArchive(s.archive);
      if (sky) sky.setFootprints(s.footprints || []);
      renderTree();
      renderFacts();
    }).catch(() => {});
  }

  async function load() {
    if (state.ra === null) return;
    const token = ++loadToken;
    const key = [state.ra.toFixed(5), state.dec.toFixed(5), state.fov, state.bands, state.limit].join('|');
    if (spec && specField !== state.ra.toFixed(5) + '|' + state.dec.toFixed(5)) clearSpectrum();   // a new field
    syncUrl();
    syncControls();
    setMessage('');
    loadSummary();
    loadGaia();
    loadFlags();
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
      showProgress(0, T('prog.asking'));
      try {
        data = await fetchFrames(state.ra, state.dec, state.fov, state.bands, state.limit, (p) => {
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
    let html = ['auto', 'first', 'prev', 'mean'].map((v) =>
      '<option value="' + v + '">' + esc(T('ref.' + v)) + '</option>').join('');
    if (d && d.n_frames) {
      html += d.epochs.map((e) => '<option value="e' + e.epoch + '">' +
        esc(T('ref.epoch', { date: e.date, exposures: TN('unit.exposures', e.n_exposures) })) + '</option>').join('');
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
            epoch: -1, date: T('frame.all'),
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
            minus: mean ? T('frame.average') : d.epochs[j].date
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
        ? T('msg.toofew', { exposures: TN('unit.exposures', d.n_used), band: bandName(state.bands) })
        : T('msg.noimages', { band: bandName(state.bands) }));
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

  // ---------------------------------------------------------------- spectrum

  const plot = window.BlinkSpectrum || null;
  const APERTURE_ARCSEC = 12.3;          // radius of the measuring circle used by the server
  let spec = null;                       // {ra, dec, moving, data}: the source being measured
  let specField = '';                    // the field it belongs to
  let specToken = 0;
  let specView = 'spectrum';
  let specKind = 'core';                 // 'core': the star itself; 'ring': the light around a saturated star
  let specRejected = 0;                  // exposures set aside as outliers in the plot

  function setSpecStatus(text) { $('spec-status').textContent = text; }

  function syncSpecControls() {
    document.querySelectorAll('#spec-views button').forEach((b) => b.classList.toggle('active', b.dataset.view === specView));
  }

  function clearSpectrum() {
    ++specToken;
    spec = null;
    specKind = 'core';
    $('spec-kind').hidden = true;
    $('spec-progress').hidden = true;
    if (plot) plot.setData(null);
    setSpecStatus(T('spec.hint'));
  }

  /* What the plot shows: the star itself or, for a saturated star, the ring of light around it. */
  function specPlotData() {
    const res = spec && spec.data;
    if (!res) return null;
    if (specKind !== 'ring' || !res.ring) return res;
    const points = res.points.map((p, i) => {
      const r = res.ring[i];
      return [p[0], p[1], r ? r[0] : null, r ? r[1] : null, p[4], p[5], p[6], 0];
    });
    return Object.assign({}, res, { points: points });
  }

  function specSummary() {
    const res = spec.data, ring = specKind === 'ring' && !!res.ring;
    const name = state.name || T('spec.target.name');
    const position = fmtRa(spec.ra) + ' ' + fmtDec(spec.dec);
    const fast = spec.moving && state.track && Math.hypot(state.track.pmra, state.track.pmdec) >= 100;
    let text;
    if (ring) {
      text = T('spec.summary.ring', {
        name: spec.moving ? name : position,
        a: res.n_saturated, b: res.points.length, r0: res.ring_arcsec[0], r1: res.ring_arcsec[1],
        exposures: TN('unit.exposures', res.ring.filter((r) => r).length)
      });
    } else {
      text = T('spec.summary.core', {
        where: !spec.moving ? position : fast ? T('spec.where.moving', { name: name }) : name,
        exposures: TN('unit.exposures', res.n_points), epochs: TN('unit.epochs', res.epochs.length),
        r: res.aperture_arcsec
      });
      if (res.n_saturated) text += T('spec.summary.saturated', { exposures: TN('unit.exposures', res.n_saturated) });
    }
    if (res.thinned) text += T('spec.summary.thinned', { a: res.n_read, b: res.n_found });
    if (specRejected) text += T('spec.summary.rejected', { exposures: TN('unit.exposures', specRejected) });
    if (res.archive && res.archive.source === 'incomplete') text += T('spec.summary.offline');
    return text;
  }

  /* Put the measurement on the plot in the chosen form and describe it. */
  function showSpectrum() {
    const res = spec.data;
    $('spec-kind').hidden = !res.ring;
    document.querySelectorAll('#spec-kind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === specKind));
    plot.setUnits(specKind === 'ring' && res.ring ? T('spec.units.ring') : T('spec.units.flux'));
    specRejected = plot.setData(specPlotData());
    setSpecStatus(specSummary());
    draw();                               // the circles on the blink image follow the choice
  }

  /* Is the star at this position saturated in the frame on screen? */
  function saturatedAt(ra, dec) {
    const d = state.data, f = state.shown[state.frame];
    if (!d || !f || f.kind !== 'image') return false;
    const q = skyToPixel(ra, dec, geometry(d)), ci = Math.round(q.x), cj = Math.round(q.y);
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        if (i >= 0 && j >= 0 && i < d.n && j < d.n && f.px[j * d.n + i] === Infinity) return true;
      }
    }
    return false;
  }

  /* Measure a sky position (or the moving target) in every exposure and plot the result.
     `wide` tells the server the star is saturated, so it measures the ring around it straight away. */
  function measureSpectrum(pos, moving, quiet, wide) {
    if (!plot || state.ra === null) return;
    const token = ++specToken;
    spec = { ra: pos.ra, dec: pos.dec, moving: moving, data: null };
    specField = state.ra.toFixed(5) + '|' + state.dec.toFixed(5);
    specKind = 'core';
    $('spec-kind').hidden = true;
    plot.setData(null);
    syncUrl();
    draw();
    const job = Math.random().toString(36).slice(2);
    let url = '/api/spectrum?ra=' + pos.ra + '&dec=' + pos.dec + '&job=' + job + (wide ? '&wide=1' : '');
    if (moving) {
      const t = state.track;
      url += '&track=' + [t.ra, t.dec, t.epoch, t.pmra, t.pmdec].join(',');
    }
    setSpecStatus(T('spec.measuring'));
    $('spec-progress').hidden = false;
    $('spec-bar').style.width = '0%';
    $('spec-progress-label').textContent = T('spec.asking');
    const poll = setInterval(() => {
      getJSON('/api/progress?job=' + job).then((p) => {
        if (token !== specToken || !p.label) return;
        $('spec-bar').style.width = Math.round(100 * p.fraction) + '%';
        $('spec-progress-label').textContent = p.label === 'headers'
          ? T('spec.finding') : T('spec.reading');
      }).catch(() => {});
    }, 400);
    getJSON(url).then((res) => {
      if (token !== specToken) return;
      spec.data = res;
      noteArchive(res.archive);
      if (res.ring && res.mostly_saturated) {          // a saturated star: its light curve is what can be trusted
        specKind = 'ring';
        specView = 'curve';
        plot.setView(specView);
        syncSpecControls();
      }
      showSpectrum();
    }).catch((err) => {
      if (token === specToken) setSpecStatus(T('spec.failed') + explain(err));
    }).finally(() => {
      clearInterval(poll);
      if (token === specToken) $('spec-progress').hidden = true;
    });
    if (!quiet) $('spectrum-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* A click on the blink image: the tracked target if it was hit, otherwise the brightest pixel nearby. */
  function pickSpectrum(x, y) {
    const d = state.data, f = state.shown[state.frame];
    if (!d || !f || !plot) return;
    const g = geometry(d);
    if (state.track && f.meta.mjd) {
      const t = propagate(state.track, yearOf(f.meta.mjd)), q = skyToPixel(t.ra, t.dec, g);
      if (Math.hypot(q.x - x, q.y - y) * d.scale <= 10) {
        measureSpectrum({ ra: state.ra, dec: state.dec }, true, false, saturatedAt(t.ra, t.dec));
        return;
      }
    }
    let bx = x, by = y;
    if (f.kind === 'image') {
      let best = -Infinity;
      for (let j = Math.max(0, y - 2); j <= Math.min(d.n - 1, y + 2); j++) {
        for (let i = Math.max(0, x - 2); i <= Math.min(d.n - 1, x + 2); i++) {
          const v = f.px[j * d.n + i];
          if (v === v && v > best) { best = v; bx = i; by = j; }
        }
      }
    }
    const pos = pixelToSky(bx, by, g);
    measureSpectrum(pos, false, false, saturatedAt(pos.ra, pos.dec));
  }

  /* Dashed circles on the blink image: what is being measured, drawn to scale. */
  function drawSpecMarker(ctx, f, g, s, dpr) {
    if (!spec) return;
    let where = spec;
    if (spec.moving && state.track && f.meta.mjd) where = propagate(state.track, yearOf(f.meta.mjd));
    const q = skyToPixel(where.ra, where.dec, g);
    if (!insideFrame(q, g.n)) return;
    const ring = specKind === 'ring' && spec.data && spec.data.ring;
    const radii = ring ? spec.data.ring_arcsec : [APERTURE_ARCSEC];
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = '#f2e56b';
    radii.forEach((arcsec) => {
      ctx.beginPath();
      ctx.arc((q.x + 0.5) * s, (q.y + 0.5) * s, Math.max(6 * dpr, arcsec / g.scale * s), 0, 2 * Math.PI);
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  // ---------------------------------------------------------------- quality flags

  function decodeFlags(buf) {
    const view = new DataView(buf);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'SBF1') throw new Error(T('msg.unexpected'));
    const headLen = view.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headLen)));
    const count = head.n_frames * head.n * head.n;
    head.fraction = new Uint8Array(buf, 8 + headLen, count);                 // share of exposures flagged, 0-255
    head.common = new Int32Array(buf, 8 + headLen + Math.ceil(count / 4) * 4, count);   // flags set in many exposures
    return head;
  }

  function setFlagsNote(text) {
    const el = $('flags-note');
    el.textContent = text || '';
    el.hidden = !text;
  }

  /* Fetch SPHEREx's own quality flags for the frames on screen while the overlay is on. */
  function loadFlags() {
    const token = ++flagToken;
    flagCanvasKey = '';
    exposureKey = '';
    if (!state.flags || state.ra === null) {
      state.flagData = null;
      setFlagsNote('');
      draw();
      return;
    }
    const key = [state.ra.toFixed(5), state.dec.toFixed(5), state.fov, state.bands, state.limit].join('|');
    const done = (data) => {
      data.key = key;
      state.flagData = data;
      setFlagsNote(T('flags.note'));
      draw();
    };
    if (flagMemo.has(key)) { done(flagMemo.get(key)); return; }
    state.flagData = null;
    setFlagsNote(T('flags.loading'));
    draw();
    const job = Math.random().toString(36).slice(2);
    const poll = setInterval(() => {
      getJSON('/api/progress?job=' + job).then((p) => {
        if (token === flagToken && p.label) {
          setFlagsNote(T('flags.loading') + ' ' + Math.round(100 * p.fraction) + '%');
        }
      }).catch(() => {});
    }, 400);
    getBinary('/api/flags?ra=' + state.ra + '&dec=' + state.dec + '&fov=' + state.fov + '&bands=' + state.bands +
      '&limit=' + state.limit + '&job=' + job)
      .then(decodeFlags)
      .then((data) => {
        flagMemo.set(key, data);
        if (token === flagToken) done(data);
      })
      .catch((err) => {
        if (token === flagToken) setFlagsNote(T('flags.failed') + explain(err));
      })
      .finally(() => clearInterval(poll));
  }

  /* Which flag frame goes with the blink frame on screen (-1 if none). */
  function flagFrame(f) {
    const fd = state.flagData;
    if (!state.flags || !fd || !state.data || fd.n !== state.data.n || !f) return -1;
    return fd.epochs.findIndex((e) => e.epoch === f.meta.epoch);
  }

  /* Names of the flags in a bit mask; trouble flags first, informative ones only if asked for. */
  function flagList(bits, withInfo) {
    const fd = state.flagData, trouble = [], info = [];
    Object.keys(fd.names).forEach((b) => {
      if (!(bits >> Number(b) & 1)) return;
      const name = fd.names[b][0], key = 'flag.' + name, plain = T(key);
      // plain words where we have them, always with the mission's own wording
      const about = plain === key ? fd.names[b][1] : T('flag.official', { plain: plain, official: fd.names[b][1] });
      const entry = { name: name, about: about, info: fd.info_bits.indexOf(Number(b)) >= 0 };
      (entry.info ? info : trouble).push(entry);
    });
    return withInfo ? trouble.concat(info) : trouble;
  }

  /* Pink tint over the pixels SPHEREx flagged in a good share of the exposures behind the frame. */
  function drawFlags(ctx, W, f) {
    const idx = flagFrame(f);
    if (idx < 0) return;
    const fd = state.flagData, n = fd.n, size = n * n, key = fd.key + '|' + idx;
    if (key !== flagCanvasKey) {
      flagCanvas.width = n;
      flagCanvas.height = n;
      const fctx = flagCanvas.getContext('2d'), img = fctx.createImageData(n, n), out = img.data;
      const limit = Math.round(255 * fd.common_share), base = idx * size;
      for (let i = 0, j = 0; i < size; i++, j += 4) {
        const v = fd.fraction[base + i];
        if (v < limit) continue;
        out[j] = 255; out[j + 1] = 60; out[j + 2] = 120;
        out[j + 3] = Math.round(70 + 110 * (v - limit) / (255 - limit));
      }
      fctx.putImageData(img, 0, 0);
      flagCanvasKey = key;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(flagCanvas, 0, 0, W, W);
  }

  /* Describe the flags under the pointer. */
  function flagHover(x, y, f) {
    const idx = flagFrame(f);
    if (idx < 0) return '';
    const fd = state.flagData, at = idx * fd.n * fd.n + y * fd.n + x;
    const names = flagList(fd.common[at], false).map((e) => e.name);
    if (!names.length) return '';
    return '  ·  ' + T('flags.hover', { names: names.join(', '), p: Math.round(100 * fd.fraction[at] / 255) });
  }

  /* Table of the exposures stacked into the frame on screen. */
  function renderExposures() {
    const wrap = $('exposures-wrap'), fd = state.flagData, f = state.shown[state.frame];
    if (!state.flags || !fd || !f) {
      wrap.hidden = true;
      exposureKey = '';
      return;
    }
    const key = fd.key + '|' + f.meta.epoch;
    if (key === exposureKey) return;
    exposureKey = key;
    const rows = fd.exposures.filter((e) => f.meta.epoch === -1 || e.epoch === f.meta.epoch);
    const flagged = rows.filter((e) => flagList(e.flags, false).length).length;
    wrap.hidden = false;
    $('exposures-note').textContent = T('exp.note', { exposures: TN('unit.exposures', rows.length), k: flagged });
    const body = rows.map((e) => {
      const chips = flagList(e.flags, true).map((c) =>
        '<span class="flag' + (c.info ? ' info' : '') + '" title="' + esc(c.about) + '">' + esc(c.name) + '</span>').join('');
      return '<tr><td>' + esc(e.time) + '</td><td>D' + e.band + '</td><td>' + e.wavelength.toFixed(3) + ' µm</td><td>' +
        (chips || '<span class="flag info">' + esc(T('exp.none')) + '</span>') + '</td><td><a href="' + esc(e.url) +
        '" target="_blank" rel="noopener" title="' + esc(T('exp.open')) + '">' + esc(e.uid) + '</a></td></tr>';
    }).join('');
    $('exposures').innerHTML = '<table><thead><tr><th>' + esc(T('exp.col.time')) + '</th><th>' + esc(T('exp.col.detector')) +
      '</th><th>' + esc(T('exp.col.wave')) + '</th><th>' + esc(T('exp.col.flags')) + '</th><th>' + esc(T('exp.col.file')) +
      '</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  // ---------------------------------------------------------------- Gaia overlay

  function setGaiaNote(text) {
    const el = $('gaia-note');
    el.textContent = text || '';
    el.hidden = !text;
  }

  /* Fetch the Gaia DR3 stars around the field (once per field) while the overlay is on. */
  function loadGaia() {
    const token = ++gaiaToken;
    if (!state.gaia || state.ra === null) {
      state.gaiaData = null;
      setGaiaNote('');
      renderFacts();
      draw();
      return;
    }
    const key = [state.ra.toFixed(5), state.dec.toFixed(5), state.fov].join('|');
    const done = (g) => {
      state.gaiaData = g;
      setGaiaNote(T('gaia.note', { years: ARROW_YEARS }) + (g.truncated ? T('gaia.truncated', { n: g.sources.length }) : ''));
      renderFacts();
      draw();
    };
    if (gaiaMemo.has(key)) { done(gaiaMemo.get(key)); return; }
    state.gaiaData = null;
    setGaiaNote(T('gaia.loading'));
    draw();
    getJSON('/api/gaia?ra=' + state.ra + '&dec=' + state.dec + '&fov=' + state.fov).then((g) => {
      gaiaMemo.set(key, g);
      if (token === gaiaToken) done(g);
    }).catch((err) => {
      if (token === gaiaToken) setGaiaNote(T('gaia.failed') + explain(err));
    });
  }

  /* Gaia stars that fall inside the frame, moved to the date of that frame. */
  function gaiaInFrame(f) {
    const d = state.data, out = [];
    if (!d || !state.gaiaData || !f) return out;
    const g = geometry(d), year = yearOf(f.meta.mjd), epoch = state.gaiaData.epoch;
    state.gaiaData.sources.forEach((src) => {
      const pmra = src[3] || 0, pmdec = src[4] || 0;
      const p = propagate({ ra: src[1], dec: src[2], epoch: epoch, pmra: pmra, pmdec: pmdec }, year);
      const q = skyToPixel(p.ra, p.dec, g);
      if (insideFrame(q, d.n)) {
        out.push({ x: q.x, y: q.y, src: src, pmra: pmra, pmdec: pmdec, pm: Math.hypot(pmra, pmdec) });
      }
    });
    return out;
  }

  function drawGaia(ctx, f, s, dpr) {
    if (!state.gaia || !state.gaiaData) return;
    const scale = state.data.scale;
    gaiaInFrame(f).forEach((q) => {
      const cx = (q.x + 0.5) * s, cy = (q.y + 0.5) * s;
      const fast = q.pm >= FAST_MOVER;
      const mag = q.src[6] === null ? 18 : q.src[6];
      const r = (fast ? 10 : clamp(9 - 0.55 * (mag - 8), 3.5, 9)) * dpr;
      ctx.lineWidth = (fast ? 2 : 1.2) * dpr;
      // fainter stars get fainter circles, so a crowded field stays readable
      ctx.strokeStyle = fast ? '#ff7ad9' : 'rgba(111, 214, 255, ' + clamp(1.25 - 0.06 * (mag - 8), 0.4, 0.95).toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.stroke();
      if (!fast) return;

      // Arrow to where the star will be in ARROW_YEARS (east is left, north is up).
      const dx = -q.pmra * ARROW_YEARS / 1000 / scale * s, dy = -q.pmdec * ARROW_YEARS / 1000 / scale * s;
      const len = Math.hypot(dx, dy);
      let labelX = cx + r + 4 * dpr, labelY = cy - r;      // beside the circle unless there is an arrow
      if (len > r + 6 * dpr) {
        const ux = dx / len, uy = dy / len, ex = cx + dx, ey = cy + dy, head = 7 * dpr;
        labelX = ex + 8 * dpr;
        labelY = ey + 6 * dpr;
        ctx.beginPath();
        ctx.moveTo(cx + ux * r, cy + uy * r);
        ctx.lineTo(ex, ey);
        ctx.moveTo(ex + head * (-ux * 0.87 + uy * 0.5), ey + head * (-ux * 0.5 - uy * 0.87));
        ctx.lineTo(ex, ey);
        ctx.lineTo(ex + head * (-ux * 0.87 - uy * 0.5), ey + head * (ux * 0.5 - uy * 0.87));
        ctx.stroke();
      }
      ctx.font = '600 ' + Math.round(11.5 * dpr) + 'px system-ui, sans-serif';
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.fillStyle = '#ff9be3';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      outlined(ctx, T('gaia.rate', { v: (q.pm / 1000).toFixed(2) }), labelX, labelY);
    });
  }

  /* Describe the Gaia star under the pointer, if there is one. */
  function gaiaHover(x, y, f) {
    if (!state.gaia || !state.gaiaData) return '';
    const d = state.data;
    let best = null, reach = Math.max(1.5, 9 * d.n / canvas.clientWidth);
    gaiaInFrame(f).forEach((q) => {
      const dist = Math.hypot(q.x - x, q.y - y);
      if (dist <= reach) { best = q; reach = dist; }
    });
    if (!best) return '';
    const mag = best.src[6], parallax = best.src[5];
    let text = '  ·  ' + T('gaia.hover');
    if (mag !== null) text += ', G = ' + mag.toFixed(1);
    if (best.pm >= 1) {
      text += ', ' + T('gaia.hover.moving', {
        v: best.pm >= 1000 ? (best.pm / 1000).toFixed(2) + '″' : best.pm.toFixed(0) + ' mas'
      });
    }
    if (parallax && parallax > 0.5) {
      text += ', ' + T('gaia.hover.distance', { d: Math.round(3261.6 / parallax).toLocaleString(I18N.locale) });
    }
    return text;
  }

  function overlays(ctx, W, dpr, f) {
    const d = state.data, g = geometry(d), s = W / d.n;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    drawGaia(ctx, f, s, dpr);
    drawSpecMarker(ctx, f, g, s, dpr);

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
    ctx.fillStyle = '#9cc4ff';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const title = f.kind === 'diff' ? f.meta.date + '  −  ' + f.minus : f.meta.date;
    outlined(ctx, title, 10 * dpr, 9 * dpr);
    ctx.font = Math.round(12 * dpr) + 'px system-ui, sans-serif';
    ctx.fillStyle = '#f1f4fa';
    outlined(ctx, bandName(state.bands) + '  ' + bandRange(state.bands) + '  ·  ' + TN('unit.exposures', f.meta.n_exposures), 10 * dpr, 27 * dpr);

    // compass: north up, east left
    const L = 24 * dpr, ox = 16 * dpr + L, oy = W - 16 * dpr;
    ctx.lineWidth = 3.5 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      ctx.moveTo(ox - L, oy); ctx.lineTo(ox, oy); ctx.lineTo(ox, oy - L);
      ctx.stroke();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#f1f4fa';
    }
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    outlined(ctx, T('compass.n'), ox, oy - L - 9 * dpr);
    outlined(ctx, T('compass.e'), ox - L - 9 * dpr, oy);

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
      ctx.strokeStyle = '#f1f4fa';
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
    ctx.fillStyle = '#010204';
    ctx.fillRect(0, 0, W, W);
    const f = state.shown[state.frame];
    if (f) {
      paint(f, state.data.n);
      ctx.imageSmoothingEnabled = state.interp;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(off, 0, 0, W, W);
      drawFlags(ctx, W, f);
      overlays(ctx, W, dpr, f);
    }
    markTimeline();
    markTree();
    syncSky();
    renderExposures();
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
    $('sky-full').textContent = on ? T('sky.full.exit') : T('sky.full');
  }

  function footprintNote(ev) {
    if (!ev.total) return T('sky.feet.none');
    const exposures = TN('unit.exposures', ev.total);
    return ev.drawn && ev.drawn < ev.total
      ? T('sky.feet.drawn', { exposures: exposures, n: ev.drawn })
      : T('sky.feet.note', { exposures: exposures });
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
    // One button per map instead of a menu: one click, and nothing that has to open first.
    const survey = $('sky-survey');
    const surveyNames = { spherex: 'SPHEREx', wise: 'WISE', twomass: '2MASS', dss: 'DSS' };
    Object.keys(sky.surveys).forEach((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.survey = id;
      b.textContent = surveyNames[id] || id;
      b.title = T('survey.' + id);
      b.classList.toggle('active', id === 'spherex');
      survey.appendChild(b);
    });
    survey.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (b) sky.setSurvey(b.dataset.survey);
    });
    $('sky-feet-note').textContent = T('sky.feet.none');
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
        survey.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.survey === ev.survey));
        $('sky-wave').value = ev.slice;
        $('sky-wave').disabled = !ev.cube;
        $('sky-wave-out').textContent = ev.cube
          ? T('sky.wave.out', { w: ev.wavelength.toFixed(2), d: ev.detector })
          : T('sky.wave.na');
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
    const span = f.meta.date_start === f.meta.date_end ? f.meta.date_start
      : T('readout.span', { a: f.meta.date_start, b: f.meta.date_end });
    $('readout').textContent = T('readout.default', { i: state.frame + 1, n: state.shown.length, span: span });
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
    $('play').textContent = on ? T('play.pause') : T('play.play');
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
      const sub = f.kind === 'diff' ? T('frame.minus', { what: f.minus }) : TN('unit.exposures', f.meta.n_exposures);
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
    if (state.name) rows.push([T('facts.target'), state.name]);
    if (state.ra !== null) rows.push([T('facts.centre'), fmtRa(state.ra) + ' ' + fmtDec(state.dec)]);
    if (state.track && Math.hypot(state.track.pmra, state.track.pmdec) >= 5) {   // mas/yr: below this it would read 0.00
      rows.push([T('facts.pm'), T('facts.pm.value', { v: (Math.hypot(state.track.pmra, state.track.pmdec) / 1000).toFixed(2) })]);
    }
    if (d) {
      rows.push([T('facts.fov'), T('facts.fov.value', { fov: fmtAngle(d.fov), scale: d.scale.toFixed(2) })]);
      rows.push([T('facts.wave'), bandRange(state.bands)]);
      rows.push([T('facts.used'), T(d.thinned ? 'facts.used.limited' : 'facts.used.value',
        { a: d.n_used, b: d.n_found, n: d.per_epoch })]);
      rows.push([T('facts.epochs'), String(d.n_frames)]);
    }
    if (state.gaia && state.gaiaData && state.shown.length) {
      const stars = gaiaInFrame(state.shown[0]);
      const fast = stars.filter((q) => q.pm >= FAST_MOVER).length;
      rows.push([T('facts.gaia'), fast ? T('facts.gaia.fast', { n: stars.length, k: fast }) : String(stars.length)]);
    }
    if (s) {
      rows.push([T('facts.images'), String(s.n_images)]);
      if (s.latest_date) rows.push([T('facts.newest'), s.latest_date]);
    }
    $('facts').innerHTML = rows.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('');
  }

  function renderTree() {
    const s = state.summary, wrap = $('tree-wrap');
    if (!s || !s.epochs.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const head = s.epochs.map((e) =>
      '<th data-epoch="' + e.index + '" title="' + esc(T('readout.span', { a: e.date_start, b: e.date_end })) + '">' + e.date_start.slice(0, 7) + '</th>').join('');
    const body = Object.keys(BANDS).map((b) => {
      let total = 0;
      const cells = s.epochs.map((e) => {
        const c = e.counts[b] || 0;
        total += c;
        return '<td data-epoch="' + e.index + '"' + (c ? '' : ' class="empty"') + '>' + (c || '·') + '</td>';
      }).join('');
      return '<tr data-band="' + b + '"><th>D' + b + '<span>' + bandRange(b) + '</span></th>' + cells + '<td>' + total + '</td></tr>';
    }).join('');
    $('tree').innerHTML = '<table><thead><tr><th>' + esc(T('tree.detector')) + '</th>' + head + '<th>' + esc(T('tree.total')) + '</th></tr></thead><tbody>' + body + '</tbody></table>';
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
    $('limit').value = String(state.limit);
    if ($('limit').value !== String(state.limit)) {      // a number that is not in the list
      const opt = document.createElement('option');
      opt.value = opt.textContent = String(state.limit);
      $('limit').insertBefore(opt, $('limit').lastElementChild);
      $('limit').value = String(state.limit);
    }
    $('limit').disabled = demo;                          // the recorded demo holds one version of each view
    document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    document.querySelectorAll('#examples .chip').forEach((b) => b.classList.toggle('active', b.dataset.target === state.target));
    $('ref-row').hidden = state.mode !== 'diff';
    $('mode-hint').textContent = T('mode.hint.' + state.mode);
    $('speed').value = state.speed;
    $('speed-out').textContent = state.speed + ' ms';
    $('white').value = whiteToSlider(state.white);
    $('white-out').textContent = state.white + ' σ';
    $('black').value = state.black;
    $('black-out').textContent = '−' + state.black + ' σ';
    $('smooth').value = state.smooth;
    $('smooth-out').textContent = state.smooth ? state.smooth + ' px' : T('ctl.off');
    $('invert').checked = state.invert;
    $('interp').checked = state.interp;
    $('marks').checked = state.marks;
    $('gaia').checked = state.gaia;
    $('flags').checked = state.flags;
    $('play').textContent = state.playing ? T('play.pause') : T('play.play');
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
    if (state.gaia) p.set('gaia', '1');
    if (state.flags) p.set('flags', '1');
    if (spec) p.set('spec', spec.moving ? 'target' : spec.ra.toFixed(5) + ',' + spec.dec.toFixed(5));
    ['api', 'embed', 'demo', 'lang'].forEach((k) => { if (query.get(k)) p.set(k, query.get(k)); });
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
    showProgress(0, T('prog.lookup', { name: text }));
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
    ex.appendChild(document.createTextNode(T('examples.try')));
    $('play').textContent = state.playing ? T('play.pause') : T('play.play');
    TARGETS.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.target = t.id;
      b.textContent = t.name;
      b.title = T('target.' + t.id);
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
    all.innerHTML = esc(T('band.all')) + '<small>' + esc(T('band.all.sub')) + '</small>';
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
    $('limit').addEventListener('change', () => { state.limit = Number($('limit').value); load(); });

    $('speed').addEventListener('input', () => { state.speed = Number($('speed').value); syncControls(); syncUrl(); schedule(); });
    $('white').addEventListener('input', () => { state.white = sliderToWhite(Number($('white').value)); syncControls(); syncUrl(); draw(); });
    $('black').addEventListener('input', () => { state.black = Number($('black').value); syncControls(); syncUrl(); draw(); });
    $('smooth').addEventListener('input', () => { state.smooth = Number($('smooth').value); syncControls(); syncUrl(); rebuild(); });
    $('invert').addEventListener('change', () => { state.invert = $('invert').checked; syncUrl(); draw(); });
    $('interp').addEventListener('change', () => { state.interp = $('interp').checked; draw(); });
    $('marks').addEventListener('change', () => { state.marks = $('marks').checked; draw(); });
    $('gaia').addEventListener('change', () => { state.gaia = $('gaia').checked; syncUrl(); loadGaia(); });
    $('flags').addEventListener('change', () => { state.flags = $('flags').checked; syncUrl(); loadFlags(); });

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
      else if (ev.key === 'g' || ev.key === 'G') { state.gaia = !state.gaia; syncControls(); syncUrl(); loadGaia(); }
      else if (ev.key === 'f' || ev.key === 'F') { state.flags = !state.flags; syncControls(); syncUrl(); loadFlags(); }
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
        (v !== v ? T('readout.nodata') : !isFinite(v) ? T('readout.saturated')
          : v.toFixed(3) + ' MJy/sr' + (f.kind === 'diff' ? ' ' + T('readout.difference') : '')) +
        gaiaHover(x, y, f) + flagHover(x, y, f);
    });
    canvas.addEventListener('mouseleave', () => {
      hovering = false;
      if (sky) sky.setCursor(null);
      defaultReadout();
    });
    canvas.addEventListener('click', (ev) => {
      const d = state.data;
      if (!d) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.floor((ev.clientX - r.left) / r.width * d.n);
      const y = Math.floor((ev.clientY - r.top) / r.height * d.n);
      if (x >= 0 && y >= 0 && x < d.n && y < d.n) pickSpectrum(x, y);
    });
    if (plot) {
      plot.init($('spec'), $('spec-legend'));
      $('spec-views').addEventListener('click', (ev) => {
        const btn = ev.target.closest('button');
        if (!btn) return;
        specView = btn.dataset.view;
        plot.setView(specView);
        syncSpecControls();
        if (spec && spec.data) setSpecStatus(specSummary());
      });
      $('spec-kind').addEventListener('click', (ev) => {
        const btn = ev.target.closest('button');
        if (!btn || !spec || !spec.data) return;
        specKind = btn.dataset.kind;
        showSpectrum();
      });
      $('spec-log').addEventListener('change', () => plot.setLog($('spec-log').checked));
      $('spec-target').addEventListener('click', () => {
        if (state.ra === null) return;
        const f = state.shown[state.frame];
        const now = state.track && f && f.meta.mjd ? propagate(state.track, yearOf(f.meta.mjd)) : state;
        measureSpectrum({ ra: state.ra, dec: state.dec }, !!state.track, false, saturatedAt(now.ra, now.dec));
      });
      syncSpecControls();
      clearSpectrum();
    } else {
      $('spectrum-wrap').hidden = true;
    }
    window.addEventListener('resize', draw);
  }

  function initFromUrl() {
    const num = (k, fallback, lo, hi) => {
      const v = parseFloat(query.get(k));
      return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
    };
    state.fov = num('fov', DEFAULTS.fov, 60, 1800);
    state.limit = Math.round(num('limit', DEFAULTS.limit, 0, 5000));
    if (/^[1-6](,[1-6])*$/.test(query.get('bands') || '')) state.bands = query.get('bands');
    if (MODES.indexOf(query.get('mode')) >= 0) state.mode = query.get('mode');
    if (/^(auto|first|prev|mean|e\d+)$/.test(query.get('ref') || '')) state.ref = query.get('ref');
    state.speed = num('speed', DEFAULTS.speed, 100, 2000);
    state.white = num('white', DEFAULTS.white, 5, 5000);
    state.black = num('black', DEFAULTS.black, 0, 10);
    state.smooth = num('smooth', DEFAULTS.smooth, 0, 2);
    state.invert = query.get('invert') === '1';
    state.gaia = query.get('gaia') === '1';
    state.flags = query.get('flags') === '1';
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
      setMessage(T('msg.start'));
    }

    // ?spec=target or ?spec=ra,dec reopens a spectrum
    const wanted = query.get('spec');
    if (wanted && state.ra !== null) {
      const c = wanted.split(',').map(Number);
      if (wanted === 'target') measureSpectrum({ ra: state.ra, dec: state.dec }, !!state.track, true);
      else if (c.length === 2 && c.every(Number.isFinite)) measureSpectrum({ ra: c[0], dec: c[1] }, false, true);
    }
  }

  buildControls();
  initSky();
  if (demo) {
    showDemoBanner();
    initFromUrl();
  } else {
    // Is the server there? If not, fall back to the recorded example targets.
    const probe = new AbortController();
    const giveUp = setTimeout(() => probe.abort(), 2500);
    fetch(API + '/api/health', { signal: probe.signal })
      .then((r) => { if (!r.ok) throw new Error('no server'); })
      .catch(() => { demo = true; showDemoBanner(); })
      .finally(() => { clearTimeout(giveUp); initFromUrl(); });
  }
})();
