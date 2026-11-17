require 'json'
require 'tmpdir'
require 'fileutils'
require 'ostruct'
require 'minitest/autorun'

class Scene_Title; end
class Scene_Map; end
class Rect; end
class Font
 attr_accessor :name
 def initialize;@name='Original';end
 def self.exist?(name);name=='Arial Unicode MS';end
end
class Window_Message
 attr_reader :rendered
 def refresh;@rendered=$game_temp.message_text.chars;end
 def start_message;@rendered=$game_message.texts.join("\n").chars;end
end
class Bitmap
  attr_reader :last, :draw_font, :measure_font
  def font;@font||=Font.new;end
  def draw_text(*args);@draw_font=font.name;@last=args;end
  def text_size(text);@measure_font=font.name;text;end
end
module Graphics
 def self.update;true;end
end
class PartyFixture
 attr_reader :gold
 def initialize;@gold=10;end
 def gain_gold(n);@gold+=n;end
 def max_gold;99999;end
 def item_number(item);(@inventory||={})[[item.is_a?(Integer) ? 0 : item.kind,item.is_a?(Integer) ? item : item.id]]||0;end
 def weapon_number(id);(@inventory||={})[[1,id]]||0;end
 def armor_number(id);(@inventory||={})[[2,id]]||0;end
 def gain_item(item,n);key=[item.is_a?(Integer) ? 0 : item.kind,item.is_a?(Integer) ? item : item.id];(@inventory||={})[key]=item_number(item)+n;end
 def gain_weapon(id,n);(@inventory||={})[[1,id]]=weapon_number(id)+n;end
 def gain_armor(id,n);(@inventory||={})[[2,id]]=armor_number(id)+n;end
 def max_item_number(item);99;end
 attr_accessor :members
 def members;@members||[];end
