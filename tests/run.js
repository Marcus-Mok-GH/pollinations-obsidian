"use strict";
/* Unit + integration suite. Runs the plugin's own code against mocked Obsidian
 * APIs and a mocked transport - no Obsidian app needed. Run: npm test */

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "obsidian") return require("./obsidian-stub");
	return originalLoad.apply(this, arguments);
};
const api = require("../main.js");

let failures = 0;
let checks = 0;
function check(condition, name) {
	checks += 1;
	console.log((condition ? "[ok] " : "[FAIL] ") + name);
	if (!condition) failures += 1;
}
function eq(a, b, name) { check(JSON.stringify(a) === JSON.stringify(b), name + " (" + JSON.stringify(a) + ")"); }

/* ---- pure helpers ---- */
const textBody = JSON.parse(api.buildTextBody("hi", "openai/gpt-5.4-nano"));
eq(textBody, { model: "openai/gpt-5.4-nano", messages: [{ role: "user", content: "hi" }] }, "buildTextBody shape");
const imageBody = JSON.parse(api.buildImageBody("a cat", "tongyi-mai/z-image-turbo", 512, 512));
eq(imageBody, { prompt: "a cat", model: "tongyi-mai/z-image-turbo", n: 1, width: 512, height: 512, response_format: "b64_json" }, "buildImageBody shape");

const chat = api.parseChatCompletion(JSON.stringify({ model: "gpt-5.4-nano-2026-03-17", choices: [{ message: { role: "assistant", content: "Pollen works" } }] }));
eq(chat, { text: "Pollen works", model: "gpt-5.4-nano-2026-03-17" }, "parseChatCompletion");

const tinyJpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02]).toString("base64");
const decoded = api.decodeImageResponse(JSON.stringify({ data: [{ b64_json: tinyJpegB64 }] }));
check(decoded.bytes.length === 6 && decoded.ext === "jpg", "decodeImageResponse b64 + jpg sniff");
eq(decoded.bytes, Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02]), "decodeImageResponse bytes round trip");
const urlDecoded = api.decodeImageResponse(JSON.stringify({ data: [{ url: "https://x/img.png" }] }));
eq(urlDecoded.url, "https://x/img.png", "decodeImageResponse url branch");

const e402 = api.friendlyError(402, JSON.stringify({ error: { message: "Insufficient balance. This request costs ~0.0000 pollen." } }));
check(/Pollen balance/.test(e402) && /top-up/.test(e402), "friendlyError 402 suggests a top-up");
const e401 = api.friendlyError(401, JSON.stringify({ error: { message: "A valid API key is required." } }));
check(/device flow/.test(e401), "friendlyError 401 points at the device flow");
const eNet = api.friendlyError(0, "gateway exploded");
check(/^Pollinations request failed/.test(eNet), "friendlyError non-JSON body");

check(/^pollinations-a-tiny-cat-1777\.jpg$/.test(api.imageFileName("A tiny cat!", 1777, "jpg")), "imageFileName slug + ext");

eq(api.deviceStep({ access_token: "tok" }), { type: "granted", accessToken: "tok" }, "deviceStep granted");
eq(api.deviceStep({ error: "authorization_pending" }), { type: "pending" }, "deviceStep pending");
eq(api.deviceStep({ error: "slow_down" }), { type: "slow_down" }, "deviceStep slow_down");
eq(api.deviceStep({ error: "access_denied" }), { type: "fail", error: "access_denied" }, "deviceStep denied");

/* ---- deviceFlow orchestration with a scripted transport ---- */
async function testDeviceFlow() {
	const seen = { openUrl: [], onCode: [], codeBody: null, tokenBodies: [] };
	const transport = async (options) => {
		const body = options.body ? JSON.parse(options.body) : null;
		if (options.url.endsWith("/api/device/code")) {
			seen.codeBody = body;
			return { status: 200, text: JSON.stringify({ device_code: "dc1", user_code: "ABCD-EFGH", verification_uri: "/device", interval: 5, expires_in: 600 }) };
		}
		seen.tokenBodies.push(body);
		if (seen.tokenBodies.length === 1) return { status: 400, text: JSON.stringify({ error: "authorization_pending" }) };
		if (seen.tokenBodies.length === 2) return { status: 400, text: JSON.stringify({ error: "slow_down" }) };
		return { status: 200, text: JSON.stringify({ access_token: "sk_live_token" }) };
	};
	let sleeps = [];
	const result = await api.deviceFlow({
		appKey: "pk_test",
		request: transport,
		openUrl: (uri) => seen.openUrl.push(uri),
		onCode: (code, uri) => seen.onCode.push([code, uri]),
		sleep: (ms) => { sleeps.push(ms); }
	});
	check(result.granted === true && result.accessToken === "sk_live_token", "deviceFlow grants after pending + slow_down");
	check(seen.codeBody && seen.codeBody.client_id === "pk_test", "deviceFlow sends client_id");
	check(seen.tokenBodies[0].device_code === "dc1", "deviceFlow polls with device_code");
	check(seen.openUrl[0] === "https://enter.pollinations.ai/device", "deviceFlow joins relative verification_uri");
	check(seen.onCode[0][0] === "ABCD-EFGH", "deviceFlow surfaces the user code");
	check(sleeps.length === 3 && sleeps[2] === 10000, "deviceFlow backs off after slow_down");
}

