// Run from the repository root: node --test tests/exporter/webapp/test_failed_search.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const settle = () => new Promise(resolve => setImmediate(resolve));
const BUSY = 'The server is busy. Try again in a moment.';
const results = { dpd: 'dpd-results', bd: 'bd-results', tt: 'tt-results' };
const buttons = { dpd: 'search-button', bd: 'bd-search-button', tt: 'tt-search-button' };
const success = {
  dpd: { summary_html: '', dpd_html: '<p>found</p>' },
  bd: '<p>found</p>',
  tt: { total: 0, results: [] },
};

function element() {
  let html = '';
  return {
    value: '', textContent: '', disabled: false, style: {}, dataset: {}, children: [], listeners: {},
    classList: { add() {}, remove() {}, contains: () => false },
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; this.children = []; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    appendChild(child) { this.children.push(child); return child; },
    focus() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
  };
}

function app() {
  const nodes = new Map();
  const requests = [];
  const pushes = [];
  const byId = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const sandbox = {
    console: { log() {}, error() {} },
    document: {
      documentElement: { lang: 'en' },
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
    history: { pushState: (state, title, url) => pushes.push(url), replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: 'https://dpdict.test/', pathname: '/', search: '', hash: '' },
    NodeFilter: { SHOW_TEXT: 4 },
    clearTimeout() {},
    setTimeout() {},
    showHideSandhi() {},
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of ['app.js', 'tipitaka_translations.js']) {
    vm.runInContext(readFileSync(`exporter/webapp/static/${name}`, 'utf8'), context);
  }
  return { context, byId, requests, pushes, state: vm.runInContext('appState', context) };
}

function search(page, tab, term = 'deva') {
  page.state.activeTab = tab;
  if (tab === 'dpd') page.state.dpd.searchTerm = term;
  if (tab === 'bd') page.state.bd.searchTerm1 = term;
  if (tab === 'tt') page.byId('tt-search-box').value = term;
  return tab === 'tt' ? page.context.performTTSearch() : page.context.performSearch();
}

// Back to an entry where `tab` is inactive, so it only holds a query.
function restore(page, tab) {
  const activeTab = tab === 'tt' ? 'bd' : 'tt';
  const entry = { activeTab, bd: {}, tt: {} };
  if (tab === 'dpd') entry.dpd = { searchTerm: 'deva', hasResults: true };
  if (tab === 'bd') entry.bd = { searchTerm1: 'deva', hasResults: true };
  if (tab === 'tt') entry.tt = { searchTerm: 'deva', hasResults: true };
  page.context.handlePopState({ state: entry });
  assert.equal(page.state[tab].needsRefetch, true);
  page.requests.length = 0;
}

function other(tab) {
  return tab === 'tt' ? 'bd' : 'tt';
}

function respond(request, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  request.resolve({
    ok: status < 300,
    status,
    headers: { get: name => headers[name] ?? null },
    json: async () => JSON.parse(text),
    text: async () => text,
  });
}

// The app's own busy answers, as lookup_busy_response in main.py sends them.
function busy(request, tab) {
  const page = `<p class="dpd">${BUSY}</p>`;
  const body = tab === 'dpd' ? { summary_html: '', dpd_html: page, license: {} } : page;
  respond(request, 503, body, { 'Retry-After': '10' });
}

function errorIn(page, tab) {
  return page.byId(results[tab]).children.find(child => child.className === 'error');
}

for (const tab of ['dpd', 'bd', 'tt']) {
  test(`${tab}: an error response is shown as an error, never as results`, async () => {
    const page = app();
    search(page, tab);
    respond(page.requests[0], 503, tab === 'bd' ? 'busy body' : { dpd_html: 'busy body', results: [] });
    await settle();
    assert.equal(page.state[tab].resultsHTML, '');
    assert.doesNotMatch(page.byId(results[tab]).innerHTML, /busy body/);
    assert.match(errorIn(page, tab).textContent, /Error fetching results/);
    assert.equal(page.pushes.length, 0);
    assert.equal(page.byId(buttons[tab]).disabled, false);
  });

  test(`${tab}: a failed restored tab retries when reselected until it succeeds`, async () => {
    const page = app();
    restore(page, tab);
    page.context.switchTab(tab);
    page.requests[0].reject(new TypeError('Failed to fetch'));
    await settle();
    assert.equal(page.state[tab].needsRefetch, true);
    assert.ok(errorIn(page, tab));

    page.context.switchTab(other(tab));
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 2);
    assert.equal(errorIn(page, tab), undefined);
    respond(page.requests[1], 200, success[tab]);
    await settle();
    assert.equal(page.state[tab].needsRefetch, false);
    assert.equal(errorIn(page, tab), undefined);

    page.context.switchTab(other(tab));
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 2);
  });

  test(`${tab}: a refetch still running is not started twice`, async () => {
    const page = app();
    restore(page, tab);
    page.context.switchTab(tab);
    page.context.switchTab(other(tab));
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 1);
    assert.equal(page.state[tab].needsRefetch, true);
    respond(page.requests[0], 200, success[tab]);
    await settle();
    assert.equal(page.state[tab].needsRefetch, false);
  });

  test(`${tab}: searching again after a failure replaces the error`, async () => {
    const page = app();
    search(page, tab);
    respond(page.requests[0], 500, 'error');
    await settle();
    search(page, tab);
    assert.equal(page.requests.length, 2);
    respond(page.requests[1], 200, success[tab]);
    await settle();
    assert.equal(page.pushes.length, 1);
    assert.equal(errorIn(page, tab), undefined);
  });

  test(`${tab}: the server's busy answer shows its message, and is still a failure`, async () => {
    const page = app();
    search(page, tab);
    busy(page.requests[0], tab);
    await settle();
    assert.equal(errorIn(page, tab).textContent.trim(), BUSY);
    assert.equal(page.state[tab].resultsHTML, '');
    assert.notEqual(page.state[tab].needsRefetch, true);
    assert.equal(page.pushes.length, 0);
    assert.equal(page.byId(buttons[tab]).disabled, false);
  });

  test(`${tab}: a restored tab retries after a busy answer and recovers`, async () => {
    const page = app();
    restore(page, tab);
    page.context.switchTab(tab);
    busy(page.requests[0], tab);
    await settle();
    assert.equal(errorIn(page, tab).textContent.trim(), BUSY);

    page.context.switchTab(other(tab));
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 2);
    respond(page.requests[1], 200, success[tab]);
    await settle();
    assert.equal(page.state[tab].needsRefetch, false);
    assert.equal(errorIn(page, tab), undefined);
  });

  test(`${tab}: an ordinary failure stays as it is when the tab is reopened`, async () => {
    const page = app();
    search(page, tab);
    respond(page.requests[0], 503, 'error');
    await settle();
    page.context.switchTab(other(tab));
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 1);
    assert.equal(errorIn(page, tab).textContent.trim(), 'Error fetching results.');
    assert.equal(page.pushes.length, 0);
  });

  test(`${tab}: a new search in a restored tab fails without a retry`, async () => {
    const page = app();
    restore(page, tab);
    search(page, tab, 'kamma');
    assert.equal(page.state[tab].needsRefetch, false);
    respond(page.requests[0], 503, 'error');
    await settle();
    page.context.switchTab(other(tab));
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 1);
    assert.ok(errorIn(page, tab));
  });

  test(`${tab}: a failure leaves focus where it was`, async () => {
    const page = app();
    search(page, tab);
    const focused = [];
    page.context.focusActiveTabSearchBox = () => focused.push(tab);
    respond(page.requests[0], 503, 'error');
    await settle();
    assert.equal(errorIn(page, tab).textContent.trim(), 'Error fetching results.');
    assert.deepEqual(focused, []);
  });
}

