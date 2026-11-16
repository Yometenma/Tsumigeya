'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const scripts = path.resolve(__dirname, '../../../Sources/TsumigeyaCore/Resources/Assist');
function game() {
    const timers = [];
    const c = { console, setInterval(fn) { timers.push(fn); return timers.length; }, clearInterval() {}, TsumigeyaAssist: { errors: [], options: {} } };
    c.window = c;
    c.$dataActors = [null, { id: 1, name: '勇者' }]; c.$dataItems = [null, { id: 1, name: '薬' }]; c.$dataWeapons = [null]; c.$dataArmors = [null];
    c.$dataMapInfos = [null, { id: 1, name: '村' }]; c.$dataCommonEvents = [null, { id: 1, name: 'イベント' }];
    c.$dataSystem = { variables: ['', '好感度', 'お金', '複雑'], switches: ['', '扉'] };
    const values = [0, 10, 20, { nested: 1 }], switches = [false, false], items = { 1: 0 };
    c.$gameVariables = { value(id) { return values[id] || 0; }, setValue(id, v) { values[id] = typeof v === 'number' ? Math.floor(v) : v; } };
    c.$gameSwitches = { value(id) { return !!switches[id]; }, setValue(id, v) { switches[id] = v; } };
    let gold = 50;
    const a = { hp: 40, mp: 10, tp: 0, level: 1, mhp: 100, mmp: 20, params: [100,20,10,10,10,10,10,10], actorId() { return 1; }, name() { return '勇者'; }, maxLevel() { return 99; }, maxTp() { return 100; }, setHp(v) { this.hp=v; }, setMp(v) { this.mp=v; }, setTp(v) { this.tp=v; }, changeLevel(v) { this.level=v; }, param(i) { return this.params[i]; }, addParam(i, v) { this.params[i]+=v; }, recoverAll() { this.hp=100; this.mp=20; } };
    c.$gameActors = { actor(id) { return id === 1 ? a : null; } };
    c.$gameParty = { gold() { return gold; }, maxGold() { return 999; }, gainGold(n) { gold+=n; }, numItems(i) { return items[i.id] || 0; }, maxItems() { return 99; }, gainItem(i,n) { items[i.id]=(items[i.id]||0)+n; }, members() { return [a]; }, inBattle() { return false; } };
    c.Game_Player = function () {}; c.Game_Player.prototype.isThrough = function () { return false; }; c.Game_Player.prototype.canEncounter = function () { return true; };
    c.$gamePlayer = new c.Game_Player(); c.$gamePlayer._moveSpeed = 4; c.$gamePlayer.moveSpeed = function() { return this._moveSpeed; }; c.$gamePlayer.setMoveSpeed = function(v) { this._moveSpeed = v; }; c.$gamePlayer.isTransferring = () => false;
    c.Scene_Map = function () {}; c.Scene_Battle = function () {};
    let updates = 0;
    c.SceneManager = { _scene: new c.Scene_Map(), updateMain() { updates++; }, updateScene() { updates++; }, isSceneChanging() { return false; } };
    c.$gameMap = { mapId() { return 1; }, events() { return []; }, isEventRunning() { return false; } };
    c.DataManager = { setupNewGame() {}, extractSaveContents() {}, onLoad() {} };
    c.Game_Message = function () {}; c.Game_Message.prototype.add = function(text) { this.text=text; }; c.Game_Message.prototype.setChoices = function(choices) { this.choices=choices; };
    c.Bitmap = function () {}; c.Bitmap.prototype.drawText = function(text) { this.drawn=text; }; c.Bitmap.prototype.measureTextWidth = function(text) { return text.length; };
    c.Window_Base = function () {}; c.Window_Base.prototype.convertEscapeCharacters = text => text;
    c.Window_Command = function () {}; c.Window_Command.prototype.addCommand = function(name) { this.name=name; };
    vm.createContext(c);
    return { c, timers, values, actor:a, updates:()=>updates, load(name) { vm.runInContext(fs.readFileSync(path.join(scripts,name),'utf8'),c,{filename:name}); }, tick() { timers.forEach(fn=>fn()); } };
}
test('cheat writes are validated, lock actually reapplies, and loading save clears it', () => {
    const g=game();g.load('cheats.js');const api=g.c.TsumigeyaAssist.cheats;
    api.set('gold',200);assert.equal(api.get('gold'),200);
    assert.throws(()=>api.set('gold',-1));assert.throws(()=>api.set('variables:1',{bad:true}));assert.throws(()=>api.set('switches:1',1));
    api.set('switches:1',true);assert.equal(api.get('switches:1'),true);
    api.lock('variables:1',30);g.values[1]=2;g.tick();assert.equal(g.values[1],30);
    api.unlock('variables:1');g.values[1]=3;g.tick();assert.equal(g.values[1],3);
    api.lock('gold',400);g.c.DataManager.extractSaveContents({});api.set('gold',1);g.tick();assert.equal(api.get('gold'),1);assert.equal(api.locks().length,0);
});
test('unknown-value narrowing compares snapshots and exposes zero and negative changes',()=>{
    const g=game();g.load('cheats.js');const api=g.c.TsumigeyaAssist.cheats;
    assert.throws(()=>api.scan('changed'));
    let rows=api.scan('unknown');assert(rows.some(r=>r.key==='variables:1'));assert(!rows.some(r=>r.key==='variables:3'));
    g.values[1]=5;rows=api.scan('decreased');assert.equal(rows.length,1);assert.equal(rows[0].key,'variables:1');
    g.values[1]=0;rows=api.scan('changed');assert.equal(rows[0].value,0);
    g.values[1]=-2;rows=api.scan('decreased');assert.equal(rows[0].value,-2);
    assert.equal(api.scan('unchanged').length,1);
});
test('inventory, attributes, noclip, encounter, speed and reset change real engine state',()=>{
    const g=game();g.load('cheats.js');const api=g.c.TsumigeyaAssist.cheats;
    api.inventory('items',1,42);assert.equal(api.list('items')[0].value,42);assert.throws(()=>api.inventory('items',1,100));
    api.set('actor:1:hp',80);assert.equal(g.actor.hp,80);assert.throws(()=>api.set('actor:1:hp',101));
    api.set('actor:1:param2',25);assert.equal(g.actor.param(2),25);
    api.toggle('clip',true);assert.equal(g.c.$gamePlayer.isThrough(),true);api.toggle('encounter',true);assert.equal(g.c.$gamePlayer.canEncounter(),false);
    api.speed(3);g.c.SceneManager.updateMain();assert.equal(g.updates(),3);
    api.moveSpeed(6);api.moveSpeed(5);assert.equal(g.c.$gamePlayer.moveSpeed(),5);
    api.reset();assert.equal(g.c.$gamePlayer.moveSpeed(),4);assert.equal(api.state().speed,1);assert.equal(g.c.$gamePlayer.isThrough(),false);assert.equal(g.c.$gamePlayer.canEncounter(),true);
});
test('translation hooks render, measure, choices and database without requiring cheats',()=>{
    const g=game();const a=g.c.TsumigeyaAssist;a.read=()=>({'勇者':'英雄','こんにちは':'你好','はい':'是','薬':'药'});
    g.load('translation.js');assert.equal(a.translationReady,true);assert.equal(a.cheats,undefined);
    const bitmap=new g.c.Bitmap();bitmap.drawText('こんにちは',0,0);assert.equal(bitmap.drawn,'你好');assert.equal(bitmap.measureTextWidth('こんにちは'),2);
    const msg=new g.c.Game_Message();msg.add('こんにちは');assert.equal(msg.text,'你好');msg.setChoices(['はい','未翻訳']);assert.deepEqual(Array.from(msg.choices),['是','未翻訳']);
    g.c.DataManager.onLoad(g.c.$dataItems);assert.equal(g.c.$dataItems[1].name,'药');assert.equal(a.translate('unknown'),'unknown');
});
test('broken translation does not prevent independently loaded cheats',()=>{
    const g=game();g.c.TsumigeyaAssist.read=()=>{throw Error('bad dictionary')};g.load('translation.js');g.load('cheats.js');
    assert.equal(g.c.TsumigeyaAssist.errors.length,1);g.c.TsumigeyaAssist.cheats.set('gold',100);assert.equal(g.c.TsumigeyaAssist.cheats.get('gold'),100);
});

