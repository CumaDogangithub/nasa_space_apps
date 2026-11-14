/* Example targets from the challenge brief.
 *
 * ra/dec are the catalogue position at `epoch` (decimal year); pmra/pmdec are
 * proper motions in mas/yr (pmra already includes cos(dec)). The viewer moves
 * each target to where it is now, so fast movers stay in the field.
 *
 * Sources: Gaia DR3 (Barnard's Star, RW Aur, R Dra), SIMBAD (Eps Indi B),
 * AllWISE position with the proper motion of Luhman & Esplin 2016 (WISE 0855).
 */
window.BLINK_TARGETS = [
  {
    id: 'barnard',
    name: "Barnard's Star",
    aliases: ['barnard', "barnard's star", 'barnards star', 'gj 699'],
    ra: 269.44850252543836, dec: 4.739420051112412, epoch: 2016.0,
    pmra: -801.551, pmdec: 10362.394,
    bands: '2', fov: 180,
    blurb: 'The fastest-moving star in the sky: 10.4 arcseconds per year.'
  },
  {
    id: 'wise0855',
    name: 'WISE 0855−0714',
    aliases: ['wise 0855', 'wise0855', 'wise 0855-0714', 'wise j085510.83-071442.5'],
    ra: 133.795129, dec: -7.245147, epoch: 2010.4,
    pmra: -8118, pmdec: 680,
    bands: '6', fov: 150,
    blurb: 'The coldest known brown dwarf, 7 light-years away. It only shows up at 4.4–5 µm.'
  },
  {
    id: 'epsindb',
    name: 'Epsilon Indi B',
    aliases: ['eps indi b', 'eps ind b', 'epsilon indi b', 'epsilon indi ba'],
    ra: 331.04414658852124, dec: -56.782844195116105, epoch: 2000.0,
    pmra: 3981.977, pmdec: -2466.832,
    bands: '2', fov: 180,
    blurb: 'A pair of brown dwarfs orbiting a nearby Sun-like star.'
  },
  {
    id: 'rwaur',
    name: 'RW Aurigae',
    aliases: ['rw aur', 'rw aurigae'],
    ra: 76.95608119552952, dec: 30.401204589097233, epoch: 2016.0,
    pmra: 2.641, pmdec: -27.398,
    bands: '2', fov: 180,
    blurb: 'A young star whose brightness changes unpredictably.'
  },
  {
    id: 'rdra',
    name: 'R Draconis',
    aliases: ['r dra', 'r draconis'],
    ra: 248.1673783672889, dec: 66.75500674547219, epoch: 2016.0,
    pmra: -20.643, pmdec: 6.149,
    bands: '2', fov: 180,
    blurb: 'A red giant that pulsates every 245 days, watched almost continuously.'
  }
];
