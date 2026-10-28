// 以 Node VM 模擬表單事件的輕量功能驗收，不取代真實瀏覽器版面測試。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const researchData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research', 'travel-data.json'), 'utf8').replace(/^\uFEFF/, ''));
const match = html.match(/<script>([\s\S]*?)<\/script>/i);
assert.ok(match, '頁面包含 JavaScript');

const selectors = [
  '#preference-form', '#results', '#empty-state', '#result-count', '#result-subtitle',
  '#match-summary', '#copy-status', '#results-title', '#empty-copy', '#edit-preferences',
  '#copy-request', '#planner'
];
const elements = Object.fromEntries(selectors.map(s => [s, {
  innerHTML: '', textContent: '', hidden: false, handlers: {},
  addEventListener(type, fn) { this.handlers[type] = fn; },
  focus() {}, scrollIntoView() {}, click() { this.handlers.click?.({}); }
}]));
const state = { audiences: [], styles: [], budget: '', days: '', rainPriority: false };
const form = elements['#preference-form'];
form.budget = { get value() { return state.budget; } };
form.days = { get value() { return state.days; } };
form.querySelectorAll = selector => selector.includes('audience') ? state.audiences.map(value => ({value})) : state.styles.map(value => ({value}));
form.querySelector = selector => selector.includes('rainPriority') ? ({ checked: state.rainPriority }) : ({ focus() {} });
form.addEventListener = (type, fn) => { form.handlers[type] = fn; };

const clipboard = [];
const alerts = [];
const document = {
  querySelector: selector => elements[selector],
  createElement: () => ({style: {}, select() {}, value: ''}),
  body: {appendChild() {}, removeChild() {}}
};
const context = {
  document,
  navigator: {clipboard: {writeText: async value => clipboard.push(value)}},
  alert: value => alerts.push(value),
  setTimeout: fn => fn(),
  console
};
vm.runInNewContext(match[1], context, {timeout: 2000});

const tests = [];
async function test(name, action) { await action(); tests.push(name); }
const submit = () => form.handlers.submit({preventDefault() {}});

(async () => {
  await test('初始畫面顯示 9 筆已查核景點資料', () => {
    assert.match(elements['#result-count'].textContent, /9 筆景點資料/);
    assert.equal((elements['#results'].innerHTML.match(/class="trip-card"/g) || []).length, 9);
  });
  await test('雨天欄位只對有明確來源的兩筆標記，其餘待確認', () => {
    assert.equal(researchData.records.length, 9);
    const confirmed = researchData.records.filter(r => ['室內', '部分室內'].includes(r.weather_suitability.status));
    assert.deepEqual(confirmed.map(r => [r.id, r.weather_suitability.status]), [['TW-ATT-0001', '部分室內'], ['TW-ATT-0007', '室內']]);
    for (const r of confirmed) {
      assert.ok(r.weather_suitability.source_ids.length);
      assert.equal(r.weather_suitability.queried_at, '2026-10-28');
      assert.ok(r.weather_suitability.limitations);
    }
    assert.equal(researchData.records.filter(r => r.weather_suitability.status === '待確認').length, 7);
  });
  await test('缺少旅遊對象時阻止推薦並提示', async () => {
    state.styles = ['親子探索']; state.budget = '20000'; state.days = '2';
    await submit(); assert.match(alerts.at(-1), /旅遊對象/);
  });
  await test('親子探索得到交集候選，且保留來源、日期與價格待確認', async () => {
    state.audiences = ['親子']; state.styles = ['親子探索'];
    await submit();
    assert.match(elements['#result-count'].textContent, /5 筆提案/);
    assert.match(elements['#results'].innerHTML, /臺北市立動物園/);
    assert.match(elements['#results'].innerHTML, /SRC|臺北旅遊網/);
    assert.match(elements['#results'].innerHTML, /2026-10-28/);
    assert.match(elements['#results'].innerHTML, /價格與正式報價/);
    assert.match(elements['#match-summary'].textContent, /預算與天數目前無資料可核對/);
  });
  await test('雨天優先依有來源支持的室內程度排序並顯示查核限制', async () => {
    state.audiences = ['情侶']; state.styles = ['文化參觀']; state.budget = '30000'; state.days = '2'; state.rainPriority = true;
    await submit();
    const cards = elements['#results'].innerHTML.match(/<article class="trip-card">[\s\S]*?<\/article>/g);
    assert.equal(cards.length, 4);
    assert.match(cards[0], /臺北101觀景台/);
    assert.match(cards[0], /雨天適配：室內/);
    assert.match(cards[0], /TAIPEI 101/);
    assert.match(cards[0], /查詢日期：2026-10-28/);
    assert.match(cards[0], /前往動線.*待確認/);
    assert.ok(cards.slice(1).some(card => /雨天適配：待確認/.test(card)));
    assert.match(elements['#match-summary'].textContent, /雨天優先只依已查核/);
  });
  await test('部分室內資料以降序優先於雨天適配待確認候選', async () => {
    state.audiences = ['親子']; state.styles = ['親子探索']; state.rainPriority = true;
    await submit();
    const cards = elements['#results'].innerHTML.match(/<article class="trip-card">[\s\S]*?<\/article>/g);
    assert.equal(cards.length, 5);
    assert.match(cards[0], /臺北市立動物園/);
    assert.match(cards[0], /雨天適配：部分室內/);
    assert.match(cards[0], /SRC-01|臺北旅遊網/);
    assert.ok(cards.slice(1).some(card => /雨天適配：待確認/.test(card)));
  });
  await test('關閉雨天優先時保留原本匹配，卡片不增加雨天排序說明', async () => {
    state.audiences = ['情侶']; state.styles = ['文化參觀']; state.rainPriority = false;
    await submit();
    assert.match(elements['#result-count'].textContent, /4 筆提案/);
    assert.doesNotMatch(elements['#results'].innerHTML, /class="rain-fit"/);
  });
  await test('沒有交集時顯示可理解提示且不自動放寬', async () => {
    state.audiences = ['親子']; state.styles = ['城市景觀'];
    await submit();
    assert.equal(elements['#empty-state'].hidden, false);
    assert.match(elements['#empty-copy'].textContent, /可自行調整旅伴或風格/);
    assert.equal(elements['#results'].innerHTML, '');
  });
  await test('一鍵複製需求帶上單位、偏好與非報價聲明', async () => {
    state.audiences = ['情侶']; state.styles = ['自然景觀']; state.budget = '30000'; state.days = '3';
    await submit(); await elements['#copy-request'].handlers.click();
    assert.equal(clipboard.length, 1);
    assert.match(clipboard[0], /新台幣／人／趟/);
    assert.match(clipboard[0], /雨天優先：否/);
    assert.match(clipboard[0], /非實際客戶資料/);
    assert.match(clipboard[0], /不是已確認可售行程或報價/);
    assert.match(elements['#copy-status'].textContent, /已複製/);
  });
  await test('響應式斷點與窄螢幕單欄規則存在', () => {
    assert.match(html, /@media\(max-width:900px\)/);
    assert.match(html, /@media\(max-width:680px\)/);
    assert.match(html, /grid-template-columns:1fr;gap:14px/);
    assert.match(html, /name="rainPriority"/);
    assert.match(html, /choice-row\{display:flex;flex-wrap:wrap/);
  });
  console.log(`通過 ${tests.length}/${tests.length} 項：\n- ${tests.join('\n- ')}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
