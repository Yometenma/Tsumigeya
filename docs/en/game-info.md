# Getting Game Info

**English** · [简体中文](../作品信息获取.md) · [日本語](../ja/game-info.md)

> Tsumigeya's interface supports Simplified Chinese, English and Japanese (Settings → Language) and follows the system language by default. This guide quotes interface labels in Simplified Chinese — the source language — with the English name on first mention; if you run the English interface, the same labels appear in English.

This page describes the game info features introduced in v3.0.0. Filling in info does not affect launch compatibility, and never downloads the game itself.

## Choosing the info language

Set 「作品信息优先语言」 (preferred game info language) and 「缺失时回退语言」 (fallback language when missing) in **Settings → Game Info** (「设置 → 作品信息」). Simplified Chinese, Traditional Chinese, Japanese, English and Korean are supported; the default is Simplified Chinese preferred with Japanese fallback, and the fallback can also be turned off.

- Single lookup, candidate preview, refresh and bulk DLsite filling all use the same preference. Switching the preference does not rewrite saved info over the network automatically; existing works need a manual refresh.
- A request explicitly specifies the DLsite product page language, and the cache is kept separately per RJ and request language, so a Chinese request does not hit an earlier English cache. Old caches are kept and are not used as caches for the new language.
- When the target product page is unavailable or explicitly returns another page language, the fallback language for the same RJ is tried; when a search returns nothing, the fallback language may also be tried. Being offline, verification pages and service failures are not disguised as "this language does not exist".
- **The page language is not the game language**. Some DLsite products only translate the site navigation, while the title or body stays in the original language; such fields keep the actual site content, and a whole description is not claimed to be translated just because of the menu language. When the page does not state a language, "not specified" is shown.
- The app does not switch automatically to a translation, additional content or remake under another RJ; different IDs still require you to check and confirm the link.

AI tidying also uses the preferred game info language, but it only translates or tidies the text in the source and never fills in "supported game languages" from it. The interface language stays independent of the game translation interface.

## Games not on DLsite

Add the local game normally first, then choose an action in **Game Details → Find Work / Fill In or Change Info → Other Game · AI / Manual** (「游戏详情 → 查找作品／补全或更换资料 → 其他游戏 · AI／手动」).

### Option 1: Specify a public page

1. Configure the game info interface and model in Settings, enter the key in the key field, and save it separately.
2. Paste the **HTTPS product page link** of the official site or store, confirm what will be sent and the cost notice, and click 「读取并整理页面」 (Read and tidy the page).
3. The app reads the necessary body text and hands it to the model for tidying. The model can submit only fields that carry quotes from the original page; fields it cannot verify are ignored. Dates must also keep the source's original text and cannot be inferred out of thin air.
4. In the preview, check the title, developer/publisher, description, date, series, tags, language, production/voice acting and original system, select the fields you need, and edit them directly if you like.
5. Data is written only after you click 「确认保存所选信息」 (Save the selected info). Cancelling or closing leaves the original info unchanged.

The cover comes from the page's own share image information; image addresses returned by the model are not accepted, and no image is generated to impersonate an official cover. You can skip saving a cover, or fill in a public HTTPS image address manually; local images and game assets are not read. Third-party images do not follow redirects, so some hotlink-protected or redirected images may not display.

Currently only public, directly accessible UTF-8 HTML is read; web scripts are not executed and browser login cookies are not carried. Login pages, age verification, anti-bot verification, dynamically loaded content, overlong body text or pages that block access may fail; use another public page, or fill in the info manually.

### Option 2: Search the web by game name

Choose a search method in **Settings → Game Info → Search Sources** (「设置 → 作品信息 → 搜索来源」), then enter the game name; you can add clues such as the developer or year.

- **Model-native web access**: requires the Responses interface and a model service that supports `web_search`; candidates accept only the source citations returned by the interface.
- **Standalone search · Tavily**: save the search key separately; leave the search address empty to use the official search interface. The app issues one basic search in the preferred game info language (a preference, not a strict language filter), with automatic search parameters not enabled, no AI answer and no full page body requested; at most twelve candidates, and the interface lets you choose three / five / ten.
- **Standalone search · SearXNG**: fill in the instance's full search address; the instance must enable JSON output. Whether a key is needed depends on your service. Public instances may rate-limit or turn JSON off.
- **Standalone search · custom interface**: supports GET query parameters or POST JSON, with a configurable keyword parameter name and dot-separated paths for result fields. By default it reads the `results` array and each item's `title`, `url` and `content`; leaving the result array path empty means a root array. Extra parameters accept only non-sensitive JSON and must be confirmed and saved separately. Authentication supports only a standalone Bearer key; services that need other authentication methods should be connected through your own conversion service — a key cannot be put into query parameters.
- **Web search off**: you can still tidy a specified page or fill in info manually.

