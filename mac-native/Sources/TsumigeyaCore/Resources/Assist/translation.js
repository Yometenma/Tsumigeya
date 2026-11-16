(function () {
    'use strict';
    var assist = window.TsumigeyaAssist;
    try {
        var dictionary = assist.read('translations.json');
        if (!dictionary || Array.isArray(dictionary) || typeof dictionary !== 'object') throw new Error('译文不是字典');
        var has = Object.prototype.hasOwnProperty;
        var targets = Object.create(null), missing = Object.create(null), dirty = false, fileSystem = null, directory = null;
        function indexTargets() { targets = Object.create(null); Object.keys(dictionary).forEach(function (key) { if (typeof dictionary[key] === 'string') targets[dictionary[key]] = true; }); }
        indexTargets();
        try {
            if (typeof require === 'function') {
                fileSystem = require('fs');
                if (assist.base.indexOf('file:') === 0) directory = require('url').fileURLToPath(assist.base);
                else if (typeof nw !== 'undefined' && nw.App && nw.App.startPath) {
                    directory = require('path').join(nw.App.startPath, decodeURIComponent(new URL(assist.base).pathname));
                    if (directory.slice(-1) !== require('path').sep) directory += require('path').sep;
                }
                if (!directory || fileSystem.lstatSync(require('path').resolve(directory)).isSymbolicLink()) throw new Error('辅助目录无效');
                var prior = directory + 'missing.json';
                if (fileSystem.existsSync(prior) && !fileSystem.lstatSync(prior).isSymbolicLink()) {
                    var previous = JSON.parse(fileSystem.readFileSync(prior, 'utf8'));
                    if (Array.isArray(previous)) previous.slice(0, 5000).forEach(function (text) { if (typeof text === 'string' && text.length <= 4096) missing[text] = true; });
                }
            }
        } catch (ignored) { fileSystem = null; }
        function capture(text) {
            if (!missing[text] && !targets[text] && text.length > 0 && text.length <= 4096 && /[\u3040-\u30ff\u3400-\u9fffA-Za-z]/.test(text) && Object.keys(missing).length < 5000) { missing[text] = true; dirty = true; }
        }
        setInterval(function () {
            if (!fileSystem || !directory) return;
            try {
                if (fileSystem.lstatSync(require('path').resolve(directory)).isSymbolicLink()) return;
                var dictionaryFile = directory + 'translations.json';
                if (fileSystem.lstatSync(dictionaryFile).isSymbolicLink()) return;
                var next = JSON.parse(fileSystem.readFileSync(dictionaryFile, 'utf8'));
                if (next && !Array.isArray(next) && typeof next === 'object') { dictionary = next; indexTargets(); }
                if (dirty) {
                    var destination = directory + 'missing.json', temp = directory + 'missing.tmp';
                    if ((fileSystem.existsSync(destination) && fileSystem.lstatSync(destination).isSymbolicLink()) || (fileSystem.existsSync(temp) && fileSystem.lstatSync(temp).isSymbolicLink())) return;
                    fileSystem.writeFileSync(temp, JSON.stringify(Object.keys(missing)), { encoding: 'utf8', flag: 'w' });
                    fileSystem.renameSync(temp, destination); dirty = false;
                }
            } catch (e) { /* 写入或热更新失败不影响游戏；下一次轮询重试。 */ }
        }, 1500);
        function translate(text) {
            if (typeof text !== 'string') return text;
            if (has.call(dictionary, text) && typeof dictionary[text] === 'string') return dictionary[text];
            if (text.indexOf('\n') >= 0) return text.split('\n').map(translate).join('\n');
            capture(text); return text;
        }
        assist.translate = translate;
        var fields = ['name', 'nickname', 'profile', 'description', 'message1', 'message2', 'message3', 'message4'];
        function database(object) {
            var knownDatabase = ['$dataActors', '$dataClasses', '$dataSkills', '$dataItems', '$dataWeapons', '$dataArmors', '$dataEnemies', '$dataStates', '$dataMapInfos'].some(function (name) { return window[name] === object; });
            if (knownDatabase && Array.isArray(object)) object.forEach(function (row) {
                if (!row || typeof row !== 'object') return;
                fields.forEach(function (key) { if (typeof row[key] === 'string') row[key] = translate(row[key]); });
            });
            if (object === window.$dataSystem) {
                ['gameTitle', 'currencyUnit'].forEach(function (key) { object[key] = translate(object[key]); });
                ['elements', 'skillTypes', 'weaponTypes', 'armorTypes', 'equipTypes', 'variables', 'switches'].forEach(function (key) {
                    if (Array.isArray(object[key])) object[key] = object[key].map(translate);
                });
                function terms(value) {
                    if (typeof value === 'string') return translate(value);
                    if (Array.isArray(value)) return value.map(terms);
                    if (value && typeof value === 'object') Object.keys(value).forEach(function (k) { value[k] = terms(value[k]); });
                    return value;
                }
                if (object.terms) terms(object.terms);
            }
            if (object === window.$dataMap) {
                object.displayName = translate(object.displayName);
                (object.events || []).forEach(function (event) { if (event) (event.pages || []).forEach(function (p) { commands(p.list); }); });
            }
            if (object === window.$dataCommonEvents) (object || []).forEach(function (e) { if (e) commands(e.list); });
        }
        function commands(list) {
            (list || []).forEach(function (cmd) {
                var p = cmd.parameters;
                if (!p) return;
                if (cmd.code === 401 || cmd.code === 405) p[0] = translate(p[0]);
                if (cmd.code === 102 && Array.isArray(p[0])) p[0] = p[0].map(translate);
                if (cmd.code === 101 && p.length > 4) p[4] = translate(p[4]);
                if ([320, 324, 325].indexOf(cmd.code) >= 0) p[1] = translate(p[1]);
            });
        }
        function hook(object, key, wrap) {
            if (!object || typeof object[key] !== 'function') return;
            var original = object[key]; object[key] = wrap(original);
        }
        function install() {
            if (!window.DataManager || !window.Bitmap || !window.Window_Base) return false;
            hook(Bitmap.prototype, 'initialize', function (original) { return function () {
                var result = original.apply(this, arguments);
                if (typeof this.fontFace === 'string') this.fontFace += ',"PingFang SC","Hiragino Sans",sans-serif';
                return result;
            }; });
            hook(DataManager, 'onLoad' , function (original) { return function (object) { original.apply(this, arguments); database(object); }; });
            ['drawText', 'measureTextWidth'].forEach(function (name) {
                hook(Bitmap.prototype, name, function (original) { return function () {
                    var args = Array.prototype.slice.call(arguments); args[0] = translate(args[0]); return original.apply(this, args);
                }; });
            });
            hook(Window_Base.prototype, 'convertEscapeCharacters', function (original) { return function (text) {
                return original.call(this, translate(text));
            }; });
            if (window.Window_Command) hook(Window_Command.prototype, 'addCommand', function (original) { return function () {
                var args = Array.prototype.slice.call(arguments); args[0] = translate(args[0]); return original.apply(this, args);
            }; });
            if (window.Game_Message) {
                hook(Game_Message.prototype, 'add', function (original) { return function (text) { return original.call(this, translate(text)); }; });
                hook(Game_Message.prototype, 'setChoices', function (original) { return function () {
                    var args = Array.prototype.slice.call(arguments); args[0] = args[0].map(translate); return original.apply(this, args);
                }; });
            }
            ['$dataActors', '$dataClasses', '$dataSkills', '$dataItems', '$dataWeapons', '$dataArmors', '$dataEnemies', '$dataStates', '$dataSystem', '$dataMapInfos', '$dataMap', '$dataCommonEvents'].forEach(function (name) {
                if (window[name]) database(window[name]);
            });
            assist.translationReady = true; return true;
        }
        if (!install()) {
            var attempts = 0, timer = setInterval(function () {
                try { if (install() || ++attempts > 300) clearInterval(timer); }
                catch (e) { clearInterval(timer); assist.errors.push('翻译初始化失败：' + e.message); }
            }, 100);
        }
    } catch (e) { assist.errors.push('翻译失败：' + e.message); }
}());
