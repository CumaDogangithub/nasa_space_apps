/* SPHEREx Blink Tree - languages.
 *
 * Every text the page shows lives here, in English and Turkish. The language
 * comes from ?lang=en|tr, else the last choice, else the browser's language.
 * Static texts in index.html are marked with data-i18n attributes; scripts
 * call BlinkI18n.t(key, values). Switching language reloads the page with the
 * same view, so nothing has to be re-rendered by hand.
 *
 * To add a language: add a block to TEXT and a button to #lang in index.html.
 */
(function () {
  'use strict';

  const TEXT = {
    en: {
      'tagline': 'Blink through NASA’s infrared sky survey and spot what moves or changes.',
      'lang.label': 'Language',

      // search
      'search.placeholder': 'RA and Dec (133.795 -7.245 or 08h55m10.8s -07d14m42.5s) or an object name',
      'search.aria': 'Coordinates or object name',
      'search.field': 'Field',
      'search.go': 'Blink',
      'examples.try': 'Try:',

      // units with a count
      'unit.exposures.one': '{n} exposure',
      'unit.exposures.other': '{n} exposures',
      'unit.epochs.one': '{n} epoch',
      'unit.epochs.other': '{n} epochs',

      // box titles
      'card.sky.title': '1 · Sky map',
      'card.sky.sub': 'where you are looking',
      'card.blink.title': '2 · Blink',
      'card.blink.sub': 'the same patch of sky on different dates',
      'card.controls.title': '3 · Adjust',
      'card.controls.sub': 'what to show and how',
      'card.spec.title': '4 · Spectrum and light curve',
      'card.spec.sub': 'click a star in the blink image',
      'card.exposures.title': 'Exposures behind this frame',
      'card.tree.title': 'What SPHEREx has for this spot',
      'help.toggle': 'Explain this box',

      // sky map
      'sky.zoom.sky': 'Whole sky',
      'sky.zoom.scan': 'Scan area',
      'sky.zoom.field': 'Field',
      'sky.blink': 'Blink map centre',
      'sky.blink.title': 'Blink the spot under the cross-hair at the centre of the map',
      'sky.full': 'Full screen',
      'sky.full.exit': 'Exit full screen',
      'sky.full.title': 'Show the map across the whole window (Esc to leave)',
      'sky.wave': 'Map wavelength',
      'sky.wave.out': '{w} µm (D{d})',
      'sky.wave.na': 'not a SPHEREx map',
      'sky.feet': 'SPHEREx footprints',
      'sky.survey.aria': 'Sky map survey',
      'sky.legend.field': 'the field being blinked',
      'sky.legend.pointer': 'the spot under your pointer in the other picture',
      'sky.feet.none': 'SPHEREx exposures of this epoch',
      'sky.feet.note': '{exposures} of this epoch (3.5° each)',
      'sky.feet.drawn': '{exposures} of this epoch, {n} drawn (3.5° each)',
      'sky.help': 'Drag to turn the sky, scroll to zoom. The orange square is the patch shown in the Blink box. ' +
        'Each green square is one SPHEREx exposure, 3.5° wide, that contains that patch: the telescope steps a little ' +
        'between exposures, so the patch is seen at a different wavelength each time. Only a few exposures of each visit are ' +
        'drawn, so that the map stays readable. “Field” zooms the map to exactly the ' +
        'area of the blink image. Point at either picture and a white cross marks the same spot on the other. ' +
        'The slider shows the whole sky at any of SPHEREx’s 102 wavelengths; the menu below it switches to WISE, 2MASS or visible light.',
      'survey.spherex': 'SPHEREx all-sky (102 channels)',
      'survey.wise': 'WISE colour (3.4–22 µm)',
      'survey.twomass': '2MASS colour (1.2–2.2 µm, sharper)',
      'survey.dss': 'DSS colour (visible light)',

      // blink box
      'play.play': 'Play',
      'play.pause': 'Pause',
      'play.title': 'Play or pause (space)',
      'play.prev': 'Previous epoch (left arrow)',
      'play.next': 'Next epoch (right arrow)',
      'blink.aria': 'SPHEREx image of the selected field',
      'blink.help': 'Each frame is a stack of all exposures one detector took during one visit of the telescope (an epoch), ' +
        'lined up on the sky: north is up, east is left. Played as a film, anything that shifts or flickers stands out. ' +
        'Click a star to measure its spectrum. Keys: space play/pause, ← → step, 1–6 detector, D difference, G Gaia stars, F flags.',
      'frame.all': 'All epochs',
      'frame.average': 'average',
      'frame.minus': 'minus {what}',
      'compass.n': 'N',
      'compass.e': 'E',
      'readout.default': 'Frame {i} of {n} · observed {span} · point at the image for coordinates',
      'readout.span': '{a} to {b}',
      'readout.nodata': 'no data',
      'readout.saturated': 'saturated',
      'readout.difference': '(difference)',

      // controls
      'ctl.detector': 'Detector',
      'band.all': 'All six combined',
      'band.all.sub': 'slower: reads every image',
      'band.all.name': 'All detectors',
      'ctl.limit': 'Exposures per visit, at most',
      'ctl.limit.all': 'all',
      'ctl.limit.title': 'The most exposures of one detector that are read for each visit. Fewer load faster, more give a deeper ' +
        'image. Most of the sky has 15 to 30 per visit; fields near the ecliptic poles have hundreds. ' +
        'If a choice would mean reading too much at once, the server lowers it and “This field” shows the number used.',
      'ctl.view': 'View',
      'mode.blink': 'Blink',
      'mode.diff': 'Difference',
      'mode.sum': 'Sum',
      'mode.hint.blink': 'Blink: frames are lined up on the sky. Anything that shifts or flickers between epochs is worth a closer look.',
      'mode.hint.diff': 'Difference: stars that do not change cancel out. A moving object leaves a dark spot where it was and a bright spot where it went.',
      'mode.hint.sum': 'Sum: all epochs averaged together. Deeper, but anything that moves is smeared.',
      'ref.label': 'Subtract',
      'ref.auto': 'the deepest earlier epoch',
      'ref.first': 'the first epoch',
      'ref.prev': 'the previous epoch',
      'ref.mean': 'the average of all epochs',
      'ref.epoch': '{date} ({exposures})',
      'ctl.display': 'Display',
      'ctl.speed': 'Blink interval',
      'ctl.white': 'Brightness range',
      'ctl.black': 'Black level',
      'ctl.smooth': 'Smoothing',
      'ctl.off': 'off',
      'ctl.invert': 'Invert',
      'ctl.interp': 'Soft pixels',
      'ctl.marks': 'Markers',
      'ctl.gaia': 'Gaia stars',
      'ctl.gaia.title': 'Mark the stars the Gaia mission already knows (key: G)',
      'ctl.flags': 'Flags',
      'ctl.flags.title': 'Show where SPHEREx itself flagged the data as doubtful (key: F)',
      'ctl.help': 'SPHEREx has six detector arrays, each covering a slice of the near-infrared. Cold objects such as brown dwarfs are ' +
        'brightest in D5 and D6. “Exposures per visit, at most” sets how many exposures are read for each frame: fewer load ' +
        'faster, more give a deeper image. Brightness range and black level set how the image is stretched, in units of the image noise (σ).',
      'ctl.facts': 'This field',
      'facts.target': 'Target',
      'facts.centre': 'Centre',
      'facts.pm': 'Proper motion',
      'facts.pm.value': '{v}″ per year',
      'facts.fov': 'Field of view',
      'facts.fov.value': '{fov} · {scale}″ per pixel',
      'facts.wave': 'Wavelengths',
      'facts.used': 'Exposures used',
      'facts.used.value': '{a} of {b}',
      'facts.used.limited': '{a} of {b} (limit {n} per visit)',
      'facts.epochs': 'Epochs',
      'facts.gaia': 'Gaia stars',
      'facts.gaia.fast': '{n} ({k} fast-moving)',
      'facts.images': 'Images in total',
      'facts.newest': 'Newest image',

      // Gaia overlay
      'gaia.loading': 'Looking up Gaia stars…',
      'gaia.note': 'Blue circle: a star Gaia knows, moved to the frame’s date. Pink arrow: where a fast mover will be in {years} years. ' +
        'Something that moves without a circle is not in Gaia.',
      'gaia.truncated': ' Only the {n} brightest stars are marked.',
      'gaia.failed': 'Gaia stars could not be loaded. ',
      'gaia.hover': 'Gaia star',
      'gaia.hover.moving': 'moving {v} per year',
      'gaia.hover.distance': '{d} light-years away',
      'gaia.rate': '{v}″/yr',

      // quality flags
      'flags.loading': 'Reading SPHEREx’s quality flags…',
      'flags.note': 'Pink: pixels SPHEREx itself flagged in at least a quarter of this frame’s exposures (cosmic rays, saturation, ' +
        'leftover charge, ghosts of bright stars). Point at a pixel to see which; every exposure is listed further down.',
      'flags.failed': 'The quality flags could not be read. ',
      'flags.hover': 'flags: {names} ({p}% of exposures flagged)',
      'exp.note': '{exposures} in this frame, {k} with a trouble flag at the centre. The wavelength is what each exposure saw at the centre of the field.',
      'exp.col.time': 'Taken (UTC)',
      'exp.col.detector': 'Detector',
      'exp.col.wave': 'Wavelength at the centre',
      'exp.col.flags': 'Flags within 12″ of the centre',
      'exp.col.file': 'SPHEREx image',
      'exp.none': 'none',
      'exp.open': 'Open the full SPHEREx image at IRSA (about 65 MB)',

      // what SPHEREx's flags mean, in plain words (the mission's own wording is added after it)
      'flag.TRANSIENT': 'A sudden jump in the signal during the exposure, usually a cosmic-ray hit',
      'flag.OVERFLOW': 'The pixel filled up (saturated) during the exposure',
      'flag.SUR_ERROR': 'The computer on board reported a processing error',
      'flag.NONFUNC': 'A dead pixel: permanently unusable',
      'flag.DICHROIC': 'Low sensitivity here because of the telescope’s beam splitter (dichroic)',
      'flag.MISSING_DATA': 'The data were lost on board',
      'flag.HOT': 'A hot pixel: it reads high on its own',
      'flag.COLD': 'Abnormally low signal',
      'flag.FULLSAMPLE': 'For information: the full read-out history of this pixel was sent to the ground',
      'flag.PHANMISS': 'The correction for phantom signals was not applied',
      'flag.NONLINEAR': 'The detector’s non-linearity correction is not reliable here',
      'flag.PERSIST': 'Charge left over from something bright in an earlier exposure',
      'flag.OUTLIER': 'Marked as an outlier by the processing pipeline',
      'flag.CROSSTALK': 'Affected by electronic crosstalk',
      'flag.SOURCE': 'For information: a known star or galaxy lies on this pixel',
      'flag.GHOST': 'Ghost (stray reflection) of a bright star inside this exposure',
      'flag.GHOST_FPA': 'Ghost of a bright star on another detector',
      'flag.GHOST_EXT': 'Ghost of a bright star outside the field of view',
      'flag.STREAK': 'On a streak across the image',
      'flag.BLOOM': 'Part of a bloom: charge spilling out of a saturated star',
      'flag.SNOWBALL': 'Part of a “snowball”, a large round blotch that appears in a single exposure',
      'flag.HALO': 'In the halo around a sudden signal jump',
      'flag.official': '{plain} (SPHEREx: “{official}”)',

      // answers of the server
      'server.archive': 'NASA’s SPHEREx image search (IRSA) is not answering right now, and no list of exposures was ' +
        'fetched for this spot earlier. Try again in a few minutes.',
      'server.search': 'The SPHEREx image search failed: {x}',
      'server.frames': 'The frames could not be built: {x}',
      'server.gaia': 'The Gaia archive did not answer: {x}',
      'server.notfound': '“{x}” was not found in SIMBAD. Check the spelling or enter coordinates.',
      'server.nocoords': 'SIMBAD has no coordinates for “{x}”.',
      'server.lookup': 'The name lookup failed: {x}',

      // coverage table
      'tree.detector': 'Detector',
      'tree.total': 'Total',
      'tree.help': 'Each column is one visit of the telescope; each row is one detector array. The numbers are exposures. Click a row to blink that detector.',

      // spectrum
      'spec.kind.core': 'Star itself',
      'spec.kind.core.title': 'Brightness of the star inside the measuring circle',
      'spec.kind.ring': 'Ring around it',
      'spec.kind.ring.title': 'For saturated stars: the light in a ring around the star',
      'spec.view.spectrum': 'Spectrum',
      'spec.view.curve': 'Light curve',
      'spec.log': 'Log scale',
      'spec.target': 'Measure the target',
      'spec.aria': 'Spectrum of the selected source',
      'spec.hint': 'Click a star in the blink image, or press “Measure the target”. Each exposure sees the star at a different ' +
        'wavelength, so together they give its spectrum from 0.75 to 5 µm and show how its brightness changed between visits.',
      'spec.help': 'Dots are single exposures, coloured by epoch; lines join the medians of neighbouring exposures. The star is measured ' +
        'inside the dashed circle drawn on the blink image, so anything else inside it adds to the brightness. In the light curve ' +
        'every exposure is first compared with the star’s own average at the same wavelength: 1 means average, 0.5 half as bright. ' +
        'Stars too bright for SPHEREx have a blank core; for them the light in a ring around the core is measured instead. ' +
        'Click the dates and detectors below the plot to hide or show them.',
      'spec.measuring': 'Measuring this spot in every SPHEREx exposure…',
      'spec.asking': 'Asking the archive which exposures cover this spot…',
      'spec.finding': 'Finding the spot on each exposure…',
      'spec.reading': 'Measuring the brightness in each exposure…',
      'spec.failed': 'The spectrum could not be measured. ',
      'spec.target.name': 'The target',
      'spec.where.moving': '{name}, followed as it moves',
      'spec.summary.core': '{where}: {exposures} over {epochs}, measured inside the dashed circle ({r}″ radius).',
      'spec.summary.saturated': ' {exposures} left out because the star is saturated there.',
      'spec.summary.ring': '{name} is too bright for SPHEREx: its core is saturated in {a} of {b} exposures. Shown instead is the light in a ' +
        'ring around it, {r0}″ to {r1}″ from the centre (between the dashed circles), from {exposures}. It rises and falls with the star but is not its total brightness.',
      'spec.summary.thinned': ' Only {a} of the {b} exposures were read.',
      'spec.summary.rejected': ' {exposures} set aside as outliers (a cosmic ray or bad pixel).',
      'spec.units.flux': 'Flux density (mJy)',
      'spec.units.ring': 'Light in the ring (mJy)',
      'plot.wavelength': 'Wavelength (µm)',
      'plot.date': 'Date of observation',
      'plot.relative': 'Brightness / own average',
      'plot.empty': 'Click a star in the blink image to see its spectrum here.',
      'plot.nothing': 'Nothing to plot: every exposure is saturated, hidden or missing.',
      'plot.feature.ice': 'water ice',
      'plot.hit.curve': '{date}  ·  D{band} ({range})  ·  {v} × its average, from {exposures}',
      'plot.chip.epoch': 'Show or hide this epoch ({exposures})',
      'plot.chip.band': 'Show or hide detector D{band} ({range})',

      // messages
      'msg.start': 'Enter coordinates or an object name to start.',
      'msg.coords': 'Those coordinates are outside the sky: RA must be 0–360° (or 0–24h) and Dec −90° to +90°.',
      'msg.noimages': 'SPHEREx has no {band} images of this position yet.\nTry another detector.',
      'msg.toofew': 'SPHEREx has only {exposures} usable in {band} here, too few to build an epoch.\nTry another detector.',
      'msg.noserver': 'Cannot reach the Blink Tree server.\nStart it from the project folder with\npython -m uvicorn backend.app:app --port 8000',
      'msg.rejected': 'The server rejected the request ({status}).',
      'msg.error': 'The server answered with an error ({status}).',
      'msg.unexpected': 'Unexpected answer from the server.',
      'prog.asking': 'Asking the SPHEREx archive which images cover this spot…',
      'prog.headers': 'Finding the target on each {band} image…',
      'prog.pixels': 'Reading {band} pixels from the NASA archive…',
      'prog.lookup': 'Looking up “{name}”…',

      // the archive's search service is down
      'archive.stale': 'NASA’s SPHEREx image search (IRSA) is not answering right now. The list of exposures fetched earlier ' +
        'for this field is used, so the newest images may be missing.',
      'archive.incomplete': 'NASA’s SPHEREx image search (IRSA) is not answering right now. The exposures were taken from ' +
        'earlier searches of nearby spots, so some may be missing. Try again in a few minutes for the full list.',
      'spec.summary.offline': ' The image search (IRSA) is not answering, so some exposures may be missing.',

      // offline demo
      'demo.start': 'Start the server to explore any position: python -m uvicorn backend.app:app --port 8000',
      'demo.banner': 'Offline demo: the live server is not running, so the five example targets are shown from data recorded on {date}. {start}',
      'demo.banner.nodate': 'Offline demo: the live server is not running, so the five example targets are shown from recorded data. {start}',
      'demo.only': 'Without the live server only the five example targets can be shown.\n{start}',
      'demo.unreadable': 'The recorded data for this target is unreadable.',
      'demo.missing': 'The recorded data for this target is missing (web/demo/{id}.js).',
      'demo.resolve': 'Looking up names needs the live server.\n{start}',
      'demo.spectrum': 'The offline demo only holds the spectrum of the target itself. {start}',
      'demo.fov': 'The offline demo holds this target with a {fov} field only.\n{start}',
      'demo.flags': 'The offline demo holds the quality flags of the {band} view only.',
      'demo.view': 'This view is not part of the offline demo.\n{start}',
      'demo.na': 'Not available in the offline demo.',

      // example targets
      'target.barnard': 'The fastest-moving star in the sky: 10.4 arcseconds per year.',
      'target.wise0855': 'The coldest known brown dwarf, 7 light-years away. It only shows up at 4.4–5 µm.',
      'target.epsindb': 'A pair of brown dwarfs orbiting a nearby Sun-like star.',
      'target.rwaur': 'A young star whose brightness changes unpredictably.',
      'target.rdra': 'A red giant that pulsates every 245 days, watched almost continuously.',

      'foot.credits': 'Images: NASA SPHEREx mission (JPL/Caltech), from the NASA/IPAC Infrared Science Archive. Positions: ESA Gaia DR3 and SIMBAD. ' +
        'Sky map: Aladin Lite (CDS, Strasbourg). Built by Kuyruk Team for the NASA Space Apps Challenge.'
    },

    tr: {
      'tagline': 'NASA’nın kızılötesi gökyüzü taramasını film gibi izle; hareket edeni ve değişeni yakala.',
      'lang.label': 'Dil',

      'search.placeholder': 'Sağ açıklık ve dik açıklık (133.795 -7.245 ya da 08h55m10.8s -07d14m42.5s) veya bir cisim adı',
      'search.aria': 'Koordinat veya cisim adı',
      'search.field': 'Alan',
      'search.go': 'Göster',
      'examples.try': 'Dene:',

      'unit.exposures.one': '{n} poz',
      'unit.exposures.other': '{n} poz',
      'unit.epochs.one': '{n} dönem',
      'unit.epochs.other': '{n} dönem',

      'card.sky.title': '1 · Gökyüzü haritası',
      'card.sky.sub': 'nereye baktığın',
      'card.blink.title': '2 · Film',
      'card.blink.sub': 'aynı gökyüzü parçası, farklı tarihlerde',
      'card.controls.title': '3 · Ayarlar',
      'card.controls.sub': 'neyi, nasıl göstereceğin',
      'card.spec.title': '4 · Spektrum ve ışık eğrisi',
      'card.spec.sub': 'görüntüde bir yıldıza tıkla',
      'card.exposures.title': 'Bu kareyi oluşturan pozlar',
      'card.tree.title': 'SPHEREx’in bu nokta için verisi',
      'help.toggle': 'Bu kutuyu açıkla',

      'sky.zoom.sky': 'Tüm gökyüzü',
      'sky.zoom.scan': 'Tarama alanı',
      'sky.zoom.field': 'Alan',
      'sky.blink': 'Harita merkezini göster',
      'sky.blink.title': 'Haritanın ortasındaki artının altında kalan noktayı göster',
      'sky.full': 'Tam ekran',
      'sky.full.exit': 'Tam ekrandan çık',
      'sky.full.title': 'Haritayı tüm pencereye yay (çıkmak için Esc)',
      'sky.wave': 'Harita dalga boyu',
      'sky.wave.out': '{w} µm (D{d})',
      'sky.wave.na': 'SPHEREx haritası değil',
      'sky.feet': 'SPHEREx ayak izleri',
      'sky.survey.aria': 'Harita katmanı',
      'sky.legend.field': 'gösterilen alan',
      'sky.legend.pointer': 'diğer resimde imlecin gösterdiği nokta',
      'sky.feet.none': 'bu dönemin SPHEREx pozları',
      'sky.feet.note': 'bu dönemden {exposures} (her biri 3.5°)',
      'sky.feet.drawn': 'bu dönemden {exposures}, {n} tanesi çizildi (her biri 3.5°)',
      'sky.help': 'Gökyüzünü sürükleyerek çevir, tekerlekle yakınlaş. Turuncu kare, Film kutusunda gösterilen gökyüzü parçasıdır. ' +
        'Her yeşil kare o parçayı içeren, 3.5° genişliğinde tek bir SPHEREx pozudur: teleskop pozlar arasında biraz kayar, ' +
        'böylece parça her seferinde farklı bir dalga boyunda görülür. Harita okunaklı kalsın diye her dönemin pozlarından ' +
        'yalnız birkaçı çizilir. “Alan” haritayı tam olarak film görüntüsünün alanına getirir. ' +
        'İmleci resimlerden birinin üzerine getirdiğinde diğerinde beyaz bir artı aynı noktayı işaretler. ' +
        'Kaydırıcı tüm gökyüzünü SPHEREx’in 102 dalga boyundan herhangi birinde gösterir; altındaki menüden WISE, 2MASS veya görünür ışığa geçilir.',
      'survey.spherex': 'SPHEREx tüm gökyüzü (102 kanal)',
      'survey.wise': 'WISE renkli (3.4–22 µm)',
      'survey.twomass': '2MASS renkli (1.2–2.2 µm, daha net)',
      'survey.dss': 'DSS renkli (görünür ışık)',

      'play.play': 'Oynat',
      'play.pause': 'Duraklat',
      'play.title': 'Oynat veya duraklat (boşluk)',
      'play.prev': 'Önceki dönem (sol ok)',
      'play.next': 'Sonraki dönem (sağ ok)',
      'blink.aria': 'Seçilen alanın SPHEREx görüntüsü',
      'blink.help': 'Her kare, teleskobun o noktayı bir ziyaretinde (bir dönemde) tek bir dedektörle çektiği tüm pozların gökyüzünde ' +
        'hizalanmış yığınıdır: kuzey yukarıda, doğu soldadır. Film gibi oynatıldığında yer değiştiren ya da yanıp sönen her şey göze çarpar. ' +
        'Spektrumunu ölçmek için bir yıldıza tıkla. Tuşlar: boşluk oynat/duraklat, ← → kare ilerlet, 1–6 dedektör, D fark, G Gaia yıldızları, F bayraklar.',
      'frame.all': 'Tüm dönemler',
      'frame.average': 'ortalama',
      'frame.minus': 'eksi {what}',
      'compass.n': 'K',
      'compass.e': 'D',
      'readout.default': 'Kare {i}/{n} · gözlem: {span} · koordinat için imleci görüntüye getir',
      'readout.span': '{a} – {b}',
      'readout.nodata': 'veri yok',
      'readout.saturated': 'doymuş',
      'readout.difference': '(fark)',

      'ctl.detector': 'Dedektör',
      'band.all': 'Altısı birlikte',
      'band.all.sub': 'daha yavaş: tüm görüntüleri okur',
      'band.all.name': 'Tüm dedektörler',
      'ctl.limit': 'Dönem başına en çok poz',
      'ctl.limit.all': 'hepsi',
      'ctl.limit.title': 'Her dönem için bir dedektörden okunacak en çok poz sayısı. Azı daha hızlı yüklenir, çoğu daha derin ' +
        'görüntü verir. Gökyüzünün çoğunda dönem başına 15–30 poz vardır; ekliptik kutuplarına yakın alanlarda yüzlerce. ' +
        'Seçim bir seferde çok fazla veri okumayı gerektirirse sunucu sayıyı düşürür; kullanılan sayı “Bu alan” bölümünde görünür.',
      'ctl.view': 'Görünüm',
      'mode.blink': 'Film',
      'mode.diff': 'Fark',
      'mode.sum': 'Toplam',
      'mode.hint.blink': 'Film: kareler gökyüzünde hizalıdır. Dönemler arasında yer değiştiren ya da yanıp sönen her şeye yakından bakmaya değer.',
      'mode.hint.diff': 'Fark: değişmeyen yıldızlar birbirini götürür. Hareket eden cisim, eski yerinde koyu, yeni yerinde parlak bir iz bırakır.',
      'mode.hint.sum': 'Toplam: tüm dönemlerin ortalaması. Daha derin bir görüntü verir ama hareket eden cisimler bulanıklaşır.',
      'ref.label': 'Çıkarılan',
      'ref.auto': 'en derin önceki dönem',
      'ref.first': 'ilk dönem',
      'ref.prev': 'bir önceki dönem',
      'ref.mean': 'tüm dönemlerin ortalaması',
      'ref.epoch': '{date} ({exposures})',
      'ctl.display': 'Görüntü',
      'ctl.speed': 'Kare süresi',
      'ctl.white': 'Parlaklık aralığı',
      'ctl.black': 'Siyah seviyesi',
      'ctl.smooth': 'Yumuşatma',
      'ctl.off': 'kapalı',
      'ctl.invert': 'Ters çevir',
      'ctl.interp': 'Yumuşak piksel',
      'ctl.marks': 'İşaretler',
      'ctl.gaia': 'Gaia yıldızları',
      'ctl.gaia.title': 'Gaia’nın zaten bildiği yıldızları işaretle (tuş: G)',
      'ctl.flags': 'Bayraklar',
      'ctl.flags.title': 'SPHEREx’in kendi verisini şüpheli olarak işaretlediği yerleri göster (tuş: F)',
      'ctl.help': 'SPHEREx’in altı dedektörü vardır; her biri yakın kızılötesinin bir dilimini görür. Kahverengi cüceler gibi soğuk cisimler ' +
        'en parlak D5 ve D6’da görünür. “Dönem başına en çok poz”, her kare için okunacak poz sayısını belirler: azı hızlı yüklenir, ' +
        'çoğu daha derin görüntü verir. Parlaklık aralığı ve siyah seviyesi, görüntünün kontrastını görüntü gürültüsü (σ) cinsinden ayarlar.',
      'ctl.facts': 'Bu alan',
      'facts.target': 'Hedef',
      'facts.centre': 'Merkez',
      'facts.pm': 'Öz hareket',
      'facts.pm.value': 'yılda {v}″',
      'facts.fov': 'Görüş alanı',
      'facts.fov.value': '{fov} · {scale}″/piksel',
      'facts.wave': 'Dalga boyları',
      'facts.used': 'Kullanılan poz',
      'facts.used.value': '{b} pozdan {a}',
      'facts.used.limited': '{b} pozdan {a} (sınır: dönemde {n})',
      'facts.epochs': 'Dönem sayısı',
      'facts.gaia': 'Gaia yıldızı',
      'facts.gaia.fast': '{n} ({k} hızlı hareketli)',
      'facts.images': 'Toplam görüntü',
      'facts.newest': 'En yeni görüntü',

      'gaia.loading': 'Gaia yıldızları aranıyor…',
      'gaia.note': 'Mavi halka: Gaia’nın bildiği, karenin tarihine taşınmış bir yıldız. Pembe ok: hızlı hareket eden yıldızın {years} yıl sonraki yeri. ' +
        'Hareket ettiği halde halkası olmayan bir cisim Gaia’da yoktur.',
      'gaia.truncated': ' Yalnız en parlak {n} yıldız işaretli.',
      'gaia.failed': 'Gaia yıldızları yüklenemedi. ',
      'gaia.hover': 'Gaia yıldızı',
      'gaia.hover.moving': 'yılda {v} hareket ediyor',
      'gaia.hover.distance': '{d} ışık yılı uzakta',
      'gaia.rate': '{v}″/yıl',

      'flags.loading': 'SPHEREx kalite bayrakları okunuyor…',
      'flags.note': 'Pembe: SPHEREx’in, bu kareyi oluşturan pozların en az dörtte birinde kendisinin işaretlediği pikseller (kozmik ışın, doyma, ' +
        'kalıcı yük, parlak yıldız hayaleti). Hangi bayrak olduğunu görmek için imleci piksele getir; pozların tamamı aşağıda listelenir.',
      'flags.failed': 'Kalite bayrakları okunamadı. ',
      'flags.hover': 'bayraklar: {names} (pozların %{p}’inde işaretli)',
      'exp.note': 'Bu karede {exposures} var; {k} tanesinde merkezde sorun bayrağı bulunuyor. Dalga boyu, her pozun alan merkezinde gördüğü değerdir.',
      'exp.col.time': 'Çekim (UTC)',
      'exp.col.detector': 'Dedektör',
      'exp.col.wave': 'Merkezdeki dalga boyu',
      'exp.col.flags': 'Merkezin 12″ çevresindeki bayraklar',
      'exp.col.file': 'SPHEREx görüntüsü',
      'exp.none': 'yok',
      'exp.open': 'SPHEREx görüntüsünün tamamını IRSA’da aç (yaklaşık 65 MB)',

      'flag.TRANSIENT': 'Poz sırasında sinyalde ani sıçrama; genellikle kozmik ışın çarpması',
      'flag.OVERFLOW': 'Piksel poz sırasında doldu (doydu)',
      'flag.SUR_ERROR': 'Uydudaki bilgisayar işlem hatası bildirdi',
      'flag.NONFUNC': 'Ölü piksel: kalıcı olarak kullanılamaz',
      'flag.DICHROIC': 'Teleskobun ışın ayırıcısı (dikroik) yüzünden burada duyarlılık düşük',
      'flag.MISSING_DATA': 'Veri uyduda kayboldu',
      'flag.HOT': 'Sıcak piksel: kendiliğinden yüksek değer okur',
      'flag.COLD': 'Anormal derecede düşük sinyal',
      'flag.FULLSAMPLE': 'Bilgi amaçlı: bu pikselin tüm okuma geçmişi yere gönderildi',
      'flag.PHANMISS': 'Hayalet sinyal (phantom) düzeltmesi uygulanmadı',
      'flag.NONLINEAR': 'Dedektörün doğrusallık düzeltmesi burada güvenilir değil',
      'flag.PERSIST': 'Önceki bir pozdaki parlak bir cisimden kalan yük',
      'flag.OUTLIER': 'İşlem hattı tarafından aykırı değer olarak işaretlendi',
      'flag.CROSSTALK': 'Elektronik girişimden (crosstalk) etkilenmiş',
      'flag.SOURCE': 'Bilgi amaçlı: bu pikselde bilinen bir yıldız ya da gökada var',
      'flag.GHOST': 'Bu pozun içindeki parlak bir yıldızın hayaleti (istenmeyen yansıması)',
      'flag.GHOST_FPA': 'Başka bir dedektördeki parlak bir yıldızın hayaleti',
      'flag.GHOST_EXT': 'Görüş alanının dışındaki parlak bir yıldızın hayaleti',
      'flag.STREAK': 'Görüntüyü boydan boya geçen bir çizginin üzerinde',
      'flag.BLOOM': 'Taşma izi: doymuş bir yıldızdan taşan yük',
      'flag.SNOWBALL': '“Kartopu”: tek bir pozda beliren büyük, yuvarlak leke',
      'flag.HALO': 'Ani bir sinyal sıçramasının çevresindeki hale',
      'flag.official': '{plain} (SPHEREx: “{official}”)',

      'server.archive': 'NASA’nın SPHEREx görüntü araması (IRSA) şu anda yanıt vermiyor ve bu nokta için daha önce ' +
        'indirilmiş bir poz listesi yok. Birkaç dakika sonra yeniden dene.',
      'server.search': 'SPHEREx görüntü araması başarısız oldu: {x}',
      'server.frames': 'Kareler oluşturulamadı: {x}',
      'server.gaia': 'Gaia arşivi yanıt vermedi: {x}',
      'server.notfound': '“{x}” SIMBAD’da bulunamadı. Yazımı kontrol et ya da koordinat gir.',
      'server.nocoords': 'SIMBAD’da “{x}” için koordinat yok.',
      'server.lookup': 'İsim araması başarısız oldu: {x}',

      'tree.detector': 'Dedektör',
      'tree.total': 'Toplam',
      'tree.help': 'Her sütun teleskobun bir ziyareti, her satır bir dedektördür. Sayılar poz sayısıdır. Bir dedektörü izlemek için satırına tıkla.',

      'spec.kind.core': 'Yıldızın kendisi',
      'spec.kind.core.title': 'Ölçüm dairesinin içindeki yıldızın parlaklığı',
      'spec.kind.ring': 'Çevresindeki halka',
      'spec.kind.ring.title': 'Doymuş yıldızlar için: yıldızın çevresindeki halkadaki ışık',
      'spec.view.spectrum': 'Spektrum',
      'spec.view.curve': 'Işık eğrisi',
      'spec.log': 'Logaritmik',
      'spec.target': 'Hedefi ölç',
      'spec.aria': 'Seçilen kaynağın spektrumu',
      'spec.hint': 'Film görüntüsünde bir yıldıza tıkla ya da “Hedefi ölç” düğmesine bas. Her poz yıldızı farklı bir dalga boyunda görür; ' +
        'hepsi birlikte 0.75–5 µm arasındaki spektrumunu ve parlaklığının ziyaretler arasında nasıl değiştiğini verir.',
      'spec.help': 'Noktalar tek tek pozlardır ve döneme göre renklidir; çizgiler komşu pozların ortancasını birleştirir. Yıldız, film görüntüsüne ' +
        'çizilen kesikli dairenin içinde ölçülür; dairenin içine giren başka her şey parlaklığa eklenir. Işık eğrisinde her poz önce yıldızın ' +
        'aynı dalga boyundaki kendi ortalamasıyla karşılaştırılır: 1 ortalama, 0.5 yarı parlaklık demektir. SPHEREx için fazla parlak ' +
        'yıldızların çekirdeği boş kalır; onlarda çekirdeğin çevresindeki halkadaki ışık ölçülür. ' +
        'Grafiğin altındaki tarihlere ve dedektörlere tıklayarak onları gizleyip gösterebilirsin.',
      'spec.measuring': 'Bu nokta tüm SPHEREx pozlarında ölçülüyor…',
      'spec.asking': 'Arşive bu noktayı hangi pozların kapsadığı soruluyor…',
      'spec.finding': 'Nokta her pozda bulunuyor…',
      'spec.reading': 'Her pozdaki parlaklık ölçülüyor…',
      'spec.failed': 'Spektrum ölçülemedi. ',
      'spec.target.name': 'Hedef',
      'spec.where.moving': '{name}, hareketi izlenerek',
      'spec.summary.core': '{where}: {epochs} boyunca {exposures}; kesikli dairenin içinde ölçüldü (yarıçap {r}″).',
      'spec.summary.saturated': ' {exposures}, yıldız orada doyduğu için dışarıda bırakıldı.',
      'spec.summary.ring': '{name} SPHEREx için fazla parlak: {b} pozun {a} tanesinde çekirdeği doymuş. Bunun yerine çevresindeki halkadaki ışık ' +
        'gösteriliyor (merkezden {r0}″–{r1}″ uzakta, kesikli dairelerin arası), {exposures} üzerinden. Bu ışık yıldızla birlikte artar ve azalır ama toplam parlaklığı değildir.',
      'spec.summary.thinned': ' {b} pozdan yalnız {a} tanesi okundu.',
      'spec.summary.rejected': ' {exposures} aykırı değer olarak ayrıldı (kozmik ışın ya da bozuk piksel).',
      'spec.units.flux': 'Akı yoğunluğu (mJy)',
      'spec.units.ring': 'Halkadaki ışık (mJy)',
      'plot.wavelength': 'Dalga boyu (µm)',
      'plot.date': 'Gözlem tarihi',
      'plot.relative': 'Parlaklık / kendi ortalaması',
      'plot.empty': 'Spektrumunu burada görmek için film görüntüsünde bir yıldıza tıkla.',
      'plot.nothing': 'Çizilecek veri yok: tüm pozlar doymuş, gizli ya da eksik.',
      'plot.feature.ice': 'su buzu',
      'plot.hit.curve': '{date}  ·  D{band} ({range})  ·  ortalamasının {v} katı, {exposures} üzerinden',
      'plot.chip.epoch': 'Bu dönemi göster ya da gizle ({exposures})',
      'plot.chip.band': 'D{band} dedektörünü göster ya da gizle ({range})',

      'msg.start': 'Başlamak için koordinat ya da bir cisim adı gir.',
      'msg.coords': 'Bu koordinatlar gökyüzünün dışında: sağ açıklık 0–360° (ya da 0–24 saat), dik açıklık −90° ile +90° arasında olmalı.',
      'msg.noimages': 'SPHEREx’in bu noktanın {band} görüntüsü henüz yok.\nBaşka bir dedektör dene.',
      'msg.toofew': 'SPHEREx’in burada {band} için yalnız {exposures} var; bir dönem oluşturmaya yetmiyor.\nBaşka bir dedektör dene.',
      'msg.noserver': 'Blink Tree sunucusuna ulaşılamıyor.\nProje klasöründe şu komutla başlat:\npython -m uvicorn backend.app:app --port 8000',
      'msg.rejected': 'Sunucu isteği reddetti ({status}).',
      'msg.error': 'Sunucu hata verdi ({status}).',
      'msg.unexpected': 'Sunucudan beklenmeyen bir yanıt geldi.',
      'prog.asking': 'SPHEREx arşivine bu noktayı hangi görüntülerin kapsadığı soruluyor…',
      'prog.headers': 'Hedef her {band} görüntüsünde bulunuyor…',
      'prog.pixels': '{band} pikselleri NASA arşivinden okunuyor…',
      'prog.lookup': '“{name}” aranıyor…',

      'archive.stale': 'NASA’nın SPHEREx görüntü araması (IRSA) şu anda yanıt vermiyor. Bu alan için daha önce indirilen ' +
        'poz listesi kullanılıyor; en yeni görüntüler eksik olabilir.',
      'archive.incomplete': 'NASA’nın SPHEREx görüntü araması (IRSA) şu anda yanıt vermiyor. Pozlar, yakındaki noktaların ' +
        'önceki aramalarından alındı; bazıları eksik olabilir. Tam liste için birkaç dakika sonra yeniden dene.',
      'spec.summary.offline': ' Görüntü araması (IRSA) yanıt vermediği için bazı pozlar eksik olabilir.',

      'demo.start': 'Herhangi bir noktayı keşfetmek için sunucuyu başlat: python -m uvicorn backend.app:app --port 8000',
      'demo.banner': 'Çevrimdışı demo: canlı sunucu çalışmıyor; beş örnek hedef {date} tarihinde kaydedilen veriden gösteriliyor. {start}',
      'demo.banner.nodate': 'Çevrimdışı demo: canlı sunucu çalışmıyor; beş örnek hedef kayıtlı veriden gösteriliyor. {start}',
      'demo.only': 'Canlı sunucu olmadan yalnız beş örnek hedef gösterilebilir.\n{start}',
      'demo.unreadable': 'Bu hedefin kayıtlı verisi okunamıyor.',
      'demo.missing': 'Bu hedefin kayıtlı verisi eksik (web/demo/{id}.js).',
      'demo.resolve': 'İsimle arama için canlı sunucu gerekir.\n{start}',
      'demo.spectrum': 'Çevrimdışı demoda yalnız hedefin kendi spektrumu var. {start}',
      'demo.fov': 'Çevrimdışı demoda bu hedef yalnız {fov} genişliğinde alanla kayıtlı.\n{start}',
      'demo.flags': 'Çevrimdışı demoda kalite bayrakları yalnız {band} görünümü için var.',
      'demo.view': 'Bu görünüm çevrimdışı demoda yok.\n{start}',
      'demo.na': 'Çevrimdışı demoda kullanılamıyor.',

      'target.barnard': 'Gökyüzünde en hızlı hareket eden yıldız: yılda 10.4 yay saniyesi.',
      'target.wise0855': 'Bilinen en soğuk kahverengi cüce, 7 ışık yılı uzakta. Yalnız 4.4–5 µm’de görünür.',
      'target.epsindb': 'Yakındaki Güneş benzeri bir yıldızın çevresinde dolanan bir çift kahverengi cüce.',
      'target.rwaur': 'Parlaklığı öngörülemez biçimde değişen genç bir yıldız.',
      'target.rdra': '245 günde bir nabız gibi atan, neredeyse kesintisiz izlenen bir kırmızı dev.',

      'foot.credits': 'Görüntüler: NASA SPHEREx görevi (JPL/Caltech), NASA/IPAC Kızılötesi Bilim Arşivi’nden. Konumlar: ESA Gaia DR3 ve SIMBAD. ' +
        'Gökyüzü haritası: Aladin Lite (CDS, Strazburg). NASA Space Apps Challenge için Kuyruk takımı tarafından geliştirildi.'
    }
  };

  const query = new URLSearchParams(location.search);
  let stored = null;
  try { stored = localStorage.getItem('blinktree.lang'); } catch (e) { /* storage may be blocked */ }
  const wanted = query.get('lang') || stored || ((navigator.language || 'en').toLowerCase().indexOf('tr') === 0 ? 'tr' : 'en');
  const lang = TEXT[wanted] ? wanted : 'en';

  /* Text for a key, with {name} placeholders filled in. Falls back to English, then to the key. */
  function t(key, values) {
    let text = TEXT[lang][key];
    if (text === undefined) text = TEXT.en[key];
    if (text === undefined) return key;
    return values ? text.replace(/\{(\w+)\}/g, (all, name) => (values[name] !== undefined ? values[name] : all)) : text;
  }

  /* A counted noun: tn('unit.exposures', 3) -> "3 exposures" / "3 poz". */
  function tn(key, n) {
    return t(key + (n === 1 ? '.one' : '.other'), { n: n });
  }

  /* Fill in the texts marked in the HTML. */
  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    scope.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    document.documentElement.lang = lang;
  }

  /* Remember the choice and reload the same view in the other language. */
  function setLang(code) {
    if (!TEXT[code] || code === lang) return;
    try { localStorage.setItem('blinktree.lang', code); } catch (e) { /* ignore */ }
    const next = new URLSearchParams(location.search);
    next.set('lang', code);
    location.search = '?' + next.toString();
  }

  window.BlinkI18n = { lang: lang, locale: lang === 'tr' ? 'tr-TR' : 'en-US', t: t, tn: tn, apply: apply, setLang: setLang };

  apply();
  const switcher = document.getElementById('lang');
  if (switcher) {
    switcher.querySelectorAll('button[data-lang]').forEach((b) => {
      b.classList.toggle('active', b.dataset.lang === lang);
      b.addEventListener('click', () => setLang(b.dataset.lang));
    });
  }
  // The small "?" on each box shows or hides its explanation.
  document.addEventListener('click', (ev) => {
    const toggle = ev.target.closest('.help-toggle');
    if (toggle) toggle.closest('.card').classList.toggle('show-help');
  });
})();