// Anything but the app's own busy answer stays generic, however close it looks.
const foreign = {
  'a proxy 503': [503, 'upstream connect error', {}],
  'a proxy 503 with Retry-After': [503, 'upstream connect error', { 'Retry-After': '10' }],
  'a proxy page with Retry-After': [503, `<html><p class="dpd">${BUSY}</p></html>`, { 'Retry-After': '10' }],
  'markup inside the message': [503, '<p class="dpd"><img src=x onerror=alert(1)></p>', { 'Retry-After': '10' }],
  'the message without Retry-After': [503, `<p class="dpd">${BUSY}</p>`, {}],
  'the message from another status': [500, `<p class="dpd">${BUSY}</p>`, { 'Retry-After': '10' }],
  'JSON without dpd_html': [503, { detail: 'proxy' }, { 'Retry-After': '10' }],
  'broken JSON': [503, '{"dpd_html": ', { 'Retry-After': '10' }],
};

for (const [name, [status, body, headers]] of Object.entries(foreign)) {
  test(`${name} stays the generic error`, async () => {
    const page = app();
    search(page, 'bd');
    respond(page.requests[0], status, body, headers);
    await settle();
    assert.equal(errorIn(page, 'bd').textContent.trim(), 'Error fetching results.');
  });
}

test('a busy message that cannot be read falls back to the generic error', async () => {
  const page = app();
  search(page, 'tt');
  page.requests[0].resolve({
    ok: false,
    status: 503,
    headers: { get: () => '10' },
    text: async () => { throw new TypeError('body stream dropped'); },
  });
  await settle();
  assert.equal(errorIn(page, 'tt').textContent.trim(), 'Error fetching results.');
  assert.notEqual(page.state.tt.needsRefetch, true);
});

