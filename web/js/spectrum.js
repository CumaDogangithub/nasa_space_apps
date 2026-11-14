/* SPHEREx Blink Tree - spectrum and light-curve plot.
 *
 * Draws the measurements of one sky position: one point per exposure.
 * "Spectrum" plots flux against wavelength, coloured by epoch.
 * "Light curve" plots the median flux of each detector against time.
 */
(function () {
  'use strict';

  const BANDS = [[0.75, 1.10], [1.10, 1.63], [1.63, 2.42], [2.42, 3.82], [3.82, 4.42], [4.42, 5.00]];
  const X_MIN = 0.7, X_MAX = 5.1;
  const EPOCH_COLORS = ['#5ad19a', '#ffb454', '#6fb7ff', '#ff7ad9', '#c9a0ff', '#f2e56b', '#ff8a6b', '#7de0e6'];
  const BAND_COLORS = ['#6fb7ff', '#5ad19a', '#c8e06b', '#ffcf5a', '#ff9a5a', '#ff6b7a'];
  // Wavelengths (microns) where molecules and hydrogen leave their mark.
  const FEATURES = [[1.875, 'Paα'], [3.05, 'water ice'], [3.3, 'PAH'], [4.05, 'Brα'], [4.27, 'CO₂'], [4.67, 'CO']];
  const CHANNELS = 17;                    // spectral channels per detector

  let canvas = null, legendEl = null;
  let data = null;
  let view = 'spectrum';
  let logScale = false;
  let unitLabel = 'Flux density (mJy)';
  const hiddenEpochs = new Set();
  const hiddenBands = new Set();
  let hits = [];                          // what is drawn where, for the pointer read-out
  let hover = null;

  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y), n = s.length;
    return n ? (n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2])) : NaN;
  };
  const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  const isoDate = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 10);
  const epochColor = (index) => {
    const order = data.epochs.findIndex((e) => e.index === index);
    return EPOCH_COLORS[(order < 0 ? 0 : order) % EPOCH_COLORS.length];
  };

  /* Points on show: measured, not hidden and (unless asked for) not rejected as outliers. */
  function validPoints(withOutliers) {
    if (!data) return [];
    return data.points.filter((p) => p[2] !== null && !hiddenEpochs.has(p[6]) && !hiddenBands.has(p[5]) &&
      (withOutliers || !p[8]));
  }

  /* Flag single exposures that jump away from their neighbours in wavelength.
   * A cosmic ray or a bad pixel inside the measuring circle does this; a real
   * spectral feature is shared by the exposures next to it. Sets p[8] = 1. */
  function flagOutliers(points) {
    const groups = {};
    points.forEach((p) => {
      p[8] = 0;
      if (p[2] === null) return;
      const key = p[5] + ':' + p[6];                 // same detector, same epoch
      (groups[key] = groups[key] || []).push(p);
    });
    let count = 0;
    Object.keys(groups).forEach((key) => {
      const g = groups[key].sort((a, b) => a[0] - b[0]);
      if (g.length < 6) return;
      const resid = g.map((p, i) => {
        const near = [];
        for (let k = Math.max(0, i - 3); k <= Math.min(g.length - 1, i + 3); k++) if (k !== i) near.push(g[k][2]);
        return p[2] - median(near);
      });
      const scatter = 1.4826 * median(resid.map(Math.abs));
      g.forEach((p, i) => {
        const limit = Math.max(5 * scatter, 4 * (p[3] || 0));
        if (limit > 0 && Math.abs(resid[i]) > limit) { p[8] = 1; count++; }
      });
    });
    return count;
  }

  function niceTicks(lo, hi, count) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return ticks;
  }

  function fmtFlux(v) {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1000) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    return v.toPrecision(2);
  }

  /* Vertical scale for a set of flux values; returns a mapping function and tick values. */
  function fluxScale(values, top, height) {
    const sorted = values.slice().sort((a, b) => a - b);
    if (logScale) {
      const pos = sorted.filter((v) => v > 0);
      if (pos.length >= 2) {
        const hi = quantile(pos, 0.995) * 1.4;
        const lo = Math.max(quantile(pos, 0.02) / 1.4, hi / 1e5);
        const l0 = Math.log10(lo), l1 = Math.log10(hi);
        const ticks = [];
        for (let e = Math.floor(l0); e <= Math.ceil(l1); e++) {
          [1, 2, 5].forEach((m) => { const v = m * Math.pow(10, e); if (v >= lo && v <= hi) ticks.push(v); });
        }
        return { map: (v) => (v > 0 ? top + height * (1 - (Math.log10(v) - l0) / (l1 - l0)) : NaN), ticks: ticks };
      }
    }
    let lo = Math.min(0, quantile(sorted, 0.01)), hi = quantile(sorted, 0.99);
    if (!(hi > lo)) hi = lo + 1;
    const pad = 0.08 * (hi - lo);
    lo -= lo < 0 ? pad : 0;
    hi += pad;
    return { map: (v) => top + height * (1 - (v - lo) / (hi - lo)), ticks: niceTicks(lo, hi, 5) };
  }

  function frame(ctx, box, dpr, yScale, yLabel) {
    ctx.strokeStyle = '#222b3d';
    ctx.lineWidth = dpr;
    ctx.fillStyle = '#8d97ab';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    yScale.ticks.forEach((v) => {
      const y = Math.round(yScale.map(v)) + 0.5;
      if (y < box.t - 1 || y > box.t + box.h + 1) return;
      ctx.beginPath(); ctx.moveTo(box.l, y); ctx.lineTo(box.l + box.w, y); ctx.stroke();
      ctx.fillText(fmtFlux(v), box.l - 7 * dpr, y);
    });
    ctx.strokeStyle = '#3a455c';
    ctx.strokeRect(box.l + 0.5, box.t + 0.5, box.w, box.h);
    ctx.save();
    ctx.translate(14 * dpr, box.t + box.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }

  function drawSpectrum(ctx, box, dpr) {
    const pts = validPoints();
    const xOf = (w) => box.l + (w - X_MIN) / (X_MAX - X_MIN) * box.w;
    const yScale = fluxScale(pts.map((p) => p[2]), box.t, box.h);

    // detector arrays as alternating bands
    BANDS.forEach((b, i) => {
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        ctx.fillRect(xOf(b[0]), box.t, xOf(b[1]) - xOf(b[0]), box.h);
      }
      ctx.fillStyle = hiddenBands.has(i + 1) ? '#465066' : '#8d97ab';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('D' + (i + 1), 0.5 * (xOf(b[0]) + xOf(b[1])), box.t - 5 * dpr);
    });
    frame(ctx, box, dpr, yScale, unitLabel);

    // wavelength axis
    ctx.fillStyle = '#8d97ab';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let w = 1; w <= 5; w += 0.5) {
      const x = Math.round(xOf(w)) + 0.5;
      ctx.strokeStyle = '#3a455c';
      ctx.beginPath(); ctx.moveTo(x, box.t + box.h); ctx.lineTo(x, box.t + box.h + 4 * dpr); ctx.stroke();
      ctx.fillText(w.toFixed(1), x, box.t + box.h + 7 * dpr);
    }
    ctx.fillText('Wavelength (µm)', box.l + box.w / 2, box.t + box.h + 22 * dpr);

    // molecular and hydrogen features
    ctx.setLineDash([3 * dpr, 4 * dpr]);
    ctx.strokeStyle = 'rgba(141,151,171,0.45)';
    ctx.textBaseline = 'top';
    FEATURES.forEach((f, i) => {
      const x = Math.round(xOf(f[0])) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, box.t); ctx.lineTo(x, box.t + box.h); ctx.stroke();
      ctx.fillStyle = 'rgba(141,151,171,0.9)';
      ctx.textAlign = 'left';
      ctx.fillText(f[1], x + 3 * dpr, box.t + (4 + 13 * (i % 2)) * dpr);
    });
    ctx.setLineDash([]);

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.l, box.t, box.w, box.h);
    ctx.clip();

    // rejected exposures: hollow grey rings, kept visible but out of the lines and the scale
    ctx.strokeStyle = 'rgba(141,151,171,0.7)';
    ctx.lineWidth = dpr;
    validPoints(true).forEach((p) => {
      if (!p[8]) return;
      const y = Math.min(box.t + box.h - 4 * dpr, Math.max(box.t + 4 * dpr, yScale.map(p[2])));
      if (!isFinite(y)) return;
      ctx.beginPath();
      ctx.arc(xOf(p[0]), y, 2.6 * dpr, 0, 2 * Math.PI);
      ctx.stroke();
    });

    // one point per exposure
    pts.forEach((p) => {
      const x = xOf(p[0]), y = yScale.map(p[2]);
      if (!isFinite(y)) return;
      const color = epochColor(p[6]);
      if (p[3] && p[3] > 0.12 * Math.abs(p[2])) {       // error bar only where it matters
        const y0 = yScale.map(p[2] - p[3]), y1 = yScale.map(p[2] + p[3]);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = dpr;
        ctx.beginPath();
        ctx.moveTo(x, isFinite(y0) ? y0 : box.t + box.h);
        ctx.lineTo(x, y1);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 2.6 * dpr, 0, 2 * Math.PI);
      ctx.fill();
      hits.push({
        x: x, y: y, color: color,
        text: isoDate(p[4]) + '  ·  ' + p[0].toFixed(3) + ' µm (D' + p[5] + ')  ·  ' +
          fmtFlux(p[2]) + ' ± ' + fmtFlux(p[3] || 0) + ' mJy'
      });
    });

    // median per spectral channel, per epoch: the clean spectrum
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 1.6 * dpr;
    ctx.lineJoin = 'round';
    data.epochs.forEach((ep) => {
      if (hiddenEpochs.has(ep.index)) return;
      ctx.strokeStyle = epochColor(ep.index);
      BANDS.forEach((b, i) => {
        if (hiddenBands.has(i + 1)) return;
        const mine = pts.filter((p) => p[6] === ep.index && p[5] === i + 1);
        if (mine.length < 4) return;                  // too few exposures for a meaningful line
        // about three exposures per bin, up to the 17 real spectral channels
        const count = Math.min(CHANNELS, Math.max(3, Math.round(mine.length / 3)));
        const bins = Array.from({ length: count }, () => []);
        mine.forEach((p) => {
          const k = Math.min(count - 1, Math.max(0, Math.floor((p[0] - b[0]) / (b[1] - b[0]) * count)));
          bins[k].push(p);
        });
        ctx.beginPath();
        let started = false;
        bins.forEach((bin) => {
          if (!bin.length) return;
          const x = xOf(median(bin.map((p) => p[0]))), y = yScale.map(median(bin.map((p) => p[2])));
          if (!isFinite(y)) return;
          if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          started = true;
        });
        ctx.stroke();
      });
    });
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawCurve(ctx, box, dpr) {
    const pts = validPoints();
    const channelOf = (w, b) => Math.min(CHANNELS - 1, Math.max(0, Math.floor((w - b[0]) / (b[1] - b[0]) * CHANNELS)));
    // Every exposure samples a different wavelength, and a star is not equally bright at all of
    // them. So first compare each exposure with the star's own average at that wavelength
    // (all epochs together); only then is it fair to follow the result through time.
    const reference = BANDS.map((b, i) => {
      const bins = Array.from({ length: CHANNELS }, () => []);
      data.points.forEach((p) => {
        if (p[2] !== null && !p[8] && p[5] === i + 1) bins[channelOf(p[0], b)].push(p[2]);
      });
      return bins.map((bin) => (bin.length ? median(bin) : NaN));
    });
    const series = [];
    BANDS.forEach((b, i) => {
      if (hiddenBands.has(i + 1)) return;
      const nodes = [];
      data.epochs.forEach((ep) => {
        if (hiddenEpochs.has(ep.index)) return;
        const sel = pts.filter((p) => p[5] === i + 1 && p[6] === ep.index);
        const rel = [];
        sel.forEach((p) => {
          const ref = reference[i][channelOf(p[0], b)];
          if (ref > 0) rel.push(p[2] / ref);
        });
        if (rel.length < 2) return;
        const mid = median(rel);
        const spread = 1.4826 * median(rel.map((v) => Math.abs(v - mid))) / Math.sqrt(rel.length);
        nodes.push({ mjd: median(sel.map((p) => p[4])), flux: mid, err: spread, n: rel.length });
      });
      if (nodes.length) series.push({ band: i + 1, nodes: nodes });
    });
    const all = series.reduce((acc, s) => acc.concat(s.nodes), []);
    if (!all.length) return false;

    let t0 = Math.min.apply(null, all.map((n) => n.mjd)), t1 = Math.max.apply(null, all.map((n) => n.mjd));
    if (t1 - t0 < 1) { t0 -= 15; t1 += 15; }
    const padT = 0.04 * (t1 - t0);
    t0 -= padT; t1 += padT;
    const xOf = (t) => box.l + (t - t0) / (t1 - t0) * box.w;
    const yScale = fluxScale(all.map((n) => n.flux), box.t, box.h);
    frame(ctx, box, dpr, yScale, 'Brightness / own average');
    const unity = Math.round(yScale.map(1)) + 0.5;        // 1 = the star's average
    if (unity > box.t && unity < box.t + box.h) {
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.strokeStyle = 'rgba(231,234,242,0.45)';
      ctx.beginPath(); ctx.moveTo(box.l, unity); ctx.lineTo(box.l + box.w, unity); ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = '#8d97ab';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let k = 0; k <= 5; k++) {
      const t = t0 + padT + k * (t1 - t0 - 2 * padT) / 5, x = Math.round(xOf(t)) + 0.5;
      ctx.strokeStyle = '#3a455c';
      ctx.beginPath(); ctx.moveTo(x, box.t + box.h); ctx.lineTo(x, box.t + box.h + 4 * dpr); ctx.stroke();
      ctx.fillText(isoDate(t), x, box.t + box.h + 7 * dpr);
    }
    ctx.fillText('Date of observation', box.l + box.w / 2, box.t + box.h + 22 * dpr);

    series.forEach((s) => {
      const color = BAND_COLORS[s.band - 1];
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath();
      s.nodes.forEach((n, k) => {
        const x = xOf(n.mjd), y = yScale.map(n.flux);
        if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
      s.nodes.forEach((n) => {
        const x = xOf(n.mjd), y = yScale.map(n.flux);
        if (!isFinite(y)) return;
        const y0 = yScale.map(n.flux - n.err), y1 = yScale.map(n.flux + n.err);
        ctx.lineWidth = dpr;
        ctx.beginPath(); ctx.moveTo(x, isFinite(y0) ? y0 : y); ctx.lineTo(x, y1); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, 2 * Math.PI); ctx.fill();
        hits.push({
          x: x, y: y, color: color,
          text: isoDate(n.mjd) + '  ·  D' + s.band + ' (' + BANDS[s.band - 1][0].toFixed(2) + '–' +
            BANDS[s.band - 1][1].toFixed(2) + ' µm)  ·  ' + n.flux.toFixed(2) + ' × its average, from ' + n.n + ' exposures'
        });
      });
    });
    return true;
  }

  function draw() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(200, Math.round(rect.width * dpr)), H = Math.max(120, Math.round(rect.height * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.font = Math.round(11.5 * dpr) + 'px system-ui, sans-serif';
    const box = { l: 64 * dpr, t: 26 * dpr, w: W - 80 * dpr, h: H - 66 * dpr };
    hits = [];

    let drawn = false;
    if (validPoints().length >= 2) {
      if (view === 'curve') drawn = drawCurve(ctx, box, dpr);
      else { drawSpectrum(ctx, box, dpr); drawn = true; }
    }
    if (!drawn) {
      ctx.strokeStyle = '#222b3d';
      ctx.strokeRect(box.l + 0.5, box.t + 0.5, box.w, box.h);
      ctx.fillStyle = '#8d97ab';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(data ? 'Nothing to plot: every exposure is saturated, hidden or missing.'
        : 'Click a star in the blink image to see its spectrum here.', box.l + box.w / 2, box.t + box.h / 2);
      return;
    }

    if (hover) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.arc(hover.x, hover.y, 6 * dpr, 0, 2 * Math.PI); ctx.stroke();
      ctx.font = Math.round(12 * dpr) + 'px system-ui, sans-serif';
      const width = ctx.measureText(hover.text).width + 14 * dpr, height = 22 * dpr;
      let x = hover.x + 10 * dpr, y = hover.y - height - 8 * dpr;
      if (x + width > W - 4 * dpr) x = hover.x - width - 10 * dpr;
      if (y < 2 * dpr) y = hover.y + 10 * dpr;
      ctx.fillStyle = 'rgba(14,19,32,0.95)';
      ctx.fillRect(x, y, width, height);
      ctx.strokeStyle = hover.color;
      ctx.lineWidth = dpr;
      ctx.strokeRect(x + 0.5, y + 0.5, width, height);
      ctx.fillStyle = '#e7eaf2';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(hover.text, x + 7 * dpr, y + height / 2);
    }
  }

  function renderLegend() {
    if (!legendEl) return;
    legendEl.innerHTML = '';
    if (!data) return;
    const chip = (label, color, off, onClick, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'spec-chip' + (off ? ' off' : '');
      b.title = title;
      b.innerHTML = '<i style="background:' + color + '"></i>' + label;
      b.addEventListener('click', onClick);
      legendEl.appendChild(b);
    };
    data.epochs.forEach((ep) => {
      const n = data.points.filter((p) => p[6] === ep.index && p[2] !== null).length;
      chip(ep.date + ' <small>' + n + '</small>', view === 'curve' ? '#8d97ab' : epochColor(ep.index),
        hiddenEpochs.has(ep.index),
        () => { if (hiddenEpochs.has(ep.index)) hiddenEpochs.delete(ep.index); else hiddenEpochs.add(ep.index); refresh(); },
        'Show or hide this epoch (' + n + ' exposures)');
    });
    BANDS.forEach((b, i) => {
      chip('D' + (i + 1), view === 'curve' ? BAND_COLORS[i] : '#8d97ab', hiddenBands.has(i + 1),
        () => { if (hiddenBands.has(i + 1)) hiddenBands.delete(i + 1); else hiddenBands.add(i + 1); refresh(); },
        'Show or hide detector D' + (i + 1) + ' (' + b[0].toFixed(2) + '–' + b[1].toFixed(2) + ' µm)');
    });
  }

  function refresh() {
    hover = null;
    renderLegend();
    draw();
  }

  function init(canvasEl, legend) {
    canvas = canvasEl;
    legendEl = legend;
    canvas.addEventListener('mousemove', (ev) => {
      const r = canvas.getBoundingClientRect(), dpr = canvas.width / r.width;
      const x = (ev.clientX - r.left) * dpr, y = (ev.clientY - r.top) * dpr;
      let best = null, reach = 14 * dpr;
      hits.forEach((h) => {
        const dist = Math.hypot(h.x - x, h.y - y);
        if (dist < reach) { best = h; reach = dist; }
      });
      if (best !== hover) { hover = best; draw(); }
    });
    canvas.addEventListener('mouseleave', () => { if (hover) { hover = null; draw(); } });
    window.addEventListener('resize', draw);
    draw();
  }

  window.BlinkSpectrum = {
    init: init,
    /* Returns how many exposures were set aside as outliers. */
    setData: function (d) {
      data = d;
      hiddenEpochs.clear();
      hiddenBands.clear();
      const rejected = d ? flagOutliers(d.points) : 0;
      refresh();
      return rejected;
    },
    setView: function (v) { view = v; refresh(); },
    setLog: function (on) { logScale = on; refresh(); },
    setUnits: function (label) { unitLabel = label; draw(); },
    redraw: draw
  };
})();
