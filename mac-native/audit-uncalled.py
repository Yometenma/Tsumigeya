#!/usr/bin/env python3
"""审计：找出「定义了但没人调用」的 public 函数/方法。

===== 为什么需要这个脚本 =====

本鱼在 Swift 版已经**犯了两次同一类错误**：

  ① `refreshRunning()` —— 定义正确，只在 load() 里调过一次，**没有轮询**
     → 用户报「关掉游戏还显示运行中」
  ② `loadSettings()` —— 定义正确，只在设置页里调过
     → 用户报「设了列表视图但重开是卡片」

两次都是：**函数写对了，调用点漏了**。编译器、类型检查、所有纯函数单测
**全部不会发现** —— 因为「函数存在」不等于「函数被调用」。

本脚本用机械化的方式找这类问题：对每个 `public/public static` 定义，
统计它在**所有 swift 文件**（含 Tests）里被**调用**的次数（排除定义行本身）。
计数为 0 或 1（只有定义）的列出来人工判断。

用法（在 mac-native/ 目录下）：
    python3 ../../scripts/audit-uncalled.py
或直接：
    python3 audit-uncalled.py
"""
import os
import re
import sys
from collections import defaultdict

# ---- 找 mac-native 根目录 ----
here = os.path.dirname(os.path.abspath(__file__))
root = here
while root and not os.path.isdir(os.path.join(root, "Sources/TsumigeyaCore")):
    parent = os.path.dirname(root)
    if parent == root:
        print("找不到 mac-native 根目录", file=sys.stderr)
        sys.exit(1)
    root = parent

# ---- 收集所有 swift 文件 ----
files = []
for sub in ("Sources", "Tests"):
    base = os.path.join(root, sub)
    if not os.path.isdir(base):
        continue
    for dirpath, _, names in os.walk(base):
        for n in names:
            if n.endswith(".swift"):
                files.append(os.path.join(dirpath, n))

print(f"扫描 {len(files)} 个 swift 文件")

# ---- 读全部内容（用于调用次数统计）----
all_text = {}
for f in files:
    try:
        all_text[f] = open(f, encoding="utf-8").read()
    except Exception:
        all_text[f] = ""

# ---- 找 public 定义 ----
# 匹配 `public [static] func name(`，以及 public enum/struct 里的方法
def_re = re.compile(
    r"^\s*(?:public\s+)?(?:static\s+)?(?:private\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)",
    re.MULTILINE)
public_func_re = re.compile(
    r"^\s*(?:public\s+static|public)\s+func\s+([A-Za-z_][A-Za-z0-9_]*)",
    re.MULTILINE)

definitions = []   # (file, name)
for f, text in all_text.items():
    if "/Tests/" in f:
        continue
    for m in public_func_re.finditer(text):
        definitions.append((f, m.group(1)))

# 统计每个名字的调用次数（排除定义行）
counts = defaultdict(int)
sites = defaultdict(list)
for name in set(n for _, n in definitions):
    # 调用形态：`name(` 或 `.name(`
    pattern = re.compile(r"[^a-zA-Z0-9_]" + re.escape(name) + r"\s*\(")
    total = 0
    where = []
    for f, text in all_text.items():
        for m in pattern.finditer(text):
            # 排除定义行（`func name(`）
            lookback = text[max(0, m.start() - 20):m.start()]
            if "func " in lookback and "func " in text[max(0, m.start()-8):m.start()]:
                continue
            # 粗略排除注释行
            line_start = text.rfind("\n", 0, m.start()) + 1
            line = text[line_start:text.find("\n", m.start()) if "\n" in text[m.start():] else len(text)]
            stripped = line.strip()
            if stripped.startswith("//") or stripped.startswith("///") or stripped.startswith("*"):
                continue
            total += 1
            where.append((f, line.strip()[:100]))
    counts[name] = total
    sites[name] = where

# ---- 输出：按调用次数排序，最少的最可疑 ----
by_name = defaultdict(list)
for f, n in definitions:
    by_name[n].append(f)

DSU = {"debugDescription", "description", "encode", "decode", "init", "hash",
       "==", "body", "id", "title", "message", "label", "value", "rawValue"}

print("\n" + "=" * 78)
print("疑似「定义了但没人调用」的 public 函数（调用点 <= 1）")
print("=" * 78)

suspects = []
for name in sorted(by_name, key=lambda n: (counts.get(n, 0), n)):
    if name in DSU:
        continue
    c = counts.get(name, 0)
    if c <= 1:
        suspects.append((c, name, by_name[name]))

for c, name, defs in suspects:
    rel = os.path.relpath(defs[0], root)
    print(f"\n[{c} 处调用] {name}")
    print(f"   定义于: {rel}")
    if c >= 1:
        f, line = sites[name][0]
        print(f"   唯一调用: {os.path.relpath(f, root)}")
        print(f"             {line}")

print("\n" + "=" * 78)
print(f"共 {len(suspects)} 个可疑（总 public 函数 {len(by_name)} 个）")
print("=" * 78)
print("\n⚠️ 注意：这不等于「全是 bug」——")
print("   · 被 App target 跨模块调用的会显示 0（因为 App 只用点语法，脚本能抓到）")
print("   · 测试专用的（fixture/helper）本来就只被测试调")
print("   · 但「库里的 public API 却 0 调用」值得逐个看一遍")
