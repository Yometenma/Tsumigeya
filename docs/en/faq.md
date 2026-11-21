# Frequently Asked Questions

**English** · [简体中文](../常见问题.md) · [日本語](../ja/faq.md)

[Back to project home](../../README.md) · [Download the latest release](https://github.com/Yometenma/Tsumigeya/releases/latest) · [Report an issue](https://github.com/Yometenma/Tsumigeya/issues/new/choose)

> Tsumigeya's interface is currently available in Simplified Chinese only. Interface labels are quoted exactly as shown in the app, in 「」, with an English name on first mention.

## Installation and updates

### Which Macs are supported?

The current installer requires **macOS 26 or later and Apple Silicon**. No Intel installer is provided, and there is no native Windows or Linux version.

<a id="first-launch"></a>

### What should I do if the first launch says the developer cannot be verified, or that the app is damaged?

First confirm the installer came from this repository's Releases and not from an unattributed mirror. The current app is only ad-hoc signed; it has no Developer ID distribution signature and has not been notarized by Apple, so Gatekeeper may block it.

If you trust the source, you can run the following against the app you have already placed in Applications (「应用程序」):

```bash
xattr -dr com.apple.quarantine /Applications/Tsumigeya.app
```

This removes that app's download quarantine flag; it is not notarization and not proof that the app is safe. **Do not turn off the system-wide security protection.** If the prompt still appears, do not attribute every problem to the quarantine flag; download the installer again and check that the download is complete.

The `SHA256SUMS.txt` in the release assets records the installer checksums. In your download folder you can view the installer's SHA-256 and compare it item by item against that version's checksum file:

```bash
shasum -a 256 Tsumigeya-*.dmg
```

If the app is not installed in `/Applications`, the path in the command needs to be adjusted accordingly.

### How do I update? Will I lose my game library?

Quit Tsumigeya, download the new DMG, then replace the old app in Applications. App data is stored separately from the `.app`; the current version uses the following directory:

```text
~/Library/Application Support/Tsumigeya/
```

Backing up app data and real game saves before updating is still recommended. Migration notes for older versions are governed by the corresponding Release; do not delete the app data directory in order to "clean up an old version".

## Games and runtimes

### Can it run any Windows game?

It cannot guarantee any Windows game. Tsumigeya launches Windows `.exe` files it has confirmed through Wine, but drivers, anti-cheat, DRM, unusual graphics interfaces and extra dependencies can all make a program incompatible. Old records for Unity, RPG Developer Bakin and WOLF RPG Editor are read through Wine and are no longer listed separately as detection only (「仅识别」).

Detecting the engine does not mean compatibility is guaranteed. Plugins, script extensions, encryption methods and dependencies can all affect the result. For the exact scope, see [Compatibility](../../README.md#compatibility).

### How do I use Wine?

Install Wine (Windows compatible) (「Wine（Windows 兼容）」) on the Engine Management (「引擎管理」) page, then add the fully extracted game. For Windows games you can also choose an ordinary file such as a readme inside the folder in order to detect them; with only one EXE it is filled in automatically, and with several you need to confirm the actual launch file rather than an installer or uninstaller. Games that already have a dedicated macOS runtime still prefer their existing runtime.

In Edit Game (「编辑游戏」) you can adjust the Windows launch file, line-by-line launch arguments and the Chinese/Japanese/English locale; Engine Management → Windows environment settings… (「引擎管理 → Windows 环境设置…」) adjusts settings such as the Windows version, audio and DLLs. The first launch has to initialize the environment and takes longer than later launches. On Apple silicon Macs without Rosetta 2, it first asks you to confirm the Apple license and does not agree automatically.

Each game has its own Windows environment; stopping one game does not end games in other environments; uninstalling a runtime keeps the environments and their data. Saves may be inside the game folder or inside the environment; when the location cannot be detected automatically, specify it manually on the Saves (「存档」) page and do not delete the environment directory directly. Wine is not a security sandbox — only run programs from sources you trust. Missing Chinese glyphs or missing game-specific fonts may still require installing the appropriate fonts.

### Which file should I choose? Can I add a ZIP directly?

Extract the game fully to a stable location first, then in Add Game (「添加游戏」) choose any file inside the game folder; it does not have to be an executable, and an `.app` bundle also works. The app detects the engine from the folder structure; check the detected folder, and do not copy a single file on its own and lose the rest of the data.

If automatic detection is incorrect, confirm that the folder structure is complete and check the engine when adding. Do not move or rename the game folder before diagnosing.

### I have many games — can I add them in one go?

The Game Library (「游戏库」) top bar offers Bulk operations → Bulk Add (「批量操作 → 批量入库」): choose the collection folder, wait for the scan, then check the engine and title of each item and tick it. Before saving it re-checks folders and duplicates; if any selected item is invalid, the whole batch is not written. Missing dependencies are reported explicitly and still have to be installed on the runtime page after adding; Wine candidates require confirming the actual launch file.

The scan has three depth levels and caps of 2000 folders and 200 candidates; it does not scan ZIPs, does not follow subfolder symlinks, and does not descend into games it has already detected. When the cap is reported, scan in smaller folders. For games that cannot be detected, use single add and confirm the engine manually. It never requests or selects DLsite game info automatically.

### Do I need to remove and re-add a game after moving it?

No. Use Relocate Game Folder… (「重新定位游戏目录…」) in the detail view's more menu. Quit the game first, then choose the same game folder after the move; the detected engine must match, and you also have to confirm the work identity manually, because the same engine does not prove it is the same game. The original number, categories, metadata and play records are kept. A wrong folder, or one already linked to another record, is not saved.

This operation does not move files, and does not move or merge saves. If the original game kept its saves in a separate location, you still have to migrate and back them up according to the real save location.

### What does launch diagnostics do?

Check Launch Requirements (「检查启动条件」) in the detail view's More (「更多」) menu shows whether the game folder exists, whether the current engine supports launching, whether the runtime binary is found and executable, and which working directory and arguments this launch will use. It only checks and does not launch the game; for mkxp-z it also does not modify Game.ini, create a path alias or overwrite mkxp.json because of the diagnostics.

If the diagnostics say the folder does not exist, use Relocate Game Folder (「重新定位游戏目录」); if they say the runtime is missing or not executable, go to the Runtime (「运行时」) page to install or repair it. When the process is already running, the diagnostics only report that it cannot be launched again and do not stop the game for you.

### The runtime is installed, so why does launching still fail?

A completed runtime installation only means the dependencies are ready; it does not mean that a particular game is compatible. Check in this order:

1. Whether the game is fully extracted and the added path still exists.
2. Whether the engine was detected correctly and the matching runtime is installed.
3. Whether the engine arguments, runtime version and path in the detail view's Engine Management are reasonable.
4. Whether the same game is already running, and whether an initialization error or the game's own error window appeared.

When reporting, please provide the app version, OS version, chip, game version, engine and reproduction steps. A public RJ number or work page is enough; you do not need to upload the game itself.

### Can it be used offline?

Adding local games and managing the Game Library do not require signing in to DLsite first. Installed runtimes do not have to be downloaded again every time, but the work itself or its launch environment may still have network requirements.

Installing runtimes, fetching DLsite game info and loading network covers require access to the corresponding sites. When the network fails, check the proxy and the reachability of the target site; do not judge a failure to download dependencies as the game being incompatible.

## Translation and cheats

### Can every engine that can launch also be translated and cheated?

No. Assist (「辅助」) currently integrates with RPG Maker MV/MZ, XP/VX/VX Ace, Ren’Py and Tyrano, and the scope of operations differs per engine. The Runtime page lists launch, translation and cheat capabilities separately. They are built-in modules shipped with the app, require no separate plugin installation, and do not mean that every work on the same engine is compatible.

Tyrano currently targets folders that NW.js can open and does not directly support Electron／ASAR originals. Text drawn in images, custom-drawn text and special plugins are not guaranteed to be translatable; cheats for Ren’Py and Tyrano target simple variables, not arbitrary process memory editing. See [Translation and cheats](translation-and-cheats.md) for the full boundaries.

### Does automatic translation require my own AI endpoint?

Yes. On the game detail view's Translation and cheats (「翻译与作弊」) page, fill in the full endpoint URL, model and key of the AI service of your choice; remote services allow HTTPS only, and local services may use HTTP. Game text is sent to the configured service and may incur costs; the key is stored in the macOS Keychain and is not written into the game folder.

You can also import a JSON dictionary from source text to translated text, or revise it manually, without using online automatic translation. Loaded translations do not require the launcher to stay online; live in-game translation does require the launcher to stay open.

### Does removing Assist undo cheat changes?

No. Stat values, items and story state may already have been written into saves; removing only cleans up this tool's Assist entry points and files and does not restore game progress. Back up your saves first, and apply or remove Assist after quitting the game. Loading a save releases old locks and does not undo modifications that have already been saved.

## Game info and saves

### I cannot find the work, or it matches a same-name result — what now?

Click Find Work… (「查找作品…」) on the detail page to enter the work title, the RJ number, or paste a DLsite work link. Name search looks up adult and all-ages works together, with no manual scope selection; an RJ number locates its own section automatically, and a work link keeps the section it points to. When there really are no results, it tries cleaning up localization／version suffixes and underscores; the window shows the keywords it tried. When a Chinese title cannot be matched reliably to the original, use the Japanese original title, an English name or the work link — it never matches automatically on a guess.

Candidates show the cover, work title, circle and number; click Preview (「预览」) to check the details and then Confirm linking this work (「确认关联此作品」). The app never assumes the first entry is your game — main games, additional content and different versions still need checking. When fetching fails, the candidates and keywords are kept; when requests for some site sections fail, candidates already found in other categories are kept and this is reported explicitly. Network faults, verification pages and a genuine no-result are shown separately.

Game info supports the full description, release date, series, genre tags, language, production／voice credits, original supported systems and preview screenshots; missing items are not guessed. The language and supported systems shown on the page are original-version information and do not guarantee the language of a local localization patch or actual compatibility on Mac. Tags, circle, series, original work title and RJ number can all be used in Game Library search.

Fields in the title, circle, description and More game info (「更多作品信息」) can be edited manually, and manual edits are preserved when the same work is refreshed. To change works, use Change Linked Work… (「更换关联…」) on the detail page; it replaces only after a preview confirmation, manual fields from the old work do not leak into the new one, the library name and saves are unchanged, automatic categories follow the new work's type while manual category adjustments are kept. A failed refresh or re-link does not replace the existing info.

Requests are scheduled automatically at intervals of at least 800ms, and a pending wait／fetch can be cancelled; it never asks you to wait and retry manually because of ordinary repeated clicking. Covers and preview images are saved to a local cache after a successful download and read locally afterwards; images not downloaded the first time still need the network. A corrupt cache is fetched again, and failures can be retried; it never picks a random image from the game assets as a cover. Saved old info is not upgraded online automatically — click Refresh info (「刷新信息」) to fetch newly added fields.

### Are categories generated automatically? Will manual changes be overwritten?

Confirmed and saved work records are categorized automatically by game type; previews and genre tags do not create top-level categories. Missing or unrecognizable types are not guessed. Records that already exist are categorized the next time the Game Library loads, without re-fetching.

Ticks and removals in Edit Game → Categories (「编辑游戏 → 分类」) are saved immediately and are not overwritten by an info refresh or a work change; existing assignments in an old library are also kept as manual choices. Type changes update only the automatic part and do not clear your custom assignments. To follow the work type completely again, use Restore Auto Categories (「恢复自动分类」) and confirm; this clears all manual category adjustments for that game.

Work-type categories can be renamed; the source and assignments are unchanged. Deleting such a category does not bring it back on refresh; creating a new default type category with the same name (for example Role-playing (「角色扮演」)) re-enables it. Restoring auto categories for a single game does not undo a global deletion.

### Removing from the Game Library says only part of the cleanup was completed — what now?

Before removing, check the Game Library, work records and play records, then clean up in order. Multiple files are not a single transaction: if it fails partway, the message lists the cleanup scope already saved, and the library record is kept so you can retry. Deal with the corrupt file, backup or permission problem named in the message and remove again; cleanup that has already completed does not release the number to a new game. This operation does not delete the game folder or saves.

### Can I get Chinese info first? What about games that are not on DLsite?

The development source adds Settings → Game Info (「设置 → 作品信息」), where you can set a preferred and fallback language for info; it does not rewrite old info automatically. The product page language and the game's supported languages are different things, so fields the site has not translated may still be in the original text; a translated edition under a different RJ is not re-linked automatically.

The find window adds Other games · AI／Manual (「其他游戏 · AI／手动」): you can provide a public official site or store page for the AI to organize, or use a separate Tavily／SearXNG／custom search, or a Responses endpoint that supports `web_search` to look up candidates by name, then choose a page to generate a preview. An ordinary chat model can be paired with separate search; without an endpoint you can fill everything in manually. Info is previewed first and saved after choosing fields; keys are stored separately in the Keychain, RJ numbers are never fabricated, and game files are never uploaded automatically. This feature has not yet shipped with a new installer; see [Game info retrieval](game-info.md) for configuration, costs and compatibility limits.

### How do I bulk-fill game info?

Bulk Fill Game Info (「批量补全作品信息」) in the Game Library sidebar's right-hand menu prepares the games within the current search and category filter. By default it processes only games with no linked work, and you can also choose to fill in and refresh existing info. You can check the list before starting.

A unique RJ number is fetched and saved directly; when several numbers are detected, or when name search finds candidates, the item stops at Pending confirmation (「待确认」) and you link each one after previewing it with Find and confirm (「查找并确认」), never auto-selecting the first entry. Refreshing an existing work keeps manual edits and does not change the library game name or saves; categories update by work type, and manually added or removed assignments are kept.

Items are processed one by one, and a failure does not block later items; Retry failed items (「重试失败项」) re-processes only the failed items and does not re-refresh items that succeeded; items not yet started are handled with Continue filling (「继续补全」). Pausing or closing the fill window cancels the current request and keeps saved items; reopening it while this run of the app lasts continues the unfinished items. The task list is not kept after you quit the app, and opening it again prepares the list anew — saved game info is not lost. Prepare list again (「重新准备列表」) regenerates the list for the current filter and does not undo saved info.

### Where are the saves? What is the difference between "location unknown" and "empty saves"?

See the Saves (「存档」) page in the game detail view. The location depends on the game and the engine and is not necessarily inside Tsumigeya's app data directory.

- **Location unknown** (「位置未知」): the app cannot yet determine this game's save folder. TyranoScript and KiriKiri do not guess paths automatically.
- **Folder empty or no saves yet**: the app has determined the location but found no saves to show.

If you know the actual location, click Choose Save Folder… (「选择存档目录…」) to specify it manually. This operation only records the folder and does not move or merge files; the folder may be empty. A folder that has been moved or deleted still shows as unknown and is not disguised as empty saves; click Show in Finder (「在访达中显示」) to open the current folder, and the copy button copies the full path; click Restore Auto Detection (「恢复自动探测」) to clear the manual choice. The folder cannot be changed while the game is running.

### How do I back up or migrate? Is cloud sync supported?

Quit the game first, then export a ZIP from the Saves page. In the target environment, add the corresponding game, confirm the save location, and restore with the import function.

The export contains the entire save folder, not only the common save slots; the import validates the content first and then backs up existing files. Import backups usually end in `.tsumigeya-bak`, and an existing backup with the same name is not overwritten; if the import fails because of that, check the backup and keep it safe first, and do not delete it directly.

There is currently **no cloud sync**; you keep the exported ZIP yourself. When migrating the Game Library you should also copy the app data directory and the game itself separately; app data, games and saves are three different things.

### Can I paste the interface or logs straight into an Issue?

Yes, but hide names, personal paths, account information, tokens and private content first. Do not attach commercial game files, paid assets, unreleased patches or private saves.

Check the image yourself before screenshotting or sharing, and crop or mask private content if necessary.

### Can a local model be paired with Tavily? Why is LAN HTTP blocked?

Yes — search services and models are configured separately, with keys stored separately. Search does not require the model to have native internet access or tool-calling support; after you select a candidate, the local model organizes the actual page. LAN HTTP must be authorized separately in the game-info settings for the current full address, and revoked when the address changes; authorization does not open the firewall and does not allow scraping intranet pages. When the model only listens on another computer's loopback address, changing the IP is not enough to connect — configure the listener securely or use an encrypted tunnel. See [Game info retrieval](game-info.md) for details.
