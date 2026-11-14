/* SPHEREx Blink Tree - sky map.
 *
 * A globe of the infrared sky (Aladin Lite) showing the SPHEREx all-sky cube
 * served by IRSA: 102 wavelength channels to scrub through. On top of it:
 * the field being blinked and the footprints of the SPHEREx exposures that
 * cover it. The library is loaded on demand; the viewer works without it.
 */
(function () {
  'use strict';

  const LIB = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js';
  const IRSA_HIPS = 'https://irsa.ipac.caltech.edu/data/hips/';
  const SURVEYS = {
    spherex: { label: 'SPHEREx all-sky (102 channels)', url: IRSA_HIPS + 'SPHEREx/spherex_allsky_cube', cube: true },
    wise: { label: 'WISE colour (3.4–22 µm)', url: IRSA_HIPS + 'CDS/AllWISE/RGB-W4-W2-W1' },
    twomass: { label: '2MASS colour (1.2–2.2 µm, sharper)', url: IRSA_HIPS + 'CDS/2MASS/Color' },
    dss: { label: 'DSS colour (visible light)', url: IRSA_HIPS + 'CDS/DSS2/color' }
  };
  // Nominal wavelength in microns of each SPHEREx channel = each frame of the all-sky cube.
  // Frame index = 17 * (detector - 1) + channel. Frames 50 and 51 (the dichroic edge) are empty.
  const WAVE = [
    0.753, 0.771, 0.790, 0.809, 0.828, 0.848, 0.868, 0.889, 0.910, 0.932, 0.955, 0.978, 1.001, 1.025, 1.050, 1.075, 1.102,
    1.113, 1.139, 1.167, 1.195, 1.224, 1.254, 1.284, 1.315, 1.346, 1.378, 1.412, 1.446, 1.481, 1.517, 1.554, 1.592, 1.631,
    1.656, 1.695, 1.735, 1.775, 1.818, 1.861, 1.905, 1.949, 1.995, 2.041, 2.089, 2.139, 2.189, 2.240, 2.292, 2.345, 2.399,
    2.445, 2.506, 2.575, 2.646, 2.719, 2.794, 2.871, 2.951, 3.033, 3.118, 3.204, 3.293, 3.383, 3.476, 3.570, 3.667, 3.768,
    3.833, 3.867, 3.901, 3.935, 3.970, 4.005, 4.040, 4.076, 4.112, 4.148, 4.184, 4.220, 4.257, 4.294, 4.331, 4.368, 4.405,
    4.435, 4.467, 4.500, 4.533, 4.566, 4.600, 4.635, 4.669, 4.704, 4.739, 4.773, 4.808, 4.843, 4.879, 4.915, 4.951, 4.988
  ];
  const EMPTY = [50, 51];
  const WHOLE_SKY = 180;        // degrees
  const SCAN_AREA = 12;         // wide enough to show whole 3.5-degree detector footprints
  const FIELD_MARGIN = 1.06;    // "Field" shows the blink field itself, with a sliver of margin
  const MAX_FOOTPRINTS = 80;
  const D2R = Math.PI / 180;

  let A = null;
  let aladin = null;
  let fieldLayer = null, feetLayer = null, markLayer = null;
  let pointerEl = null;         // white cross mirroring the pointer of the blink image
  let target = null;            // {ra, dec, fov (arcsec)}
  let feet = [];                // [detector, epoch, ra1, dec1, ... ra4, dec4]
  let shown = { epoch: -2, bands: '' };
  let showFeet = true;
  let survey = 'spherex';
  let slice = 25;
  let listener = null;
  let cursor = null;

  /* Tangent-plane offset (degrees east, degrees north) from a centre -> [ra, dec]. */
  function offset(ra0, dec0, east, north) {
    const x = east * D2R, y = north * D2R, d0 = dec0 * D2R;
    const rho = Math.hypot(x, y);
    if (!rho) return [ra0, dec0];
    const c = Math.atan(rho);
    const dec = Math.asin(Math.cos(c) * Math.sin(d0) + y * Math.sin(c) * Math.cos(d0) / rho);
    const ra = ra0 + Math.atan2(x * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - y * Math.sin(d0) * Math.sin(c)) / D2R;
    return [(ra % 360 + 360) % 360, dec / D2R];
  }

  function separation(ra1, dec1, ra2, dec2) {
    const s = Math.sin(dec1 * D2R) * Math.sin(dec2 * D2R) +
      Math.cos(dec1 * D2R) * Math.cos(dec2 * D2R) * Math.cos((ra1 - ra2) * D2R);
    return Math.acos(Math.min(1, Math.max(-1, s))) / D2R;
  }

  function emit(event) {
    if (listener) listener(event);
  }

  function emitSlice() {
    emit({
      type: 'slice', survey: survey, cube: !!SURVEYS[survey].cube, slice: slice,
      wavelength: WAVE[slice], detector: Math.floor(slice / 17) + 1
    });
  }

  function clearCatalog(cat) {
    try { (cat.removeAll || cat.clear).call(cat); } catch (e) { /* nothing to remove */ }
  }

  /* The cube layer needs a moment to read its metadata before a slice can be set. */
  function applySlice(tries) {
    if (!aladin || !SURVEYS[survey].cube) return;
    const layer = aladin.getBaseImageLayer();
    if (layer && layer.cubeDepth && layer.added) {
      try { layer.setSliceNumber(slice); } catch (e) { /* keep the current slice */ }
    } else if (tries < 80) {
      setTimeout(function () { applySlice(tries + 1); }, 250);
    }
  }

  function drawField() {
    if (!aladin || !target) return;
    fieldLayer.removeAll();
    const h = target.fov / 3600 / 2;
    fieldLayer.add(A.polygon([[h, h], [-h, h], [-h, -h], [h, -h]].map(function (o) {
      return offset(target.ra, target.dec, o[0], o[1]);
    })));
    // A fixed-size ring keeps the field findable when the square is only a few pixels wide.
    clearCatalog(markLayer);
    markLayer.addSources([A.source(target.ra, target.dec)]);
  }

  function drawFeet() {
    if (!aladin) return;
    feetLayer.removeAll();
    let list = [];
    if (shown.epoch >= -1) {
      const bands = shown.bands.split(',').map(Number);
      list = feet.filter(function (f) {
        return bands.indexOf(f[0]) >= 0 && (shown.epoch === -1 || f[1] === shown.epoch);
      });
    }
    const total = list.length;
    if (list.length > MAX_FOOTPRINTS) {
      const step = list.length / MAX_FOOTPRINTS;
      list = Array.from({ length: MAX_FOOTPRINTS }, function (_, i) { return list[Math.floor(i * step)]; });
    }
    if (showFeet && list.length) {
      feetLayer.addFootprints(list.map(function (f) {
        return A.polygon([[f[2], f[3]], [f[4], f[5]], [f[6], f[7]], [f[8], f[9]]]);
      }));
    }
    emit({ type: 'footprints', total: total, drawn: showFeet ? list.length : 0 });
  }

  /* Put the mirrored pointer where its sky position falls on the map, or hide it. */
  function placeCursor() {
    if (!aladin || !pointerEl) return;
    let p = null;
    if (cursor) {
      try { p = aladin.world2pix(cursor.ra, cursor.dec); } catch (e) { p = null; }
    }
    const box = pointerEl.parentNode.getBoundingClientRect();
    if (p && isFinite(p[0]) && isFinite(p[1]) && p[0] >= 0 && p[1] >= 0 && p[0] <= box.width && p[1] <= box.height) {
      pointerEl.style.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px)';
      pointerEl.style.display = 'block';
    } else {
      pointerEl.style.display = 'none';
    }
  }

  function fly() {
    if (!aladin || !target) return;
    const here = aladin.getRaDec();
    const fov = aladin.getFov();
    const go = function () {
      aladin.animateToRaDec(target.ra, target.dec, 1.8);
      aladin.zoomToFoV(SCAN_AREA, 2.6);
    };
    // Coming from far away while zoomed in: pull back first so the journey is visible.
    if (separation(here[0], here[1], target.ra, target.dec) > 25 && Math.max(fov[0], fov[1]) < 80) {
      aladin.zoomToFoV(110, 0.8, go);
    } else {
      go();
    }
  }

  // ------------------------------------------------------------------ API

  function init(selector, onEvent) {
    listener = onEvent || null;
    return import(LIB).then(function (mod) {
      A = mod.default;
      return A.init;
    }).then(function () {
      aladin = A.aladin(selector, {
        survey: SURVEYS.spherex.url,
        target: '0 +0', fov: WHOLE_SKY, projection: 'SIN',
        showReticle: true, reticleColor: '#ffb454', reticleSize: 16,
        // The page has its own full-screen mode that keeps the map controls visible.
        showZoomControl: true, showFullscreenControl: false,
        showLayersControl: false, showProjectionControl: false, showCooGridControl: false,
        showSimbadPointerControl: false, showSettingsControl: false, showShareControl: false,
        showColorPickerControl: false, showContextMenu: false,
        showFrame: false, showFov: true, showCooLocation: true, showStatusBar: false,
        backgroundColor: 'rgb(4, 6, 11)', log: false
      });
      feetLayer = A.graphicOverlay({ color: '#5ad19a', lineWidth: 1 });
      fieldLayer = A.graphicOverlay({ color: '#ffb454', lineWidth: 2 });
      aladin.addOverlay(feetLayer);
      aladin.addOverlay(fieldLayer);
      markLayer = A.catalog({ name: 'Blink field', shape: 'circle', sourceSize: 20, color: '#ffb454' });
      aladin.addCatalog(markLayer);
      aladin.on('mouseMove', function (pos) {
        if (pos && isFinite(pos.ra) && isFinite(pos.dec)) emit({ type: 'hover', ra: pos.ra, dec: pos.dec });
      });
      aladin.on('positionChanged', placeCursor);
      aladin.on('zoomChanged', placeCursor);
      const el = document.querySelector(selector);
      if (el) {
        el.addEventListener('mouseleave', function () { emit({ type: 'leave' }); });
        pointerEl = document.createElement('div');
        pointerEl.className = 'sky-pointer';
        el.appendChild(pointerEl);
      }
      applySlice(0);
      emitSlice();
      if (target) { drawField(); fly(); }
      drawFeet();
    });
  }

  function setTarget(ra, dec, fov) {
    const moved = !target || Math.abs(target.ra - ra) > 1e-6 || Math.abs(target.dec - dec) > 1e-6;
    target = { ra: ra, dec: dec, fov: fov };
    if (!aladin) return;
    drawField();
    if (moved) fly();
  }

  function setFootprints(list) {
    feet = list || [];
    drawFeet();
  }

  /* epoch: index of the epoch on screen, -1 for all epochs, -2 for none. */
  function showEpoch(epoch, bands) {
    if (epoch === shown.epoch && bands === shown.bands) return;
    shown = { epoch: epoch, bands: bands };
    drawFeet();
  }

  function setFootprintsVisible(on) {
    showFeet = on;
    drawFeet();
  }

  /* Mirror the pointer of the blink image: pass null to hide it. */
  function setCursor(ra, dec) {
    cursor = (ra === null || ra === undefined) ? null : { ra: ra, dec: dec };
    placeCursor();
  }

  function setSlice(index) {
    let i = Math.min(WAVE.length - 1, Math.max(0, Math.round(index)));
    if (EMPTY.indexOf(i) >= 0) i = i > slice ? EMPTY[EMPTY.length - 1] + 1 : EMPTY[0] - 1;
    slice = i;
    applySlice(0);
    emitSlice();
  }

  /* Show the map at the middle wavelength of a detector array. */
  function setBand(bands) {
    if (!/^[1-6]$/.test(bands)) return;
    setSlice(17 * (Number(bands) - 1) + 8);
  }

  function setSurvey(id) {
    if (!SURVEYS[id]) return;
    survey = id;
    if (aladin) {
      aladin.setBaseImageLayer(SURVEYS[id].url);
      applySlice(0);
    }
    emitSlice();
  }

  /* 'sky': the whole globe; 'scan': the exposure footprints; 'field': exactly the blink field. */
  function zoom(kind) {
    if (!aladin) return;
    if (kind === 'sky') {
      aladin.zoomToFoV(WHOLE_SKY, 1.5);
    } else if (target) {
      aladin.animateToRaDec(target.ra, target.dec, 1.0);
      aladin.zoomToFoV(kind === 'scan' ? SCAN_AREA : FIELD_MARGIN * target.fov / 3600, 1.8);
    }
  }

  function centre() {
    if (!aladin) return null;
    const p = aladin.getRaDec();
    return { ra: p[0], dec: p[1] };
  }

  window.BlinkSkyMap = {
    surveys: SURVEYS, channels: WAVE.length,
    init: init, setTarget: setTarget, setFootprints: setFootprints, showEpoch: showEpoch,
    setFootprintsVisible: setFootprintsVisible, setCursor: setCursor, setSlice: setSlice,
    setBand: setBand, setSurvey: setSurvey, zoom: zoom, centre: centre,
    aladin: function () { return aladin; }      // for debugging in the console
  };
})();
