// Run with: node --test tests/exporter/webapp/test_restore_state.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const STATIC = path.join(__dirname, '../../../exporter/webapp/static');
const settle = () => new Promise(resolve => setImmediate(resolve));

function element() {
  let html = '';
  return {
    value: '', textContent: '', disabled: false, style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    appendChild(child) { this.children.push(child); },
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
  };
}

function app(search = '') {
  const nodes = new Map();
  const requests = [];
  const seeds = [];
  const byId = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const sandbox = {
    URLSearchParams,
    console: { log() {}, error() {} },
    document: {
      documentElement: { lang: 'en' },
      activeElement: null,
      getElementById: byId,
      getElementsByName: () => [],
      querySelector: () => element(),
      querySelectorAll: () => [],
      createElement: element,
      createTreeWalker: () => ({ nextNode: () => null }),
      createDocumentFragment: element,
      createTextNode: text => ({ textContent: text }),
      addEventListener() {},
    },
    fetch: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    history: { pushState() {}, replaceState: state => seeds.push(state) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: `https://dpdict.test/${search}`, pathname: '/', search, hash: '' },
    NodeFilter: { SHOW_TEXT: 4 },
    clearTimeout() {},
    setTimeout() {},
    showHideSandhi() {},
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['app.js', 'tipitaka_translations.js']) {
    vm.runInContext(readFileSync(path.join(STATIC, name), 'utf8'), context);
  }
  return { context, byId, requests, seeds, state: vm.runInContext('appState', context) };
}

