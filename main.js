"use strict";

/*
 * Pollinations for Obsidian
 *
 * Text and image generation inside notes, with player-funded BYOP device-flow
 * sign-in (or a development API key). No build step: this file plus
 * manifest.json drop straight into .obsidian/plugins/pollinations/.
 */

const { Plugin, Notice, Modal, FuzzySuggestModal, PluginSettingTab, Setting } = require("obsidian");

const GENERATION_URL = "https://gen.pollinations.ai";
const AUTH_URL = "https://enter.pollinations.ai";
const JSON_HEADERS = { "Content-Type": "application/json" };
const DEFAULT_TEXT_MODEL = "openai/gpt-5.4-nano";
const DEFAULT_IMAGE_MODEL = "tongyi-mai/z-image-turbo";

/* ------------------------------------------------------------------ */
/* Pure helpers - exported for tests. No Obsidian API needed.          */
/* ------------------------------------------------------------------ */

function buildTextBody(prompt, model) {
	return JSON.stringify({ model: model, messages: [{ role: "user", content: prompt }] });
}

function buildImageBody(prompt, model, width, height) {
	return JSON.stringify({
		prompt: prompt,
		model: model,
		n: 1,
		width: width,
		height: height,
		response_format: "b64_json"
	});
}

function parseChatCompletion(text) {
	const data = JSON.parse(text);
	const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
	const content = choice && choice.message ? choice.message.content : null;
	if (content == null) throw new Error("No text in the Pollinations response");
	return { text: String(content), model: data.model || "" };
}

function sniffExt(base64) {
	if (base64.startsWith("/9j/")) return "jpg";
	if (base64.startsWith("iVBOR")) return "png";
	if (base64.startsWith("R0lGOD")) return "gif";
	if (base64.startsWith("UklGR")) return "webp";
	return "png";
}

function decodeImageResponse(text) {
	const data = JSON.parse(text);
	const item = data && Array.isArray(data.data) ? data.data[0] : null;
	if (!item) throw new Error("No image data in the Pollinations response");
	if (typeof item.b64_json === "string" && item.b64_json) {
		return { bytes: Buffer.from(item.b64_json, "base64"), ext: sniffExt(item.b64_json) };
	}
	if (typeof item.url === "string" && item.url) return { url: item.url };
	throw new Error("The response had neither b64_json nor a URL");
}

function friendlyError(status, bodyText) {
	let message = "Pollinations request failed (HTTP " + status + ")";
	try {
		const parsed = JSON.parse(bodyText);
		if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
	} catch (e) { /* non-JSON body */ }
	if (status === 402 || /insufficient/i.test(message)) {
		message += " - your Pollen balance is too low. Top up at https://enter.pollinations.ai/top-up";
	}
	if (status === 401) {
		message += " - sign in with the device flow (Connect Pollinations command) or set a development API key in settings";
	}
	return message;
}

function imageFileName(prompt, stamp, ext) {
	let slug = String(prompt || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	if (!slug) slug = "image";
	return "pollinations-" + slug + "-" + stamp + "." + ext;
}

function deviceStep(body) {
	if (body && typeof body.access_token === "string" && body.access_token) {
		return { type: "granted", accessToken: body.access_token };
	}
	const error = body && typeof body.error === "string" ? body.error : "unknown";
	if (error === "authorization_pending") return { type: "pending" };
	if (error === "slow_down") return { type: "slow_down" };
	return { type: "fail", error: error };
}

/* The BYOP device flow. `request` is a transport: options -> {status, text}. */
async function deviceFlow(options) {
	const request = options.request;
	const appKey = options.appKey;
	const openUrl = options.openUrl || null;
	const onCode = options.onCode || null;
	const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const codeRes = await request({
		url: AUTH_URL + "/api/device/code",
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ client_id: appKey })
	});
	if (codeRes.status >= 400) throw new Error(friendlyError(codeRes.status, codeRes.text));
	const code = JSON.parse(codeRes.text);
	const deviceCode = code && typeof code.device_code === "string" ? code.device_code : "";
	if (!deviceCode) throw new Error("The device flow returned no device_code");
	let uri = typeof code.verification_uri === "string" ? code.verification_uri : "/device";
	if (!/^https?:/.test(uri)) uri = AUTH_URL + (uri.startsWith("/") ? "" : "/") + uri;
	if (onCode) onCode(String(code.user_code || ""), uri);
	if (openUrl) openUrl(uri);
	let interval = typeof code.interval === "number" && code.interval > 0 ? code.interval : 5;
	const deadline = Date.now() + (typeof code.expires_in === "number" && code.expires_in > 0 ? code.expires_in * 1000 : 600000);
	for (;;) {
		if (Date.now() >= deadline) return { granted: false, error: "expired_token" };
		await sleep(interval * 1000);
		const tokenRes = await request({
			url: AUTH_URL + "/api/device/token",
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ client_id: appKey, device_code: deviceCode })
		});
		if (tokenRes.status >= 400) throw new Error(friendlyError(tokenRes.status, tokenRes.text));
		const step = deviceStep(JSON.parse(tokenRes.text));
		if (step.type === "granted") return { granted: true, accessToken: step.accessToken };
		if (step.type === "pending") continue;
		if (step.type === "slow_down") { interval += 5; continue; }
		return { granted: false, error: step.error };
	}
}

