// Run from the repository root: node --test tests/exporter/webapp/test_startup.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const template = readFileSync('exporter/webapp/templates/home.html', 'utf8');
const head = template.match(/<script>([\s\S]*?)<\/script>/)[1];
const home = readFileSync('exporter/webapp/static/home.js', 'utf8');
const collapse = home.slice(home.indexOf('function initCollapseToggle('), home.indexOf('\ndocument.addEventListener("DOMContentLoaded", function () {', home.indexOf('function initCollapseToggle(')));

function classList() {
  const values = new Set();
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    contains: value => values.has(value),
    toggle(value, force = !values.has(value)) {
      if (force) values.add(value); else values.delete(value);
      return force;
    },
    values,
  };
}

function startup(width, preferences = {}, blocked = false) {
  const root = { classList: classList() };
  const elements = {};
  const storage = {
    getItem(key) { if (blocked) throw Error('blocked'); return preferences[key] ?? null; },
    setItem(key, value) { if (blocked) throw Error('blocked'); preferences[key] = String(value); },
  };
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: width <= 576 }) },
    document: { documentElement: root, getElementById: id => elements[id] },
    localStorage: storage,
    console,
  });
  vm.runInContext(head, context);
  vm.runInContext(collapse, context);
  return { context, root, elements, preferences };
}

function element(id) {
  const listeners = {};
  return { id, classList: classList(), listeners,
    addEventListener: (name, listener) => { listeners[name] = listener; },
    querySelector: () => null,
  };
}

for (const width of [375, 576, 577, 750, 751, 1440]) {
  for (const saved of [undefined, 'true', 'false', 'malformed']) {
    test(`prepaint and hydrated collapse agree at ${width}px, preference ${saved}`, () => {
      const state = startup(width, { 'history-pane_collapsed': saved, 'settings-pane_collapsed': saved });
      for (const name of ['history', 'settings']) {
        const pane = element(`${name}-pane`);
        const button = element(`${name}-collapse-toggle`);
        const expected = width <= 576 && saved !== 'false';
        assert.equal(state.root.classList.contains(`startup-${name}-collapsed`), saved !== 'false');
        state.context.initCollapseToggle(button, pane);
        assert.equal(pane.classList.contains('collapsed'), expected);
        assert.equal(state.root.classList.contains(`startup-${name}-collapsed`), false);
        for (let i = 0; i < 4; i++) button.listeners.click();
        assert.equal(pane.classList.contains('collapsed'), expected);
        assert.equal(state.preferences[`${name}-pane_collapsed`], String(expected));
      }
    });
  }
}

for (const blocked of [false, true]) {
  test(`hidden panes hand off and repeated toggles work, blocked storage=${blocked}`, () => {
    const state = startup(375, { historyPaneVisible: 'false', settingsPaneVisible: 'false' }, blocked);
    for (const name of ['history', 'settings']) {
      const pane = state.elements[`${name}-pane`] = element(`${name}-pane`);
      const button = state.elements[`${name}-toggle-button`] = element(`${name}-toggle-button`);
      state.context.initPanelToggle(button.id, pane.id, `${name}PaneVisible`);
      assert.equal(pane.classList.contains('panel-hidden'), !blocked);
      assert.equal(button.classList.contains('inactive'), !blocked);
      assert.equal(state.root.classList.contains(`startup-${name}-hidden`), false);
      for (let i = 0; i < 4; i++) button.listeners.click();
      assert.equal(pane.classList.contains('panel-hidden'), !blocked);
    }
  });
}

test('legacy Settings state is used only when the new key is absent', () => {
  assert.equal(startup(375, { _collapsed: 'false' }).root.classList.contains('startup-settings-collapsed'), false);
  assert.equal(startup(375, { _collapsed: 'false', 'settings-pane_collapsed': 'true' }).root.classList.contains('startup-settings-collapsed'), true);
});

test('blocked storage defaults safely and collapse toggles remain usable', () => {
  const state = startup(375, {}, true);
  const pane = element('history-pane');
  const button = element('history-collapse-toggle');
  state.context.initCollapseToggle(button, pane);
  assert.equal(pane.classList.contains('collapsed'), true);
  button.listeners.click();
  assert.equal(pane.classList.contains('collapsed'), false);
});

test('welcome copy stays identical to the app empty-state copy', () => {
  const app = readFileSync('exporter/webapp/static/app.js', 'utf8');
  const welcome = readFileSync('exporter/webapp/templates/welcome.html', 'utf8');
  const appWelcome = app.match(/const startMessage = `([\s\S]*?)`;/)[1];
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  assert.equal(normalize(welcome), normalize(appWelcome));
  assert.equal(home.includes('dpdResults.innerHTML = startMessage'), false);
});

for (const [initialWidth, hydratedWidth] of [[800, 375], [375, 800]]) {
  test(`viewport changes before hydration: ${initialWidth} → ${hydratedWidth}`, () => {
    const state = startup(initialWidth);
    state.context.window.matchMedia = () => ({ matches: hydratedWidth <= 576 });
    const pane = element('history-pane');
    state.context.initCollapseToggle(element('history-collapse-toggle'), pane);
    assert.equal(pane.classList.contains('collapsed'), hydratedWidth <= 576);
  });
}
