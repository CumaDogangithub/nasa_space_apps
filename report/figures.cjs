/* SPHEREx Blink Tree - figures of the report.
 *
 * Every picture in the report is a screenshot of the running tool, taken by
 * this script, once per language.
 *
 * Run (the server must be up on port 8000, see ../README.md):
 *   npm install --prefix report puppeteer-core     once; needs Node 18+ and Chrome or Edge
 *   node report/figures.cjs                        all figures, Turkish and English
 *   node report/figures.cjs tr --only hero,rwaur_spec
 *
 * Output: report/figures/<lang>/<name>.png   (use --out <dir> for another folder)
 * Set CHROME to the browser's path if it is not found.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BLINK_URL || 'http://localhost:8000';
const BROWSERS = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);

/* What to photograph.
 *   view    window size in CSS pixels; the two squares of the page are (height - 205) px, at least 300
 *   params  address parameters of the tool (see "URL parameters" in the README)
 *   wait    what has to be on screen first: gaia, spectrum, flags, sky (the blink frames always)
 *   click   buttons to press once everything is loaded
 *   clip    'top' = header and the three boxes, 'page' = down to the end of the spectrum box,
 *           'phone' = one screenful starting at the blink box,
 *           or the page elements whose common outline is cut out
 */
const SHOTS = [
  // the whole tool
  { name: 'hero', view: [1180, 860], params: 'target=barnard&gaia=1&play=0&frame=2', wait: ['gaia', 'sky'], clip: 'top' },
  { name: 'page', view: [1180, 860], params: 'target=epsindb&gaia=1&spec=target&play=0&frame=2', wait: ['gaia', 'spectrum', 'sky'], clip: 'page' },

  // Barnard's Star: first visit, last visit, last minus first
  { name: 'barnard_first', view: [1180, 505], scale: 3, params: 'target=barnard&gaia=1&play=0&frame=0', wait: ['gaia'], clip: ['#viewer'] },
  { name: 'barnard_last', view: [1180, 505], scale: 3, params: 'target=barnard&gaia=1&play=0&frame=2', wait: ['gaia'], clip: ['#viewer'] },
  { name: 'barnard_diff', view: [1180, 505], scale: 3, params: 'target=barnard&mode=diff&ref=first&play=0&frame=9', clip: ['#viewer'] },

  // WISE 0855: faint, so the display range is narrowed (white=25)
  { name: 'wise_first', view: [1180, 505], scale: 3, params: 'target=wise0855&white=25&play=0&frame=1', clip: ['#viewer'] },
  { name: 'wise_last', view: [1180, 505], scale: 3, params: 'target=wise0855&white=25&play=0&frame=3', clip: ['#viewer'] },
  { name: 'wise_diff', view: [1180, 505], scale: 3, params: 'target=wise0855&white=25&mode=diff&play=0&frame=9', clip: ['#viewer'] },

  // Epsilon Indi B: the two thinly sampled epochs are switched off in the plot's legend
  { name: 'epsindb_frame', view: [1180, 505], scale: 3, params: 'target=epsindb&gaia=1&play=0&frame=2', wait: ['gaia'], clip: ['#viewer'] },
  { name: 'epsindb_spec', view: [580, 900], scale: 3, params: 'target=epsindb&spec=target&play=0', wait: ['spectrum'],
    click: ['#spec-legend .spec-chip:nth-child(1)', '#spec-legend .spec-chip:nth-child(2)'], clip: ['.spectrum-plot'] },

  // RW Aurigae and R Draconis: spectra and light curves
  { name: 'rwaur_frame', view: [1180, 505], scale: 3, params: 'target=rwaur&spec=target&play=0&frame=0', wait: ['spectrum'], clip: ['#viewer'] },
  { name: 'rwaur_spec', view: [580, 900], scale: 3, params: 'target=rwaur&spec=target&play=0', wait: ['spectrum'], clip: ['.spectrum-plot', '#spec-legend'] },
  { name: 'rwaur_curve', view: [580, 900], scale: 3, params: 'target=rwaur&spec=target&play=0', wait: ['spectrum'], click: ['#spec-views [data-view="curve"]'], clip: ['.spectrum-plot', '#spec-legend'] },
  { name: 'rdra_frame', view: [1180, 505], scale: 3, params: 'target=rdra&spec=target&play=0&frame=3', wait: ['spectrum'], clip: ['#viewer'] },
  { name: 'rdra_curve', view: [580, 900], scale: 3, params: 'target=rdra&spec=target&play=0', wait: ['spectrum'], click: ['#spec-views [data-view="curve"]'], clip: ['.spectrum-plot'] },

  // the extras
  { name: 'sky', view: [1180, 860], scale: 3, params: 'target=barnard&play=0&frame=2', wait: ['sky'], clip: ['#sky'] },
  { name: 'flags_frame', view: [1180, 505], scale: 3, params: 'target=rwaur&flags=1&play=0&frame=0', wait: ['flags'], clip: ['#viewer'] },
  { name: 'flags_list', view: [900, 900], params: 'target=rwaur&flags=1&play=0&frame=0', wait: ['flags'], clip: ['#exposures-wrap'] },
  { name: 'coverage', view: [560, 900], scale: 3, params: 'target=rwaur&play=0', clip: ['#tree-wrap'] },
  { name: 'phone', view: [390, 800], scale: 3, params: 'target=barnard&gaia=1&play=0&frame=2', wait: ['gaia'], clip: 'phone' }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READY = {
  frames: () => document.querySelectorAll('#timeline button').length > 0 &&
    document.getElementById('progress').hidden && document.getElementById('message').hidden &&
    !document.getElementById('view').classList.contains('stale'),
  gaia: () => { const n = document.getElementById('gaia-note'); return !n.hidden && !/\u2026$/.test(n.textContent.trim()); },
  spectrum: () => document.getElementById('spec-progress').hidden &&
    document.querySelectorAll('#spec-legend .spec-chip').length > 0,
  flags: () => !document.getElementById('exposures-wrap').hidden,
  sky: () => /\d/.test(document.getElementById('sky-feet-note').textContent)
};

async function outline(page, clip) {
  return page.evaluate((what) => {
    const box = (els) => {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      els.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top + scrollY);
        x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom + scrollY);
      });
      return { x: Math.floor(x0), y: Math.floor(y0), width: Math.ceil(x1 - x0), height: Math.ceil(y1 - y0) };
    };
    if (what === 'phone') {
      const top = document.querySelector('.stage').getBoundingClientRect().top + scrollY;
      return { x: 0, y: Math.max(0, Math.floor(top - 6)), width: document.documentElement.clientWidth, height: innerHeight };
    }
    if (what === 'top' || what === 'page') {
      const last = document.querySelector(what === 'top' ? '.layout' : '#spectrum-wrap').getBoundingClientRect();
      return { x: 0, y: 0, width: document.documentElement.clientWidth, height: Math.ceil(last.bottom + scrollY + 6) };
    }
    return box(what.map((s) => document.querySelector(s)).filter(Boolean));
  }, clip);
}

