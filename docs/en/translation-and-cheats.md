# Translation and Cheats

**English** · [简体中文](../翻译与作弊.md) · [日本語](../ja/translation-and-cheats.md)

> Tsumigeya's interface supports Simplified Chinese, English and Japanese (Settings → Language) and follows the system language by default. This guide quotes interface labels in Simplified Chinese — the source language — with the English name on first mention; if you run the English interface, the same labels appear in English.

These features live in two separate tabs of a game's detail view, Translation (「翻译」) and Assist (「辅助」). **Launching, translating, and cheating are three different capabilities**: the Engine Management (「引擎管理」) tab lists each one separately. Being able to launch an engine does not mean its text and game state are wired up.

## Built-in assist modules

Assist is built in as four engine-specific module groups: MV/MZ, XP/VX/VX Ace, Ren'Py, and Tyrano. The modules ship with the app and need no extra download; this is not external plugin loading or a plugin store.

- Each module owns its own game detection, text extraction, assist script, and operating notes; the AI endpoint, translation directory, backup verification, and task management are shared.
- Translation and cheats declare their support scope separately and are enabled independently; the runtime capability view and the game detail view read the same module declarations, so launch support is never misreported as translation or cheat support.
- This module consolidation keeps existing game identities, config formats, manual translations, and assist install records, so there is no need to re-enter the endpoint or rebuild the translation directory. Adding modules or capabilities later does not by itself widen compatibility for other engines.

## Engine scope

| Game type | Translation support | Cheat entry point and scope |
|---|---|---|
| RPG Maker MV / MZ | Database and event text extraction, replace-at-display and miss capture | In-game Game Assist (「游戏辅助」) / `⇧F8`; money, items, actors, variables and switches, lock, value filtering, speed / noclip / encounters, map, event, and battle controls |
| RPG Maker XP / VX / VX Ace (mkxp-z) | Keeps the existing compatibility preload and adds a separate assist; the database and map events are extracted after entering the game once, then replaced at display time | Launcher detail view; money, items / weapons / armor, party actor HP / MP / level, numeric variables and switches, lock and value filtering |
| Ren'Py | Reads dialogue lines and text choices from visible source; replaces at display time and captures dynamic content | Launcher detail view; the game's public simple numeric, boolean, and short-text variables, with lock and value filtering; complex objects and engine control fields are not edited |
| TyranoScript / TyranoBuilder | `.ks` dialogue extraction, replace-at-display for text and text-choice tags, dynamic content capture | In-game Game Assist (「游戏辅助」) / `⇧F8`; simple values in `f` game variables and `sf` system variables, lock and value filtering |
| Other engines | Not supported | Not supported; an engine never appears as cheat-capable just because launching is supported |

**Verification scope**: real game copies have been verified for MV/MZ and VX Ace; XP uses the official free sample 《KNight-Blade》 and VX uses the free original 《魔女之家》1.09a, covering the XP menu and dialogue, VX menu display, and money / item / actor / variable and switch editing, locking, and runtime extraction on both. Ren'Py uses a self-built sample on the 8.5.2 SDK. Beyond the self-built sample on the official Tyrano V5, Tyrano was also checked against the original script of the free work 《放課後ネットミームカルタ》 for dialogue and choice translations and simple variable editing, but its Electron download package was only tested after an isolated copy was switched to an NW.js host, which **does not mean the Electron original package can launch directly**. The translation-display acceptance above used a prebuilt dictionary and does not mean the user's paid AI service was called. All of these tests cover the corresponding samples only and are not a compatibility promise for every work.

**Known limits**: 《Star Stealing Prince》3.2 hits an old script syntax error on the current mkxp-z / Ruby that still reproduces after the assist is removed, and the game cannot yet be entered normally. Ren'Py 7 / Python 2, other self-modified engines, and special plugins carry no general compatibility guarantee. Tyrano's Electron / ASAR packaging has no automatic conversion support, and the current integration targets folders that open directly with NW.js.

## Translation