test('a failed search replaces the results on screen, and the DPD summary', async () => {
  const page = app();
  page.state.dpd.resultsHTML = 'old results';
  page.byId('summary-results').innerHTML = 'old summary';
  search(page, 'dpd', 'santi');
  page.requests[0].reject(new TypeError('Failed to fetch'));
  await settle();
  assert.equal(page.state.dpd.resultsHTML, '');
  assert.equal(page.byId('summary-results').innerHTML, '');
  assert.equal(page.state.dpd.searchTerm, 'santi');
});

test('a failure on a tab the user has left is shown when they return', async () => {
  const page = app();
  search(page, 'bd');
  page.context.switchTab('dpd');
  respond(page.requests[0], 503, 'error');
  await settle();
  assert.equal(page.state.activeTab, 'dpd');
  assert.equal(errorIn(page, 'bd'), undefined);
  page.context.switchTab('bd');
  assert.equal(errorIn(page, 'bd').textContent.trim(), 'Error fetching results.');
  assert.equal(page.requests.length, 1);
});

test('a failure still shows after another tab changed the term', async () => {
  const page = app();
  search(page, 'dpd', 'deva');
  search(page, 'bd', 'kamma');
  page.requests[0].reject(new TypeError('Failed to fetch'));
  await settle();
  page.context.switchTab('dpd');
  assert.equal(errorIn(page, 'dpd').textContent.trim(), 'Error fetching results.');
  assert.equal(page.requests.length, 2);
});

test('a reply to a restored search counts after another tab changed the term', async () => {
  const page = app();
  restore(page, 'bd');
  page.context.switchTab('bd');
  page.state.bd.searchTerm1 = 'newer';
  respond(page.requests[0], 200, success.bd);
  await settle();
  assert.equal(page.state.bd.needsRefetch, false);
  page.context.switchTab('tt');
  page.context.switchTab('bd');
  assert.equal(page.requests.length, 1);
});

for (const tab of ['dpd', 'bd', 'tt']) {
  test(`${tab}: a tab restored as the active one also retries after failing`, async () => {
    const page = app();
    page.byId('tt-search-box').value = 'deva';
    const entry = { activeTab: tab, dpd: {}, bd: {}, tt: {} };
    entry[tab] = { [tab === 'bd' ? 'searchTerm1' : 'searchTerm']: 'deva', hasResults: true };
    page.context.handlePopState({ state: entry });
    assert.equal(page.requests.length, 1);
    respond(page.requests[0], 503, 'error');
    await settle();
    page.context.switchTab(other(tab));
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 2);
    respond(page.requests[1], 200, success[tab]);
    await settle();
    assert.equal(page.state[tab].needsRefetch, false);
  });

  // A direct link seeds its entry before its search finishes, so the entry
  // says the tab had no results.
  test(`${tab}: a seeded entry restored as the active one retries after failing`, async () => {
    const page = app();
    page.byId('tt-search-box').value = 'deva';
    const entry = { activeTab: tab, dpd: {}, bd: {}, tt: {} };
    entry[tab] = { [tab === 'bd' ? 'searchTerm1' : 'searchTerm']: 'deva', hasResults: false };
    page.context.handlePopState({ state: entry });
    assert.equal(page.requests.length, 1);
    page.requests[0].reject(new TypeError('Failed to fetch'));
    await settle();
    page.context.switchTab(other(tab));
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 2);
  });

  test(`${tab}: a tab restored as the active one leaves the other tabs' terms`, async () => {
    const page = app();
    page.byId('tt-search-box').value = 'deva';
    const entry = {
      activeTab: tab,
      dpd: { searchTerm: 'kamma' }, bd: { searchTerm1: 'kamma' }, tt: { searchTerm: 'kamma' },
    };
    entry[tab] = { [tab === 'bd' ? 'searchTerm1' : 'searchTerm']: 'deva', hasResults: true };
    page.context.handlePopState({ state: entry });
    respond(page.requests[0], 200, success[tab]);
    await settle();
    for (const name of ['dpd', 'bd', 'tt'].filter(name => name !== tab)) {
      assert.equal(page.state[name][name === 'bd' ? 'searchTerm1' : 'searchTerm'], 'kamma', name);
    }
  });
}

