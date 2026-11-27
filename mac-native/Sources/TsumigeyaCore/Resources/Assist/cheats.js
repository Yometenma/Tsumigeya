(function () {
    'use strict';
    var assist = window.TsumigeyaAssist;
    var locks = Object.create(null), scan = null, noClip = false, noEncounter = false, speed = 1, movement = null, resetRevision = 0;
    var api = assist.cheats = {};
    api.ready = function () { return !!(window.$gameParty && window.$gameVariables && window.$gameSwitches && window.$gamePlayer && window.$gameMap && $gameMap.mapId() > 0 && !(window.Scene_Title && SceneManager._scene instanceof Scene_Title)); };
    function ready() { if (!api.ready()) throw new Error('请先进入游戏或读取存档。'); }
    function integer(value, min, max) {
        var n = Number(value);
        if (!isFinite(n) || Math.floor(n) !== n || n < min || n > max) throw new Error('请输入 ' + min + ' 至 ' + max + ' 的整数。');
        return n;
    }
    function scalar(value) {
        if (typeof value === 'number' && isFinite(value) && Math.abs(value) <= 9007199254740991) return value;
        if (typeof value === 'boolean' || (typeof value === 'string' && value.length <= 4096)) return value;
        throw new Error('只能修改有限数字、布尔值或短文本，不能覆盖复杂对象。');
    }
    function actor(id) { var a = $gameActors.actor(integer(id, 1, ($dataActors || []).length - 1)); if (!a) throw new Error('角色不存在。'); return a; }
    function item(kind, id) {
        var list = kind === 'items' ? $dataItems : kind === 'weapons' ? $dataWeapons : kind === 'armors' ? $dataArmors : null;
        if (!list) throw new Error('物品类型无效。');
        var i = list[integer(id, 1, list.length - 1)]; if (!i) throw new Error('物品不存在。'); return i;
    }
    function tableOf(kind) {
        var list = kind === 'items' ? window.$dataItems : kind === 'weapons' ? window.$dataWeapons : kind === 'armors' ? window.$dataArmors : null;
        if (!list) throw new Error('物品类型无效。');
        return list;
    }
    function itemKey(kind, id) { return 'item:' + kind + ':' + id; }
    // 分栏来自数据库自己的类型表，标题跟随游戏术语，不硬编码。
    api.itemTabs = function () {
        ready();
        var sys = window.$dataSystem || {}, tabs = [{ kind: 'items', sub: 1, title: '物品' }];
        var seen = Object.create(null);
        (window.$dataArmors || []).forEach(function (a) { if (a && a.etypeId > 0) seen['armors:' + a.etypeId] = a.etypeId; });
        (window.$dataWeapons || []).forEach(function (w) { if (w && w.wtypeId > 0) seen['weapons:' + w.wtypeId] = w.wtypeId; });
        Object.keys(seen).sort().forEach(function (id) {
            var kind = id.split(':')[0], n = seen[id];
            var title = kind === 'armors' ? ((sys.armorTypes && sys.armorTypes[n]) || '防具 ' + n)
                                          : ((sys.weaponTypes && sys.weaponTypes[n]) || '武器 ' + n);
            tabs.push({ kind: kind, sub: n, title: title });
        });
        tabs.push({ kind: 'items', sub: 2, title: '关键物品' });
        return tabs;
    };
    api.catalog = function (kind, sub) {
        ready();
        var list = tableOf(kind), mode = sub === undefined || sub === null ? null : Number(sub);
        return list.filter(function (entry) {
            if (!entry) return false;
            if (mode === null) return true;
            if (kind === 'items') return entry.itypeId === mode;
            if (kind === 'armors') return entry.etypeId === mode;
            return entry.wtypeId === mode;
        }).map(function (entry) {
            var key = itemKey(kind, entry.id);
            return {
                id: entry.id, key: key,
                name: entry.name || '未命名',
                desc: entry.description || '',
                value: $gameParty.numItems(entry),
                max: $gameParty.maxItems(entry),
                locked: locks[key] !== undefined
            };
        });
    };
    api.list = function (kind) {
        ready();
        if (kind === 'variables' || kind === 'switches') {
            var names = kind === 'variables' ? $dataSystem.variables : $dataSystem.switches;
            return names.map(function (name, id) { return { id: id, name: name || '未命名', value: kind === 'variables' ? $gameVariables.value(id) : $gameSwitches.value(id), key: kind + ':' + id }; }).slice(1);
        }
        var list = { items: window.$dataItems, weapons: window.$dataWeapons, armors: window.$dataArmors, actors: window.$dataActors, maps: window.$dataMapInfos, common: window.$dataCommonEvents }[kind];
        if (!list) throw new Error('未知数据类型。');
        return list.filter(Boolean).map(function (entry) {
            var value = ['items', 'weapons', 'armors'].indexOf(kind) >= 0 ? $gameParty.numItems(entry) : '';
            return { id: entry.id, name: entry.name || '未命名', value: value };
        });
    };
    api.get = function (key) {
        ready(); var p = key.split(':'), id = Number(p[1]);
        if (key === 'gold') return $gameParty.gold();
        if (p[0] === 'item') return $gameParty.numItems(item(p[1], Number(p[2])));
        if (p[0] === 'variables') return $gameVariables.value(integer(id, 1, $dataSystem.variables.length - 1));
        if (p[0] === 'switches') return $gameSwitches.value(integer(id, 1, $dataSystem.switches.length - 1));
        if (p[0] === 'actor') {
            var a = actor(id);
            if (['hp', 'mp', 'tp', 'level'].indexOf(p[2]) >= 0) return a[p[2]];
            if (/^param[0-7]$/.test(p[2])) return a.param(Number(p[2].slice(5)));
        }
        throw new Error('不支持的修改目标。');
    };
    api.set = function (key, value) {
        ready(); var p = key.split(':'), id = Number(p[1]);
        if (key === 'gold') { var gold = integer(value, 0, $gameParty.maxGold()); $gameParty.gainGold(gold - $gameParty.gold()); return; }
        if (p[0] === 'item') {
            var held = item(p[1], Number(p[2])), cap = $gameParty.maxItems(held);
            var want = integer(value, 0, cap);
            $gameParty.gainItem(held, want - $gameParty.numItems(held));
            return;
        }
        if (p[0] === 'variables') { scalar(value); if (typeof value === 'number' && Math.floor(value) !== value) throw new Error('此引擎的数值变量只保存整数。'); $gameVariables.setValue(integer(id, 1, $dataSystem.variables.length - 1), value); return; }
        if (p[0] === 'switches') { if (typeof value !== 'boolean') throw new Error('开关只能设为 true 或 false。'); $gameSwitches.setValue(integer(id, 1, $dataSystem.switches.length - 1), value); return; }
        if (p[0] === 'actor') {
            var a = actor(id), field = p[2];
            if (field === 'hp') a.setHp(integer(value, 0, a.mhp));
            else if (field === 'mp') a.setMp(integer(value, 0, a.mmp));
            else if (field === 'tp') a.setTp(integer(value, 0, a.maxTp()));
            else if (field === 'level') a.changeLevel(integer(value, 1, a.maxLevel()), false);
            else if (/^param[0-7]$/.test(field)) {
                var n = Number(field.slice(5));
                var minimum = typeof a.paramMin === 'function' ? a.paramMin(n) : 0;
                var maximum = typeof a.paramMax === 'function' ? a.paramMax(n) : 999999;
                var target = integer(value, minimum, maximum), delta = target - a.param(n);
                if (typeof a.paramBase === 'function' && typeof a.paramPlus === 'function' && typeof a.paramRate === 'function' && typeof a.paramBuffRate === 'function') {
                    var rate = a.paramRate(n) * a.paramBuffRate(n);
                    if (!isFinite(rate) || rate <= 0) throw new Error('当前属性倍率不支持直接设置。');
                    delta = target / rate - (a.paramBase(n) + a.paramPlus(n));
                }
                if (!isFinite(delta)) throw new Error('当前属性倍率导致增量超出安全范围。');
                a.addParam(n, delta);
                if (a.param(n) !== target) { a.addParam(n, -delta); throw new Error('游戏插件限制了属性修改，已撤回此次属性增量。'); }
            }
            else throw new Error('不支持的角色属性。');
            return;
        }
        throw new Error('不支持的修改目标。');
    };
    api.lock = function (key, value) { api.set(key, value); locks[key] = { value: value }; };
    api.unlock = function (key) { delete locks[key]; };
    api.locks = function () { return Object.keys(locks).map(function (key) { return { key: key, value: locks[key].value }; }); };
    api.inventory = function (kind, id, count) { ready(); var i = item(kind, id); $gameParty.gainItem(i, integer(count, 0, $gameParty.maxItems(i)) - $gameParty.numItems(i)); };
    api.nudge = function (kind, id, delta) {
        ready();
        var i = item(kind, id), cap = $gameParty.maxItems(i);
        var next = Math.max(0, Math.min(cap, $gameParty.numItems(i) + integer(delta, -999999, 999999)));
        $gameParty.gainItem(i, next - $gameParty.numItems(i));
        return next;
    };
    api.setAll = function (kind, sub, value) {
        ready();
        var target = integer(value, 0, 999999), changed = 0;
        api.catalog(kind, sub).forEach(function (row) {
            var i = item(kind, row.id), want = Math.min(target, $gameParty.maxItems(i));
            $gameParty.gainItem(i, want - $gameParty.numItems(i));
            changed++;
        });
        return changed;
    };
    // 装备直接写槽位：走 changeEquip 会从背包里扣掉一件装备。
    api.equips = function (actorID) {
        ready();
        var a = actor(actorID), slots = typeof a.equipSlots === 'function' ? a.equipSlots() : [];
        var types = (window.$dataSystem && $dataSystem.equipTypes) || [];
        return slots.map(function (etypeId, index) {
            var held = a._equips && a._equips[index], id = held && held._itemId ? held._itemId : 0;
            var kind = etypeId === 1 ? 'weapons' : 'armors';
            var table = kind === 'weapons' ? window.$dataWeapons : window.$dataArmors;
            return {
                index: index, etypeId: etypeId, kind: kind, id: id,
                slot: etypeId === 1 ? '武器' : (types[etypeId] || '装备槽 ' + etypeId),
                name: id && table && table[id] ? table[id].name : '（空）'
            };
        });
    };
    api.equip = function (actorID, index, kind, itemID) {
        ready();
        var a = actor(actorID), slot = integer(index, 0, 9), n = Number(itemID) || 0;
        if (!a._equips || !a._equips[slot] || typeof a._equips[slot].setObject !== 'function') throw new Error('当前引擎不支持直接更换装备。');
        var entry = n ? item(kind, n) : null;
        if (entry && typeof a.canEquip === 'function' && !a.canEquip(entry)) throw new Error('该角色不能装备这件装备。');
        a._equips[slot].setObject(entry);
        if (typeof a.refresh === 'function') a.refresh();
        return api.equips(actorID);
    };
    api.recover = function () { ready(); $gameParty.members().forEach(function (a) { a.recoverAll(); }); };
    api.battle = function (mode) {
        ready(); if (!$gameParty.inBattle()) throw new Error('当前不在战斗中。');
        if (mode !== 'win' && mode !== 'escape') throw new Error('战斗操作无效。');
        var scene = SceneManager._scene;
        if (!(scene instanceof Scene_Battle)) throw new Error('请等战斗场景准备完成。');
        if (BattleManager._phase === 'battleEnd' || BattleManager._phase === 'aborting') throw new Error('战斗正在结束，请勿重复操作。');
        if ((window.$gameTroop && $gameTroop.isEventRunning()) || (window.$gameMessage && $gameMessage.isBusy()) ||
            (typeof BattleManager.isBusy === 'function' && BattleManager.isBusy())) throw new Error('请等战斗事件、对话或动画结束后再操作。');
        if (mode === 'win') BattleManager.processVictory();
        else BattleManager.abort();
        // 部分插件将结算改为公共事件却保留输入阶段；让事件继续，不重新开放战斗指令。
        if (BattleManager._phase === 'input' && window.$gameTroop && $gameTroop.isEventRunning()) BattleManager._phase = 'turn';
        if (typeof scene.endCommandSelection === 'function') scene.endCommandSelection();
        ['_partyCommandWindow', '_actorCommandWindow', '_skillWindow', '_itemWindow', '_actorWindow', '_enemyWindow'].forEach(function (name) {
            var control = scene[name]; if (!control) return;
            if (typeof control.deactivate === 'function') control.deactivate();
            if (typeof control.hide === 'function') control.hide();
        });
    };
    api.toggle = function (kind, enabled) {
        ready(); if (kind === 'clip') noClip = !!enabled;
        else if (kind === 'encounter') noEncounter = !!enabled;
        else throw new Error('未知开关。');
    };
    api.speed = function (value) { speed = integer(value, 1, 5); };
    api.moveSpeed = function (value) {
        ready(); var next = integer(value, 1, 6);
        if (!movement || movement.player !== $gamePlayer) movement = { player: $gamePlayer, original: $gamePlayer.moveSpeed() };
        $gamePlayer.setMoveSpeed(next);
    };
    api.state = function () { return { resetRevision: resetRevision, clip: noClip, encounter: noEncounter, speed: speed, moveSpeed: api.ready() ? $gamePlayer.moveSpeed() : null }; };
    api.teleport = function (map, x, y) {
        ready(); if ($gameParty.inBattle() || $gamePlayer.isTransferring()) throw new Error('战斗或传送期间不能再次传送。');
        map = integer(map, 1, $dataMapInfos.length - 1); if (!$dataMapInfos[map]) throw new Error('地图不存在。');
        var name = String(map); while (name.length < 3) name = '0' + name;
        var xhr = new XMLHttpRequest(); xhr.open('GET', 'data/Map' + name + '.json', false); xhr.send();
        if (xhr.status && xhr.status !== 200) throw new Error('无法读取目标地图。');
        var data = JSON.parse(xhr.responseText);
        $gamePlayer.reserveTransfer(map, integer(x, 0, data.width - 1), integer(y, 0, data.height - 1), 2, 0);
    };
    api.events = function () {
        ready(); return $gameMap.events().map(function (event) { var data = event.event(); return { id: event.eventId(), name: data.name, x: event.x, y: event.y, active: event._pageIndex >= 0, trigger: event._trigger }; });
    };
    api.event = function (kind, id) {
        ready(); if ($gameParty.inBattle() || $gameMap.isEventRunning()) throw new Error('请等当前事件或战斗结束。');
        if (kind === 'common') { id = integer(id, 1, $dataCommonEvents.length - 1); if (!$dataCommonEvents[id]) throw new Error('公共事件不存在。'); $gameTemp.reserveCommonEvent(id); }
        else if (kind === 'map') { var event = $gameMap.event(integer(id, 1, 999999)); if (!event || event._pageIndex < 0) throw new Error('事件不存在或没有生效页面。'); event.start(); }
        else throw new Error('事件类型无效。');
    };
    function snapshot() {
        var values = Object.create(null);
        api.list('variables').forEach(function (e) { if (typeof e.value === 'number' && isFinite(e.value)) values[e.key] = { value: e.value, name: e.name }; });
        values.gold = { value: $gameParty.gold(), name: '金钱' };
        $gameParty.members().forEach(function (a) { ['hp', 'mp', 'tp', 'level'].forEach(function (p) { values['actor:' + a.actorId() + ':' + p] = { value: a[p], name: a.name() + ' ' + p }; }); });
        return values;
    }
    api.scan = function (mode, target) {
        ready(); var values = snapshot();
        if (mode === 'unknown' || mode === 'exact') {
            scan = Object.keys(values).filter(function (key) { return mode === 'unknown' || values[key].value === Number(target); }).map(function (key) { return { key: key, name: values[key].name, value: values[key].value }; });
        } else {
            if (!scan) throw new Error('请先建立搜索范围。');
            scan = scan.filter(function (row) {
                var next = values[row.key]; if (!next) return false;
                var a = next.value, b = row.value;
                return mode === 'increased' ? a > b : mode === 'decreased' ? a < b : mode === 'changed' ? a !== b : mode === 'unchanged' ? a === b : mode === 'equal' ? a === Number(target) : false;
            }).map(function (row) { return { key: row.key, name: row.name, value: values[row.key].value }; });
        }
        return scan.slice();
    };
    api.reset = function () {
        if (movement && window.$gamePlayer === movement.player) movement.player.setMoveSpeed(movement.original);
        resetRevision++; movement = null; locks = Object.create(null); scan = null; noClip = false; noEncounter = false; speed = 1;
    };
    // 反射层：只接受 $ 开头的属性路径，拒绝原型链，写入只允许标量。
    var PATH_RE = /^\$[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[\d{1,6}\])*$/;
    var BLOCKED = ['__proto__', 'constructor', 'prototype'];
    function pathValue(path) {
        var text = String(path === null || path === undefined ? '' : path).trim();
        if (!PATH_RE.test(text)) throw new Error('只接受 $ 开头的属性路径，例如 $gameParty._gold。');
        if (/(^|[.[\]])(__proto__|constructor|prototype)([.[\]]|$)/.test(text)) throw new Error('不允许访问原型链。');
        return Function('return (' + text + ')')();
    }
    api.probe = function (path, depth) {
        ready();
        var root = pathValue(path);
        var limit = Math.min(Math.max(Number(depth) || 3, 1), 6), budget = 4000;
        var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
        function walk(value, level) {
            if (--budget < 0) return { type: 'truncated' };
            var t = typeof value;
            if (value === null) return { type: 'null' };
            if (t === 'number' || t === 'boolean') return { type: t, value: value };
            if (t === 'string') return { type: 'string', value: value.length > 500 ? value.slice(0, 500) + '…' : value };
            if (t === 'function') return { type: 'function', value: value.name || '(未命名)' };
            if (t === 'undefined') return { type: 'undefined' };
            if (seen && seen.has(value)) return { type: 'circular' };
            if (seen) seen.add(value);
            var isArray = Object.prototype.toString.call(value) === '[object Array]';
            var keys = isArray ? null : Object.keys(value);
            var total = isArray ? value.length : keys.length;
            var node = { type: isArray ? 'array' : 'object', size: total };
            if (level >= limit || total === 0) return node;
            node.children = [];
            for (var i = 0; i < Math.min(total, 200); i++) {
                var k = isArray ? i : keys[i], child;
                try { child = walk(value[k], level + 1); } catch (e) { child = { type: 'error', value: e.message }; }
                node.children.push({ key: String(k), value: child });
            }
            if (total > 200) node.truncated = total - 200;
            return node;
        }
        return walk(root, 0);
    };
    api.assign = function (path, value) {
        ready();
        var text = String(path === null || path === undefined ? '' : path).trim();
        var bracket = /\[(\d{1,6})\]$/.exec(text), parentPath, key;
        if (bracket) { parentPath = text.slice(0, bracket.index); key = Number(bracket[1]); }
        else {
            var cut = text.lastIndexOf('.');
            if (cut < 0) throw new Error('不能替换全局对象。');
            parentPath = text.slice(0, cut); key = text.slice(cut + 1);
        }
        if (BLOCKED.indexOf(String(key)) >= 0) throw new Error('不允许修改原型链。');
        var parent = pathValue(parentPath);
        if (!parent || typeof parent !== 'object') throw new Error('父对象不存在。');
        var current = parent[key];
        if (current !== null && typeof current === 'object') throw new Error('目标不是标量，请进入下一层再改。');
        parent[key] = scalar(value);
        return parent[key];
    };
    function install() {
        if (!window.Game_Player || !window.Scene_Map || !window.SceneManager || !window.DataManager) return false;
        var through = Game_Player.prototype.isThrough;
        Game_Player.prototype.isThrough = function () { return noClip || through.apply(this, arguments); };
        var encounter = Game_Player.prototype.canEncounter;
        Game_Player.prototype.canEncounter = function () { return !noEncounter && encounter.apply(this, arguments); };
        var update = SceneManager.updateMain;
        SceneManager.updateMain = function () {
            // 不重复调渲染和输入；额外更新限于地图/战斗逻辑，避免加速加载循环。
            var result = update.apply(this, arguments);
            if (api.ready() && !this.isSceneChanging() && (this._scene instanceof Scene_Map || (window.Scene_Battle && this._scene instanceof Scene_Battle))) {
                for (var i = 1; i < speed; i++) { if (this.isSceneChanging()) break; this.updateScene(); }
            }
            return result;
        };
        ['setupNewGame', 'extractSaveContents'].forEach(function (name) {
            var original = DataManager[name]; if (typeof original !== 'function') return;
            DataManager[name] = function () { api.reset(); return original.apply(this, arguments); };
        });
        setInterval(function () {
            if (!api.ready()) return;
            Object.keys(locks).forEach(function (key) {
                try { if (api.get(key) !== locks[key].value) api.set(key, locks[key].value); }
                catch (e) { delete locks[key]; assist.errors.push('锁定已解除：' + key + '，' + e.message); }
            });
        }, 150);
        assist.cheatsReady = true; return true;
    }
    if (!install()) { var attempts = 0, timer = setInterval(function () { if (install() || ++attempts > 300) clearInterval(timer); }, 100); }
}());
