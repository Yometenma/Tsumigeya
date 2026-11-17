# -*- coding: utf-8 -*-
"""Ren'Py runtime: local text cache and scalar-only, session-bound commands."""
import os
import json
import time
import uuid
import math

class Runtime(object):
    # 这些是引擎控制状态，不是游戏剧情变量；编辑会破坏菜单、光标或版本分支。
    RESERVED = frozenset(('PY2', 'main_menu', 'mouse_visible', 'suppress_overlay'))

    def __init__(self, directory, config):
        self.directory = directory
        self.config = config
        self.session = uuid.uuid4().hex
        self.dictionary = {}
        self.missing = []
        self.locks = {}
        self.ack = None
        self.error = None
        self.last = 0
        self.after_edit = None
        self.reload()

    def path(self, name):
        path = os.path.join(self.directory, name)
        if os.path.islink(self.directory) or os.path.islink(path):
            raise ValueError('辅助文件不能是符号链接')
        return path

    def read(self, name):
        path = self.path(name)
        if os.path.getsize(path) > 4 * 1024 * 1024:
            raise ValueError('辅助文件过大')
        with open(path, 'rb') as stream:
            return json.loads(stream.read().decode('utf-8'))

    def write(self, name, value):
        path = self.path(name)
        temporary = self.path(name.replace('.json', '.tmp'))
        with open(temporary, 'wb') as stream:
            stream.write(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8'))
        getattr(os, "replace", os.rename)(temporary, path)

    def reload(self):
        try:
            dictionary = self.read('translations.json')
        except Exception:
            # 译文损坏时保留已有字典或原文，不阻断游戏与独立作弊功能。
            return
        if isinstance(dictionary, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in dictionary.items()):
            self.dictionary = dictionary
            targets = set(dictionary.values())
            self.missing = [x for x in self.missing if x not in dictionary and x not in targets]

    def translate(self, text):
        if not isinstance(text, str) or not self.config.get('translation'):
            return text
        if text in self.dictionary:
            return self.dictionary[text]
        if 0 < len(text) <= 4096 and any(x.isalpha() for x in text) and text not in self.missing and text not in self.dictionary.values():
            self.missing.append(text)
            self.missing = self.missing[-5000:]
        return text

    @staticmethod
    def scalar(value):
        return type(value) in (bool, int, float, str) and (not isinstance(value, str) or len(value) <= 4096) and (not isinstance(value, (int, float)) or (math.isfinite(value) and abs(value) <= 10**12))

    def reset(self, *args):
        self.locks.clear()
        self.session = uuid.uuid4().hex
        self.ack = None
        self.error = None

    def tick(self, store, ready=True):
        if time.time() - self.last < .25:
            return
        self.last = time.time()
        try:
            self.reload()
            self.write('missing.json', self.missing)
            if not self.config.get('cheats'):
                return
            variables = dict((key, value) for key, value in vars(store).items() if not key.startswith('_') and key not in self.RESERVED and self.scalar(value))
            variables = dict(sorted(variables.items())[:10000])
            changed = False
            for key, value in list(self.locks.items()):
                if not ready or key not in variables or type(variables[key]) is not type(value):
                    del self.locks[key]
                else:
                    changed = changed or variables[key] != value
                    setattr(store, key, value)
                    variables[key] = value
            command_path = self.path('command.json')
            if os.path.exists(command_path):
                command = self.read('command.json')
                identifier = command.get('id')
                if identifier != self.ack and command.get('session') == self.session and command.get('identity') == self.config.get('identity') and time.time() <= command.get('expires', 0) <= time.time() + 10:
                    self.ack = identifier
                    self.error = None
                    try:
                        if not ready:
                            raise ValueError('请先进入游戏')
                        action, key, value = command.get('action'), command.get('key'), command.get('value')
                        if action == 'reset':
                            self.locks.clear()
                        elif key not in variables:
                            raise ValueError('变量不存在或不是简单值')
                        elif action == 'unlock':
                            self.locks.pop(key, None)
                        elif action in ('set', 'lock'):
                            if type(variables[key]) is float and type(value) in (int, float):
                                value = float(value)
                            if not self.scalar(value) or type(value) is not type(variables[key]):
                                raise ValueError('目标值的类型与原变量不一致')
                            setattr(store, key, value)
                            variables[key] = value
                            changed = True
                            if action == 'lock':
                                self.locks[key] = value
                            else:
                                self.locks.pop(key, None)
                        else:
                            raise ValueError('不支持的操作')
                    except Exception as exception:
                        self.error = str(exception)
            if changed and self.after_edit:
                self.after_edit()
            self.write('state.json', dict(identity=self.config['identity'], session=self.session, updated=time.time(), ready=ready,
                variables=[dict(key=k, name=k, value=v, locked=k in self.locks) for k, v in sorted(variables.items())], ack=self.ack, error=self.error))
        except Exception as exception:
            self.error = str(exception)


def install(renpy):
    directory = os.path.join(renpy.config.gamedir, '.tsumigeya-assist')
    with open(os.path.join(directory, 'config.json'), 'rb') as stream:
        runtime = Runtime(directory, json.loads(stream.read().decode('utf-8')))
    def after_edit():
        # 交互中外部写入的变量也要在本句存档后保留，不能被读档的语句回滚撤销。
        renpy.retain_after_load()
        renpy.restart_interaction()
    runtime.after_edit = after_edit
    original_text = renpy.config.replace_text
    def replace(text):
        return runtime.translate(original_text(text) if original_text else text)
    renpy.config.replace_text = replace
    def periodic():
        runtime.tick(renpy.store, ready=not renpy.store.main_menu)
    # 添加回调而不是取代游戏原有回调，所有状态留在模块中，不进入存档。
    renpy.config.periodic_callbacks.append(periodic)
    renpy.config.after_load_callbacks.append(runtime.reset)
    renpy.config.start_callbacks.append(runtime.reset)
    return runtime