end
class RGSSRuntimeTest < Minitest::Test
 def setup
  @dir=Dir.mktmpdir('rgss-runtime-')
  resource=File.expand_path('../../../Sources/TsumigeyaCore/Resources/Assist/rgss.rb',__dir__)
  FileUtils.cp(resource,File.join(@dir,'rgss.rb'))
  File.write(File.join(@dir,'config.json'),JSON.generate({identity:'game',translation:true,cheats:true,edition:'VX Ace'}))
  File.write(File.join(@dir,'translations.json'),JSON.generate({'こんにちは'=>'你好'}))
  $game_party=PartyFixture.new
  $game_variables=[0,10];$game_switches=[false,false]
  $data_system=OpenStruct.new(variables:['','好感度'],switches:['','门'])
  $data_items=[];$data_weapons=[];$data_armors=[]
  $data_actors=[];$data_classes=[];$data_skills=[];$data_enemies=[];$data_states=[];$data_common_events=[]
  TsumigeyaRuntime.send(:remove_const,:DIRECTORY) if defined?(TsumigeyaRuntime::DIRECTORY)
  load File.join(@dir,'rgss.rb')
 end
 def teardown;FileUtils.remove_entry(@dir);end
 def tick;TsumigeyaRuntime.instance_variable_set(:@last,0);TsumigeyaRuntime.tick;end
 def command(action,key='gold',value=30,extra={})
  c={id:SecureRandom.hex(6),session:TsumigeyaRuntime.session,identity:'game',expires:Time.now.to_f+5,action:action,key:key,value:value}.merge(extra)
  File.write(File.join(@dir,'command.json'),JSON.generate(c));tick
 end
 def test_render_capture_and_hot_reload
  b=Bitmap.new;b.draw_text(0,0,100,40,'こんにちは');assert_equal '你好',b.last[4]
  assert_equal '你好',b.text_size('こんにちは')
  TsumigeyaRuntime.translate('新しい台詞');tick
  assert_includes JSON.parse(File.read(File.join(@dir,'missing.json'))),'新しい台詞'
  File.write(File.join(@dir,'translations.json'),JSON.generate({'新しい台詞'=>'新的台词'}));tick
  assert_equal '新的台词',TsumigeyaRuntime.translate('新しい台詞')
 end
 def test_cjk_uses_same_font_for_measurement_and_draw_and_restores_game_font
  bitmap=Bitmap.new
  bitmap.draw_text(0,0,100,40,'こんにちは')
  assert_equal 'Arial Unicode MS',bitmap.draw_font
  assert_equal 'Original',bitmap.font.name
  bitmap.text_size('こんにちは')
  assert_equal 'Arial Unicode MS',bitmap.measure_font
  assert_equal 'Original',bitmap.font.name
  ['。','：'].each do |punctuation|
   bitmap.draw_text(0,0,100,40,punctuation)
   assert_equal 'Arial Unicode MS',bitmap.draw_font
  end
  bitmap.draw_text(0,0,100,40,'你');tick
  refute_includes JSON.parse(File.read(File.join(@dir,'missing.json'))),'你'
  bitmap.draw_text(0,0,100,40,'unchanged')
  assert_equal 'Original',bitmap.draw_font
  TsumigeyaRuntime.instance_variable_get(:@config)['translation']=false
  bitmap.draw_text(0,0,100,40,'原文')
  assert_equal 'Original',bitmap.draw_font
 end
 def test_dialogue_is_translated_before_character_splitting_in_xp_and_vx
  tick
  TsumigeyaRuntime.instance_variable_get(:@config)['edition']='XP'
  $game_temp=OpenStruct.new(message_text:"こんにちは\n")
  window=Window_Message.new;window.refresh
  assert_equal "你好\n".chars,window.rendered
  TsumigeyaRuntime.instance_variable_get(:@config)['edition']='VX'
  $game_message=OpenStruct.new(texts:['こんにちは'])
  window.start_message
  assert_equal '你好'.chars,window.rendered
 ensure
  $game_temp=nil;$game_message=nil
 end
 def test_write_lock_load_reset_and_stale_rejection
  tick;command('set');assert_equal 30,$game_party.gold
  command('lock','variables:1',50);$game_variables[1]=2;tick;assert_equal 50,$game_variables[1]
  command('unlock','variables:1');$game_variables[1]=3;tick;assert_equal 3,$game_variables[1]
  command('set','gold',40,{session:'wrong'});assert_equal 30,$game_party.gold
  command('set','gold',40,{expires:Time.now.to_f-2});assert_equal 30,$game_party.gold
  command('set','gold',true);assert_equal 30,$game_party.gold
  command('lock','variables:1',70);old=TsumigeyaRuntime.session
  $game_party=PartyFixture.new;$game_variables[1]=4;tick
  refute_equal old,TsumigeyaRuntime.session;assert_equal 4,$game_variables[1]
 end
 def test_game_alias_wrappers_do_not_recurse_into_preloaded_hooks
  Bitmap.class_eval do
   alias_method :game_draw_text, :draw_text
   alias_method :game_text_size, :text_size
   def draw_text(*args);game_draw_text(*args);end
   def text_size(text);game_text_size(text);end
  end
  Graphics.singleton_class.class_eval do
   alias_method :game_update, :update
   def update;game_update;end
  end
  bitmap=Bitmap.new;bitmap.draw_text(0,0,100,40,'こんにちは')
  assert_equal '你好',bitmap.last[4];assert_equal '你好',bitmap.text_size('こんにちは')
  assert Graphics.update
 ensure
  Bitmap.class_eval do
   define_method :draw_text,TsumigeyaRuntime::DRAW_TEXT
   define_method :text_size,TsumigeyaRuntime::TEXT_SIZE
  end
  Graphics.singleton_class.send(:define_method,:update,TsumigeyaRuntime::GRAPHICS_UPDATE)
 end
 def test_fractional_variables_do_not_relax_inventory_integer_rules
  tick;command('set','variables:1',1.5);assert_equal 1.5,$game_variables[1]
  command('set','variables:1',true);assert_equal 1.5,$game_variables[1]
  command('set','gold',2.5);assert_equal 10,$game_party.gold
 end
 def test_inventory_and_actor_adapters_for_all_three_rgss_editions
  ['XP','VX','VX Ace'].each do |edition|
   TsumigeyaRuntime.instance_variable_get(:@config)['edition']=edition
   $game_party=PartyFixture.new
   $data_items=[nil,OpenStruct.new(id:1,kind:0,name:'药水')]
   $data_weapons=[nil,OpenStruct.new(id:1,kind:1,name:'剑')]
   $data_armors=[nil,OpenStruct.new(id:1,kind:2,name:'甲')]
   actor=OpenStruct.new(id:1,name:'勇者',hp:10,mp:5,sp:5,tp:1,level:2,mhp:100,mmp:50,maxhp:100,maxmp:50,maxsp:50,max_tp:100,max_level:99)
   actor.define_singleton_method(:change_level){|value,show|self.level=value}
   $game_actors=[nil,actor];$game_party.members=[actor];tick
   3.times do |kind|
    command('set',"item:#{kind}:1",5)
    assert_equal 5,TsumigeyaRuntime.rows.find{|r|r[:key]=="item:#{kind}:1"}[:value],edition
   end
   command('set','actor:1:hp',30);assert_equal 30,actor.hp,edition
   command('set','actor:1:level',4);assert_equal 4,actor.level,edition
   field=edition=='XP' ? 'sp' : 'mp'
   command('set',"actor:1:#{field}",9);assert_equal 9,actor.public_send(field),edition
   command('lock','actor:1:hp',1000);assert_equal 30,actor.hp,edition
   refute TsumigeyaRuntime.rows.find{|r|r[:key]=='actor:1:hp'}[:locked]
  end
 end
 def test_broken_translation_preserves_original_and_state_bridge
  File.write(File.join(@dir,'translations.json'),'{broken')
  TsumigeyaRuntime.install;tick
  assert_equal '原文',TsumigeyaRuntime.translate('原文')
  command('set','gold',35);assert_equal 35,$game_party.gold
  File.write(File.join(@dir,'translations.json'),JSON.generate({'原文'=>'译文'}));tick
  assert_equal '译文',TsumigeyaRuntime.translate('原文')
 end
 def test_title_rejects_commands_even_with_leftover_party
  $scene=Scene_Title.new;tick
  refute TsumigeyaRuntime.ready?
  command('set');assert_equal 10,$game_party.gold
  $scene=Scene_Map.new;tick
  assert TsumigeyaRuntime.ready?
 ensure
  $scene=nil
 end
 def test_symlinks_do_not_overwrite_unrelated_files
  outside=File.join(@dir,'outside');File.write(outside,'keep')
  File.symlink(outside,File.join(@dir,'missing.tmp'));tick
  assert_equal 'keep',File.read(outside)
 end
end
