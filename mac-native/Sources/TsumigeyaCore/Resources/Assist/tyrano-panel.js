(function(){
    'use strict';
    var api=TsumigeyaAssist.cheats, host=document.createElement('div');host.id='tsumigeya-assist-panel';
    host.style.cssText='position:fixed;z-index:2147483647;top:8px;right:8px;left:auto;bottom:auto;margin:0;padding:0;border:0;background:transparent;';
    var root=host.attachShadow({mode:'open'});
    function el(tag,text,parent){var node=document.createElement(tag);if(text!==undefined)node.textContent=text;(parent||root).appendChild(node);return node;}
    el('style','*{box-sizing:border-box}button,input,select{font:14px system-ui;margin:4px;padding:7px;color:#eee;background:#273344;border:1px solid #65758b;border-radius:5px}section{font:14px system-ui;background:#18202e;color:#eee;padding:15px;border-radius:10px;width:480px;max-width:90vw;max-height:85vh;overflow:auto}p{line-height:1.6}.list{max-height:36vh;overflow:auto}.row{padding:8px 0;border-bottom:1px solid #536075}input{max-width:95%}');
    var toggle=el('button','游戏辅助'),panel=el('section');panel.hidden=true;
    function run(fn){try{fn();}catch(e){status.textContent=e.message;}}
    function button(parent,text,fn){var b=el('button',text,parent);b.onclick=function(){run(fn);};return b;}
    function open(){panel.hidden=!panel.hidden;toggle.hidden=!panel.hidden;if(!panel.hidden)render();}
    toggle.onclick=open;button(panel,'关闭',open);el('h3','游戏变量与数值搜索',panel);
    el('p','修改可能写入存档并破坏剧情，请先备份。仅操作简单变量；sf 是跨存档的系统变量。',panel);
    var status=el('p','',panel),search=el('input',undefined,panel);search.placeholder='搜索变量名或数值';search.oninput=function(){render();};
    var target=el('input',undefined,panel);target.placeholder='已知数值';target.type='number';var candidates=null,generation=api.generation;
    button(panel,'已知数值',function(){candidates=api.scan('exact',Number(target.value));render();});button(panel,'未知数值',function(){candidates=api.scan('unknown');render();});
    [['increased','增加'],['decreased','减少'],['changed','变化'],['unchanged','未变化']].forEach(function(pair){button(panel,pair[1],function(){candidates=api.scan(pair[0]);render();});});
    button(panel,'显示全部',function(){candidates=null;render();});button(panel,'解除全部锁定',function(){api.reset();render();});
    var list=el('div',undefined,panel);list.className='list';
    function render(){
        if(generation!==api.generation){candidates=null;generation=api.generation;}
        list.textContent='';if(!api.ready()){status.textContent='请先进入游戏。';return;}
        var rows=api.list();if(candidates)rows=rows.filter(function(r){return candidates.some(function(c){return c.key===r.key;});});var query=search.value.toLowerCase();rows=rows.filter(function(r){return r.key.toLowerCase().indexOf(query)>=0||String(r.value).toLowerCase().indexOf(query)>=0;});
        status.textContent='匹配 '+rows.length+' 条，显示前 100 条。';
        rows.slice(0,100).forEach(function(row){var wrap=el('div',undefined,list);wrap.className='row';el('div',row.key,wrap);var value=el('input',undefined,wrap);value.type=typeof row.value==='boolean'?'checkbox':typeof row.value==='number'?'number':'text';if(value.type==='checkbox')value.checked=row.value;else value.value=String(row.value);
            function edit(lock){if(!window.confirm('修改 '+row.key+'？可能影响进度。'))return;var parsed=value.type==='checkbox'?value.checked:value.type==='number'?Number(value.value):value.value;if(value.type==='number'&&(!value.value.trim()||!isFinite(parsed)))throw Error('请输入有效数值。');(lock?api.lock:api.set)(row.key,parsed);render();}
            button(wrap,'修改',function(){edit(false);});button(wrap,'锁定',function(){edit(true);});button(wrap,'解锁',function(){api.unlock(row.key);render();});if(row.locked)el('span','已锁定',wrap);
        });
    }
    el('h3','场景跳转',panel);
    var sceneInput=el('input',undefined,panel);sceneInput.placeholder='场景文件，例如 scenario/first.ks';
    var labelInput=el('input',undefined,panel);labelInput.placeholder='标签（可空）';
    button(panel,'跳转',function(){
        if(!window.confirm('跳转到其它场景？当前未保存的进度会丢失。'))return;
        var info=api.jump(sceneInput.value,labelInput.value);
        status.textContent=info?('已跳到 '+(info.scenario||'（未知场景）')+' '+(info.label||'')):'已请求跳转。';render();
    });
    button(panel,'当前位置',function(){var info=api.where();status.textContent=info?((info.scenario||'（未知场景）')+' '+(info.label||'')+'，行 '+(info.line||0)):'请先进入游戏。';});
    setInterval(function(){if(!panel.hidden&&generation!==api.generation)render();},500);
    ['keydown','keyup','keypress','mousedown','mouseup','click','wheel','touchstart','touchend'].forEach(function(n){host.addEventListener(n,function(e){e.stopPropagation();});});
    document.addEventListener('keydown',function(e){if(e.key==='F8'&&e.shiftKey){e.preventDefault();e.stopImmediatePropagation();open();}},true);
    document.body.appendChild(host);if(host.showPopover){host.setAttribute('popover','manual');try{host.showPopover();}catch(_){}}
}());
