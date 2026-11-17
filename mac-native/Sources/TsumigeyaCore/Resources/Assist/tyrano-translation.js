(function () {
    'use strict';
    var assist = window.TsumigeyaAssist, dictionary = assist.read('translations.json'), missing = [], fs = null, directory = null, hooked = false;
    try {
        fs = require('fs');
        directory = assist.base.indexOf('file:') === 0 ? require('url').fileURLToPath(assist.base) : require('path').join(nw.App.startPath, decodeURIComponent(new URL(assist.base).pathname));
        if (fs.lstatSync(directory).isSymbolicLink()) throw Error('辅助目录是符号链接');
    } catch (_) { fs = null; }
    function translate(text) {
        if (typeof text !== 'string') return text;
        if (Object.prototype.hasOwnProperty.call(dictionary, text) && typeof dictionary[text] === 'string') return dictionary[text];
        if (text.length && text.length <= 4096 && /[A-Za-z\u3040-\u9fff]/.test(text) && missing.indexOf(text) < 0 && !Object.keys(dictionary).some(function (key) { return dictionary[key] === text; })) {
            missing.push(text); if (missing.length > 5000) missing.shift();
        }
        return text;
    }
    assist.translate = translate;
    function wrap(tags) {
        if (!tags) return;
        [['text', 'val'], ['glink', 'text']].forEach(function (entry) {
            var tag = tags[entry[0]]; if (!tag || typeof tag.start !== 'function' || tag.start.tsumigeyaTranslated) return;
            var start = tag.start;
            tag.start = function (parameters) {
                // Tyrano 也通过 text 标签积累 iscript/html 原文，不能将代码送去翻译或替换。
                var kag = this.kag || (window.TYRANO && TYRANO.kag);
                if (entry[0] === 'text' && kag && kag.stat && (kag.stat.is_script || kag.stat.is_html)) return start.call(this, parameters);
                var copy = Object.assign({}, parameters);
                copy[entry[1]] = translate(copy[entry[1]]);
                return start.call(this, copy);
            };
            tag.start.tsumigeyaTranslated = true;
        });
    }
    // 先包住标签模板，避免小型本地剧本在首次轮询之前就显示首句。
    if (window.tyrano && tyrano.plugin && tyrano.plugin.kag) wrap(tyrano.plugin.kag.tag);
    function hook() {
        if (hooked || !window.TYRANO || !TYRANO.kag || !TYRANO.kag.ftag) return;
        var tags = TYRANO.kag.ftag.master_tag;
        if (!tags || !tags.text) return;
        wrap(tags); hooked = true; clearInterval(poll);
    }
    var poll = setInterval(hook, 100);
    hook();
    setInterval(function () {
        if (!fs || !directory) return;
        try {
            var path = require('path'), names = ['translations.json', 'missing.json', 'missing.tmp'];
            if (fs.lstatSync(directory).isSymbolicLink()) return;
            if (names.some(function (n) { var p = path.join(directory, n); return fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink(); })) return;
            var next = JSON.parse(fs.readFileSync(path.join(directory, 'translations.json'), 'utf8'));
            if (next && !Array.isArray(next) && typeof next === 'object') dictionary = next;
            missing = missing.filter(function (s) { return !Object.prototype.hasOwnProperty.call(dictionary, s); });
            fs.writeFileSync(path.join(directory, 'missing.tmp'), JSON.stringify(missing));
            fs.renameSync(path.join(directory, 'missing.tmp'), path.join(directory, 'missing.json'));
        } catch (_) { /* 游戏继续显示原文；下次轮询重试。 */ }
    }, 1500);
}());
