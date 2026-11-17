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
