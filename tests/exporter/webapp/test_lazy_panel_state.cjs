// Run from the repository root: node --test tests/exporter/webapp/test_lazy_panel_state.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const app = readFileSync('exporter/webapp/static/app.js', 'utf8');

function runtime() {
  const listeners = new Map();
  const checkbox = { checked: false };
  const panels = [];
  const rootClasses = new Set();
  const context = vm.createContext({
    console,
    document: {
      documentElement: {
        classList: {
          add: (...names) => names.forEach(name => rootClasses.add(name)),
          remove: (...names) => names.forEach(name => rootClasses.delete(name)),
          contains: name => rootClasses.has(name),
        },
      },
      addEventListener() {},
      getElementById: id => id === 'niggahita-toggle' ? checkbox : null,
      querySelectorAll: selector => selector === '#dpd-results [data-panel-id]' ? panels : [],
    },
    window: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      history: { replaceState() {} },
      location: { href: 'https://example.test/' },
    },
  });
  vm.runInContext(app, context);
  // Keep real navigation/state and panel logic, excluding unrelated UI work.
  vm.runInContext(`
    render = () => {};
    performSearch = () => {};
    highlightInflections = () => {};
    wrapApostrophesInHTML = html => html;
  `, context);
  return { context, state: vm.runInContext('appState', context), checkbox, panels, listeners };
}

function historyFixture() {
  const runtimeState = runtime();
  const { state, context } = runtimeState;
  state.activeTab = 'tt';
  state.dpd.searchTerm = 'dhamma';
  state.dpd.resultsHTML = '<div id="grammar_dhamma" class="hidden"></div>';
  state.dpd.panels = { grammar_dhamma: '<p>masculine</p>' };
  state.bd.searchTerm1 = 'dhamma';
  const snapshot = context.navigationState();
  snapshot.activeTab = 'bd';
  return { ...runtimeState, snapshot };
}

test('Back/Forward retains deferred content with an inactive matching DPD result', () => {
  const { context, state, snapshot } = historyFixture();
  const contents = state.dpd.panels;
  context.handlePopState({ state: snapshot });
  assert.equal(state.dpd.panels, contents);
  assert.equal(state.dpd.needsRefetch, false);
  assert.notEqual(state.dpd.resultsHTML, '');
});

for (const changed of ['active tab', 'query']) {
  test(`history clears stale deferred content when ${changed} requires a refetch`, () => {
    const { context, state, snapshot } = historyFixture();
    if (changed === 'active tab') snapshot.activeTab = 'dpd';
    else snapshot.dpd.searchTerm = 'deva';
    context.handlePopState({ state: snapshot });
    assert.equal(state.dpd.resultsHTML, '');
    assert.deepEqual(Object.keys(state.dpd.panels), []);
    assert.equal(state.dpd.needsRefetch, true);
  });
}

test('legacy full results without a panel map initialize an empty map on restore', () => {
  const { context, state, snapshot } = historyFixture();
  delete state.dpd.panels;
  context.handlePopState({ state: snapshot });
  assert.deepEqual(Object.keys(state.dpd.panels), []);
});

function emptyPanel(id, key) {
  const panel = { id, dataset: { panelId: encodeURIComponent(key) }, childNodes: [] };
  let html = '';
  Object.defineProperty(panel, 'innerHTML', {
    get: () => html,
    set(value) { html = value; panel.childNodes = value ? [{}] : []; },
  });
  return panel;
}

for (const checked of [true, false]) {
  test(`an unopened panel survives niggahita changes and uses checked=${checked}`, () => {
    const { context, state, checkbox } = runtime();
    state.dpd.panels = { 'grammar_saṃsāra': '<p>saṃsāra ṁ</p>' };
    checkbox.checked = checked;
    const panel = emptyPanel(checked ? 'grammar_saṁsāra' : 'grammar_saṃsāra', 'grammar_saṃsāra');
    assert.equal(context.fillPanel(panel), true);
    assert.equal(panel.innerHTML, checked ? '<p>saṁsāra ṁ</p>' : '<p>saṃsāra ṃ</p>');
    // Closing/reopening must preserve the user's already constructed content.
    assert.equal(context.fillPanel(panel), false);
  });
}

test('print builds panels by their stable markers after their DOM ids change', () => {
  const { context, state, checkbox, panels, listeners } = runtime();
  state.dpd.panels = { 'grammar_saṃsāra': '<p>saṃsāra</p>' };
  checkbox.checked = true;
  const panel = emptyPanel('grammar_saṁsāra', 'grammar_saṃsāra');
  panels.push(panel);
  listeners.get('beforeprint')();
  assert.equal(panel.innerHTML, '<p>saṁsāra</p>');
  assert.equal(context.fillPanel(panel), false);
});

test('printing an empty restored page does not depend on a stale panel map', () => {
  const { state, listeners } = runtime();
  delete state.dpd.panels;
  assert.doesNotThrow(() => listeners.get('beforeprint')());
});

for (const original of ['saṃsāra', 'saṁsāra']) {
  test(`audio uses the original ${original} key after display spelling changes`, () => {
    const requested = audioClick({
      'data-headword': original === 'saṃsāra' ? 'saṁsāra' : 'saṃsāra',
      'data-audio-headword': encodeURIComponent(original),
      'data-gender': 'male1',
    });
    assert.equal(requested, '/audio/' + encodeURIComponent(original) + '?gender=male1');
  });
}

test('legacy audio buttons without an encoded key retain their request behavior', () => {
  assert.equal(audioClick({ 'data-headword': 'saṃsāra', 'data-gender': 'male1' }),
    '/audio/' + encodeURIComponent('saṃsāra') + '?gender=male1');
});

function audioClick(attributes) {
  let listener;
  let requested;
  const context = vm.createContext({
    console,
    window: {},
    localStorage: { getItem: () => null },
    Audio: class {
      constructor(url) { requested = url; }
      play() { return Promise.resolve(); }
    },
    document: { addEventListener: (name, callback) => { listener = callback; } },
  });
  vm.runInContext(readFileSync('exporter/webapp/static/dpd.js', 'utf8'), context);
  const button = { getAttribute: name => attributes[name] ?? null };
  listener({
    target: { closest: selector => selector === '.dpd-button.play' ? button : null },
    preventDefault() {},
  });
  return requested;
}
