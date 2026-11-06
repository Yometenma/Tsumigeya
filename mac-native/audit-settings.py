#!/usr/bin/env python3
"""审计：找「用户能改但没人读」的设置项。

v1 只匹配 `.listView` 点语法，漏掉了真正的消费点
    if store.settingBool(.listView) { ... }
因为 .listView 是作为**参数**传的 —— 假阴性。
假阴性比假阳性危险：它给你「查过了没问题」的错觉。

v2 判据：按「谁在消费」分类（UI / 逻辑 / 启动链），
没有逻辑消费的项就是没生效。
"""
import os
import re
import sys

here = os.path.dirname(os.path.abspath(__file__))
root = here
while root and not os.path.isdir(os.path.join(root, "Sources/TsumigeyaCore")):
    parent = os.path.dirname(root)
    if parent == root:
        print("找不到 mac-native 根目录", file=sys.stderr)
        sys.exit(1)
    root = parent

APP = os.path.join(root, "Sources", "TsumigeyaApp")
CORE = os.path.join(root, "Sources", "TsumigeyaCore")


def read_all(base):
    out = {}
    for dirpath, _, names in os.walk(base):
        for n in names:
            if n.endswith(".swift"):
                p = os.path.join(dirpath, n)
                try:
                    out[p] = open(p, encoding="utf-8").read()
                except Exception:
                    out[p] = ""
    return out


app_files = read_all(APP)
core_files = read_all(CORE)

groups_src = open(os.path.join(CORE, "SettingsGroups.swift"), encoding="utf-8").read()
m = re.search(r"public enum Key: String, CaseIterable, Sendable \{(.*?)\}", groups_src, re.S)
keys = re.findall(r"case ([a-zA-Z_][a-zA-Z0-9_]*)", m.group(1))
print("设置项 {} 个\n".format(len(keys)))


def hits(key, text_map):
    out = []
    pat = re.compile(r"\." + re.escape(key) + r"\b")
    for path, text in text_map.items():
        name = os.path.basename(path)
        if name == "SettingsGroups.swift":
            continue
        for line_no, line in enumerate(text.split("\n"), 1):
            s = line.strip()
            if s.startswith("//") or s.startswith("///") or s.startswith("*"):
                continue
            if pat.search(line):
                out.append((name, line_no, s))
    return out


def load_body(appstore):
    lines = appstore.split("\n")
    start = -1
    for i, l in enumerate(lines):
        if "func load() async" in l:
            start = i
            break
    if start < 0:
        return ""
    body = []
    for i in range(start + 1, len(lines)):
        if "// MARK:" in lines[i] or lines[i].startswith("    func "):
            break
        body.append(lines[i])
    return "\n".join(body)


appstore_src = ""
for p, t in app_files.items():
    if os.path.basename(p) == "AppStore.swift":
        appstore_src = t
LOAD_BODY = load_body(appstore_src)

print("=" * 104)
print("{:<26} {:<4} {:<6} {:<8} {}".format("设置项", "UI", "逻辑", "启动链", "判定"))
print("=" * 104)

report = []
for key in keys:
    ui, logic, startup = [], [], []

    for name, ln, line in hits(key, app_files):
        if name == "SettingsPage.swift":
            ui.append((name, ln, line))
        elif name == "AppStore.swift":
            if ("applySettingSideEffect" in line or "case ." in line
                    or "settingString(" in line or "settingBool(" in line):
                logic.append((name, ln, line))
            else:
                ui.append((name, ln, line))
        else:
            logic.append((name, ln, line))

    for name, ln, line in hits(key, core_files):
        logic.append((name, ln, line))

    if ("." + key) in LOAD_BODY or "loadSettings()" in LOAD_BODY:
        startup.append(("load", 0, ""))

    if len(logic) == 0:
        verdict = "X 无逻辑消费（改了不生效）"
    elif len(logic) <= 1:
        verdict = "? 仅 1 处消费"
    else:
        verdict = "OK"

    print("{:<26} {:<4} {:<6} {:<8} {}".format(
        key, len(ui), len(logic), len(startup), verdict))
    report.append((key, ui, logic, startup, verdict))

print("\n" + "=" * 104)
print("无逻辑消费的项")
print("=" * 104)
bad = [r for r in report if r[4].startswith("X")]
if not bad:
    print("（没有）")
for key, ui, logic, startup, verdict in bad:
    print("\n### " + key)
    for name, ln, line in ui[:2]:
        print("   UI  {}:{}  {}".format(name, ln, line[:95]))
    if not ui:
        print("   （界面里也没有？）")

print("\n共 {} 个无消费 / 总 {} 个".format(len(bad), len(keys)))