test('NW extension paths capture missing text and hot reload the dictionary without networking',()=>{
    const os=require('node:os');
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tsumigeya-runtime-'));
    try {
        const data=path.join(directory,'www','.tsumigeya-assist');fs.mkdirSync(data,{recursive:true});
        const dictionary=path.join(data,'translations.json');fs.writeFileSync(dictionary,JSON.stringify({'こんにちは':'你好'}));
        const g=game();g.c.require=require;g.c.URL=URL;g.c.nw={App:{startPath:directory}};
        g.c.TsumigeyaAssist.base='chrome-extension://example/www/.tsumigeya-assist/';
        g.c.TsumigeyaAssist.read=()=>JSON.parse(fs.readFileSync(dictionary,'utf8'));
        g.load('translation.js');const api=g.c.TsumigeyaAssist;
        assert.equal(api.errors.length,0);assert.equal(api.translate('こんにちは'),'你好');
        api.translate('新しい文章');api.translate('你好');g.tick();
        const missing=JSON.parse(fs.readFileSync(path.join(data,'missing.json'),'utf8'));
        assert(missing.includes('新しい文章'));assert(!missing.includes('你好'));
        fs.writeFileSync(dictionary,JSON.stringify({'こんにちは':'你好','新しい文章':'新的句子'}));g.tick();
        assert.equal(api.translate('新しい文章'),'新的句子');
        assert(!fs.existsSync(path.join(data,'missing.tmp')));
    } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
test('map transfer validates map bounds and refuses battle, event execution respects busy state',()=>{
    const g=game();g.load('cheats.js');const api=g.c.TsumigeyaAssist.cheats;
    let transfer, common, eventStarted=false;
    g.c.XMLHttpRequest=function(){this.open=()=>{};this.send=()=>{};this.status=200;this.responseText=JSON.stringify({width:10,height:8});};
    g.c.$gamePlayer.reserveTransfer=(...args)=>{transfer=args;};
    api.teleport(1,9,7);assert.deepEqual(transfer,[1,9,7,2,0]);assert.throws(()=>api.teleport(1,10,0));
    g.c.$gameTemp={reserveCommonEvent(id){common=id;}};api.event('common',1);assert.equal(common,1);
    g.c.$gameMap.event=()=>({_pageIndex:0,start(){eventStarted=true;}});api.event('map',1);assert(eventStarted);
    g.c.$gameMap.isEventRunning=()=>true;assert.throws(()=>api.event('common',1));
    g.c.$gameParty.inBattle=()=>true;assert.throws(()=>api.teleport(1,0,0));
    let battle;g.c.BattleManager={processVictory(){battle='win';},abort(){battle='escape';}};
    api.battle('win');assert.equal(battle,'win');api.battle('escape');assert.equal(battle,'escape');
});

test('attribute edits respect engine caps and multipliers instead of creating an impossible lock',()=>{
    const g=game();g.load('cheats.js');const api=g.c.TsumigeyaAssist.cheats,a=g.actor;
    const plus=[0,0,0,0,0,0,0,0];
    a.paramMin=i=>i===0?1:0;a.paramMax=()=>999;
    a.paramBase=i=>a.params[i];a.paramPlus=i=>plus[i];a.paramRate=()=>2;a.paramBuffRate=()=>1.25;
    a.param=i=>Math.round(Math.max(a.paramMin(i),Math.min(a.paramMax(i),(a.paramBase(i)+plus[i])*a.paramRate(i)*a.paramBuffRate(i))));
    a.addParam=(i,delta)=>{plus[i]+=delta;};
    api.set('actor:1:param2',45);assert.equal(a.param(2),45);
    assert.throws(()=>api.lock('actor:1:param0',0));assert.equal(api.locks().length,0);
    api.lock('actor:1:param2',50);g.tick();assert.equal(a.param(2),50);
    a.paramRate=()=>0;assert.throws(()=>api.set('actor:1:param2',40));
});
