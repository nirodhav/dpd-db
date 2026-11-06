// Run from the repository root: node --test tests/exporter/webapp/test_deep_link_pending.cjs
// Execute the real request/navigation functions; only rendering and external
// browser APIs are stubbed. Held promises make each completion order explicit.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const app = readFileSync('exporter/webapp/static/app.js', 'utf8');
const home = readFileSync('exporter/webapp/static/home.js', 'utf8');
const clear = home.slice(home.indexOf('function clearSearch()'), home.indexOf('\nclearButton.addEventListener'));

function element() {
  const classes = new Set();
  return {
    innerHTML: '', textContent: 'search', value: '', checked: false,
    dataset: {}, style: {}, disabled: false,
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, focus() {},
  };
}

function harness({ pending = true, search = '?q=dhamma' } = {}) {
  const root = element();
  root.lang = 'en';
  if (pending) root.classList.add('search-pending');
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const requests = [];
  const errors = [];
  const context = vm.createContext({
    console: { log() {}, error: error => errors.push(error) },
    URLSearchParams,
    setTimeout() {},
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      documentElement: root,
      getElementById: get,
      createElement: element,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {
      location: { search, pathname: '/', href: `https://dpdict.net/${search}` },
      history: { replaceState() {}, pushState() {} },
      requestIdleCallback() {},
      addEventListener() {},
    },
    fetch: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    wrapApostrophesInHTML: html => html,
    highlightInflections() {},
    searchBox: get('search-box'),
    dpdResults: get('dpd-results'),
    summaryResults: get('summary-results'),
  });
  vm.runInContext(app, context);
  vm.runInContext(clear, context);
  vm.runInContext('render = () => {}; addToHistory = () => {}; wrapApostrophesInHTML = html => html;', context);
  return {
    context, requests, errors,
    pending: () => root.classList.contains('search-pending'),
    run: source => vm.runInContext(source, context),
    start(term = 'dhamma', tab = 'dpd') {
      context.testTerm = term;
      context.testTab = tab;
      return vm.runInContext(`
        appState.activeTab = testTab;
        if (testTab === 'dpd') appState.dpd.searchTerm = testTerm;
        else appState.bd.searchTerm1 = testTerm;
        performSearch(false);
      `, context);
    },
  };
}

function succeed(request, html = '<p>Result</p>') {
  request.resolve({
    ok: true,
    json: async () => ({ summary_html: '', dpd_html: html }),
    text: async () => html,
  });
}

test('initial hold lasts through response decoding and ends after current success', async () => {
  const h = harness();
  const search = h.start();
  assert.equal(h.pending(), true);
  let decode;
  h.requests[0].resolve({ ok: true, json: () => new Promise(resolve => { decode = resolve; }) });
  await new Promise(setImmediate);
  assert.equal(h.pending(), true);
  decode({ summary_html: '', dpd_html: '<p>Ready</p>' });
  await search;
  assert.equal(h.run('appState.dpd.resultsHTML'), '<p>Ready</p>');
  assert.equal(h.pending(), false);
  assert.equal(h.run('pendingQuery.dpd'), null);
  assert.deepEqual(h.errors, []);
});

for (const failure of ['network', 'http', 'json']) {
  test(`current ${failure} failure releases the hold`, async () => {
    const h = harness();
    const search = h.start();
    if (failure === 'network') h.requests[0].reject(new Error('network'));
    if (failure === 'http') h.requests[0].resolve({ ok: false, status: 500 });
    if (failure === 'json') h.requests[0].resolve({ ok: true, json: async () => { throw new Error('json'); } });
    await search;
    assert.equal(h.pending(), false);
    assert.equal(h.run('pendingQuery.dpd'), null);
    assert.equal(h.run('appState.dpd.error'), 'Error fetching results.');
  });
}