/* ---- integration: the plugin's own insertion paths with a mocked transport ---- */
function fakeTransport(responses) {
	const calls = [];
	const transport = async (options) => {
		calls.push(options);
		const match = responses.find((r) => options.url.includes(r.match));
		if (!match) return { status: 404, text: "{}" };
		return { status: match.status, text: match.text, bytes: match.bytes || null };
	};
	transport.calls = calls;
	return transport;
}

async function testPluginInsertion() {
	const { Plugin } = require("obsidian");
	const plugin = new api.Plugin();
	plugin.app = {
		vault: {
			adapter: { exists: async () => false },
			createFolder: async (folder) => { plugin._folders = plugin._folders || []; plugin._folders.push(folder); },
			createBinary: async (path, arrayBuffer) => {
				plugin._saved = plugin._saved || [];
				plugin._saved.push({ path: path, bytes: Buffer.from(arrayBuffer).length });
			}
		}
	};
	await plugin.loadSettings();
	await plugin.onload();
	const commandIds = Object.keys(plugin.commands);
	check(commandIds.includes("generate-text-prompt") && commandIds.includes("generate-text-selection")
		&& commandIds.includes("generate-image") && commandIds.includes("connect") && commandIds.includes("disconnect"),
		"onload registers the five commands (" + commandIds.join(", ") + ")");
	check(plugin.settingTabs.length === 1, "onload registers the settings tab");

	const editor = { replaced: [], replaceSelection(t) { this.replaced.push(t); }, getSelection: () => "Explain this: pollen" };
	const transport = fakeTransport([
		{ match: "/v1/chat/completions", status: 200, text: JSON.stringify({ model: "gpt-5.4-nano", choices: [{ message: { content: "Pollen is the currency." } }] }) }
	]);
	plugin.transport = () => transport;
	await plugin.insertGeneratedText(editor, "Explain pollen", "openai/gpt-5.4-nano");
	check(editor.replaced[0] === "Pollen is the currency.", "text path inserts the completion at the cursor");
	const sent = JSON.parse(transport.calls[0].body);
	check(sent.model === "openai/gpt-5.4-nano" && sent.messages[0].content === "Explain pollen", "text path sends the documented body");
	check(transport.calls[0].headers["Authorization"] === undefined, "no Authorization header without a token");

	plugin.settings.apiKey = "sk_test";
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02]);
	const transport2 = fakeTransport([
		{ match: "/v1/images/generations", status: 200, text: JSON.stringify({ data: [{ b64_json: jpeg.toString("base64") }] }) }
	]);
	plugin.transport = () => transport2;
	await plugin.insertGeneratedImage(editor, "A tiny cat", "tongyi-mai/z-image-turbo");
	check(transport2.calls[0].headers["Authorization"] === "Bearer sk_test", "image path sends the key as a Bearer token");
	check(plugin._folders && plugin._folders[0] === "pollinations", "image path creates the vault folder");
	check(plugin._saved && plugin._saved[0].path.startsWith("pollinations/pollinations-a-tiny-cat-") && plugin._saved[0].path.endsWith(".jpg"),
		"image path saves a slugged jpg into the vault (" + (plugin._saved && plugin._saved[0].path) + ")");
	check(editor.replaced[1] === "![[" + plugin._saved[0].path.split("/")[1] + "]]", "image path embeds the file at the cursor");
}

async function testErrorNotices() {
	const { Notice } = require("obsidian");
	const plugin = new api.Plugin();
	plugin.app = { vault: {} };
	await plugin.loadSettings();
	plugin.transport = () => fakeTransport([
		{ match: "/v1/chat/completions", status: 402, text: JSON.stringify({ error: { message: "Insufficient balance." } }) }
	]);
	Notice.log.length = 0;
	await plugin.insertGeneratedText({ replaceSelection() {} }, "hi", "openai/gpt-5.4-nano");
	check(Notice.log.some((m) => /Pollen balance/.test(m)), "low-balance error surfaces a top-up notice");
	plugin.transport = () => fakeTransport([{ match: "/v1/chat/completions", status: 401, text: JSON.stringify({ error: { message: "A valid API key is required." } }) }]);
	Notice.log.length = 0;
	await plugin.insertGeneratedText({ replaceSelection() {} }, "hi", "openai/gpt-5.4-nano");
	check(Notice.log.some((m) => /device flow/.test(m)), "missing-auth error points at sign-in");
}

async function main() {
	await testDeviceFlow();
	await testPluginInsertion();
	await testErrorNotices();
	console.log("RESULT: " + (failures === 0 ? "PASS" : "FAIL") + " (" + failures + " failures, " + checks + " checks)");
	process.exit(failures === 0 ? 0 : 1);
}
main();
