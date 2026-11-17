# encoding: UTF-8
require 'json'
require 'securerandom'

module TsumigeyaRuntime
  DIRECTORY = File.dirname(__FILE__)
  class << self
    attr_reader :session
    def path(name)
      file = File.join(DIRECTORY, name)
      raise '辅助文件不能是符号链接' if File.symlink?(DIRECTORY) || File.symlink?(file)
      file
    end
    def read(name)
      file = path(name)
      raise '辅助文件过大' if File.size(file) > 8 * 1024 * 1024
      JSON.parse(File.binread(file))
    end
    def write(name, value)
      temp = path(name.sub('.json', '.tmp'))
      File.binwrite(temp, JSON.generate(value))
      File.rename(temp, path(name))
    end
    def reset
      @locks = {}; @session = SecureRandom.hex(16); @ack = nil; @error = nil
    end
    def text(value)
      value.encode('UTF-8')
    rescue EncodingError
      value.dup.force_encoding('Windows-31J').encode('UTF-8')
    end
    def translate(value)
      return value unless value.is_a?(String) && @config['translation']
      key = text(value)
      return @dictionary[key] if @dictionary.key?(key)
      if key.size.between?(1,4096) && key.match?(/[A-Za-z\p{Han}\p{Hiragana}\p{Katakana}]/) && !@missing.include?(key) && !@dictionary.value?(key)
        @missing << key; @missing.shift if @missing.length > 5000
      end
      value
    rescue StandardError
      value
    end
    def ready?
      scene = defined?(SceneManager) && SceneManager.respond_to?(:scene) ? SceneManager.scene : (defined?($scene) ? $scene : nil)
      return false if scene && %w[Scene_Title Scene_Load Scene_Gameover].include?(scene.class.name)
      defined?($game_party) && $game_party && defined?($game_variables) && $game_variables && defined?($data_system) && $data_system
    end
    def rows
      return [] unless ready?
      result = [{key:'gold',name:'金钱',value:$game_party.gold}]
      $data_system.variables.each_with_index do |name,i|
        next if i == 0
        value = $game_variables[i]
        next unless value.is_a?(Numeric) && value.finite? && value.abs <= 10**12
        result << {key:"variables:#{i}",name:"变量 #{i} #{text(name)}",value:value}
      end
      $data_system.switches.each_with_index do |name,i|
        result << {key:"switches:#{i}",name:"开关 #{i} #{text(name)}",value:!!$game_switches[i]} if i > 0
      end
      [$data_items, $data_weapons, $data_armors].each_with_index do |items,kind|
        (items || []).each do |item|
          next unless item
          value = if @config['edition'] == 'XP'
            [$game_party.method(:item_number),$game_party.method(:weapon_number),$game_party.method(:armor_number)][kind].call(item.id)
          else
            $game_party.item_number(item)
          end
          result << {key:"item:#{kind}:#{item.id}",name:text(item.name),value:value}
        end
      end
      members = $game_party.respond_to?(:members) ? $game_party.members : $game_party.actors
      members.each do |actor|
        %w[hp mp sp tp level].each do |field|
          next unless actor.respond_to?(field)
          result << {key:"actor:#{actor.id}:#{field}",name:"#{text(actor.name)} #{field}",value:actor.public_send(field)}
        end
      end
      result.first(10000).each { |r| r[:locked] = @locks.key?(r[:key]) }
    end
    def set(key, value)
      row = rows.find { |r| r[:key] == key }
      raise '变量不存在或不可编辑' unless row
      old = row[:value]
      if old == true || old == false
        raise '开关只能使用布尔值' unless value == true || value == false
      elsif key.start_with?('variables:')
        raise '请输入有效数值' unless value.is_a?(Numeric) && value.finite? && value.abs <= 10**12
      else
        raise '请输入有效整数' unless value.is_a?(Integer) && value.abs <= 10**12
      end
      parts = key.split(':'); id = parts[-1].to_i
      case parts[0]
      when 'gold'
        raise '金钱超出范围' unless value.between?(0, $game_party.respond_to?(:max_gold) ? $game_party.max_gold : 9999999)
        $game_party.gain_gold(value - old)
      when 'variables' then $game_variables[id] = value
      when 'switches' then $game_switches[id] = value
      when 'item'
        kind = parts[1].to_i; item = [$data_items,$data_weapons,$data_armors][kind][id]
        max = $game_party.respond_to?(:max_item_number) ? $game_party.max_item_number(item) : 99
        raise '物品数量超出范围' unless value.between?(0,max)
        if @config['edition'] == 'XP'
          [$game_party.method(:gain_item),$game_party.method(:gain_weapon),$game_party.method(:gain_armor)][kind].call(id,value-old)
        else
          $game_party.gain_item(item,value-old)
        end
      when 'actor'
        actor = $game_actors[parts[1].to_i]; field = parts[2]
        max = case field
          when 'hp' then actor.respond_to?(:mhp) ? actor.mhp : actor.maxhp
          when 'mp' then actor.respond_to?(:mmp) ? actor.mmp : actor.maxmp
          when 'sp' then actor.maxsp
          when 'tp' then actor.max_tp
          when 'level' then actor.respond_to?(:max_level) ? actor.max_level : 99
        end
        raise '角色数值超出范围' unless max && value.between?(field == 'level' ? 1 : 0,max)
        if field == 'level' && actor.respond_to?(:change_level)
          actor.change_level(value,false)
        else
          actor.public_send(field+'=',value)
        end
      end
      current = rows.find { |r| r[:key] == key }[:value]
      raise '游戏插件未接受目标数值，未添加锁定' unless current == value
    end
    def event_text(list, output)
      (list || []).each do |command|
        case command.code
        when 101,401,405 then command.parameters.each { |v| output << text(v) if v.is_a?(String) && command.code != 101 || (v.is_a?(String) && @config['edition'] == 'XP') }
        when 102 then (command.parameters[0] || []).each { |v| output << text(v) if v.is_a?(String) }
        end
      end
    end
    def extract
      output = []
      [$data_actors,$data_classes,$data_skills,$data_items,$data_weapons,$data_armors,$data_enemies,$data_states].each do |table|
        (table || []).each do |row|
          next unless row
          %w[name nickname profile description message1 message2 message3 message4].each { |field| output << text(row.public_send(field)) if row.respond_to?(field) && row.public_send(field).is_a?(String) }
        end
      end
      ($data_common_events || []).each { |event| event_text(event.list,output) if event }
      ext = {'XP'=>'rxdata','VX'=>'rvdata','VX Ace'=>'rvdata2'}[@config['edition']]
      begin
        infos = load_data("Data/MapInfos.#{ext}")
        infos.keys.sort.first(2000).each do |id|
          map = load_data(format('Data/Map%03d.%s',id,ext))
          map.events.each_value { |event| event.pages.each { |page| event_text(page.list,output) } }
        end
      rescue StandardError
        # 不读取脚本文本；无法读取的加密或自定义地图仍通过实际显示文字捕获。
      end
      output = output.reject { |v| v.strip.empty? || v.size > 4096 }.uniq.first(50000)
      write('extracted.json',output)
    end
    def reload_dictionary
      next_dictionary = read('translations.json')
      @dictionary = next_dictionary if next_dictionary.is_a?(Hash) && next_dictionary.all? { |k,v| k.is_a?(String) && v.is_a?(String) }
    rescue StandardError
      # 译文损坏不阻断游戏或独立的状态编辑；保留已有字典，稍后重试。
    end
    def tick
      now = Time.now.to_f
      return if now - @last < 0.25
      @last = now
      begin
        reload_dictionary
        @missing.reject! { |s| @dictionary.key?(s) || @dictionary.value?(s) }
        write('missing.json',@missing)
        if ready? && @party != $game_party.object_id
          reset; @party = $game_party.object_id
          extract if @config['translation']
        end
        return unless @config['cheats']
        @locks.dup.each do |key,value|
          begin; set(key,value); rescue StandardError; @locks.delete(key); end
        end
        if File.exist?(path('command.json'))
          command = read('command.json')
          if command['id'] != @ack && command['session'] == @session && command['identity'] == @config['identity'] && command['expires'].is_a?(Numeric) && command['expires'].between?(now,now+10)
            @ack = command['id']; @error = nil
            begin
              raise '请先进入游戏或读档' unless ready?
              key = command['key']; action = command['action']; value = command['value']
              case action
              when 'reset' then @locks.clear
              when 'unlock' then @locks.delete(key)
              when 'set','lock'
                set(key,value); @locks.delete(key)
                @locks[key] = value if action == 'lock'
              else raise '不支持的操作'
              end
            rescue StandardError => error
              @error = error.message
            end
          end
        end
        write('state.json',{identity:@config['identity'],session:@session,updated:now,ready:!!ready?,variables:rows,ack:@ack,error:@error})
      rescue StandardError => error
        @error = error.message
      end
    end
    def install
      @config = read('config.json'); @dictionary = {}; @missing = []; @last = 0; reset; reload_dictionary
    end
  end