Standalone search is executed by the app, and **an ordinary chat model does not need to support tool calling or have its own web access**. Even if the model supports tool calling, the current flow is fixed as "search → pick sources manually → model tidies", and the model is not left to loop through searches on its own. Each operation calls only the selected search service; a failure is not retried automatically or switched to a paid service.

Candidates show the title, source link and an available summary; only public HTTPS links are accepted and deduplicated, addresses are not extracted arbitrarily from model text, and the first hit is not assumed to be your game. Search summaries are only identification clues and are not saved directly as formal info; only after you pick a source is the page read and the pending info generated by the model. Standalone search does not require a model to be configured first, but tidying a page still needs one.

### Option 3: Fill in everything manually

Click 「手动填写…」 (Fill in manually…) to enter info; no interface or key is needed, and nothing goes online. The title is required; other unknown fields can be left empty. After saving, you can still change it from 「编辑游戏」 (Edit Game).

## Interfaces, credentials and cost

The game info interface and the game translation interface are configured separately, and the address must be the full request path. For example:

```text
Chat-compatible interface: https://api.example.com/v1/chat/completions
Responses interface: https://api.example.com/v1/responses
```

The addresses above only show the format; they are not services you can use directly. Model names and search support depend on your provider, and no default paid model is built in. By default only HTTPS is accepted, or an explicitly configured local HTTP service on `localhost`／`127.0.0.1`; LAN HTTP needs the separate authorization described below. An interface address cannot contain an account, a password or query parameters — put the key in the dedicated key field.

- Keys are stored in the macOS Keychain per interface address and are not written into the game library, ordinary settings or logs; switching the address does not carry over the key of another address.
- Calls happen only after explicit confirmation; specifying a page sends the necessary body text and source address, and searching by name sends the name you entered and supplementary clues. Search and model calls may both be billed.
- The game itself, saves, private folders and the whole game library are never uploaded automatically. A public page also triggers a request to the website that hosts it; local, intranet and file addresses are not read.
- Bulk DLsite filling does not automatically call paid AI; existing external info is skipped and must be previewed and confirmed work by work.
- Even with real quotes attached, AI may still misunderstand; quotes are clues for checking, not a guarantee of fact. Important information still needs human verification.

## LAN and local models

The model and search interfaces each have an independent **"authorize the current LAN interface"** switch (「授权当前局域网接口」). After entering the full HTTP address, turn it on and confirm the risk notice before a connection to that address is allowed; changing the address, port or path revokes it automatically, and switching the search method also revokes the search authorization. Model authorization is not search authorization, and revoking it cancels the current info task. Private IPv4, IPv6 ULA and local service names are supported; this switch cannot be used to authorize public plaintext HTTP.

HTTP is not encrypted, and body text and keys may be read by other devices on the network; use it only on a trusted network, and HTTPS or an encrypted tunnel is recommended. The app does not open ports, change firewall settings or change service listener configuration automatically. **Page text and images are still limited to public HTTPS**, and intranet pages are not read just because an interface is authorized.

If the model runs on another computer, the Mac's `127.0.0.1` is not that computer. If the service listens only on its own machine, simply switching to the LAN IP still will not connect; you can configure the service to listen on the LAN yourself and safely, or use an encrypted tunnel. The address should include the actual path such as `/v1/chat/completions`, and model names should be entered according to the service's model list, not guessed from display names.

The following can be adjusted in **"local models and compatibility options"** (「本地模型与兼容选项」):

- Model wait limit: ninety seconds, three minutes, five minutes or ten minutes; default three minutes.
- Single-request body length: eight thousand to forty-five thousand characters, default sixteen thousand; the excess is truncated, uncovered fields may be missing, and calls are not increased by splitting the text automatically.
- JSON object output: enabled only when the service supports it, off by default; without support it reports a failure and does not silently fall back and retry.
- Turning off thinking mode for compatible models: only the chat protocol sends `chat_template_kwargs.enable_thinking=false`, off by default, and the service must support it.

A thinking field returned separately by the model is not read as info; a complete `<think>…</think>` at the start of the body can be stripped. Answers that are only thinking, have unclosed thinking, or cannot be parsed are not saved. A type needs a source quote containing an explicit type word, and the category cannot be guessed from gameplay descriptions alone; other fields may still be misunderstood, so check the preview.

## Saving and refresh

External info records its source separately; an RJ is never fabricated and a work is never passed off as a DLsite work; it stays compatible with older DLsite metadata. The info, source quotes and manual-edit markers are kept in a sidecar file next to the game library, and categories and unknown extension fields are preserved.

Refreshing the same source keeps manually edited fields; unchecked fields keep the work's existing values and are not cleared when they are missing. Changing the source shows a notice in the preview and does not mix in old work info. Fields edited by hand are no longer endorsed by the original AI quotes; the source record is still kept for checking.

The original game name, files and saves stay unchanged. Automatic categories update according to the confirmed work type, and manual category adjustments are preserved. The external source URL serves as the identity of the info; switching to a different address is handled as changing the source, so check the notice carefully.