- Accepts a JSON object mapping source text to translated text, including MTool translations in that shape; nested formats, comments, and mismatched control characters are rejected, and the format is never guessed.
- Extract Game Text (「提取游戏文本」) picks the extraction method per engine. MV/MZ reads the database and events; RGSS needs the assist applied and one launch through the launcher before you come back and extract. The Ren'Py source parser deliberately skips Python, the interface, and multi-line code blocks; archives and complex syntax fall back to runtime capture. Tyrano skips script and HTML tag blocks; text choices can be captured at runtime.
- Automatic translation requires a **full endpoint URL** compatible with chat completion requests, a model, and a target language; any AI service of your choice can be used. Remote endpoints must be HTTPS, while local endpoints may use HTTP. The key is stored in the macOS Keychain and never written into the game folder. Game text is sent to the service you enter and may incur charges.
- Pause and resume, retry only failed items, search, and revise by hand. Progress is saved item by item; successful translations are not requested again, and re-extraction does not overwrite existing revisions. Game control characters and placeholders must be preserved, including Ren'Py interpolation and text tags.
- Live in-game translation (「跟随游戏补译」) handles the missed text captured while the game displays it and updates the local cache; the launcher must stay open for it. After pausing or quitting, the game keeps showing existing translations or the source text. Existing screens usually update on the next redraw.
- RGSS per-character dialogue is translated before the text is split into glyphs; measuring and drawing Chinese, Japanese, and their punctuation use a consistent font. While translation is on, the Arial Unicode font bundled with macOS is cached into `assist-fonts/` in the launcher data directory and loaded as an extra asset path; it is not written into the game folder and not distributed with the app, and the path is no longer appended once translation is off. A damaged cache or an unsafe link stops the launch instead of overwriting the suspicious file.
- At runtime Tyrano neither translates nor captures text inside `iscript` / HTML blocks, so program code is not mistaken for dialogue.
- Text in images, hand-drawn glyphs, dynamically assembled strings, and some plugin text are not guaranteed to be fully covered. A miss keeps the source text, and a translation failure never blocks the game.

Translation files live at `translations/<game-identity>.json` under the data root, and the endpoint config is `translation-service.json`. The identity is validated against both the canonical folder and engine-specific feature data: MV/MZ uses the entry point and system data, RGSS uses script data or the matching version archive, Ren'Py uses the scenario / archive (excluding caches, saves, and the assist entry point), and Tyrano uses engine and scene features. After a game is moved or its feature files change, an old cache is never applied by Game Library number alone.

## Cheats

**Back up your saves first.** Edits can change the story and are written into the save data; turning the assist off or removing it does not undo money, items, actor stats, or story state that were already changed. `sf` holds system variables shared across saves, so the effects of an edit may cross saves too.

- MV/MZ, Tyrano: click Game Assist (「游戏辅助」) in the top-right corner of the game or press `⇧F8`. The panel blocks input from reaching the game, and edits need confirmation.
- RGSS, Ren'Py: after applying the assist, launch the game through the launcher, then go back to Cheat Tools (「作弊工具」) on the detail view. Plain input fields edit numbers or text and toggles edit booleans; confirming sends the change to the game and shows the game's receipt. Editing is unavailable once the connection expires or while the game is still on the title screen.
- Value search supports known and unknown initial values, plus pass-by-pass filtering for increased, decreased, changed, and unchanged; it compares the snapshot taken at each search rather than scanning the whole process memory. The list shows at most the first 100 entries and can be searched by name, key, or value.
- Edit and lock maintains the target value periodically; a plain edit clears that item's old lock. Items can be unlocked one by one or unlocked all at once. A new game or a loaded save clears old locks and searches, and never forces the previous run's locks onto the new state.
- RGSS only operates on exposed state; items, money, and actor levels follow the engine scope, and HP / MP stay within the current maximum. Ren'Py does not execute arbitrary Python and Tyrano does not execute arbitrary JavaScript; only simple values and restricted paths are wired up.
- MV/MZ map transfer, event execution, and battle actions check the current scene and busy state and ask for extra confirmation; custom plugins can still affect behavior. Other engines never show MV/MZ-only tools that are not implemented for them.

## Apply and remove

Translation and cheats are enabled independently. After quitting the game, click Apply to Game (「应用到游戏」); the original database or scenario is not replaced. After revising translations you can apply again; live in-game translation updates the runtime dictionary automatically.

