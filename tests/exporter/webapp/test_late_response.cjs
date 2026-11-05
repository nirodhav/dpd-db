// Run with: node --test tests/exporter/webapp/test_late_response.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = name => readFileSync(join(__dirname, '..', '..', '..', 'exporter', 'webapp', 'static', name), 'utf8');
const app = source('app.js');
const home = source('home.js');
const bd = source('bold_definitions.js');
const tt = source('tipitaka_translations.js');
const clearSearch = home.slice(home.indexOf('function clearSearch() {'), home.indexOf('clearButton.addEventListener("click", clearSearch);'));
const clearBdResults = bd.slice(bd.indexOf('function clearBdResults() {'), bd.indexOf('bdClearButton.addEventListener("click", clearBdResults);'));
const performTTSearch = tt.slice(tt.indexOf('async function performTTSearch('), tt.indexOf('// Expose performTTSearch globally'));
const clearTTSearch = tt.slice(tt.indexOf('function clearTTSearch() {'), tt.indexOf('function getSelectedBooks'));

function element(id = '') {
  const classes = new Set();
  return {
    id, value: '', innerHTML: '', textContent: '', style: {}, dataset: {}, checked: false,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    addEventListener() {}, appendChild() {}, focus() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function page() {
  const nodes = {};
  const get = id => nodes[id] ??= element(id);
  const pushes = [];
  const requests = [];
  const errors = [];
  const location = { href: 'https://dpdict.test/', pathname: '/', search: '' };
  const history = {
    pushState(state, title, url) {
      pushes.push(url);
      const next = new URL(url, location.href);
      Object.assign(location, { href: next.href, pathname: next.pathname, search: next.search });
    },
    replaceState() {},
  };
  const context = vm.createContext({
    URLSearchParams, NodeFilter: { SHOW_TEXT: 4 }, showHideSandhi() {},
    console: { log() {}, error: (...args) => errors.push(args.join(' ')) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {},
    fetch: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    document: {
      documentElement: { lang: 'en' },
      activeElement: null,
      getElementById: get,
      getElementsByName: () => [],
      querySelector: () => element(),
      querySelectorAll: () => [],
      createElement: () => element(),
      createTreeWalker: () => ({ nextNode: () => null }),
      addEventListener() {},
    },
    window: { location, history, addEventListener() {} },
  });
  vm.runInContext(`${app}\n;globalThis.appState = appState;`, context);
  Object.assign(context, {
    searchBox: get('search-box'), dpdResults: get('dpd-results'), summaryResults: get('summary-results'),
    bdResults: get('bd-results'), bdSearchBox1: get('bd-search-box-1'), bdSearchBox2: get('bd-search-box-2'),
    ttSearchBox: get('tt-search-box'), ttLangSelect: get('tt-lang-select'), ttResults: get('tt-results'),
    getSelectedBooks: () => ['all'], ttFilterBox: get('tt-filter-box'), ttBookCheckboxes: [], updateBookDropdownText() {},
  });
  context.window.showLoading = context.showLoading;
  context.window.hideLoading = context.hideLoading;
  vm.runInContext(clearSearch + clearBdResults + clearTTSearch + performTTSearch, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const answer = async (index, word) => {
    requests[index].resolve({
      ok: true,
      json: async () => ({ summary_html: `summary:${word}`, dpd_html: `result:${word}`, results: [], total: 0 }),
      text: async () => `result:${word}`,
    });
    await settle();
  };
  const fail = async index => { requests[index].reject(new Error('offline')); await settle(); };
  const search = (word, tab = 'dpd') => {
    context.appState.activeTab = tab;
    if (tab === 'dpd') context.appState.dpd.searchTerm = word;
    if (tab === 'bd') context.appState.bd.searchTerm1 = word;
    return context.performSearch(true);
  };
  const searchTT = word => {
    context.appState.activeTab = 'tt';
    get('tt-search-box').value = word;
    return context.performTTSearch(true);
  };
  const loading = id => get(id).classList.contains('loading');
  return { answer, context, errors, fail, get, loading, location, pushes, requests, search, searchTT, settle };
}

test('an older response cannot overwrite a newer search', async () => {
  const p = page();
  p.search('older');
  p.search('newer');
  await p.answer(1, 'newer');
  await p.answer(0, 'older');
  assert.equal(p.context.appState.dpd.resultsHTML, 'result:newer');
  assert.ok(p.get('summary-results').innerHTML.includes('summary:newer'));
  assert.deepEqual(p.pushes, ['/?tab=dpd&q=newer']);
});

test('an older request finishing leaves the newer one loading', async () => {
  const p = page();
  p.search('older');
  p.search('newer');
  await p.answer(0, 'older');
  assert.equal(p.loading('search-button'), true);
  await p.answer(1, 'newer');
  assert.equal(p.loading('search-button'), false);
});

test('Clear drops a pending search and releases its button', async () => {
  const p = page();
  p.search('pending');
  p.context.clearSearch();
  assert.equal(p.loading('search-button'), false);
  await p.answer(0, 'pending');
  assert.equal(p.get('dpd-results').innerHTML, '');
  assert.equal(p.context.appState.dpd.resultsHTML, '');
  assert.equal(p.location.href, 'https://dpdict.test/');
  assert.deepEqual(p.pushes, ['/']);
});

test('Back drops a pending search, and restored requests may settle out of order', async () => {
  const p = page();
  const entry = word => ({ version: 1, activeTab: 'dpd', dpd: { searchTerm: word, hasResults: true },
    bd: { searchTerm1: word, searchTerm2: '', searchOption: 'regex', hasResults: false },
    tt: { searchTerm: word, language: 'Pāḷi', books: ['all'], hasResults: false } });
  p.search('pending');
  p.context.handlePopState({ state: entry('middle') });
  p.context.handlePopState({ state: entry('earlier') });
  await p.answer(2, 'earlier');
  await p.answer(1, 'middle');
  await p.answer(0, 'pending');
  assert.equal(p.context.appState.dpd.searchTerm, 'earlier');
  assert.equal(p.context.appState.dpd.resultsHTML, 'result:earlier');
  assert.deepEqual(p.pushes, []);
});

test('a search leaves other tabs\' pending searches, while syncing its term', async () => {
  const p = page();
  p.search('dpd word');
  p.search('bd word', 'bd');
  assert.equal(p.loading('search-button'), true);
  await p.answer(1, 'bd word');
  await p.answer(0, 'dpd word');
  assert.equal(p.context.appState.dpd.resultsHTML, 'result:dpd word');
  assert.equal(p.context.appState.dpd.searchTerm, 'bd word');
  assert.equal(p.pushes.length, 2);
  p.context.switchTab('dpd');
  assert.equal(p.requests.length, 2);
});

test('the button stays disabled until the search ends or is cancelled', async () => {
  const p = page();
  p.search('word');
  assert.equal(p.get('search-button').disabled, true);
  await p.answer(0, 'word');
  assert.equal(p.get('search-button').disabled, false);
  p.search('word');
  assert.equal(p.get('search-button').disabled, true);
  p.context.clearSearch();
  assert.equal(p.get('search-button').disabled, false);
});

test('refetches of restored tabs load side by side', async () => {
  const p = page();
  p.context.appState.activeTab = 'dpd';
  p.context.appState.dpd.searchTerm = 'word';
  p.context.performSearch(false);
  p.context.appState.activeTab = 'bd';
  p.context.appState.bd.searchTerm1 = 'word';
  p.context.performSearch(false);
  await p.answer(1, 'bd');
  await p.answer(0, 'dpd');
  assert.equal(p.context.appState.dpd.resultsHTML, 'result:dpd');
  assert.equal(p.context.appState.bd.resultsHTML, 'result:bd');
  assert.deepEqual(p.pushes, []);
});

// As before, a completed search writes its term into the box.
test('a completed search shows its term in the box, and a genuine failure is still logged', async () => {
  const p = page();
  p.search('older');
  p.get('search-box').value = 'typed';
  p.context.document.activeElement = p.get('search-box');
  await p.answer(0, 'older');
  assert.equal(p.get('search-box').value, 'older');
  assert.equal(p.context.appState.dpd.resultsHTML, 'result:older');
  p.search('next');
  await p.fail(1);
  assert.equal(p.errors.length, 1);
  assert.equal(p.loading('search-button'), false);
});

test('a completed BD search shows its term in the box', async () => {
  const p = page();
  p.search('older', 'bd');
  p.get('bd-search-box-1').value = 'typed';
  p.context.document.activeElement = p.get('bd-search-box-1');
  await p.answer(0, 'older');
  assert.equal(p.get('bd-search-box-1').value, 'older');
  assert.equal(p.context.appState.bd.resultsHTML, 'result:older');
});

test('a superseded request failing is not reported', async () => {
  const p = page();
  p.search('older');
  p.search('newer');
  await p.fail(0);
  assert.deepEqual(p.errors, []);
  assert.equal(p.loading('search-button'), true);
});

test('the same rule holds for Tipiṭaka Translations', async () => {
  const p = page();
  p.searchTT('older');
  p.searchTT('newer');
  await p.answer(1, 'newer');
  const shown = p.get('tt-results').innerHTML;
  await p.fail(0);
  assert.equal(p.get('tt-results').innerHTML, shown);
  assert.deepEqual(p.errors, []);
  assert.equal(p.pushes.length, 1);
  assert.equal(p.loading('tt-search-button'), false);
});

test('an empty Tipiṭaka Translations search leaves a pending one running', async () => {
  const p = page();
  p.searchTT('word');
  p.searchTT('');
  assert.equal(p.requests.length, 1);
  await p.answer(0, 'word');
  assert.notEqual(p.context.appState.tt.resultsHTML, '');
  assert.equal(p.loading('tt-search-button'), false);
});

test('repeating the pending search is not sent again, on any tab', async () => {
  const p = page();
  p.search('word');
  p.search('word');
  p.search('word');
  assert.equal(p.requests.length, 1);
  await p.answer(0, 'word');
  assert.equal(p.context.appState.dpd.resultsHTML, 'result:word');
  assert.deepEqual(p.pushes, ['/?tab=dpd&q=word']);
  assert.equal(p.loading('search-button'), false);

  const b = page();
  b.search('word', 'bd');
  b.search('word', 'bd');
  assert.equal(b.requests.length, 1);

  const t = page();
  t.searchTT('word');
  t.searchTT('word');
  assert.equal(t.requests.length, 1);
  await t.answer(0, 'word');
  assert.equal(t.pushes.length, 1);
  assert.equal(t.loading('tt-search-button'), false);
});

test('a different word, or the same word on another tab, is still sent', () => {
  const p = page();
  p.search('older');
  p.search('newer');
  assert.equal(p.requests.length, 2);
  p.search('newer', 'bd');
  assert.equal(p.requests.length, 3);
});

test('any part of a BD or TT request makes it a different search', () => {
  const b = page();
  b.search('word', 'bd');
  b.context.appState.bd.searchTerm2 = 'second';
  b.search('word', 'bd');
  b.context.appState.bd.searchOption = 'fuzzy';
  b.search('word', 'bd');
  assert.equal(b.requests.length, 3);

  const t = page();
  t.searchTT('word');
  t.get('tt-lang-select').value = 'English';
  t.searchTT('word');
  t.context.getSelectedBooks = () => ['dn1'];
  t.searchTT('word');
  assert.equal(t.requests.length, 3);
});

test('the same search runs again once the pending one is over', async () => {
  const p = page();
  p.search('word');
  await p.answer(0, 'word');
  p.search('word');
  assert.equal(p.requests.length, 2, 'after finishing');
  await p.fail(1);
  p.search('word');
  assert.equal(p.requests.length, 3, 'after failing');
  p.context.clearSearch();
  p.search('word');
  assert.equal(p.requests.length, 4, 'after Clear');
  p.context.handlePopState({ state: {} });
  p.search('word');
  assert.equal(p.requests.length, 5, 'after Back');
  p.context.appState.activeTab = 'tt';
  const stale = p.requests.length;
  p.context.performSearch(false);
  assert.equal(p.requests.length, stale, 'no request from a tab performSearch does not serve');

  const t = page();
  t.searchTT('word');
  await t.answer(0, 'word');
  t.searchTT('word');
  assert.equal(t.requests.length, 2, 'TT after finishing');
  await t.fail(1);
  t.searchTT('word');
  assert.equal(t.requests.length, 3, 'TT after failing');
});

test('a superseded search does not free the query of the newer one', async () => {
  const p = page();
  p.search('older');
  p.search('newer');
  await p.fail(0);
  p.search('newer');
  assert.equal(p.requests.length, 2);
});

test('DPD Clear forgets a failed search', async () => {
  const p = page();
  p.search('first');
  await p.fail(0);
  p.context.clearSearch();
  assert.equal(p.context.appState.dpd.error, '');
  p.search('second', 'bd');
  await p.answer(1, 'second');
  p.context.switchTab('dpd');
  assert.equal(p.requests.length, 2);
  assert.equal(p.pushes.filter(url => url.includes('tab=dpd')).length, 0);
});

for (const [tab, clear, term] of [['dpd', 'clearSearch', 'searchTerm'], ['bd', 'clearBdResults', 'searchTerm1'], ['tt', 'clearTTSearch', 'searchTerm']]) {
  test(`${tab}: Clear cancels the retry of a failed restored tab`, async () => {
    const p = page();
    p.context.window.performTTSearch = p.context.performTTSearch;
    p.context.handlePopState({ state: { activeTab: tab, dpd: {}, bd: {}, tt: {}, [tab]: { [term]: 'deva', hasResults: true } } });
    assert.equal(p.requests.length, 1);
    await p.fail(0);
    assert.equal(p.context.appState[tab].needsRefetch, true);
    p.context[clear]();
    assert.equal(p.context.appState[tab].needsRefetch, false);
    p.context.switchTab(tab === 'dpd' ? 'bd' : 'dpd');
    p.context.switchTab(tab);
    assert.equal(p.requests.length, 1);
  });
}

test('BD and Translations Clear forget a failed search', async () => {
  const p = page();
  p.search('first', 'bd');
  await p.fail(0);
  p.context.clearBdResults();
  assert.equal(p.context.appState.bd.error, '');
  p.searchTT('first');
  await p.fail(1);
  assert.notEqual(p.context.appState.tt.error, '');
  p.context.clearTTSearch();
  assert.equal(p.context.appState.tt.error, '');
});

test('a search of the same term leaves another tab\'s pending search', async () => {
  const p = page();
  p.search('deva');
  p.search('deva', 'bd');
  assert.equal(p.loading('search-button'), true);
  await p.answer(0, 'deva');
  await p.answer(1, 'deva');
  assert.equal(p.context.appState.dpd.resultsHTML, 'result:deva');
  assert.equal(p.context.appState.bd.resultsHTML, 'result:deva');
  assert.equal(p.loading('search-button'), false);
});

test('a second BD term does not change the query of a pending DPD search', async () => {
  const p = page();
  p.search('deva');
  p.context.appState.bd.searchTerm2 = 'bhikkhu';
  p.search('deva', 'bd');
  await p.answer(0, 'deva');
  assert.equal(p.context.appState.dpd.resultsHTML, 'result:deva');
});

test('a tab is not searched by itself when another tab changed its term', async () => {
  const p = page();
  p.search('deva');
  p.search('kamma', 'bd');
  await p.answer(1, 'kamma');
  p.context.switchTab('dpd');
  assert.equal(p.requests.length, 2);
  await p.answer(0, 'deva');
  assert.equal(p.context.appState.dpd.resultsHTML, 'result:deva');
  assert.notEqual(p.context.appState.dpd.needsRefetch, true);
});

test('a tab that keeps older results is not searched when opened', async () => {
  const p = page();
  p.search('old');
  await p.answer(0, 'old');
  p.search('deva');
  p.search('kamma', 'bd');
  await p.answer(2, 'kamma');
  p.context.switchTab('dpd');
  assert.equal(p.requests.length, 3);
  assert.equal(p.context.appState.dpd.resultsHTML, 'result:old');
  assert.notEqual(p.context.appState.dpd.needsRefetch, true);
});

for (const [name, clear] of [['DPD', 'clearSearch'], ['BD', 'clearBdResults'], ['Translations', 'clearTTSearch']]) {
  test(`${name} Clear leaves other tabs' pending searches`, async () => {
    const p = page();
    if (clear !== 'clearSearch') {
      p.search('deva');
      p.context[clear]();
      await p.answer(0, 'deva');
      assert.equal(p.context.appState.dpd.resultsHTML, 'result:deva');
    } else {
      p.search('deva', 'bd');
      p.context[clear]();
      await p.answer(0, 'deva');
      assert.equal(p.context.appState.bd.resultsHTML, 'result:deva');
    }
  });
}

test('BD Clear drops its own pending search', async () => {
  const p = page();
  p.search('deva', 'bd');
  p.context.clearBdResults();
  assert.equal(p.loading('bd-search-button'), false);
  await p.answer(0, 'deva');
  assert.equal(p.context.appState.bd.resultsHTML, '');
  assert.equal(p.pushes.length, 0);
});

test('Translations Clear drops its own pending search', async () => {
  const p = page();
  p.searchTT('deva');
  p.context.clearTTSearch();
  assert.equal(p.loading('tt-search-button'), false);
  await p.answer(0, 'deva');
  assert.equal(p.context.appState.tt.resultsHTML, '');
  assert.equal(p.pushes.filter(url => url.includes('q=deva')).length, 0);
});