async function shoot(browser, shot, lang, outDir) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: shot.view[0], height: shot.view[1], deviceScaleFactor: shot.scale || 2 });
    await page.goto(BASE + '/?' + shot.params + '&lang=' + lang, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (const what of ['frames'].concat(shot.wait || [])) {
      await page.waitForFunction(READY[what], { timeout: 240000, polling: 250 });
    }
    for (const selector of shot.click || []) { await page.click(selector); await sleep(400); }
    if ((shot.wait || []).indexOf('sky') >= 0) {
      // let the map fetch its tiles and finish flying to the target
      await page.waitForNetworkIdle({ idleTime: 2500, timeout: 45000 }).catch(() => {});
      await sleep(3000);
    } else {
      await sleep(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    const file = path.join(outDir, shot.name + '.png');
    await page.screenshot({ path: file, clip: await outline(page, shot.clip), captureBeyondViewport: true });
    return file;
  } finally {
    await page.close();
  }
}

(async () => {
  const args = process.argv.slice(2);
  const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const only = take('--only'), out = take('--out');
  const langs = args.length ? args : ['tr', 'en'];
  const shots = only ? SHOTS.filter((s) => only.split(',').indexOf(s.name) >= 0) : SHOTS;
  const chrome = BROWSERS.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('No Chrome or Edge found; set CHROME to its path.');

  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-swiftshader'] });
  let failed = 0;
  for (const lang of langs) {
    const outDir = path.join(out || path.join(__dirname, 'figures'), lang);
    fs.mkdirSync(outDir, { recursive: true });
    for (const shot of shots) {
      let done = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        try {
          const file = await shoot(browser, shot, lang, outDir);
          console.log(lang, shot.name, Math.round(fs.statSync(file).size / 1024) + ' kB');
          done = true;
        } catch (err) {
          console.log(lang, shot.name, 'attempt ' + attempt + ' failed: ' + String(err.message || err).split('\n')[0]);
          await sleep(5000);
        }
      }
      if (!done) failed += 1;
    }
  }
  await browser.close();
  if (failed) { console.log(failed + ' figure(s) could not be taken'); process.exit(1); }
})().catch((err) => { console.error(err); process.exit(1); });
