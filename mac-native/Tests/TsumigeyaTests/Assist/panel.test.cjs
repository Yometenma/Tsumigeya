'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const scripts = path.resolve(__dirname, '../../../Sources/TsumigeyaCore/Resources/Assist');

// 最小 DOM 桩：只实现 panel.js 用到的节点、选择器和事件槽。
class Stub {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this._text = '';
        this.style = {};
        this.className = '';
        this.attributes = Object.create(null);
        this.hidden = false;
        this.value = '';
        this.checked = false;
        this.type = '';
        this.placeholder = '';
        this.title = '';
        this.id = '';
        this.parentNode = null;
        this._classes = new Set();
        this.classList = {
            add: name => this._classes.add(name),
            remove: name => this._classes.delete(name),
            toggle: (name, on) => {
                if (on === undefined) { this._classes.has(name) ? this._classes.delete(name) : this._classes.add(name); }
                else if (on) this._classes.add(name); else this._classes.delete(name);
            },
            contains: name => this._classes.has(name) || this.className.split(/\s+/).indexOf(name) >= 0
        };
    }
    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); this.children = []; }
    appendChild(node) {
        if (node && node._fragment) {
            for (const child of node.children) { child.parentNode = this; this.children.push(child); }
            node.children = [];
            return node;
        }
        node.parentNode = this; this.children.push(node); return node;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    attachShadow() { const root = new Stub('shadow-root'); this.shadowRoot = root; return root; }
    addEventListener() {}
    querySelectorAll(selector) { return queryAll(this, selector); }
    querySelector(selector) { const all = queryAll(this, selector); return all.length ? all[0] : null; }
}

function matchSimple(element, selector) {
    const m = /^([A-Za-z*]*)((?:\.[A-Za-z0-9_-]+)*)(?:\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\])?$/.exec(selector);
    if (!m) return false;
    const tag = m[1], classes = m[2], attr = m[3], attrValue = m[4];
    if (tag && tag !== '*' && element.tagName !== tag.toUpperCase()) return false;
    if (classes) for (const name of classes.split('.').filter(Boolean)) if (!element.classList.contains(name)) return false;
    if (attr) {
        if (!(attr in element.attributes)) return false;
        if (attrValue !== undefined && element.attributes[attr] !== attrValue) return false;
    }
    return true;
}

function descendants(node, out) {
    for (const child of node.children || []) { out.push(child); descendants(child, out); }
    return out;
}

function queryAll(root, selector) {
    let current = [root];
    for (const part of selector.trim().split(/\s+/)) {
        const next = [];
        for (const node of current) for (const candidate of descendants(node, [])) if (matchSimple(candidate, part)) next.push(candidate);
        current = next;
    }
    return current;
}

function flatten(root) { return descendants(root, []); }
function byText(root, text, tag) {
    return flatten(root).find(node => node.textContent === text && (!tag || node.tagName === tag));
}
// 切到别的分栏后旧分栏只是 hidden，DOM 仍在；断言必须限定在当前可见分栏。
function visibleRows(root) {
    return flatten(root)
        .filter(node => node.tagName === 'SECTION' && !node.hidden)
        .map(section => flatten(section).filter(node => node.tagName === 'TR'))
        .reduce((all, rows) => all.concat(rows), []);
}

