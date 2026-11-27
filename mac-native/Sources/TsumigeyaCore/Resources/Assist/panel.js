(function () {
    'use strict';
    var assist = window.TsumigeyaAssist, api = assist.cheats;
    if (!api) return;
    var host = document.createElement('div'); host.id = 'tsumigeya-assist-panel';
    host.style.cssText = 'position:fixed;z-index:2147483647;top:8px;right:8px;left:auto;bottom:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;font:14px system-ui;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = document.createElement('style');
    style.textContent = [
        ':host{color:#edf0f5}*{box-sizing:border-box}',
        'button,input,select{font:inherit;border-radius:5px;border:1px solid #667085;padding:5px 7px;color:#edf0f5;background:#263143}',
        'button{cursor:pointer}button:hover{background:#3d5273}button.active{background:#3d5273;border-color:#8fa3bd}',
        'input[type=checkbox]{padding:0;width:15px;height:15px;accent-color:#5b8def}',
        'label{display:inline-flex;align-items:center;gap:5px}',
        '#panel{background:#17202ff5;border:1px solid #667085;border-radius:10px;width:min(940px,94vw);max-height:min(88vh,760px);overflow:auto;padding:12px;box-shadow:0 8px 40px #0008}',
        'h3{margin:0 0 8px}',
        '.row{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:8px 0}',
        '.note{font-size:12px;color:#bec9d9;line-height:1.6}',
        '.status{white-space:pre-wrap;max-height:88px;overflow:auto;color:#ffe3a3;font-size:13px;min-height:18px}',
        'nav{display:flex;gap:5px;flex-wrap:wrap;margin:10px 0}',
        'section[hidden]{display:none!important}',
        '.subnav{margin:6px 0 0}',
        '.subnav button{padding:4px 9px;font-size:13px}',
        '.mm{display:grid;grid-template-columns:minmax(0,1fr) 252px;gap:10px;height:min(52vh,430px);margin-top:8px}',
        '.mm-list{overflow:auto;border:1px solid #49576b;border-radius:6px;background:#131c28}',
        '.mm-list table{width:100%;border-collapse:collapse}',
        '.mm-list tr{cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 26px}',
        '.mm-list tr:hover{background:#233046}',
        '.mm-list tr.sel{background:#3d5273}',
        '.mm-list td{padding:3px 6px;border-bottom:1px solid #263143;font-size:13px;white-space:nowrap}',
        '.mm-list td.n{overflow:hidden;text-overflow:ellipsis;max-width:0;width:100%}',
        '.mm-list td.v{text-align:right;color:#8fa3bd;font-variant-numeric:tabular-nums}',
        '.mm-list td.c{width:24px}',
        '.mm-side{border:1px solid #49576b;border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:8px;overflow:auto;font-size:13px;background:#131c28}',
        '.mm-side .desc{flex:1;min-height:56px;color:#bec9d9;white-space:pre-wrap;line-height:1.55}',
        '.tree{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;line-height:1.7;white-space:pre-wrap;max-height:44vh;overflow:auto;background:#131c28;border:1px solid #49576b;border-radius:6px;padding:8px}',
        '.data{width:100%;border-collapse:collapse}.data td,.data th{text-align:left;padding:4px;border-bottom:1px solid #49576b;word-break:break-all}.data input{width:110px}'
    ].join('');
    root.appendChild(style);

    function el(tag, text, parent) {
        var e = document.createElement(tag);
        if (text !== undefined) e.textContent = text;
        if (parent) parent.appendChild(e);
        return e;
    }
    var toggle = el('button', '游戏辅助', root); toggle.id = 'toggle'; toggle.type = 'button';
    var panel = el('div', undefined, root); panel.id = 'panel'; panel.hidden = true;
    var header = el('div', undefined, panel); header.className = 'row';
    el('h3', '游戏辅助', header); var close = el('button', '收起', header);
    var warning = el('div', '修改会写入存档；关闭辅助功能不会撤销已保存的修改。建议先单独存档。读档与新游戏会解除本次锁定和搜索。', panel);
    warning.className = 'note';
    var status = el('div', '', panel); status.className = 'status'; status.setAttribute('role', 'status');
    var nav = el('nav', undefined, panel), sections = {}, tabButtons = {}, tabShows = {};

    function say(text) { status.textContent = text; }
    function run(fn) {
        try { return fn(); }
        catch (e) { say(e.message || String(e)); return undefined; }
    }
    function row(parent) { var e = el('div', undefined, parent); e.className = 'row'; return e; }
    function button(parent, title, fn) {
        var b = el('button', title, parent); b.type = 'button';
        b.onclick = function () { run(fn); };
        return b;
    }
    function input(parent, value, hint, type) {
        var e = el('input', undefined, parent); e.type = type || 'text';
        e.value = value; e.placeholder = hint || ''; e.setAttribute('aria-label', hint || '数值');
        return e;
    }
    function select(parent, choices) {
        var s = el('select', undefined, parent);
        choices.forEach(function (c) { var o = el('option', c[1], s); o.value = c[0]; });
        return s;
    }
    function checkbox(parent, title, fn) {
        var label = el('label', undefined, parent), c = input(label, '', title, 'checkbox');
        el('span', title, label);
        c.onchange = function () { run(function () { fn(c.checked); }); };
        return c;
    }
    function parse(text) { try { return JSON.parse(text); } catch (_) { return text; } }
    function confirmRisk(text, fn) {
        if (window.confirm(text + '\n此操作可能改变剧情或损坏进度，建议先单独存档。是否继续？')) fn();
        else say('已取消。');
    }
    function tab(id, title, onShow) {
        var s = el('section', undefined, panel);
        sections[id] = s; s.hidden = true; tabShows[id] = onShow || null;
        var b = el('button', title, nav); b.type = 'button';
        b.onclick = function () { selectTab(id); };
        tabButtons[id] = b;
        return s;
    }
    var activeTab = 'common';
    function selectTab(id) {
        activeTab = id;
        Object.keys(sections).forEach(function (key) {
            sections[key].hidden = key !== id;
            if (tabButtons[key].classList) tabButtons[key].classList.toggle('active', key === id);
            else tabButtons[key].className = key === id ? 'active' : '';
        });
        if (tabShows[id]) run(tabShows[id]);
    }
    function open() {
        panel.hidden = !panel.hidden; toggle.hidden = !panel.hidden;
        if (window.Input && typeof Input.clear === 'function') Input.clear();
        if (panel.hidden) return;
        say(api.ready() ? '已连接当前游戏。' : '请先进入游戏或读取存档。');
        selectTab(activeTab);
        syncControls();
    }
    toggle.onclick = open; close.onclick = open;
    // 辅助面板输入不能落到游戏里触发移动或快捷键。
    ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'wheel', 'touchstart', 'touchend'].forEach(function (name) {
        host.addEventListener(name, function (event) { event.stopPropagation(); });
    });
    host.addEventListener('focusin', function () { if (window.Input && typeof Input.clear === 'function') Input.clear(); });
    document.addEventListener('keydown', function (event) {
        if (event.key === 'F8' && event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); open(); }
    }, true);

    // ---------------- 常用 ----------------
    var common = tab('common', '常用');
    var goldRow = row(common), gold = input(goldRow, '0', '目标金钱', 'number');
    button(goldRow, '读取', function () { gold.value = api.get('gold'); return false; });
    button(goldRow, '设置', function () { api.set('gold', Number(gold.value)); say('金钱已设为 ' + api.get('gold') + '。'); });
    button(goldRow, '锁定', function () { api.lock('gold', Number(gold.value)); say('已锁定金钱 ' + gold.value + '。'); });
    button(goldRow, '解锁', function () { api.unlock('gold'); });
    var r = row(common);
    button(r, '全队恢复', function () { api.recover(); });
    button(r, '战斗胜利', function () { confirmRisk('立即结束战斗并胜利？', function () { api.battle('win'); }); });
    button(r, '退出战斗', function () { confirmRisk('立即退出当前战斗？', function () { api.battle('escape'); }); });
    var clip = checkbox(row(common), '穿墙', function (on) { api.toggle('clip', on); });
    var encounters = checkbox(row(common), '禁止随机遇敌', function (on) { api.toggle('encounter', on); });
    var speeds = row(common), speed = select(speeds, [['1', '正常游戏速度'], ['2', '游戏速度 ×2'], ['3', '游戏速度 ×3'], ['4', '游戏速度 ×4'], ['5', '游戏速度 ×5']]);
    button(speeds, '应用速度', function () { api.speed(speed.value); });
    var move = input(speeds, '4', '移动速度（1 至 6）', 'number');
    button(speeds, '设置移动速度', function () { api.moveSpeed(move.value); });
    button(row(common), '解除全部锁定与临时辅助', function () { api.reset(); syncControls(); });
    var lastResetRevision = 0;
    function syncControls() {
        var current = api.state(); lastResetRevision = current.resetRevision;
        clip.checked = current.clip; encounters.checked = current.encounter; speed.value = String(current.speed);
        if (current.moveSpeed !== null && root.activeElement !== move && document.activeElement !== move) move.value = String(current.moveSpeed);
    }
    setInterval(function () { if (!panel.hidden && api.state().resetRevision !== lastResetRevision) syncControls(); }, 500);

    function lockMap() {
        var map = Object.create(null);
        api.locks().forEach(function (entry) { map[entry.key] = entry.value; });
        return map;
    }
    // 左列密集条目、右列详情；选中不离开列表就能改值。
    function masterDetail(parent) {
        var box = el('div', undefined, parent); box.className = 'mm';
        var list = el('div', undefined, box); list.className = 'mm-list';
        var side = el('div', undefined, box); side.className = 'mm-side';
        return { box: box, list: list, side: side };
    }

    // ---------------- 物品 ----------------
    var data = tab('data', '物品', function () { refreshItems(); });
    var subnav = el('nav', undefined, data); subnav.className = 'subnav';
    var itemBar = row(data);
    var itemQuery = input(itemBar, '', '搜索编号或名称');
    var bulkCount = input(itemBar, '99', '批量数量', 'number');
    button(itemBar, '当前分栏全设', function () {
        var n = api.setAll(currentTab.kind, currentTab.sub, Number(bulkCount.value));
        refreshItems(); say('已设置 ' + n + ' 项。');
    });
    button(itemBar, '当前分栏归零', function () {
        confirmRisk('把当前分栏的物品数量全部清零？', function () {
            var n = api.setAll(currentTab.kind, currentTab.sub, 0); refreshItems(); say('已清零 ' + n + ' 项。');
        });
    });
    var itemCount = el('div', '', data); itemCount.className = 'note';
    var itemView = masterDetail(data);
    var currentTab = { kind: 'items', sub: 1, title: '物品' }, selectedItem = null, itemTimer = null;

    var iName = el('strong', '—', itemView.side);
    var iMeta = el('div', '', itemView.side); iMeta.className = 'note';
    var iDesc = el('div', '选择左侧条目查看详情。', itemView.side); iDesc.className = 'desc';
    var iQtyRow = row(itemView.side);
    var iQty = input(iQtyRow, '0', '数量', 'number');
    [-100, -1, 1, 100].forEach(function (d) {
        button(iQtyRow, (d > 0 ? '+' : '') + d, function () {
            if (!selectedItem) return false;
            var next = api.nudge(currentTab.kind, selectedItem.id, d);
            iQty.value = String(next); paintRow(selectedItem.id, next);
        });
    });
    var iSetRow = row(itemView.side);
    button(iSetRow, '设置数量', function () {
        if (!selectedItem) return false;
        var next = api.nudge(currentTab.kind, selectedItem.id, Number(iQty.value) - selectedItem.value);
        selectedItem.value = next; iQty.value = String(next); paintRow(selectedItem.id, next);
        say('已设为 ' + next + '。');
    });
    var iLock = checkbox(iSetRow, '锁定', function (on) {
        if (!selectedItem) return;
        if (on) { api.lock(selectedItem.key, Number(iQty.value)); say('已锁定 ' + selectedItem.name + '。'); }
        else { api.unlock(selectedItem.key); say('已解除 ' + selectedItem.name + ' 的锁定。'); }
    });

    function paintRow(id, value) {
        var cell = itemView.list.querySelector('tr[data-id="' + id + '"] td.v');
        if (cell) cell.textContent = '*' + value;
    }
    function renderSubnav() {
        subnav.textContent = '';
        api.itemTabs().forEach(function (entry) {
            var b = el('button', entry.title, subnav); b.type = 'button';
            if (entry.kind === currentTab.kind && entry.sub === currentTab.sub) b.classList.add('active');
            b.onclick = function () { currentTab = entry; selectedItem = null; run(refreshItems); };
        });
    }
    function refreshItems() {
        if (!api.ready()) { itemView.list.textContent = ''; itemCount.textContent = '请先进入游戏或读取存档。'; return; }
        renderSubnav();
        var locked = lockMap();
        var rows = api.catalog(currentTab.kind, currentTab.sub);
        var needle = itemQuery.value.trim().toLowerCase();
        if (needle) {
            rows = rows.filter(function (entry) {
                return (entry.id + ' ' + entry.name + ' ' + entry.desc).toLowerCase().indexOf(needle) >= 0;
            });
        }
        var fragment = document.createDocumentFragment();
        var table = el('table', undefined, fragment);
        rows.forEach(function (entry) {
            var tr = el('tr', undefined, table);
            tr.setAttribute('data-id', entry.id);
            var cell = el('td', undefined, tr); cell.className = 'c';
            var box = input(cell, '', '锁定 ' + entry.name, 'checkbox');
            box.checked = locked[entry.key] !== undefined;
            box.onclick = function (event) { event.stopPropagation(); };
            box.onchange = function () {
                try {
                    if (box.checked) { api.lock(entry.key, entry.value); say('已锁定 ' + entry.name + '。'); }
                    else { api.unlock(entry.key); say('已解除 ' + entry.name + ' 的锁定。'); }
                } catch (e) { box.checked = !box.checked; say(e.message); }
            };
            el('td', '#' + entry.id, tr).style.color = '#8fa3bd';
            var name = el('td', entry.name, tr); name.className = 'n'; name.title = entry.name;
            var value = el('td', '*' + entry.value, tr); value.className = 'v';
            tr.onclick = function () { selectItem(entry, tr); };
        });
        itemView.list.textContent = '';
        itemView.list.appendChild(fragment);
        itemCount.textContent = '共 ' + rows.length + ' 条' + (needle ? '（已筛选）' : '') + '；行首勾选即锁定，数量由引擎上限约束。';
    }
    function selectItem(entry, tr) {
        selectedItem = entry;
        Array.prototype.forEach.call(itemView.list.querySelectorAll('tr'), function (node) { node.classList.remove('sel'); });
        tr.classList.add('sel');
        iName.textContent = entry.name;
        iMeta.textContent = '编号 #' + entry.id + ' · 上限 ' + entry.max;
        iDesc.textContent = entry.desc || '（无描述）';
        iQty.value = String(entry.value);
        iLock.checked = entry.key in lockMap();
    }
    itemQuery.oninput = function () {
        if (itemTimer) clearTimeout(itemTimer);
        itemTimer = setTimeout(function () { run(refreshItems); }, 120);
    };

    // ---------------- 变量 / 开关 ----------------
    function scalarSection(id, title, kind) {
        var section = tab(id, title, function () { refreshScalar(); });
        var bar = row(section), query = input(bar, '', '搜索编号或名称');
        var hint = el('div', '', section); hint.className = 'note';
        var view = masterDetail(section);
        var name = el('strong', '—', view.side);
        var meta = el('div', '', view.side); meta.className = 'note';
        var desc = el('div', '选择左侧条目查看当前值。', view.side); desc.className = 'desc';
        var editRow = row(view.side);
        var value = kind === 'switches'
            ? checkbox(editRow, '开启', function () {})
            : input(editRow, '0', '变量值');
        var lock = checkbox(editRow, '锁定', function (on) {
            if (!choice) return;
            if (on) { api.lock(choice.key, kind === 'switches' ? value.checked : currentValue()); say('已锁定 #' + choice.id + '。'); }
            else { api.unlock(choice.key); say('已解除锁定。'); }
        });
        var choice = null, timer = null;
        function currentValue() { return kind === 'switches' ? value.checked : parse(value.value); }
        button(editRow, '写入', function () {
            if (!choice) return false;
            api.set(choice.key, currentValue());
            refreshScalar(); say('已写入 #' + choice.id + ' = ' + JSON.stringify(currentValue()) + '。');
        });
        function render() {
            if (!api.ready()) { view.list.textContent = ''; hint.textContent = '请先进入游戏或读取存档。'; return; }
            var locked = lockMap();
            var rows = api.list(kind);
            var needle = query.value.trim().toLowerCase();
            if (needle) rows = rows.filter(function (entry) { return (entry.id + ' ' + entry.name).toLowerCase().indexOf(needle) >= 0; });
            var fragment = document.createDocumentFragment(), table = el('table', undefined, fragment);
            rows.forEach(function (entry) {
                var tr = el('tr', undefined, table), complex = entry.value !== null && typeof entry.value === 'object';
                var cell = el('td', undefined, tr); cell.className = 'c';
                var box = input(cell, '', '锁定 #' + entry.id, 'checkbox');
                box.checked = locked[entry.key] !== undefined;
                box.onclick = function (event) { event.stopPropagation(); };
                box.onchange = function () {
                    run(function () {
                        if (box.checked) { api.lock(entry.key, entry.value); say('已锁定 #' + entry.id + '。'); }
                        else { api.unlock(entry.key); say('已解除锁定。'); }
                    });
                };
                el('td', '#' + entry.id, tr).style.color = '#8fa3bd';
                var label = el('td', entry.name, tr); label.className = 'n'; label.title = entry.name;
                el('td', complex ? '（复杂）' : (kind === 'switches' ? (entry.value ? '开' : '关') : String(entry.value)), tr).className = 'v';
                tr.onclick = function () {
                    choice = entry;
                    Array.prototype.forEach.call(view.list.querySelectorAll('tr'), function (node) { node.classList.remove('sel'); });
                    tr.classList.add('sel');
                    name.textContent = entry.name; meta.textContent = '编号 #' + entry.id;
                    desc.textContent = complex ? '这是复杂对象，只读；可在对象浏览里改它的字段。' : '当前值：' + JSON.stringify(entry.value);
                    if (kind === 'switches') value.checked = !!entry.value;
                    else value.value = complex ? '' : (typeof entry.value === 'string' ? entry.value : String(entry.value));
                    lock.checked = entry.key in lockMap();
                };
            });
            view.list.textContent = ''; view.list.appendChild(fragment);
            hint.textContent = '共 ' + rows.length + ' 条' + (needle ? '（已筛选）' : '') + '；变量和开关会直接影响剧情分支。';
        }
        query.oninput = function () { if (timer) clearTimeout(timer); timer = setTimeout(render, 120); };
        function refreshScalar() { render(); }
        return section;
    }
    scalarSection('vars', '变量', 'variables');
    scalarSection('switches', '开关', 'switches');

    // ---------------- 角色 ----------------
    var actors = tab('actors', '角色', function () { refreshActors(); });
    var actorBar = row(actors), actorPick = select(actorBar, []);
    var actorHint = el('div', '', actors); actorHint.className = 'note';
    var actorTable = el('table', undefined, actors); actorTable.className = 'data';
    var equipTable = el('table', undefined, actors); equipTable.className = 'data';
    var equipHint = el('div', '', actors); equipHint.className = 'note';
    function refreshActors() {
        actorPick.textContent = '';
        api.list('actors').forEach(function (entry) { var o = el('option', '#' + entry.id + ' ' + entry.name, actorPick); o.value = String(entry.id); });
        renderActor();
    }
    var FIELDS = [['hp', '当前生命'], ['mp', '当前魔力'], ['tp', '当前特技点'], ['level', '等级'],
        ['param0', '最大生命'], ['param1', '最大魔力'], ['param2', '攻击'], ['param3', '防御'],
        ['param4', '魔法攻击'], ['param5', '魔法防御'], ['param6', '敏捷'], ['param7', '幸运']];
    function renderActor() {
        var id = actorPick.value; actorTable.textContent = ''; equipTable.textContent = '';
        if (!id || !api.ready()) { actorHint.textContent = '请先进入游戏或读取存档。'; return; }
        var header = el('tr', undefined, actorTable);
        ['属性', '当前值', '目标值', '', ''].forEach(function (title) { el('th', title, header); });
        FIELDS.forEach(function (pair) {
            var key = 'actor:' + id + ':' + pair[0], tr = el('tr', undefined, actorTable);
            el('td', pair[1], tr);
            var cell = el('td', '', tr), field = input(cell, '', '目标值', 'number');
            field.value = String(api.get(key));
            button(el('td', undefined, tr), '写入', function () { api.set(key, Number(field.value)); renderActor(); say('已写入 ' + pair[1] + '。'); });
            button(el('td', undefined, tr), '锁定', function () { api.lock(key, Number(field.value)); say('已锁定 ' + pair[1] + '。'); });
            button(el('td', undefined, tr), '解锁', function () { api.unlock(key); });
        });
        var slots = api.equips(id);
        if (!slots.length) { equipHint.textContent = '当前引擎没有可编辑的装备槽。'; return; }
        var ehead = el('tr', undefined, equipTable);
        ['装备槽', '当前装备', '更换为编号', ''].forEach(function (title) { el('th', title, ehead); });
        slots.forEach(function (slot) {
            var tr = el('tr', undefined, equipTable);
            el('td', slot.slot, tr); el('td', slot.name, tr);
            var cell = el('td', '', tr), code = input(cell, String(slot.id), '物品编号', 'number');
            button(el('td', undefined, tr), '更换', function () {
                confirmRisk('把「' + slot.slot + '」换成编号 ' + code.value + ' 的装备？', function () {
                    api.equip(id, slot.index, slot.kind, Number(code.value)); renderActor(); say('已更换装备。');
                });
            });
        });
        equipHint.textContent = '编号 0 表示卸下。直接写装备槽，不从背包扣除；不合身的装备会被引擎拒绝。';
    }
    actorPick.onchange = function () { run(renderActor); };

    // ---------------- 数值查找 ----------------
    var search = tab('scan', '数值查找'), sr = row(search), target = input(sr, '0', '待查找数值', 'number');
    el('div', '搜索范围：游戏变量、金钱与队伍角色的生命／魔力／特技点／等级。不是任意进程内存扫描。每次筛选都与上一次记录比较。', search).className = 'note';
    var scanHint = el('div', '', search), scanTable = el('table', undefined, search); scanTable.className = 'data';
    function scan(mode) {
        var rows = api.scan(mode, target.value); scanTable.textContent = '';
        scanHint.textContent = '剩余 ' + rows.length + ' 条，显示前 100 条。';
        rows.slice(0, 100).forEach(function (entry) {
            var tr = el('tr', undefined, scanTable); el('td', entry.name + '（' + entry.key + '）', tr);
            var td = el('td', undefined, tr), value = input(td, entry.value, '目标数值', 'number');
            button(td, '修改', function () { confirmRisk('修改搜索结果？', function () { api.set(entry.key, Number(value.value)); }); });
            button(td, '锁定', function () { confirmRisk('锁定搜索结果？', function () { api.lock(entry.key, Number(value.value)); }); });
        });
    }
    [['unknown', '未知初始值'], ['exact', '按数值重新查找'], ['equal', '等于输入值'], ['increased', '增加了'], ['decreased', '减少了'], ['changed', '改变了'], ['unchanged', '没有改变']]
        .forEach(function (c) { button(sr, c[1], function () { scan(c[0]); }); });

    // ---------------- 地图与事件 ----------------
    var maps = tab('maps', '地图与事件'), mr = row(maps), mapQuery = input(mr, '', '搜索地图名称／编号');
    var mapList = el('div', '', maps); mapList.className = 'note';
    button(mr, '查找地图', function () {
        var matches = api.list('maps').filter(function (m) { return (m.id + ' ' + m.name).indexOf(mapQuery.value) >= 0; });
        mapList.textContent = '共 ' + matches.length + ' 条，显示前 200 条：\n' + matches.slice(0, 200).map(function (m) { return '#' + m.id + ' ' + m.name; }).join(' / ');
    });
    var teleportRow = row(maps), mapID = input(teleportRow, '1', '地图编号', 'number'), x = input(teleportRow, '0', '横坐标', 'number'), y = input(teleportRow, '0', '纵坐标', 'number');
    button(teleportRow, '传送', function () { confirmRisk('传送到指定地图和坐标？', function () { api.teleport(mapID.value, x.value, y.value); }); });
    var eventText = el('div', '', maps); eventText.className = 'note';
    button(row(maps), '查看当前地图事件', function () {
        eventText.textContent = api.events().map(function (e) { return '#' + e.id + ' ' + e.name + ' (' + e.x + ',' + e.y + ') ' + (e.active ? '生效' : '未生效'); }).join('\n');
        eventText.style.whiteSpace = 'pre-wrap';
    });
    var er = row(maps), eventKind = select(er, [['map', '当前地图事件'], ['common', '公共事件']]), eventID = input(er, '1', '事件编号', 'number');
    button(er, '执行事件', function () { confirmRisk('强制执行指定事件？', function () { api.event(eventKind.value, eventID.value); }); });
    button(row(maps), '查看公共事件编号', function () {
        eventText.textContent = api.list('common').map(function (e) { return '#' + e.id + ' ' + e.name; }).join(' / ');
    });

    // ---------------- 对象浏览 ----------------
    var tree = tab('tree', '对象浏览', null);
    el('div', '只接受 $ 开头的属性路径，例如 $gameParty._gold、$gameMap._events[3]。读取有深度和数量上限；写入只允许标量，不能覆盖对象，也不能碰原型链。', tree).className = 'note';
    var treeBar = row(tree), treePath = input(treeBar, '$gameParty', '对象路径'), treeDepth = input(treeBar, '2', '展开深度', 'number');
    var treeOut = el('div', '', tree); treeOut.className = 'tree';
    button(treeBar, '查看', function () {
        var node = api.probe(treePath.value, treeDepth.value), lines = [];
        (function walk(current, prefix) {
            lines.push(prefix + (current.type === 'array' ? '[' + current.size + ']' : current.type === 'object' ? '{' + current.size + '}' : String(current.value)));
            if (lines.length > 600) { lines.push('…输出已截断'); return; }
            (current.children || []).forEach(function (child) { walk(child.value, prefix + '  ' + child.key + ': '); });
        }(node, ''));
        treeOut.textContent = lines.join('\n');
        say('已读取 ' + treePath.value + '。');
    });
    var assignBar = row(tree), assignPath = input(assignBar, '$gameParty._gold', '写入路径'), assignValue = input(assignBar, '0', '新值');
    button(assignBar, '写入', function () {
        confirmRisk('直接写入 ' + assignPath.value + '？', function () {
            api.assign(assignPath.value, parse(assignValue.value)); say('已写入 ' + assignPath.value + '。');
        });
    });

    // ---------------- 锁定与状态 ----------------
    var lockSection = tab('locks', '锁定与状态'), lockTable = el('table', undefined, lockSection); lockTable.className = 'data';
    button(row(lockSection), '刷新锁定列表', function () {
        lockTable.textContent = '';
        api.locks().forEach(function (entry) {
            var tr = el('tr', undefined, lockTable);
            el('td', entry.key, tr); el('td', JSON.stringify(entry.value), tr);
            button(el('td', undefined, tr), '解除', function () { api.unlock(entry.key); tr.remove(); });
        });
    });
    button(row(lockSection), '检查模块状态', function () {
        say('翻译：' + (assist.translationReady ? '已加载' : assist.options.translation ? '未就绪' : '未启用')
            + '\n作弊：' + (assist.cheatsReady ? '已加载' : '未就绪')
            + (assist.errors.length ? '\n' + assist.errors.slice(-10).join('\n') : ''));
    });

    document.body.appendChild(host);
    // 有些游戏给画布设置最大层级；支持时使用非模态顶层，否则保持在画布之后。
    if (typeof host.showPopover === 'function') {
        host.setAttribute('popover', 'manual'); host.showPopover();
        document.addEventListener('fullscreenchange', function () { try { host.showPopover(); } catch (_) {} });
    } else if (typeof MutationObserver === 'function') {
        var observer = new MutationObserver(function () { if (host.nextSibling) document.body.appendChild(host); });
        observer.observe(document.body, { childList: true });
    }
    selectTab('common');
}());
