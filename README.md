# Pollinations for Obsidian

Generate text and images with [Pollinations](https://pollinations.ai) inside your notes — at the
cursor, from the selection, or from a prompt — paying with your own Pollen. Submitted for
Pollinations quest #15574.

Single-file plugin with **no build step**: `manifest.json` + `main.js` drop straight into your
vault. Standard Obsidian APIs only (`requestUrl`, `vault`, modals, commands).

## Features

- **Generate text from a prompt** — command → prompt modal (with a live-model picker) → the
  answer is inserted at the cursor
- **Generate text from the selection** — writes about whatever you selected
- **Generate an image** — the image is generated, saved into a vault folder, and embedded at the
  cursor as `![[pollinations-...jpg]]`
- **Player-funded sign-in** — BYOP device flow: paste your publishable `pk_` App Key, approve in
  your browser, and generation is paid with your own Pollen; the token is stored in the plugin's
  local data, never in a note
- **Development API key** option in settings (from enter.pollinations.ai/keys)
- **Live model catalogs** — any text or image model from the current lists, picked with a
  fuzzy-search modal
- **Actionable errors** — notices for expired sign-in, low Pollen balance (with the top-up link),
  and network failures

## Install

1. Download `manifest.json`, `main.js` from this repo.
2. Put them in `<your vault>/.obsidian/plugins/pollinations/`.
3. Enable **Pollinations** under Settings → Community plugins.
4. Optional: set a development API key in the plugin settings, or run **Connect Pollinations
   (device flow)** and approve in your browser.

## Short demo

1. Open any note, place the cursor where you want text.
2. Ctrl/Cmd+P → **Pollinations: Generate text from a prompt**.
3. Type “a haiku about the note-taking habit”, pick a model from **Live list…** (optional),
   hit **Generate**.
4. The haiku appears at the cursor. Select any paragraph → **Generate text from the selection**
   to expand it in place.
5. **Generate an image from a prompt** → describe a scene → the image lands in
   `pollinations/` and `![[pollinations-your-scene-….jpg]]` is embedded at the cursor.

## Verification

Two suites ship in the repo:

```bash
npm test          # 31 checks: unit + integration with mocked Obsidian APIs
npm run test:live # live text + image + catalogs through the plugin's own builders/parsers
```

The offline suite covers the request bodies, response parsers (b64_json + extension sniffing,
URL branch), the device-flow state machine (pending → slow_down → granted, back-off timing,
verification_uri joining), command registration, cursor insertion, vault folder creation and
embed syntax, and the low-balance / missing-auth notices. The live suite (with
`POLLINATIONS_API_KEY` in the environment) verified: text generation
(`"Pollen works"` via `/v1/chat/completions`), a 192 KB JPEG decoded from a real `b64_json`
response, and both live model catalogs. The device-flow endpoints are verified by the state
machine tests plus a live reachability/shape check against `enter.pollinations.ai`; a full
end-to-end sign-in needs a registered `pk_` App Key.

## License

MIT