end
TsumigeyaRuntime.install
module TsumigeyaRuntime
  # 游戏脚本常用 alias 包装原 API；预加载的 prepend 被 alias 捕获时，重入必须直达原实现。
  DRAW_TEXT = Bitmap.instance_method(:draw_text) unless const_defined?(:DRAW_TEXT)
  TEXT_SIZE = Bitmap.instance_method(:text_size) unless const_defined?(:TEXT_SIZE)
  GRAPHICS_UPDATE = Graphics.method(:update) unless const_defined?(:GRAPHICS_UPDATE)
end
module TsumigeyaBitmap
  def draw_text(*arguments)
    return TsumigeyaRuntime::DRAW_TEXT.bind(self).call(*arguments) if @tsumigeya_drawing
    begin
      @tsumigeya_drawing = true
      index = arguments[0].is_a?(Rect) ? 1 : 4
      arguments[index] = TsumigeyaRuntime.translate(arguments[index]) if arguments.size > index
      super(*arguments)
    ensure
      @tsumigeya_drawing = false
    end
  end
  def text_size(text)
    return TsumigeyaRuntime::TEXT_SIZE.bind(self).call(text) if @tsumigeya_measuring
    begin
      @tsumigeya_measuring = true
      super(TsumigeyaRuntime.translate(text))
    ensure
      @tsumigeya_measuring = false
    end
  end
end
Bitmap.prepend(TsumigeyaBitmap)
module TsumigeyaGraphics
  def update(*args)
    return TsumigeyaRuntime::GRAPHICS_UPDATE.call(*args) if @tsumigeya_updating
    begin
      @tsumigeya_updating = true
      TsumigeyaRuntime.tick
      super(*args)
    ensure
      @tsumigeya_updating = false
    end
  end
end
Graphics.singleton_class.prepend(TsumigeyaGraphics)