function ok(request, body) {
  request.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

// Back to a CST entry with an empty first term, holding `tab` only as a query.
function restoreEntry(page, tab) {
  const entry = {
    activeTab: 'bd',
    dpd: { searchTerm: 'deva', hasResults: tab === 'dpd' },
    bd: { searchTerm1: '', searchTerm2: 'bhikkhu', searchOption: 'regex', hasResults: true },
    tt: { searchTerm: 'deva', language: 'Pāḷi', books: ['all'], hasResults: tab === 'tt' },
  };
  page.state.dpd.resultsHTML = '<p>another word</p>';
  page.state.dpd.searchTerm = 'nibbāti';
  page.state.tt.resultsHTML = '<p>another word</p>';
  page.state.tt.searchTerm = 'nibbāti';
  page.context.handlePopState({ state: entry });
  assert.equal(page.state[tab].needsRefetch, true);
  page.requests.length = 0;
}

test('opening a restored DPD tab leaves the other tabs\' terms as restored', async () => {
  const page = app();
  restoreEntry(page, 'dpd');
  page.context.switchTab('dpd');
  await settle();
  assert.equal(page.requests.length, 1);
  assert.match(page.requests[0].url, /search_json\?q=deva/);
  assert.equal(page.state.bd.searchTerm1, '');
  assert.equal(page.state.bd.searchTerm2, 'bhikkhu');
  ok(page.requests[0], { summary_html: '', dpd_html: '<p>found</p>' });
  await settle();
  assert.equal(page.state.bd.searchTerm1, '');
  assert.equal(page.state.dpd.needsRefetch, false);
});

test('opening a restored Translations tab leaves the other tabs\' terms as restored', async () => {
  const page = app();
  restoreEntry(page, 'tt');
  page.byId('tt-search-box').value = 'deva';
  page.state.dpd.searchTerm = 'deva';
  page.context.switchTab('tt');
  await settle();
  assert.equal(page.requests.length, 1);
  assert.match(page.requests[0].url, /tt_search\?q=deva/);
  assert.equal(page.state.bd.searchTerm1, '');
});

test('retrying a failed refetch still leaves the other tabs\' terms alone', async () => {
  const page = app();
  restoreEntry(page, 'dpd');
  page.context.switchTab('dpd');
  await settle();
  page.requests[0].reject(new Error('offline'));
  await settle();
  page.requests.length = 0;
  page.context.switchTab('bd');
  page.requests.length = 0;
  page.context.switchTab('dpd');
  await settle();
  assert.match(page.requests[0].url, /search_json\?q=deva/);
  assert.equal(page.state.bd.searchTerm1, '');
});

test('retrying a failed Translations refetch leaves them alone too', async () => {
  const page = app();
  restoreEntry(page, 'tt');
  page.byId('tt-search-box').value = 'deva';
  page.context.switchTab('tt');
  await settle();
  page.requests[0].reject(new Error('offline'));
  await settle();
  page.requests.length = 0;
  page.context.switchTab('bd');
  page.requests.length = 0;
  page.byId('tt-search-box').value = 'deva';
  page.context.switchTab('tt');
  await settle();
  assert.match(page.requests[0].url, /tt_search\?q=deva/);
  assert.equal(page.state.bd.searchTerm1, '');
});

test('a search of the user\'s own still syncs its term to the other tabs', async () => {
  const page = app();
  page.state.activeTab = 'dpd';
  page.state.dpd.searchTerm = 'deva';
  page.context.performSearch();
  assert.equal(page.state.bd.searchTerm1, 'deva');
  assert.equal(page.state.tt.searchTerm, 'deva');

  const bd = app();
  bd.state.activeTab = 'bd';
  bd.state.bd.searchTerm1 = 'santi';
  bd.context.performSearch();
  assert.equal(bd.state.dpd.searchTerm, 'santi');
  assert.equal(bd.state.tt.searchTerm, 'santi');

  const tt = app();
  tt.byId('tt-search-box').value = 'santi';
  tt.context.performTTSearch();
  await settle();
  assert.equal(tt.state.dpd.searchTerm, 'santi');
  assert.equal(tt.state.bd.searchTerm1, 'santi');
});

for (const [name, search, term] of [
  ['DPD', '?tab=dpd&q=deva', 'deva'],
  ['the default tab', '?q=deva', 'deva'],
  ['CST', '?tab=bd&q1=santi&q2=&option=regex', 'santi'],
  ['Translations', '?tab=tt&q=deva&book=all', 'deva'],
]) {
  test(`a ${name} link seeds its History entry with the synced term`, () => {
    const page = app(search);
    page.context.initializeApp();
    const seed = page.seeds[0];
    assert.equal(seed.dpd.searchTerm, term);
    assert.equal(seed.bd.searchTerm1, term);
    assert.equal(seed.tt.searchTerm, term);
  });
}

test('the empty home page seeds empty terms', () => {
  const page = app();
  page.context.initializeApp();
  const seed = page.seeds[0];
  assert.equal(seed.dpd.searchTerm, '');
  assert.equal(seed.bd.searchTerm1, '');
  assert.equal(seed.tt.searchTerm, '');
});

test('Back from a summary link on a linked search runs no search', async () => {
  const page = app('?tab=dpd&q=deva');
  page.context.initializeApp();
  assert.equal(page.requests.length, 1);
  ok(page.requests[0], { summary_html: '<p>summary</p>', dpd_html: '<p>found</p>' });
  await settle();
  await settle();
  page.requests.length = 0;
  page.context.handlePopState({ state: page.seeds[0] });
  await settle();
  assert.equal(page.requests.length, 0);
  assert.notEqual(page.state.dpd.resultsHTML, '');
});

for (const [name, tab] of [['CST', 'bd'], ['Translations', 'tt']]) {
  test(`Back from a summary link keeps a ${name} search still running`, async () => {
    const page = app('?tab=dpd&q=deva');
    page.context.initializeApp();
    ok(page.requests[0], { summary_html: '<p>summary</p>', dpd_html: '<p>found</p>' });
    await settle();
    await settle();
    page.state.activeTab = tab;
    if (tab === 'tt') {
      page.byId('tt-search-box').value = 'deva';
      page.context.performTTSearch();
    } else {
      page.context.performSearch();
    }
    assert.equal(page.requests.length, 2);
    page.state.activeTab = 'dpd';
    page.context.handlePopState({ state: page.seeds[0] });
    await settle();
    assert.equal(page.requests.length, 2);
    ok(page.requests[1], tab === 'tt' ? { total: 1, results: [] } : '<p>found</p>');
    await settle();
    await settle();
    assert.notEqual(page.state[tab].resultsHTML, '');
  });
}

for (const [name, tab, button] of [['CST', 'bd', 'bd-search-button'], ['Translations', 'tt', 'tt-search-button']]) {
  test(`Back to an entry that replaces a running ${name} search restores the entry`, async () => {
    const page = app('?tab=dpd&q=deva');
    page.context.initializeApp();
    ok(page.requests[0], { summary_html: '<p>summary</p>', dpd_html: '<p>found</p>' });
    await settle();
    await settle();
    page.state.activeTab = tab;
    if (tab === 'tt') {
      page.byId('tt-search-box').value = 'santi';
      page.context.performTTSearch();
    } else {
      page.state.bd.searchTerm1 = 'santi';
      page.context.performSearch();
    }
    assert.equal(page.requests.length, 2);
    assert.equal(page.byId(button).disabled, true);
    page.state.activeTab = 'dpd';
    page.context.handlePopState({ state: page.seeds[0] });
    await settle();
    assert.equal(page.byId(button).disabled, false);
    ok(page.requests[1], tab === 'tt' ? { total: 1, results: [] } : '<p>found</p>');
    await settle();
    await settle();
    assert.equal(page.state[tab].resultsHTML, '');
    assert.equal(page.state[tab][tab === 'bd' ? 'searchTerm1' : 'searchTerm'], 'deva');
  });
}
