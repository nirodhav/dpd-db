const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync('exporter/webapp/static/tipitaka_translations.js', 'utf8');

// Small text-node double for unit testing matching/highlighting. The browser
// regression exercises the real DOM and input listeners separately.
function row(text) {
  return {
    innerHTML: text,
    get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ''); },
    dataset: { originalHtml: text },
    style: {},
    tagName: 'DIV',
    classList: { contains: () => false },
    replaceChild(span) { this.innerHTML = span.innerHTML; span.parentNode = this; },
    removeChild() {},
  };
}

function harness(term, mode = 'with', filtering = false) {
  const rows = filtering ? [row(`before ${term} after`), row('unrelated teaching')] : [];
  const count = { textContent: 'Found 2 results.' };
  const input = { value: term, addEventListener() {} };
  const pane = {
    innerHTML: '',
    dataset: { originalCountText: count.textContent, totalCount: 2 },
    addEventListener() {},
    querySelectorAll: () => rows,
    querySelector: () => count,
  };
  const controls = {
    'tt-search-box': input,
    'tt-lang-select': { value: 'English' },
    'tt-filter-mode': { value: mode, addEventListener() {} },
    'tt-results': pane,
  };
  const errors = [];
  const context = vm.createContext({
    document: {
      getElementById: id => controls[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: () => ({ innerHTML: '', firstChild: null }),
      createTreeWalker(element) {
        let visited = false;
        return {
          currentNode: { nodeValue: element.textContent, parentNode: element },
          nextNode() {
            if (visited) return false;
            visited = true;
            return true;
          },
        };
      },
    },
    NodeFilter: { SHOW_TEXT: 4 },
    window: {},
    console: { error: (...args) => errors.push(args) },
    appState: { tt: { resultsHTML: '' }, dpd: {}, bd: {} },
    startRequest: () => () => false,
    endRequest() {},
    showSearchError: (...args) => errors.push(args),
    fetch: async () => ({
      ok: true,
      json: async () => ({ total: 1, results: [{
        id: 1, pali: 'dhamma', eng: `before ${term} after`, book: 'test', table: 'test',
      }] }),
    }),
  });
  vm.runInContext(source, context);
  return { context, rows, count, errors };
}

for (const term of ['[', '(', '*', '\\', '[a.b']) {
  test(`invalid regex ${JSON.stringify(term)} highlights literally in search results`, async () => {
    const { context, errors } = harness(term);
    await context.performTTSearch(false, false);
    assert.deepEqual(errors, []);
    assert.ok(context.appState.tt.resultsHTML.includes(`<span class='hi'>${term}</span>`));
    assert.equal(context.appState.tt.needsRefetch, false);
  });

  test(`invalid regex ${JSON.stringify(term)} filters literally and clearing restores results`, () => {
    const { context, rows, count } = harness(term, 'with', true);
    context.filterTTResults(term);
    assert.equal(rows[0].style.display, '');
    assert.equal(rows[1].style.display, 'none');
    assert.ok(rows[0].innerHTML.includes(`<span class="hi-filter">${term}</span>`));
    assert.equal(count.textContent, 'Showing 1 / 2 results.');
    context.filterTTResults('');
    assert.ok(rows.every(item => item.style.display === ''));
    assert.equal(rows[0].innerHTML, rows[0].dataset.originalHtml);
    assert.equal(count.textContent, 'Found 2 results.');
  });
}

test('without mode excludes a literal match without adding highlights', () => {
  const { context, rows, count } = harness('[', 'without', true);
  context.filterTTResults('[');
  assert.equal(rows[0].style.display, 'none');
  assert.equal(rows[1].style.display, '');
  assert.ok(rows.every(item => !item.innerHTML.includes('hi-filter')));
  assert.equal(count.textContent, 'Showing 1 / 2 results.');
});

test('valid regex search terms keep regex matching', async () => {
  const { context, errors } = harness('befo.e');
  await context.performTTSearch(false, false);
  assert.deepEqual(errors, []);
  assert.ok(context.appState.tt.resultsHTML.includes("<span class='hi'>before</span>"));
});
