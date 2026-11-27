(function () {
    'use strict';
    var assist = window.TsumigeyaAssist;
    try {
        var dictionary = assist.read('translations.json');
        if (!dictionary || Array.isArray(dictionary) || typeof dictionary !== 'object') throw new Error('译文不是字典');
        var has = Object.prototype.hasOwnProperty;
        var targets = Object.create(null), templates = [], missing = Object.create(null), missingOrder = [], missingHead = 0;
        var dirty = false, fileSystem = null, directory = null, captureSuppressed = 0, dictionaryStat = null;
        // 未捕获文本上限与译文序号上限一致：引擎里同屏不会出现更多不同的新句子。
        var MISSING_LIMIT = 5000;
        // 中文比日文在同字号下更占行高，整句折行时容易超出固定高度的窗口。
        var fontScale = typeof assist.options.fontScale === 'number' && assist.options.fontScale > 0 && assist.options.fontScale <= 1
            ? assist.options.fontScale : 0.92;

        function reindex() {
            targets = Object.create(null);
            templates = [];
            Object.keys(dictionary).forEach(function (key) {
                var value = dictionary[key];
                if (typeof value !== 'string') return;
                targets[value] = true;
                // 引擎会用 %1 拼装句子（'%1の攻撃'.format('勇者')），整串查不到时按模板回退。
                if (key.indexOf('%') < 0 || !/%\d+/.test(key) || !/%\d+/.test(value)) return;
                var parts = key.split(/(%\d+)/), names = [], pattern = '^';
                for (var i = 0; i < parts.length; i++) {
                    if (/^%\d+$/.test(parts[i])) { names.push(parts[i]); pattern += '([\\s\\S]+?)'; }
                    else pattern += parts[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                }
                try { templates.push({ re: new RegExp(pattern + '$'), names: names, target: value, length: key.length }); }
                catch (e) { /* 单个模板不合法不影响其它译文。 */ }
            });
            // 更长的模板更具体，先匹配，避免短模板吃掉长句子。
            templates.sort(function (a, b) { return b.length - a.length; });
        }
        reindex();

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
                    if (Array.isArray(previous)) previous.slice(0, MISSING_LIMIT).forEach(function (text) {
                        if (typeof text === 'string' && text.length <= 4096 && !missing[text]) { missing[text] = true; missingOrder.push(text); }
                    });
                }
            }
        } catch (ignored) { fileSystem = null; }

        // 队列而不是每次 Object.keys：满载后每次捕获都建 5000 元素数组会让帧时间涨到毫秒级。
        function capture(text) {
            if (captureSuppressed || missing[text] || targets[text] || !text.length || text.length > 4096 ||
                !/[\u3040-\u30ff\u3400-\u9fffA-Za-z]/.test(text)) return;
            if (missingOrder.length - missingHead >= MISSING_LIMIT) {
                delete missing[missingOrder[missingHead]];
                missingHead++;
                if (missingHead > MISSING_LIMIT) { missingOrder = missingOrder.slice(missingHead); missingHead = 0; }
            }
            missing[text] = true; missingOrder.push(text); dirty = true;
        }

        setInterval(function () {
            if (!fileSystem || !directory) return;
            try {
                if (fileSystem.lstatSync(require('path').resolve(directory)).isSymbolicLink()) return;
                var dictionaryFile = directory + 'translations.json';
                if (fileSystem.lstatSync(dictionaryFile).isSymbolicLink()) return;
                // 只有文件真的变了才重新解析；词典到几 MB 时每 1.5 秒全量读盘会拖慢游戏循环。
                var stat = fileSystem.statSync(dictionaryFile);
                if (!dictionaryStat || stat.mtimeMs !== dictionaryStat.mtimeMs || stat.size !== dictionaryStat.size) {
                    dictionaryStat = { mtimeMs: stat.mtimeMs, size: stat.size };
                    var next = JSON.parse(fileSystem.readFileSync(dictionaryFile, 'utf8'));
                    if (next && !Array.isArray(next) && typeof next === 'object') addDictionary(next);
                }
                if (dirty) {
                    var destination = directory + 'missing.json', temp = directory + 'missing.tmp';
                    if ((fileSystem.existsSync(destination) && fileSystem.lstatSync(destination).isSymbolicLink()) ||
                        (fileSystem.existsSync(temp) && fileSystem.lstatSync(temp).isSymbolicLink())) return;
                    fileSystem.writeFileSync(temp, JSON.stringify(Object.keys(missing)), { encoding: 'utf8', flag: 'w' });
                    fileSystem.renameSync(temp, destination); dirty = false;
                }
            } catch (e) { /* 写入或热更新失败不影响游戏；下一次轮询重试。 */ }
        }, 1500);

        function addDictionary(next) {
            dictionary = next; reindex();
            var compact = false;
            Object.keys(missing).forEach(function (text) {
                if (has.call(dictionary, text) || targets[text]) { delete missing[text]; compact = true; dirty = true; }
            });
            if (compact) {
                var kept = [];
                for (var i = missingHead; i < missingOrder.length; i++) if (missing[missingOrder[i]]) kept.push(missingOrder[i]);
                missingOrder = kept; missingHead = 0;
            }
        }

        function fromTemplate(text) {
            for (var i = 0; i < templates.length; i++) {
                var template = templates[i], match = template.re.exec(text);
                if (!match) continue;
                return template.target.replace(/%(\d+)/g, function (whole, number) {
                    var slot = template.names.indexOf('%' + number);
                    return slot >= 0 ? match[slot + 1] : whole;
                });
            }
            return null;
        }
        function translate(text) {
            if (typeof text !== 'string') return text;
            if (has.call(dictionary, text) && typeof dictionary[text] === 'string') return dictionary[text];
            if (text.indexOf('\n') >= 0) return text.split('\n').map(translate).join('\n');
            var applied = fromTemplate(text);
            if (applied !== null) return applied;
            capture(text); return text;
        }
        assist.translate = translate;
        var fields = ['name', 'nickname', 'profile', 'description', 'message1', 'message2', 'message3', 'message4'];
        function database(object) {
            // 预加载数据库不代表文字已经显示，不能挤占动态文字的捕获范围。
            captureSuppressed++;
            try { translateDatabase(object); } finally { captureSuppressed--; }
        }
        function translateDatabase(object) {
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
        // 译文比原文宽时按可用宽度临时缩小这一行，画完立刻还原，不影响其它文字。
        function fitting(original) {
            return function (text, x, y, maxWidth, align) {
                var translated = translate(text);
                if (translated === text || !(maxWidth > 0)) return original.call(this, translated, x, y, maxWidth, align);
                var width = this.measureTextWidth(translated);
                var saved = this.fontSize;
                if (typeof saved === 'number' && width > maxWidth) {
                    var size = Math.floor(saved * maxWidth / width);
                    if (size >= 8 && size < saved) {
                        this.fontSize = size;
                        try { return original.call(this, translated, x, y, maxWidth, align); }
                        finally { this.fontSize = saved; }
                    }
                }
                return original.call(this, translated, x, y, maxWidth, align);
            };
        }
        function install() {
            if (!window.DataManager || !window.Bitmap || !window.Window_Base) return false;
            hook(Bitmap.prototype, 'initialize', function (original) { return function () {
                var result = original.apply(this, arguments);
                if (typeof this.fontFace === 'string') this.fontFace += ',"PingFang SC","Hiragino Sans",sans-serif';
                return result;
            }; });
            hook(DataManager, 'onLoad' , function (original) { return function (object) { original.apply(this, arguments); database(object); }; });
            hook(Bitmap.prototype, 'drawText', fitting);
            hook(Bitmap.prototype, 'measureTextWidth', function (original) { return function (text) {
                return original.call(this, translate(text));
            }; });
            // 窗口字体是在 resetFontSettings 里按数据库字号重新设定的，改 Bitmap 默认值不起作用。
            hook(Window_Base.prototype, 'resetFontSettings', function (original) { return function () {
                var result = original.apply(this, arguments);
                var contents = this.contents;
                if (fontScale !== 1 && contents && typeof contents.fontSize === 'number') {
                    contents.fontSize = Math.max(8, Math.round(contents.fontSize * fontScale));
                }
                return result;
            }; });
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
