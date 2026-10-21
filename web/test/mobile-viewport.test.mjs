import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function syncMobileViewport(');
const end = source.indexOf('\nlet viewportFrame', start);
assert.ok(start >= 0 && end > start, 'mobile viewport implementation is available');

function fixture({
  zoom = 1, editing = false, viewport = { height: 912, offsetTop: 0, scale: 1 },
  mobile = true, ios = false, standalone = false, displayStandalone = false,
  innerHeight = 912, rootHeight = 912,
  units = { vh: '912px', dvh: '912px', safeTop: '68px', safeBottom: '34px' },
} = {}) {
  const properties = new Map([['--mobile-vh', '528px'], ['--mobile-vtop', '60px']]);
  const classes = new Set(['keyboard-open']);
  const readings = { units: { ...units }, count: 0 };
  const root = {
    clientHeight: rootHeight,
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: name => properties.delete(name),
    },
    classList: {
      remove: name => classes.delete(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      contains: name => classes.has(name),
    },
  };
  const context = vm.createContext({
    window: { visualViewport: viewport },
    navigator: { userAgent: ios ? 'iPhone' : 'Android', standalone },
    document: { documentElement: root, activeElement: { tagName: editing ? 'TEXTAREA' : 'BODY' } },
    innerHeight,
    matchMedia: query => ({ matches: query.includes('display-mode') ? displayStandalone : mobile }),
    getComputedStyle: () => ({ zoom: String(zoom) }),
    $: () => null,
    requestAnimationFrame: callback => callback(),
  });
  vm.runInContext(source.slice(source.indexOf('function isIosStandalone('), source.indexOf('function captureDisplayDiagnostics(')), context);
  context.readViewportUnits = () => { readings.count++; return readings.units; };
  vm.runInContext(source.slice(start, end), context);
  return { sync: () => context.syncMobileViewport(), properties, classes, readings, context, root };
}

test('blurred composer drops a stale keyboard viewport instead of leaving a bottom gap', () => {
  const { sync, properties, classes } = fixture({ viewport: { height: 528, offsetTop: 60, scale: 1 } });
  sync();
  assert.equal(properties.has('--mobile-vh'), false);
  assert.equal(properties.has('--mobile-vtop'), false);
  assert.equal(classes.has('keyboard-open'), false);
});

test('only installed iOS mode uses the standalone layout, including the legacy Safari flag', () => {
  for (const options of [{ ios: true, standalone: true }, { ios: true, displayStandalone: true }]) {
    const { sync, classes } = fixture(options);
    sync(); assert.equal(classes.has('ios-standalone'), true);
  }
  for (const options of [{ ios: true }, { displayStandalone: true }, { ios: true, standalone: true, mobile: false }]) {
    const { sync, classes } = fixture(options);
    sync(); assert.equal(classes.has('ios-standalone'), false);
  }
});

test('focused composer without a keyboard retains the edge-pinned layout at reduced page zoom', () => {
  const { sync, properties, classes } = fixture({ zoom: .67, editing: true });
  sync();
  assert.equal(properties.has('--mobile-vh'), false);
  assert.equal(properties.has('--mobile-vtop'), false);
  assert.equal(classes.has('keyboard-open'), false);
});

test('enlarged page zoom does not misidentify a focused composer as an open keyboard', () => {
  const { sync, properties, classes } = fixture({ zoom: 1.25, editing: true });
  sync();
  assert.equal(properties.size, 0);
  assert.equal(classes.has('keyboard-open'), false);
});

test('visible keyboard height and scroll offset are translated into the scaled page coordinates', () => {
  const { sync, properties, classes } = fixture({ zoom: .8, editing: true, viewport: { height: 512, offsetTop: 64, scale: 1 } });
  sync();
  assert.equal(properties.get('--mobile-vh'), '640px');
  assert.equal(properties.get('--mobile-vtop'), '80px');
  assert.equal(classes.has('keyboard-open'), true);
});

test('pinch zoom leaves viewport positioning to the browser and clears stale keyboard state', () => {
  const { sync, properties, classes } = fixture({ editing: true, viewport: { height: 400, offsetTop: 20, scale: 1.5 } });
  sync();
  assert.equal(properties.size, 0);
  assert.equal(classes.has('keyboard-open'), false);
});

test('browsers without visualViewport retain the CSS layout instead of a fixed pixel height', () => {
  const { sync, properties, classes } = fixture({ editing: true, viewport: null });
  sync();
  assert.equal(properties.size, 0);
  assert.equal(classes.has('keyboard-open'), false);
});

const reportedUnits = { vh: '912px', dvh: '843.984375px', safeTop: '68px', safeBottom: '34px' };
function reportedPhone(overrides = {}) {
  return fixture({
    ios: true, standalone: true, innerHeight: 844, rootHeight: 844,
    viewport: { height: 844, offsetTop: 0, scale: 1 },
    units: reportedUnits, ...overrides,
  });
}

test('reported iPhone standalone gap uses the full viewport with page zoom compensation', () => {
  for (const zoom of [.67, 1, 1.25]) {
    const { sync, properties, classes, readings } = reportedPhone({ zoom });
    sync();
    assert.equal(properties.get('--standalone-vh'), `${100 / zoom}vh`);
    assert.equal(properties.has('--mobile-vh'), false);
    assert.equal(classes.has('keyboard-open'), false);
    assert.equal(readings.count, 1);
  }
});

test('a healthy iOS PWA and a genuinely reserved system area do not receive extra height', () => {
  for (const units of [
    { ...reportedUnits, dvh: '912px' },
    { ...reportedUnits, safeTop: '0px' },
    { ...reportedUnits, dvh: '800px' },
    { ...reportedUnits, dvh: '980px' },
    { ...reportedUnits, vh: 'NaNpx' },
    { ...reportedUnits, dvh: 'Infinitypx' },
    { ...reportedUnits, safeTop: 'unknown' },
  ]) {
    const { sync, properties } = reportedPhone({ units });
    properties.set('--standalone-vh', '100vh');
    sync();
    assert.equal(properties.has('--standalone-vh'), false, JSON.stringify(units));
  }
});

test('only the matching top safe-area difference is compensated within pixel rounding tolerance', () => {
  for (const [dvh, expected] of [['842px', true], ['846px', true], ['841px', false], ['847px', false]]) {
    const { sync, properties } = reportedPhone({ units: { ...reportedUnits, dvh } });
    sync();
    assert.equal(properties.has('--standalone-vh'), expected, dvh);
  }
});

test('Safari tabs, non-iOS standalone apps and desktop never read or compensate iOS viewport units', () => {
  for (const overrides of [
    { standalone: false },
    { ios: false },
    { mobile: false },
  ]) {
    const { sync, properties, readings } = reportedPhone(overrides);
    properties.set('--standalone-vh', '100vh');
    sync();
    assert.equal(properties.has('--standalone-vh'), false);
    assert.equal(readings.count, 0);
  }
});

test('rotating away from and back to the affected viewport refreshes rather than retaining compensation', () => {
  const { sync, properties, readings, context, root } = reportedPhone();
  sync();
  assert.equal(properties.get('--standalone-vh'), '100vh');
  readings.units = { vh: '420px', dvh: '420px', safeTop: '0px', safeBottom: '21px' };
  context.innerHeight = root.clientHeight = 420;
  context.window.visualViewport.height = 420;
  sync();
  assert.equal(properties.has('--standalone-vh'), false);
  readings.units = { ...reportedUnits };
  context.innerHeight = root.clientHeight = 844;
  context.window.visualViewport.height = 844;
  sync();
  assert.equal(properties.get('--standalone-vh'), '100vh');
});

test('the iOS keyboard takes precedence and full-height layout returns after dismissal', () => {
  const viewport = { height: 844, offsetTop: 0, scale: 1 };
  const { sync, properties, classes, context } = reportedPhone({ zoom: .8, viewport });
  sync();
  assert.equal(properties.get('--standalone-vh'), '125vh');
  context.document.activeElement.tagName = 'TEXTAREA';
  Object.assign(viewport, { height: 512, offsetTop: 64 });
  sync();
  assert.equal(properties.has('--standalone-vh'), false);
  assert.equal(properties.get('--mobile-vh'), '640px');
  assert.equal(properties.get('--mobile-vtop'), '80px');
  assert.equal(classes.has('keyboard-open'), true);
  context.document.activeElement.tagName = 'BODY';
  Object.assign(viewport, { height: 844, offsetTop: 0 });
  sync();
  assert.equal(properties.get('--standalone-vh'), '125vh');
  assert.equal(properties.has('--mobile-vh'), false);
  assert.equal(properties.has('--mobile-vtop'), false);
  assert.equal(classes.has('keyboard-open'), false);
});

test('blurred iOS input restores the standalone height even while visualViewport reports stale keyboard dimensions', () => {
  const { sync, properties, classes } = reportedPhone({
    viewport: { height: 512, offsetTop: 64, scale: 1 },
  });
  sync();
  assert.equal(properties.get('--standalone-vh'), '100vh');
  assert.equal(properties.has('--mobile-vh'), false);
  assert.equal(properties.has('--mobile-vtop'), false);
  assert.equal(classes.has('keyboard-open'), false);
});

test('pinching an affected PWA keeps its established layout height while removing keyboard offsets', () => {
  const viewport = { height: 844, offsetTop: 0, scale: 1 };
  const { sync, properties, readings } = reportedPhone({ viewport });
  sync();
  assert.equal(properties.get('--standalone-vh'), '100vh');
  Object.assign(viewport, { height: 400, offsetTop: 20, scale: 1.5 });
  properties.set('--mobile-vh', '512px');
  properties.set('--mobile-vtop', '64px');
  sync();
  assert.equal(properties.get('--standalone-vh'), '100vh');
  assert.equal(properties.has('--mobile-vh'), false);
  assert.equal(properties.has('--mobile-vtop'), false);
  assert.equal(readings.count, 1);
  Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
  sync();
  assert.equal(properties.get('--standalone-vh'), '100vh');
  assert.equal(readings.count, 2);
});