- **MV/MZ, Tyrano**: a separate script is loaded at the end of the entry page; assist files and the backup of the original entry point sit in `.tsumigeya-assist/` next to the entry. Removal verifies and restores the page byte for byte.
- **RGSS**: only `.tsumigeya-assist/` is added to the game folder; the launch plan appends the assist after the existing preload without touching `Scripts` / game archives, and the game must be launched from this launcher. After removal the next launch no longer appends the assist.
- **Ren'Py**: a separate `zz_tsumigeya_assist.rpy` and `.tsumigeya-assist/` are added under `game/`, leaving the original scenario intact. Assist state stays in its own module, and initialization locals are not added to the game's save data. Removal also cleans up this tool's entry point and compiled files.

Before applying, the game identity, the scripts it owns, and the original entry point are checked; external tampering, same-name files, unknown files, or unsafe symlinks stop the overwrite or cleanup. Installing, updating, or restoring is unavailable while the game runs; removal keeps the launcher's translation directory. Native state commands carry the current game identity, the running session, and a short lifetime, so expired commands and commands issued before a save load are not written into the new session.

The game keeps running without the launcher being alive; but once the launcher is closed, the RGSS / Ren'Py state editing view and live in-game translation for every engine stop, while the game keeps the assist already loaded and the dictionary it has.

## Offline assistance

Reads and writes the game's own files instead of injecting into its runtime. A `.tsumigeya-bak` backup is written alongside first; an existing backup is never overwritten.

- **NScripter**: reads `0.txt` / `00.txt` / `nscript.dat` (the last is XOR 0x84 per byte) and replaces only lines that start with a quote character; commands, comments, and `*label` lines are untouched, and each line keeps its original line ending. Output reuses the original encoding; when it cannot hold Chinese the file falls back to UTF-8 and reports it, and the game's `--enc` argument must be changed to match.
- **RPG Maker MZ**: `save/*.rmmzsave` is `LZString.compressToBase64(JsonEx.stringify(...))`. The 8-character `JsonEx` hash prefix is preserved and only scalars inside the JSON are changed; a replacement of the wrong type is refused.
- **RPG Maker XP / VX / VX Ace**: `.rvdata2` / `.rxdata` is Ruby Marshal. Rather than re-serializing (which would expand shared references into duplicates), only the byte range of each scalar is rewritten in place and every other byte, including all `@n` references, is left alone. Only numbers, booleans, and strings can be changed.
- **RPG Maker 2000 / 2003**: `RPG_RT.ldb` is an LCF container. Names and descriptions of actors, skills, items, enemies, terrains, states, common events, switches, and variables can be extracted. **Read-only**: writing back would require rebuilding the whole chunk tree and recomputing every length.

Validation scope: NScripter covers plaintext, encrypted, and three encodings; MZ and RGSS are only verified against generated samples, **with no real game saves**. EasyRPG `.lsd` saves and KiriKiri `.xp3` are not implemented.

## CLI acceptance

```bash
swift run tsumigeya-cli assist inspect <game-dir>
swift run tsumigeya-cli assist extract <game-dir>
swift run tsumigeya-cli assist install <game-dir> --translation --cheats
swift run tsumigeya-cli assist state <RGSS-or-RenPy-dir>
swift run tsumigeya-cli assist command <RGSS-or-RenPy-dir> set <var-key> <json-value>
swift run tsumigeya-cli assist restore <game-dir>
swift run tsumigeya-cli offline script-inspect <game-dir>
swift run tsumigeya-cli offline script-apply <game-dir> <dictionary.json>
swift run tsumigeya-cli offline save-inspect <save-path>
swift run tsumigeya-cli offline save-set <save-path> party._gold 4200
swift run tsumigeya-cli offline ldb-inspect <RPG_RT.ldb>
node --test Tests/TsumigeyaTests/Assist/runtime.test.cjs
python3 Tests/TsumigeyaTests/Assist/renpy_runtime_test.py
ruby Tests/TsumigeyaTests/Assist/rgss_runtime_test.rb
```

The first `assist install` uses an empty dictionary, and repeated installs keep existing translations; use the interface for actual import, translation, and applying translations. `assist command` returns a send number and does not mean the edit already succeeded; check `ack` and `error` with `state`. Run acceptance against a separate game copy and data directory, and never validate destructive operations against personal saves.