/* ------------------------------------------------------------------ */
/* API client. `transport(options) -> {status, text, bytes}`.           */
/* ------------------------------------------------------------------ */

class PollinationsClient {
	constructor(transport, getToken) {
		this.transport = transport;
		this.getToken = getToken || (() => "");
	}

	async _post(path, body) {
		const headers = Object.assign({}, JSON_HEADERS);
		const token = this.getToken();
		if (token) headers["Authorization"] = "Bearer " + token;
		const res = await this.transport({ url: GENERATION_URL + path, method: "POST", headers: headers, body: body });
		if (res.status >= 400) throw new Error(friendlyError(res.status, res.text));
		return res;
	}

	async generateText(prompt, model) {
		return parseChatCompletion((await this._post("/v1/chat/completions", buildTextBody(prompt, model))).text);
	}

	async generateImage(prompt, model, width, height) {
		const res = await this._post("/v1/images/generations", buildImageBody(prompt, model, width, height));
		const decoded = decodeImageResponse(res.text);
		if (decoded.url) {
			const headers = {};
			const token = this.getToken();
			if (token) headers["Authorization"] = "Bearer " + token;
			const download = await this.transport({ url: decoded.url, method: "GET", headers: headers });
			if (download.status >= 400) throw new Error(friendlyError(download.status, download.text));
			return { bytes: download.bytes, ext: "png" };
		}
		return decoded;
	}

	async models(modality) {
		const token = this.getToken();
		const headers = {};
		if (token) headers["Authorization"] = "Bearer " + token;
		const res = await this.transport({ url: GENERATION_URL + "/" + modality + "/models", method: "GET", headers: headers });
		if (res.status >= 400) throw new Error(friendlyError(res.status, res.text));
		const parsed = JSON.parse(res.text);
		if (!Array.isArray(parsed)) throw new Error("Unexpected model list response");
		return parsed.map((m) => String(m && m.name ? m.name : "")).filter(Boolean);
	}
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

class ModelSuggestModal extends FuzzySuggestModal {
	constructor(plugin, names, onChoose) {
		super(plugin.app);
		this.names = names;
		this.onChoose = onChoose;
	}
	getItems() { return this.names; }
	getItemText(name) { return name; }
	onChooseItem(name) { this.onChoose(name); this.close(); }
}

class PromptModal extends Modal {
	constructor(plugin, options) {
		super(plugin.app);
		this.plugin = plugin;
		this.options = options;
		this.model = options.model;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.options.title });
		const modelRow = contentEl.createDiv();
		const modelInput = modelRow.createEl("input", { type: "text" });
		modelInput.value = this.model;
		modelInput.placeholder = "model";
		const listBtn = modelRow.createEl("button", { text: "Live list…" });
		listBtn.onclick = async () => {
			listBtn.disabled = true;
			listBtn.setText("Loading…");
			try {
				const names = await this.plugin.client().models(this.options.modality);
				if (!names.length) { new Notice("The model list came back empty"); return; }
				new ModelSuggestModal(this.plugin, names, (name) => { modelInput.value = name; }).open();
			} catch (error) {
				new Notice(String(error.message || error));
			} finally {
				listBtn.disabled = false;
				listBtn.setText("Live list…");
			}
		};
		const promptArea = contentEl.createEl("textarea");
		promptArea.placeholder = this.options.placeholder || "Prompt";
		promptArea.value = this.options.initial || "";
		const submit = contentEl.createEl("button", { text: this.options.submitLabel || "Generate" });
		submit.classList.add("mod-cta");
		submit.onclick = () => {
			const prompt = promptArea.value.trim();
			if (!prompt) { new Notice("Write a prompt first"); return; }
			this.close();
			this.options.onSubmit(prompt, modelInput.value.trim() || this.model);
		};
	}
}