test('Clear abandons a failed Translations search', async () => {
  const page = app();
  search(page, 'tt');
  respond(page.requests[0], 503, 'error');
  await settle();
  page.context.clearTTSearch();
  page.context.switchTab('bd');
  page.context.switchTab('tt');
  assert.equal(page.requests.length, 1);
  assert.equal(page.byId(buttons.tt).disabled, false);
});

test('the error follows the page language', async () => {
  const page = app();
  page.context.document.documentElement.lang = 'ru';
  search(page, 'bd');
  respond(page.requests[0], 503, 'error');
  await settle();
  assert.equal(errorIn(page, 'bd').textContent, 'Ошибка при получении ответа.');
});

const boxes = { dpd: 'search-box', bd: 'bd-search-box-1', tt: 'tt-search-box' };

for (const tab of ['dpd', 'bd', 'tt']) {
  test(`${tab}: a failure leaves text typed since`, async () => {
    const page = app();
    search(page, tab);
    page.byId(boxes[tab]).value = 'typed';
    page.context.document.activeElement = page.byId(boxes[tab]);
    page.requests[0].reject(new TypeError('Failed to fetch'));
    await settle();
    assert.equal(page.byId(boxes[tab]).value, 'typed');
    assert.ok(errorIn(page, tab));
  });

  test(`${tab}: a failure leaves text in a box without focus`, async () => {
    const page = app();
    search(page, tab);
    page.byId(boxes[tab]).value = 'old text';
    page.requests[0].reject(new TypeError('Failed to fetch'));
    await settle();
    assert.equal(page.byId(boxes[tab]).value, 'old text');
  });
}

test('a failed CST search leaves a draft in the other box', async () => {
  const page = app();
  search(page, 'bd');
  page.byId('bd-search-box-2').value = 'bhikkhu';
  page.context.document.activeElement = page.byId('bd-search-box-1');
  page.requests[0].reject(new TypeError('Failed to fetch'));
  await settle();
  assert.equal(page.byId('bd-search-box-2').value, 'bhikkhu');
  assert.ok(errorIn(page, 'bd'));
});

test('a failed restored search leaves drafts in the other tabs', async () => {
  const page = app();
  restore(page, 'dpd');
  page.context.switchTab('dpd');
  page.byId('tt-search-box').value = 'santi';
  page.byId('tt-lang-select').value = 'ru';
  page.requests[0].reject(new TypeError('Failed to fetch'));
  await settle();
  assert.equal(page.byId('tt-search-box').value, 'santi');
  assert.equal(page.byId('tt-lang-select').value, 'ru');
  assert.ok(errorIn(page, 'dpd'));
});

test('a result arriving for another tab leaves the error on screen', async () => {
  const page = app();
  page.context.handlePopState({ state: {
    activeTab: 'tt',
    dpd: { searchTerm: 'deva', hasResults: true },
    bd: { searchTerm1: 'deva', hasResults: true },
    tt: { searchTerm: '', hasResults: false },
  } });
  page.context.switchTab('dpd');
  page.context.switchTab('bd');
  page.context.switchTab('dpd');
  assert.equal(page.requests.length, 2);
  page.requests[0].reject(new TypeError('Failed to fetch'));
  await settle();
  respond(page.requests[1], 200, success.bd);
  await settle();
  assert.equal(page.state.activeTab, 'dpd');
  assert.ok(errorIn(page, 'dpd'));
  assert.match(page.byId('bd-results').innerHTML, /found/);
});

test('an error shows only in the tab that failed', async () => {
  const page = app();
  search(page, 'dpd');
  page.requests[0].reject(new TypeError('Failed to fetch'));
  await settle();
  page.context.switchTab('bd');
  assert.equal(errorIn(page, 'bd'), undefined);
  assert.equal(errorIn(page, 'tt'), undefined);
});

test('the error stays out of History', async () => {
  const page = app();
  search(page, 'dpd');
  page.requests[0].reject(new TypeError('Failed to fetch'));
  await settle();
  const entry = page.context.navigationState();
  assert.equal('error' in entry.dpd, false);
});

for (const [tab, from] of [['dpd', 'bd'], ['bd', 'dpd'], ['tt', 'dpd']]) {
  test(`${tab}: a refetch keeps running through a search from ${from}, and is not repeated`, async () => {
    const page = app();
    page.byId('tt-search-box').value = 'deva';
    restore(page, tab);
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 1);
    search(page, from, 'kamma');
    respond(page.requests[1], 200, success[from]);
    await settle();
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 2);
    respond(page.requests[0], 200, success[tab]);
    await settle();
    assert.equal(page.state[tab].needsRefetch, false);
    page.context.switchTab(from);
    page.context.switchTab(tab);
    assert.equal(page.requests.length, 2);
  });
}
