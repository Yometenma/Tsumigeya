#!/usr/bin/env python3
"""清理 Swift 源码里的「历史流水账」注释。

===== 清理什么（判据）=====

**历史型**（删）—— 注释块里出现这些词：
  本鱼 / 第一版 / 原来 / 之前是 / 踩到 / 踩过 / 实测发现 / 用户 2026 /
  用户截图 / 用户反馈 / 历史 / 曾经 / 早期 / 改回 / 退回 / 犯了这个错

**设计型**（留）—— 解释「为什么现在是这样」：
  为什么 / 因为 / 否则 / 必须 / 不能 / 注意 / 判据 / 保证 / 契约 / 边界

**混合块**（保留设计部分，删掉历史部分）—— 这是最常见的形态：
一个注释块里前半段讲「当年踩了什么坑」，后半段讲「所以现在必须怎么做」。

===== ⚠️ 这个脚本的保守原则 =====

**只删「整块都是历史」的注释块**。混合块**原样保留** ——
因为拆块是件有风险的事（可能拆掉关键上下文），
而混合块本身读起来是通顺的（历史 + 结论）。

混合块的进一步清理留给人工（或者干脆不清理 —— 它有信息量）。

===== 用法 =====

    python3 clean-comments.py --dry-run   # 只看会删什么
    python3 clean-comments.py --apply     # 真删
"""
import os
import re
import sys

# ---- 历史型标记（出现任意一个就算历史）----
HISTORY_MARKERS = [
    '本鱼', '第一版', '原来', '之前', '踩到', '踩过',
    '实测发现', '实测踩', '用户 2026', '用户截图', '用户反馈',
    '历史', '曾经', '早期', '改回', '退回', '犯了这个',
    '第一次跑', '一开始', '本来的', '最初的',
]

# ---- 设计型标记（出现任意一个就算设计说明）----
DESIGN_MARKERS = [
    '为什么', '因为', '否则', '必须', '不能', '千万',
    '注意', '判据', '保证', '契约', '边界', '理由',
    '否则会', '不然', '取决于', '依据', '原则',
]

# ---- 永远不碰的文件/区块 ----
# 文件头的模块说明（有分节标题的）保留 —— 那是导航
PROTECTED_PATTERN = re.compile(r'^// ={3,}')


def find_blocks(lines):
    """找所有连续的 `//` 注释块，返回 [(start, end_exclusive, indent)]。"""
    blocks = []
    i = 0
    while i < len(lines):
        s = lines[i].lstrip()
        if s.startswith('//'):
            indent = len(lines[i]) - len(lines[i].lstrip())
            start = i
            j = i
            while j < len(lines) and lines[j].lstrip().startswith('//'):
                j += 1
            blocks.append((start, j, indent))
            i = j
        else:
            i += 1
    return blocks


def classify(block_text):
    """分类一个注释块：'history' / 'design' / 'mixed' / 'other'。"""
    has_hist = any(m in block_text for m in HISTORY_MARKERS)
    has_design = any(m in block_text for m in DESIGN_MARKERS)
    if has_hist and has_design:
        return 'mixed'
    if has_hist:
        return 'history'
    if has_design:
        return 'design'
    return 'other'


def is_protected(block_lines):
    """文件头的分节标题、`/// 文档注释` 的 @param 段等不删。"""
    for line in block_lines:
        s = line.strip()
        if PROTECTED_PATTERN.match(s):
            return True
        # Swift 文档注释的关键字段（参数/返回值说明）保留
        if s.startswith('/// - ') or s.startswith('/// - Parameter') \
                or s.startswith('/// - Returns'):
            return True
    return False


def process_file(path, dry_run):
    """处理一个文件，返回 (删除行数, 删除块数)。"""
    with open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')

    blocks = find_blocks(lines)
    to_delete = []   # [(start, end)]

    for start, end, _indent in blocks:
        block_lines = lines[start:end]
        if is_protected(block_lines):
            continue
        text = ' '.join(x.strip() for x in block_lines)
        kind = classify(text)
        # ⚠️ **只删整块都是历史的**
        if kind == 'history':
            to_delete.append((start, end))

    if not to_delete:
        return 0, 0

    if dry_run:
        return sum(e - s for s, e in to_delete), len(to_delete)

    # 从后往前删（避免索引偏移）
    for start, end in sorted(to_delete, reverse=True):
        del lines[start:end]

    # 清理因删除产生的「连续空行」（最多留 1 个）
    cleaned = []
    blank_run = 0
    for line in lines:
        if line.strip() == '':
            blank_run += 1
            if blank_run > 1:
                continue
        else:
            blank_run = 0
        cleaned.append(line)

    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(cleaned))

    return sum(e - s for s, e in to_delete), len(to_delete)


def main():
    dry_run = '--apply' not in sys.argv

    # ⚠️ **必须找对 root**：脚本可能在仓库根跑（`mac-native/Sources`），
    #    也可能在 `mac-native/` 里跑（`Sources`）。
    #    本鱼第一版那个 `os.isdir` 是笔误 → 永远走 else 分支 →
    #    在 mac-native 里跑时找 `mac-native/Sources`（不存在）→ 0 文件。
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'Sources'),
        'mac-native/Sources',
        'Sources',
    ]
    root = None
    for c in candidates:
        c = os.path.abspath(c)
        if os.path.isdir(c):
            root = c
            break

    if root is None:
        print('❌ 找不到 Sources 目录（试过：%s）' % candidates, file=sys.stderr)
        sys.exit(1)

    print('扫描: %s' % root)

    total_lines = 0
    total_blocks = 0
    files_changed = 0

    for dirpath, _, names in os.walk(root):
        for name in sorted(names):
            if not name.endswith('.swift'):
                continue
            path = os.path.join(dirpath, name)
            removed, blocks = process_file(path, dry_run)
            if removed:
                files_changed += 1
                total_lines += removed
                total_blocks += blocks
                rel = os.path.relpath(path, root)
                print(f'  {rel}: -{removed} 行 ({blocks} 块)')

    print()
    mode = '【预览】' if dry_run else '【已应用】'
    print(f'{mode} 涉及 {files_changed} 个文件，'
          f'删除 {total_blocks} 个注释块 / {total_lines} 行')


if __name__ == '__main__':
    main()