class AppKeyModal extends Modal {
	constructor(plugin, onSubmit) {
		super(plugin.app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Connect Pollinations" });
		contentEl.createEl("p", { text: "Paste your publishable App Key (starts with pk_) from enter.pollinations.ai. " +
			"You will approve the sign-in in your browser; generation is paid with your own Pollen." });
		const input = contentEl.createEl("input", { type: "password" });
		input.placeholder = "pk_…";
		const submit = contentEl.createEl("button", { text: "Start sign-in" });
		submit.classList.add("mod-cta");
		submit.onclick = () => {
			const value = input.value.trim();
			if (!value.startsWith("pk_")) { new Notice("An App Key starts with pk_"); return; }
			this.close();
			this.onSubmit(value);
		};
	}
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
	apiKey: "",
	token: "",
	defaultTextModel: DEFAULT_TEXT_MODEL,
	defaultImageModel: DEFAULT_IMAGE_MODEL,
	imageFolder: "pollinations",
	imageWidth: 1024,
	imageHeight: 1024
};

class PollinationsSettingsTab extends PluginSettingTab {
	constructor(plugin, app) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display() {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Development API key")
			.setDesc("Optional sk_ key from enter.pollinations.ai/keys. The device flow below is preferred and overrides it.")
			.addText((text) => text.setValue(this.plugin.settings.apiKey).onChange(async (value) => {
				this.plugin.settings.apiKey = value.trim();
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Pollinations account")
			.setDesc(this.plugin.settings.token ? "Connected via device flow. Disconnect with the Disconnect command." : "Not connected. Use the Connect Pollinations command.")
			.addButton((button) => button.setButtonText("Connect").onClick(() => this.plugin.connect()));
		new Setting(containerEl).setName("Default text model").addText((text) => text.setValue(this.plugin.settings.defaultTextModel).onChange(async (value) => {
			this.plugin.settings.defaultTextModel = value.trim() || DEFAULT_TEXT_MODEL;
			await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName("Default image model").addText((text) => text.setValue(this.plugin.settings.defaultImageModel).onChange(async (value) => {
			this.plugin.settings.defaultImageModel = value.trim() || DEFAULT_IMAGE_MODEL;
			await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName("Image folder").setDesc("Images are saved in this vault folder.").addText((text) => text.setValue(this.plugin.settings.imageFolder).onChange(async (value) => {
			this.plugin.settings.imageFolder = value.trim() || "pollinations";
			await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName("Image size").addText((text) => text.setValue(this.plugin.settings.imageWidth + "x" + this.plugin.settings.imageHeight).onChange(async (value) => {
			const match = /^(\d+)x(\d+)$/.exec(value.trim());
			if (match) {
				this.plugin.settings.imageWidth = parseInt(match[1], 10);
				this.plugin.settings.imageHeight = parseInt(match[2], 10);
				await this.plugin.saveSettings();
			}
		}));
	}
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class PollinationsPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		this.addCommand({
			id: "generate-text-prompt",
			name: "Generate text from a prompt",
			editorCallback: (editor) => this.promptForText(editor)
		});
		this.addCommand({
			id: "generate-text-selection",
			name: "Generate text from the selection",
			editorCallback: (editor) => this.selectionToText(editor)
		});
		this.addCommand({
			id: "generate-image",
			name: "Generate an image from a prompt",
			editorCallback: (editor) => this.promptForImage(editor)
		});
		this.addCommand({ id: "connect", name: "Connect Pollinations (device flow)", callback: () => this.connect() });
		this.addCommand({ id: "disconnect", name: "Disconnect Pollinations", callback: () => this.disconnect() });
		this.addSettingTab(new PollinationsSettingsTab(this, this.app));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	transport() {
		const plugin = this;
		return async function (options) {
			const res = await plugin.requestUrl({
				url: options.url,
				method: options.method || "GET",
				headers: options.headers || {},
				body: options.body,
				throw: false
			});
			const bytes = res.arrayBuffer ? Buffer.from(res.arrayBuffer) : null;
			const text = typeof res.text === "string" ? res.text : (bytes ? bytes.toString("utf8") : "");
			return { status: res.status, text: text, bytes: bytes };
		};
	}

	client() {
		return new PollinationsClient(this.transport(), () => this.getToken());
	}

	getToken() {
		return this.settings.token || this.settings.apiKey || "";
	}

	async connect() {
		new AppKeyModal(this, (appKey) => { void this.runDeviceFlow(appKey); }).open();
	}

	async runDeviceFlow(appKey) {
		const notice = new Notice("Sign-in started. Approve it in your browser.", 0);
		try {
			const result = await deviceFlow({
				appKey: appKey,
				request: this.transport(),
				openUrl: (uri) => {
					if (typeof window !== "undefined" && window.open) {
						window.open(uri, "_blank");
					} else {
						new Notice("Open this in your browser: " + uri, 0);
					}
				},
				onCode: (userCode, uri) => {
					new Notice("Your code: " + userCode, 15000);
				}
			});
			if (result.granted) {
				this.settings.token = result.accessToken;
				await this.saveSettings();
				new Notice("Pollinations connected");
			} else if (result.error === "access_denied") {
				new Notice("Sign-in was denied");
			} else {
				new Notice("Sign-in expired before approval. Try again.");
			}
		} catch (error) {
			new Notice("Sign-in failed: " + String(error.message || error), 10000);
		} finally {
			notice.hide();
		}
	}

	async disconnect() {
		this.settings.token = "";
		await this.saveSettings();
		new Notice("Pollinations disconnected");
	}

	promptForText(editor) {
		new PromptModal(this, {
			title: "Generate text",
			modality: "text",
			model: this.settings.defaultTextModel,
			placeholder: "What should Pollinations write?",
			onSubmit: (prompt, model) => { void this.insertGeneratedText(editor, prompt, model); }
		}).open();
	}

	selectionToText(editor) {
		const selection = editor.getSelection().trim();
		if (!selection) { new Notice("Select some text first"); return; }
		void this.insertGeneratedText(editor, selection, this.settings.defaultTextModel);
	}

	promptForImage(editor) {
		new PromptModal(this, {
			title: "Generate an image",
			modality: "image",
			model: this.settings.defaultImageModel,
			placeholder: "Describe the image",
			submitLabel: "Generate image",
			onSubmit: (prompt, model) => { void this.insertGeneratedImage(editor, prompt, model); }
		}).open();
	}

	async insertGeneratedText(editor, prompt, model) {
		const notice = new Notice("Generating text…", 0);
		try {
			const result = await this.client().generateText(prompt, model);
			editor.replaceSelection(result.text);
			new Notice("Text inserted at the cursor");
		} catch (error) {
			new Notice(String(error.message || error), 10000);
		} finally {
			notice.hide();
		}
	}

	async insertGeneratedImage(editor, prompt, model) {
		const notice = new Notice("Generating image…", 0);
		try {
			const image = await this.client().generateImage(prompt, model, this.settings.imageWidth, this.settings.imageHeight);
			const folder = this.settings.imageFolder || "pollinations";
			if (!(await this.app.vault.adapter.exists(folder))) {
				await this.app.vault.createFolder(folder);
			}
			const fileName = imageFileName(prompt, Date.now(), image.ext);
			const path = folder + "/" + fileName;
			const arrayBuffer = image.bytes.buffer.slice(image.bytes.byteOffset, image.bytes.byteOffset + image.bytes.byteLength);
			await this.app.vault.createBinary(path, arrayBuffer);
			editor.replaceSelection("![[" + fileName + "]]");
			new Notice("Image saved to " + path);
		} catch (error) {
			new Notice(String(error.message || error), 10000);
		} finally {
			notice.hide();
		}
	}
}

module.exports = {
	Plugin: PollinationsPlugin,
	buildTextBody: buildTextBody,
	buildImageBody: buildImageBody,
	parseChatCompletion: parseChatCompletion,
	decodeImageResponse: decodeImageResponse,
	friendlyError: friendlyError,
	imageFileName: imageFileName,
	deviceStep: deviceStep,
	deviceFlow: deviceFlow,
	PollinationsClient: PollinationsClient,
	DEFAULT_SETTINGS: DEFAULT_SETTINGS
};
