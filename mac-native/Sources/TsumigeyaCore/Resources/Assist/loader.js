(function () {
    'use strict';
    if (window.TsumigeyaAssist) return;
    var source = document.currentScript.src;
    var base = source.slice(0, source.lastIndexOf('/') + 1);
    var assist = window.TsumigeyaAssist = { base: base, errors: [], options: {}, version: 1 };
    assist.read = function (name) {
        var xhr = new XMLHttpRequest(); xhr.open('GET', base + name, false); xhr.send();
        if (xhr.status && xhr.status !== 200) throw new Error('无法读取辅助文件：' + name);
        return JSON.parse(xhr.responseText);
    };
    function load(name) {
        var xhr = new XMLHttpRequest(); xhr.open('GET', base + name, false); xhr.send();
        if (xhr.status && xhr.status !== 200) throw new Error('无法加载辅助脚本：' + name);
        var script = document.createElement('script'); script.textContent = xhr.responseText;
        document.head.appendChild(script);
    }
    try { assist.options = assist.read('config.json'); }
    catch (e) { assist.errors.push('读取配置失败：' + e.message); return; }
    if (assist.options.translation) {
        try { load('translation.js'); } catch (e) { assist.errors.push('翻译加载失败：' + e.message); }
    }
    if (assist.options.cheats) {
        try { load('cheats.js'); load('panel.js'); } catch (e) { assist.errors.push('作弊加载失败：' + e.message); }
    }
    if (assist.errors.length) console.warn('[Tsumigeya]', assist.errors.join('\n'));
}());
