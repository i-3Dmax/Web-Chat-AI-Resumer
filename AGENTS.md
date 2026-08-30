# AGENTS.md

## What this repo is

A **single-file Tampermonkey userscript** (`wcair.user.js`, ~3070 lines) that scrapes messages from chats on `web.max.ru` (MAX messenger) and `vk.ru`/`vk.com` (VK messenger), then summarizes them via an AI provider. No build step, no package.json, no test runner.

- The app lives entirely in `wcair.user.js`. Edit that one file.
- `dev-server.js` + `run-dev.bat` are just a local static server for Tampermonkey updates (uses Node's built-in `http`; no dependencies).
- `README.md` is accurate and in Russian — update it whenever providers or behaviour change.

UI strings, code comments, and docs are all in **Russian** — keep them that way.

## Verify your changes

There is **no test/lint/build**. The only checks:
- Syntax: `node --check wcair.user.js`
- Runtime: must be tested live in Tampermonkey (requires opening a chat on web.max.ru or vk.ru behind auth).

## Dev loop (hot-reload via Tampermonkey)

1. Run `node dev-server.js` (or `run-dev.bat`) — serves `wcair.user.js` at `http://localhost:3000/wcair.user.js`.
2. The script's `@updateURL`/`@downloadURL` point at that URL.
3. After editing, **bump `@version`**; Tampermonkey checks it to detect a new version.
4. In Tampermonkey: "Проверить обновления", or tab Обновления → Обновить, then reload the page.

## Hard-won facts about MAX

- MAX is a SvelteKit SPA with **no internal `window.vkApi`**. Messages are read from the **DOM** of the open chat, not from any network API.
- The message list is **virtualized**: only ~25–59 `.item[data-index]` rows exist in the DOM at once, reused (indices `0..58`).
- **Programmatic history loading WORKS via direct `scrollTop` setting**: MAX ignores synthetic/`untrusted` `wheel`/`scroll` **events** (`isTrusted:false`), but a **direct `container.scrollTop = ...` assignment** makes MAX send `getMessages` and load older history. Sending synthetic events does NOT help; assign `scrollTop` instead.
- DOM selectors live in `DOM_CONF` (top of file). Re-derive them on a live chat with `window.__maxAirInspect()` in the browser console if layout changes.
- Date separator capsules ("Сегодня", "Вчера", "26 августа 2026") are parsed in `parseCapsuleDate`.

## Hard-won facts about VK

- VK uses `window.vkApi.api('messages.getHistory', params)` for loading messages.
- Chat ID is extracted from URL: `/im/convo/123` → `peerId = 2000000000 + 123` for group chats.
- VK API bridge is installed via `installVkBridge()` and `installBridgeListener()`.

## AI providers

- Keys are stored in cookies; enter once, reused. On 401/403 the old key is deleted and re-prompted.
- Cookie keys are site-specific: `maxair-*` for MAX, `vk-exporter-*` for VK.
- Default provider is `qwen` (Qwen Cloud). **OpenRouter free currently returns HTTP 403** — not fixable in script code.
