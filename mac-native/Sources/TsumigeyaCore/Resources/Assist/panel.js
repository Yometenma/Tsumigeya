(function () {
    'use strict';
    var assist = window.TsumigeyaAssist, api = assist.cheats;
    if (!api) return;
    var host = document.createElement('div'); host.id = 'tsumigeya-assist-panel';
    host.style.cssText = 'position:fixed;z-index:2147483647;top:8px;right:8px;left:auto;bottom:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;font:14px system-ui;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = document.createElement('style');
    style.textContent = ':host{color:#edf0f5}*{box-sizing:border-box}button,input,select{font:inherit;border-radius:5px;border:1px solid #667085;padding:6px;color:#edf0f5;background:#263143}button{cursor:pointer}button:hover{background:#3d5273}input{min-width:0}label{display:inline-flex;align-items:center;gap:5px}#panel{background:#17202ff5;border:1px solid #667085;border-radius:10px;width:min(650px,92vw);max-height:85vh;overflow:auto;padding:14px;box-shadow:0 8px 40px #0008}h3{margin:0 0 10px}.row{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:9px 0}.note{font-size:12px;color:#bec9d9;line-height:1.6}.status{white-space:pre-wrap;max-height:100px;overflow:auto;color:#ffe3a3}.data{width:100%;border-collapse:collapse}.data td,.data th{text-align:left;padding:5px;border-bottom:1px solid #49576b;word-break:break-all}.data input{width:110px}.data button{padding:4px}#toggle{float:right}nav{display:flex;gap:5px;flex-wrap:wrap;margin:12px 0}section[hidden]{display:none!important}';
    root.appendChild(style);
    function el(tag, text, parent) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (parent) parent.appendChild(e); return e; }
    var toggle = el('button', '游戏辅助', root); toggle.id = 'toggle'; toggle.type = 'button';
    var panel = el('div', undefined, root); panel.id = 'panel'; panel.hidden = true;
    var header = el('div', undefined, panel); header.className = 'row';
    el('h3', '游戏辅助', header); var close = el('button', '收起', header);
    var warning = el('div', '修改可能写入存档；关闭辅助功能不会撤销已保存的修改。建议先备份。读档与新游戏会解除本次锁定和搜索。', panel); warning.className = 'note';
    var status = el('div', '', panel); status.className = 'status'; status.setAttribute('role', 'status');
    var nav = el('nav', undefined, panel), sections = {};
    function run(fn) { try { status.textContent = '操作完成。'; return fn(); } catch (e) { status.textContent = e.message; } }
    function row(parent) { var e = el('div', undefined, parent); e.className = 'row'; return e; }
    function button(parent, title, fn) { var b = el('button', title, parent); b.type = 'button'; b.onclick = function () { run(fn); }; return b; }
    function input(parent, value, hint, type) { var e = el('input', undefined, parent); e.type = type || 'text'; e.value = value; e.placeholder = hint || ''; e.setAttribute('aria-label', hint || '数值'); return e; }
    function select(parent, choices) { var s = el('select', undefined, parent); choices.forEach(function (c) { var o = el('option', c[1], s); o.value = c[0]; }); return s; }
    function checkbox(parent, title, fn) { var label = el('label', undefined, parent), c = input(label, '', title, 'checkbox'); el('span', title, label); c.onchange = function () { run(function () { fn(c.checked); }); }; return c; }
    function parse(text) { try { return JSON.parse(text); } catch (_) { return text; } }
    function confirmRisk(text, fn) { if (window.confirm(text + '\n此操作可能改变剧情或损坏进度，建议先单独存档。是否继续？')) fn(); else status.textContent = '已取消。'; }
    function tab(id, title) {
        var s = el('section', undefined, panel); sections[id] = s; s.hidden = Object.keys(sections).length > 1;
        button(nav, title, function () { Object.keys(sections).forEach(function (key) { sections[key].hidden = key !== id; }); }); return s;
    }
    function open() { panel.hidden = !panel.hidden; toggle.hidden = !panel.hidden; if (!panel.hidden && window.Input && typeof Input.clear === 'function') Input.clear(); if (!panel.hidden) syncControls(); if (!panel.hidden) status.textContent = api.ready() ? '已连接当前游戏。' : '请先进入游戏或读取存档。'; }
    toggle.onclick = open; close.onclick = open;
    // 辅助面板输入不能落到游戏里触发移动或快捷键。
    ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'wheel', 'touchstart', 'touchend'].forEach(function (name) {
        host.addEventListener(name, function (event) { event.stopPropagation(); });
    });
    host.addEventListener('focusin', function () { if (window.Input && typeof Input.clear === 'function') Input.clear(); });
    document.addEventListener('keydown', function (event) { if (event.key === 'F8' && event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); open(); } }, true);
    var common = tab('common', '常用');
    var goldRow = row(common), gold = input(goldRow, '0', '目标金钱', 'number');
    button(goldRow, '读取金钱', function () { gold.value = api.get('gold'); });
    button(goldRow, '设置金钱', function () { api.set('gold', Number(gold.value)); });
    button(goldRow, '锁定金钱', function () { api.lock('gold', Number(gold.value)); });
    button(goldRow, '解除金钱锁定', function () { api.unlock('gold'); });
    var r = row(common);
    button(r, '全队恢复', api.recover);
    button(r, '战斗胜利', function () { confirmRisk('立即结束战斗并胜利？', function () { api.battle('win'); }); });
    button(r, '退出战斗', function () { confirmRisk('立即退出当前战斗？', function () { api.battle('escape'); }); });
    var clip = checkbox(row(common), '穿墙', function (on) { api.toggle('clip', on); });
    var encounters = checkbox(row(common), '禁止随机遇敌', function (on) { api.toggle('encounter', on); });
    var speeds = row(common), speed = select(speeds, [['1', '正常游戏速度'], ['2', '游戏速度 ×2'], ['3', '游戏速度 ×3'], ['4', '游戏速度 ×4'], ['5', '游戏速度 ×5']]);
    button(speeds, '应用速度', function () { api.speed(speed.value); });
    var move = input(speeds, '4', '移动速度（1 至 6）', 'number'); button(speeds, '设置移动速度', function () { api.moveSpeed(move.value); });
    button(row(common), '解除全部锁定与临时辅助', function () { api.reset(); syncControls(); });
    var lastResetRevision = 0;
    function syncControls() {
        var current = api.state(); lastResetRevision = current.resetRevision; clip.checked = current.clip; encounters.checked = current.encounter; speed.value = String(current.speed);
        if (current.moveSpeed !== null && root.activeElement !== move && document.activeElement !== move) move.value = String(current.moveSpeed);
    }
    setInterval(function () { if (!panel.hidden && api.state().resetRevision !== lastResetRevision) syncControls(); }, 500);
    var data = tab('data', '数据编辑');
    var filters = row(data), kind = select(filters, [['variables', '变量'], ['switches', '开关'], ['items', '物品'], ['weapons', '武器'], ['armors', '防具']]);
    var query = input(filters, '', '按编号或名称搜索');
    var hint = el('div', '', data); hint.className = 'note';
    el('div', '值可填写数字、true／false 或文本。复杂对象只读。变量和开关会影响剧情。', data).className = 'note';
    var table = el('table', undefined, data); table.className = 'data';
    function renderData() {
        var rows = api.list(kind.value).filter(function (entry) { return (entry.id + ' ' + entry.name).toLowerCase().indexOf(query.value.toLowerCase()) >= 0; });
        table.textContent = ''; hint.textContent = '匹配 ' + rows.length + ' 条，显示前 150 条；可搜索缩小范围。';
        rows.slice(0, 150).forEach(function (entry) {
            var tr = el('tr', undefined, table); el('td', '#' + entry.id + ' ' + entry.name, tr);
            var td = el('td', undefined, tr), complex = entry.value !== null && typeof entry.value === 'object';
            if (complex) { el('span', '复杂对象（只读）', td); return; }
            var value = input(td, typeof entry.value === 'string' ? JSON.stringify(entry.value) : String(entry.value), '目标值');
            var actions = el('td', undefined, tr), selectedKind = kind.value;
            button(actions, '修改', function () {
                if (entry.key) confirmRisk('修改 #' + entry.id + ' ' + entry.name + '？', function () { api.set(entry.key, parse(value.value)); });
                else api.inventory(selectedKind, entry.id, Number(value.value));
            });
            if (entry.key) {
                button(actions, '锁定', function () { confirmRisk('锁定 #' + entry.id + ' ' + entry.name + '？', function () { api.lock(entry.key, parse(value.value)); }); });
                button(actions, '解锁', function () { api.unlock(entry.key); });
            }
        });
    }
    button(filters, '读取／刷新', renderData); kind.onchange = function () { run(renderData); }; query.oninput = function () { run(renderData); };
    var actors = tab('actors', '角色');
    var ar = row(actors), actorID = input(ar, '1', '角色编号', 'number');
    var field = select(ar, [['hp', '当前生命'], ['mp', '当前魔力'], ['tp', '当前特技点'], ['level', '等级'], ['param0', '最大生命'], ['param1', '最大魔力'], ['param2', '攻击'], ['param3', '防御'], ['param4', '魔法攻击'], ['param5', '魔法防御'], ['param6', '敏捷'], ['param7', '幸运']]);
    var actorValue = input(ar, '0', '目标属性值', 'number');
    function actorKey() { return 'actor:' + actorID.value + ':' + field.value; }
    button(row(actors), '读取属性', function () { actorValue.value = api.get(actorKey()); });
    button(row(actors), '修改属性', function () { api.set(actorKey(), Number(actorValue.value)); });
    button(row(actors), '锁定属性', function () { api.lock(actorKey(), Number(actorValue.value)); });
    button(row(actors), '解除锁定', function () { api.unlock(actorKey()); });
    var actorList = el('div', '', actors); actorList.className = 'note';
    button(row(actors), '显示角色编号', function () { actorList.textContent = api.list('actors').map(function (a) { return '#' + a.id + ' ' + a.name; }).join(' / '); });
    var search = tab('scan', '数值查找'), sr = row(search), target = input(sr, '0', '待查找数值', 'number');
    el('div', '搜索范围：游戏变量、金钱与队伍角色的生命／魔力／特技点／等级。不是任意进程内存扫描。每次筛选都与上一次记录比较。', search).className = 'note';
    var scanHint = el('div', '', search), scanTable = el('table', undefined, search); scanTable.className = 'data';
    function scan(mode) {
        var rows = api.scan(mode, target.value); scanTable.textContent = ''; scanHint.textContent = '剩余 ' + rows.length + ' 条，显示前 100 条。';
        rows.slice(0, 100).forEach(function (entry) {
            var tr = el('tr', undefined, scanTable); el('td', entry.name + '（' + entry.key + '）', tr);
            var td = el('td', undefined, tr), value = input(td, entry.value, '目标数值', 'number');
            button(td, '修改', function () { confirmRisk('修改搜索结果？', function () { api.set(entry.key, Number(value.value)); }); });
            button(td, '锁定', function () { confirmRisk('锁定搜索结果？', function () { api.lock(entry.key, Number(value.value)); }); });
        });
    }
    [['unknown', '未知初始值'], ['exact', '按数值重新查找'], ['equal', '等于输入值'], ['increased', '增加了'], ['decreased', '减少了'], ['changed', '改变了'], ['unchanged', '没有改变']].forEach(function (c) { button(sr, c[1], function () { scan(c[0]); }); });
    var maps = tab('maps', '地图与事件'), mr = row(maps), mapQuery = input(mr, '', '搜索地图名称／编号');
    var mapList = el('div', '', maps); mapList.className = 'note';
    button(mr, '查找地图', function () { var matches = api.list('maps').filter(function (m) { return (m.id + ' ' + m.name).indexOf(mapQuery.value) >= 0; }); mapList.textContent = '共 ' + matches.length + ' 条，显示前 200 条：\n' + matches.slice(0, 200).map(function (m) { return '#' + m.id + ' ' + m.name; }).join(' / '); });
    var teleportRow = row(maps), mapID = input(teleportRow, '1', '地图编号', 'number'), x = input(teleportRow, '0', '横坐标', 'number'), y = input(teleportRow, '0', '纵坐标', 'number');
    button(teleportRow, '传送', function () { confirmRisk('传送到指定地图和坐标？', function () { api.teleport(mapID.value, x.value, y.value); }); });
    var eventText = el('div', '', maps); eventText.className = 'note';
    button(row(maps), '查看当前地图事件', function () { eventText.textContent = api.events().map(function (e) { return '#' + e.id + ' ' + e.name + ' (' + e.x + ',' + e.y + ') ' + (e.active ? '生效' : '未生效'); }).join('\n'); eventText.style.whiteSpace = 'pre-wrap'; });
    var er = row(maps), eventKind = select(er, [['map', '当前地图事件'], ['common', '公共事件']]), eventID = input(er, '1', '事件编号', 'number');
    button(er, '执行事件', function () { confirmRisk('强制执行指定事件？', function () { api.event(eventKind.value, eventID.value); }); });
    button(row(maps), '查看公共事件编号', function () { eventText.textContent = api.list('common').map(function (e) { return '#' + e.id + ' ' + e.name; }).join(' / '); });
    var lockSection = tab('locks', '锁定与状态'), lockTable = el('table', undefined, lockSection); lockTable.className = 'data';
    button(row(lockSection), '刷新锁定列表', function () {
        lockTable.textContent = ''; api.locks().forEach(function (entry) { var tr = el('tr', undefined, lockTable); el('td', entry.key, tr); el('td', JSON.stringify(entry.value), tr); button(el('td', undefined, tr), '解除', function () { api.unlock(entry.key); tr.remove(); }); });
    });
    button(row(lockSection), '检查模块状态', function () { status.textContent = '翻译：' + (assist.translationReady ? '已加载' : assist.options.translation ? '未就绪' : '未启用') + '\n作弊：' + (assist.cheatsReady ? '已加载' : '未就绪') + '\n' + assist.errors.slice(-10).join('\n'); });
    document.body.appendChild(host);
    // 有些游戏给画布设置最大层级；支持时使用非模态顶层，否则保持在画布之后。
    if (typeof host.showPopover === 'function') {
        host.setAttribute('popover', 'manual'); host.showPopover();
        document.addEventListener('fullscreenchange', function () { try { host.showPopover(); } catch (_) {} });
    } else if (typeof MutationObserver === 'function') {
        var observer = new MutationObserver(function () { if (host.nextSibling) document.body.appendChild(host); });
        observer.observe(document.body, { childList: true });
    }
}());
