import importlib.util
import pathlib
import json
import tempfile
import time
import types
import unittest
import sys

sys.dont_write_bytecode = True

SOURCE=pathlib.Path(__file__).resolve().parents[3]/'Sources/TsumigeyaCore/Resources/Assist/renpy.py'
spec=importlib.util.spec_from_file_location('assist_runtime_test',SOURCE)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class RuntimeTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
  (self.root/'translations.json').write_text(json.dumps({'こんにちは [name]':'你好 [name]'}))
  self.runtime=module.Runtime(str(self.root),dict(identity='game',translation=True,cheats=True))
  self.store=types.SimpleNamespace(money=10,flag=False,name='勇者',complex={'not':'scalar'},_private=100)
 def tearDown(self):self.temp.cleanup()
 def tick(self,ready=True):self.runtime.last=0;self.runtime.tick(self.store,ready)
 def command(self,action,key='money',value=25,**kw):
  c=dict(id=str(time.time_ns()),session=self.runtime.session,identity='game',expires=time.time()+5,action=action,key=key,value=value);c.update(kw)
  (self.root/'command.json').write_text(json.dumps(c));self.tick();return c
 def test_translate_hot_capture(self):
  self.assertEqual(self.runtime.translate('こんにちは [name]'),'你好 [name]')
  self.assertEqual(self.runtime.translate('新しい台詞'),'新しい台詞');self.tick()
  self.assertEqual(json.loads((self.root/'missing.json').read_text(encoding='utf-8')),['新しい台詞'])
  (self.root/'translations.json').write_text(json.dumps({'新しい台詞':'新的台词'}));self.tick()
  self.assertEqual(self.runtime.translate('新しい台詞'),'新的台词');self.assertEqual(self.runtime.missing,[])
 def test_scalar_set_lock_and_reset(self):
  self.command('set');self.assertEqual(self.store.money,25)
  self.command('lock',value=30);self.store.money=0;self.tick();self.assertEqual(self.store.money,30)
  self.command('unlock');self.store.money=2;self.tick();self.assertEqual(self.store.money,2)
  self.command('lock',value=40);old=self.runtime.session;self.runtime.reset();self.store.money=5;self.tick()
  self.assertEqual(self.store.money,5);self.assertNotEqual(self.runtime.session,old)
  rows=json.loads((self.root/'state.json').read_text(encoding='utf-8'))['variables'];self.assertFalse(any(x['key'] in ['_private','complex'] for x in rows))
 def test_stale_wrong_type_and_busy_refused(self):
  self.command('set',session='other');self.assertEqual(self.store.money,10)
  self.command('set',expires=time.time()-1);self.assertEqual(self.store.money,10)
  self.command('set',identity='other');self.assertEqual(self.store.money,10)
  self.command('set',value=True);self.assertEqual(self.store.money,10);self.assertTrue(self.runtime.error)
  self.command('set',key='complex',value=3);self.assertEqual(self.store.complex,{'not':'scalar'})
  self.command('set',key='_private',value=3);self.assertEqual(self.store._private,100)
  self.command('set',key='flag',value=True);self.assertIs(self.store.flag,True)
 def test_disabled_modules_do_not_mutate(self):
  self.runtime.config['translation']=False;self.assertEqual(self.runtime.translate('こんにちは [name]'),'こんにちは [name]')
  self.runtime.config['cheats']=False;self.command('set');self.assertEqual(self.store.money,10)
 def test_broken_translation_does_not_disable_game_state_bridge(self):
  (self.root/'translations.json').write_text('{broken')
  self.command('set','money',35);self.assertEqual(self.store.money,35)
  self.assertEqual(self.runtime.translate('こんにちは [name]'),'你好 [name]')
  fresh=module.Runtime(str(self.root),dict(identity='game',translation=True,cheats=True))
  self.assertEqual(fresh.translate('原文'),'原文');fresh.tick(self.store)
  self.assertTrue((self.root/'state.json').exists())
 def test_actual_edits_notify_engine_without_restarting_idle_ticks(self):
  changes=[];self.runtime.after_edit=lambda:changes.append(True)
  self.tick();self.assertEqual(changes,[])
  self.command('lock','money',25);self.assertEqual(len(changes),1)
  self.tick();self.assertEqual(len(changes),1)
  self.store.money=2;self.tick();self.assertEqual(len(changes),2)
  self.command('unlock');self.assertEqual(len(changes),2)
 def test_engine_control_fields_are_not_editable(self):
  self.store.main_menu=False;self.store.mouse_visible=True;self.store.PY2=False
  self.tick();state=json.loads((self.root/'state.json').read_text(encoding='utf-8'))
  self.assertTrue(all(x['key'] not in module.Runtime.RESERVED for x in state['variables']))
  self.command('set','main_menu',True);self.assertFalse(self.store.main_menu)
 def test_float_accepts_integer_without_changing_type(self):
  self.store.affection=1.5;self.command('lock','affection',3)
  self.assertEqual(self.store.affection,3.0);self.assertIs(type(self.store.affection),float)
  self.store.affection=1.0;self.tick();self.assertEqual(self.store.affection,3.0)
  self.command('set','affection',4);self.assertNotIn('affection',self.runtime.locks)
  self.command('set','affection',True);self.assertEqual(self.store.affection,4.0)
 def test_nested_dict_and_list_entries_are_editable(self):
  self.store.player={'level':3,'name':'アリス'};self.store.party=[10,20];self.store.items={1:5}
  self.tick();state={x['key']:x['value'] for x in json.loads((self.root/'state.json').read_text(encoding='utf-8'))['variables']}
  self.assertEqual(state['player.level'],3);self.assertEqual(state['party[1]'],20);self.assertEqual(state['items.1'],5)
  self.command('set','player.level',9);self.assertEqual(self.store.player['level'],9)
  self.command('set','party[0]',99);self.assertEqual(self.store.party,[99,20])
  self.command('set','items.1',7);self.assertEqual(self.store.items,{1:7})
  self.command('set','player.nope',1);self.assertEqual(self.store.player,{'level':9,'name':'アリス'})
  self.command('set','party.0',1);self.assertEqual(self.store.party,[99,20])
  self.command('lock','party[0]',42);self.store.party[0]=0;self.tick();self.assertEqual(self.store.party[0],42)
 def test_hooks_chain_and_reset(self):
  config=types.SimpleNamespace(gamedir=str(self.root.parent),replace_text=lambda s:s+'原',periodic_callbacks=[],after_load_callbacks=[],start_callbacks=[])
  # install reads a real sidecar, exactly like the engine entry.
  parent=self.root/'.tsumigeya-assist';parent.mkdir();(parent/'config.json').write_text(json.dumps(dict(identity='g',translation=True,cheats=True)))
  (parent/'translations.json').write_text(json.dumps({'台詞原':'译文'}));config.gamedir=str(self.root)
  renpy=types.SimpleNamespace(config=config,store=types.SimpleNamespace(main_menu=False,money=1))
  runtime=module.install(renpy);self.assertEqual(config.replace_text('台詞'),'译文')
  config.periodic_callbacks[0]();self.assertTrue((parent/'state.json').exists())
  old=runtime.session;config.after_load_callbacks[0]();self.assertNotEqual(runtime.session,old)

if __name__=='__main__':unittest.main()
