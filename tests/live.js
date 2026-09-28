"use strict";
/* Live verification: runs the plugin's own request builders and parsers against
 * the real Pollinations API. Uses POLLINATIONS_API_KEY when present; without a
 * key it exits with an explicit SKIP. Run: npm run test:live */

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "obsidian") return require("./obsidian-stub");
	return originalLoad.apply(this, arguments);
};
const api = require("../main.js");

const KEY = process.env.POLLINATIONS_API_KEY || "";

let failures = 0;
function check(condition, name) {
	console.log((condition ? "[ok] " : "[FAIL] ") + name);
	if (!condition) failures += 1;
}

async function transport(options) {
	const headers = Object.assign({}, options.headers || {});
	const res = await fetch(options.url, { method: options.method || "GET", headers: headers, body: options.body || undefined });
	const bytes = Buffer.from(await res.arrayBuffer());
	return { status: res.status, text: bytes.toString("utf8"), bytes: bytes };
}

async function main() {
	if (!KEY) {
		console.log("[skip] live checks (no POLLINATIONS_API_KEY in the environment)");
		return;
	}
	const client = new api.PollinationsClient(transport, () => KEY);

	const text = await client.generateText("Answer with exactly two words: pollen works", "openai/gpt-5.4-nano");
	check(text.text !== "", "live text via the plugin's own builder/parser (" + JSON.stringify(text.text.slice(0, 60)) + ")");

	const image = await client.generateImage("a tiny pixel-art garden on an alien planet", "tongyi-mai/z-image-turbo", 512, 512);
	check(image.bytes.length > 1000 && image.bytes[0] === 0xff && image.bytes[1] === 0xd8, "live image decoded to " + image.bytes.length + "-byte JPEG via b64_json");

	const textModels = await client.models("text");
	const imageModels = await client.models("image");
	check(textModels.includes("openai/gpt-5.4-nano"), "live text model catalog includes the default model");
	check(imageModels.includes("tongyi-mai/z-image-turbo"), "live image model catalog includes the default model");

	console.log("RESULT: " + (failures === 0 ? "PASS" : "FAIL") + " (" + failures + " failures)");
	process.exit(failures === 0 ? 0 : 1);
}
main();