function panel() {
    const document = {
        createElement: tag => new Stub(tag),
        createDocumentFragment: () => { const f = new Stub('fragment'); f._fragment = true; return f; },
        body: new Stub('body'),
        head: new Stub('head'),
        addEventListener() {},
        activeElement: null
    };
    const timers = [];
    const c = {
        console, document,
        setTimeout: fn => { timers.push(fn); return timers.length; },
        clearTimeout() {},
        setInterval: fn => { timers.push(fn); return timers.length; },
        clearInterval() {},
        confirm: () => false,
        Input: { clear() {} }
    };
    c.window = c;
    c.$dataItems = [null,
        { id: 1, name: '薬', description: '回復する。', itypeId: 1 },
        { id: 2, name: 'ポーション', description: 'HP を 500 回復する。', itypeId: 1 },
        { id: 3, name: '鍵', description: '扉を開ける。', itypeId: 2 }];
    c.$dataWeapons = [null, { id: 1, name: '銅の剣', wtypeId: 1 }];
    c.$dataArmors = [null, { id: 1, name: '旅人の服', etypeId: 3 }];
    c.$dataActors = [null, { id: 1, name: '勇者' }];
    c.$dataMapInfos = [null, { id: 1, name: '村' }];
    c.$dataCommonEvents = [null, { id: 1, name: 'イベント' }];
    c.$dataSystem = { variables: ['', '好感度', 'お金'], switches: ['', '扉'], armorTypes: ['', '', '头', '身体'], weaponTypes: ['', '剑'], equipTypes: ['', '武器', '', '身体'] };
    const values = [0, 10, 20], switches = [false, false], inventory = { 1: 0, 2: 0 };
    c.$gameVariables = { value(id) { return values[id] || 0; }, setValue(id, v) { values[id] = v; } };
    c.$gameSwitches = { value(id) { return !!switches[id]; }, setValue(id, v) { switches[id] = v; } };
    let gold = 50;
    const actor = {
        hp: 40, mp: 10, tp: 0, level: 1, mhp: 100, mmp: 20,
        params: [100, 20, 10, 10, 10, 10, 10, 10],
        actorId() { return 1; }, name() { return '勇者'; },
        maxLevel() { return 99; }, maxTp() { return 100; },
        setHp(v) { this.hp = v; }, setMp(v) { this.mp = v; }, setTp(v) { this.tp = v; },
        changeLevel(v) { this.level = v; },
        param(i) { return this.params[i]; },
        addParam(i, v) { this.params[i] += v; },
        recoverAll() { this.hp = this.mhp; }
    };
    c.$gameActors = { actor(id) { return id === 1 ? actor : null; } };
    c.$gameParty = {
        gold() { return gold; }, maxGold() { return 999; }, gainGold(n) { gold += n; },
        numItems(item) { return inventory[item.id] || 0; }, maxItems() { return 99; },
        gainItem(item, n) { inventory[item.id] = (inventory[item.id] || 0) + n; },
        members() { return [actor]; }, inBattle() { return false; }
    };
    c.Game_Player = function () {};
    c.Game_Player.prototype.isThrough = function () { return false; };
    c.Game_Player.prototype.canEncounter = function () { return true; };
    c.$gamePlayer = new c.Game_Player();
    c.$gamePlayer._moveSpeed = 4;
    c.$gamePlayer.moveSpeed = function () { return this._moveSpeed; };
    c.$gamePlayer.setMoveSpeed = function (v) { this._moveSpeed = v; };
    c.$gamePlayer.isTransferring = () => false;
    c.Scene_Map = function () {};
    c.Scene_Battle = function () {};
    c.SceneManager = { _scene: new c.Scene_Map(), updateMain() {}, updateScene() {}, isSceneChanging() { return false; } };
    c.$gameMap = { mapId() { return 1; }, events() { return []; }, isEventRunning() { return false; } };
    c.DataManager = { setupNewGame() {}, extractSaveContents() {}, onLoad() {} };
    c.TsumigeyaAssist = { errors: [], options: {}, version: 1 };
    vm.createContext(c);
    const load = name => vm.runInContext(fs.readFileSync(path.join(scripts, name), 'utf8'), c, { filename: name });
    load('cheats.js'); load('panel.js');
    return { c, document, host: c.document.body.children[0], load };
}

function panelRoot(g) {
    const host = g.document.body.children[0];
    assert.ok(host, '面板宿主没有挂到 document.body');
    return host.shadowRoot || host;
}

test('panel builds every section without touching the engine until opened', () => {
    const g = panel();
    const root = panelRoot(g);
    const buttons = flatten(root).filter(node => node.tagName === 'BUTTON').map(node => node.textContent);
    for (const title of ['常用', '物品', '变量', '开关', '角色', '数值查找', '地图与事件', '对象浏览', '锁定与状态']) {
        assert.ok(buttons.includes(title), `缺少导航按钮：${title}`);
    }
    const sections = flatten(root).filter(node => node.tagName === 'SECTION');
    assert.equal(sections.length, 9);
    assert.equal(sections.filter(section => !section.hidden).length, 1, '面板关闭时只允许一个分栏处于选中状态');
});

test('opening the item tab renders the database with a working row lock', () => {
    const g = panel();
    const root = panelRoot(g);
    const toggle = byText(root, '游戏辅助', 'BUTTON');
    toggle.onclick();
    byText(root, '物品', 'BUTTON').onclick();

    const rows = flatten(root).filter(node => node.tagName === 'TR' && node.attributes['data-id']);
    assert.equal(rows.length, 2, '默认分栏只显示 itypeId 为 1 的物品');

    const second = rows.find(row => row.attributes['data-id'] === '2');
    second.onclick();
    const side = flatten(root).find(node => node.tagName === 'STRONG' && node.textContent === 'ポーション');
    assert.ok(side, '选中行后右侧应显示物品名称');
    assert.ok(flatten(root).some(node => node.textContent === 'HP を 500 回復する。'), '右侧应显示物品描述');

    const box = flatten(second).find(node => node.type === 'checkbox');
    box.checked = true;
    box.onchange();
    assert.ok(g.c.TsumigeyaAssist.cheats.locks().some(entry => entry.key === 'item:items:2'));

    byText(root, '关键物品', 'BUTTON').onclick();
    const keys = flatten(root).filter(node => node.tagName === 'TR' && node.attributes['data-id']);
    assert.deepEqual(Array.from(keys.map(row => row.attributes['data-id'])), ['3']);
});

test('variable, switch, actor and object tabs render against a live engine', () => {
    const g = panel();
    const root = panelRoot(g);
    byText(root, '游戏辅助', 'BUTTON').onclick();

    byText(root, '变量', 'BUTTON').onclick();
    assert.equal(visibleRows(root).length, 2, '变量分栏应列出两条命名变量');

    byText(root, '开关', 'BUTTON').onclick();
    assert.equal(visibleRows(root).length, 1);

    byText(root, '角色', 'BUTTON').onclick();
    const picks = flatten(root).filter(node => node.tagName === 'SELECT');
    assert.ok(picks.some(node => node.children.some(option => option.textContent === '#1 勇者')));

    byText(root, '对象浏览', 'BUTTON').onclick();
    byText(root, '查看', 'BUTTON').onclick();
    const output = flatten(root).find(node => node.className === 'tree');
    assert.ok(output, '对象浏览应有输出容器');
    assert.ok(output.textContent.length > 0, '对象浏览应输出树内容');
});