for (const staleFails of [false, true]) {
  test(`old ${staleFails ? 'failure' : 'success'} cannot release a replacement hold`, async () => {
    const h = harness();
    const old = h.start('dhamma');
    const current = h.start('deva');
    if (staleFails) h.requests[0].reject(new Error('old'));
    else succeed(h.requests[0], '<p>Old</p>');
    await old;
    assert.equal(h.pending(), true);
    assert.equal(h.run('pendingQuery.dpd'), '/?tab=dpd&q=deva');
    assert.equal(h.run('appState.dpd.resultsHTML'), '');
    succeed(h.requests[1], '<p>New</p>');
    await current;
    assert.equal(h.pending(), false);
    assert.equal(h.run('appState.dpd.resultsHTML'), '<p>New</p>');
  });
}

test('new response before old response releases once and keeps the new results', async () => {
  const h = harness();
  const old = h.start('dhamma');
  const current = h.start('deva');
  succeed(h.requests[1], '<p>New</p>');
  await current;
  assert.equal(h.pending(), false);
  succeed(h.requests[0], '<p>Old</p>');
  await old;
  assert.equal(h.pending(), false);
  assert.equal(h.run('appState.dpd.resultsHTML'), '<p>New</p>');
});

test('duplicate submit keeps the same request and hold', async () => {
  const h = harness();
  const search = h.start();
  await h.start();
  assert.equal(h.requests.length, 1);
  assert.equal(h.pending(), true);
  succeed(h.requests[0]);
  await search;
  assert.equal(h.pending(), false);
});

for (const cancel of ['clearSearch()', 'cancelRequests()', 'cancelRequests(["dpd"])']) {
  test(`${cancel} immediately releases a held request`, async () => {
    const h = harness();
    const search = h.start();
    h.run(cancel);
    assert.equal(h.pending(), false);
    assert.equal(h.run('pendingQuery.dpd'), null);
    succeed(h.requests[0], '<p>Old</p>');
    await search;
    assert.equal(h.run('appState.dpd.resultsHTML'), '');
    assert.equal(h.pending(), false);
  });
}

test('BD completion while DPD is pending cannot release the DPD hold', async () => {
  const h = harness();
  const dpd = h.start();
  const bd = h.start('deva', 'bd');
  succeed(h.requests[1]);
  await bd;
  assert.equal(h.pending(), true);
  succeed(h.requests[0]);
  await dpd;
  assert.equal(h.pending(), false);
});

test('TT completion or cancellation cannot release the DPD hold', async () => {
  const h = harness();
  const dpd = h.start();
  h.run('startRequest("tt", "test"); endRequest("tt"); cancelRequests(["bd", "tt"]);');
  assert.equal(h.pending(), true);
  succeed(h.requests[0]);
  await dpd;
  assert.equal(h.pending(), false);
});

for (const tab of ['bd', 'tt']) {
  test(`navigation to ${tab} releases immediately without restarting the hold`, async () => {
    const h = harness();
    const search = h.start();
    h.run(`switchTab('${tab}')`);
    assert.equal(h.pending(), false);
    h.run('switchTab("dpd")');
    assert.equal(h.pending(), false);
    succeed(h.requests[0]);
    await search;
  });
}

test('Back to an empty entry cancels and releases before the response arrives', async () => {
  const h = harness();
  const search = h.start();
  h.run('handlePopState({state: navigationState({})})');
  assert.equal(h.pending(), false);
  assert.equal(h.run('pendingQuery.dpd'), null);
  assert.equal(h.run('appState.dpd.searchTerm'), '');
  succeed(h.requests[0], '<p>Old</p>');
  await search;
  assert.equal(h.run('appState.dpd.resultsHTML'), '');
});

for (const search of ['', '?q=', '?q=%20', '?q=&q=dhamma', '?tab=bd&q=dhamma', '?tab=tt&q=dhamma', '?tab=invalid&q=dhamma']) {
  test(`initialization releases an inapplicable server hold for ${search || '/'}`, () => {
    const h = harness({ search });
    h.run('initializeApp()');
    assert.equal(h.pending(), false);
  });
}

test('empty replacement query releases without fetching', async () => {
  const h = harness();
  await h.start('  ');
  assert.equal(h.requests.length, 0);
  assert.equal(h.pending(), false);
});

test('ordinary searches never add a new layout hold', async () => {
  const h = harness({ pending: false });
  const search = h.start();
  assert.equal(h.pending(), false);
  succeed(h.requests[0]);
  await search;
  assert.equal(h.pending(), false);
});
