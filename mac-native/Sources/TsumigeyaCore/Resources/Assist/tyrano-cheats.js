(function () {
    'use strict';
    var assist = window.TsumigeyaAssist, locks = Object.create(null), previous = null, scanned = null;
    var api = assist.cheats = { generation: 0 };
    function roots() { if (!api.ready()) throw Error('请先进入游戏。'); return { f: TYRANO.kag.stat.f, sf: TYRANO.kag.variable.sf }; }
    function scalar(v) { return typeof v === 'boolean' || (typeof v === 'number' && isFinite(v) && Math.abs(v) <= 1e12) || (typeof v === 'string' && v.length <= 4096); }
    function safe(key) { return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'; }
    api.ready = function () { return !!(window.TYRANO && TYRANO.kag && TYRANO.kag.stat && TYRANO.kag.stat.f && TYRANO.kag.variable && TYRANO.kag.variable.sf); };
    api.list = function () {
        var result = [], data = roots();
        function visit(object, prefix, depth) {
            if (!object || typeof object !== 'object' || depth > 3) return;
            Object.keys(object).forEach(function (key) {
                if (result.length >= 10000 || !safe(key) || key.indexOf('.') >= 0) return;
                var descriptor = Object.getOwnPropertyDescriptor(object, key);
                if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return;
                var value = descriptor.value, path = prefix ? prefix + '.' + key : key;
                if (scalar(value)) result.push({key:path, name:path, value:value, locked:Object.prototype.hasOwnProperty.call(locks,path)});
                else if (value && Object.getPrototypeOf(value) === Object.prototype) visit(value,path,depth+1);
            });
        }
        visit(data,'',0); return result;
    };
    function assign(key, value) {
        var row = api.list().find(function (r) { return r.key === key; });
        if (!row || !scalar(value) || typeof value !== typeof row.value) throw Error('变量不存在或目标类型与原值不一致。');
        var parts = key.split('.'), object = roots();
        if (!parts.every(safe)) throw Error('变量路径无效。');
        for (var i=0; i<parts.length-1; i++) object = object[parts[i]];
        object[parts[parts.length-1]] = value;
    };
    api.set = function (key,value) { assign(key,value); delete locks[key]; };
    api.lock = function (key,value) { assign(key,value); locks[key]=value; };
    api.unlock = function (key) { delete locks[key]; };
    api.reset = function () { locks=Object.create(null);scanned=null;api.generation++; };
    api.scan = function (mode,value) {
        var rows=api.list().filter(function(r){return typeof r.value==='number';});
        if(mode==='unknown'||mode==='exact') scanned=rows.filter(function(r){return mode==='unknown'||r.value===value;});
        else {
            if(!scanned)throw Error('请先建立数值搜索范围。');
            var tests={changed:function(a,b){return a!==b;},unchanged:function(a,b){return a===b;},increased:function(a,b){return a>b;},decreased:function(a,b){return a<b;}};
            if(!tests[mode])throw Error('搜索方式无效。');
            scanned=scanned.map(function(old){var row=rows.find(function(r){return r.key===old.key;});return row&&tests[mode](row.value,old.value)?row:null;}).filter(Boolean);
        }
        return scanned;
    };
    setInterval(function () {
        if (!api.ready()) {api.reset();return;}
        if (previous !== TYRANO.kag.stat.f) {api.reset();previous=TYRANO.kag.stat.f;}
        Object.keys(locks).forEach(function(key){try{assign(key,locks[key]);}catch(_){delete locks[key];}});
    }, 200);
}());
