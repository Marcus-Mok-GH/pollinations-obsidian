/* Minimal in-memory stubs for the Obsidian API, used only by tests/run.js. */
class Emitter { on() {} off() {} }
class Plugin extends Emitter {
	constructor() { super(); this.commands = {}; this.settingTabs = []; this.settings = {}; }
	addCommand(cmd) { this.commands[cmd.id] = cmd; return cmd; }
	addSettingTab(tab) { this.settingTabs.push(tab); }
	register() {}
	async loadData() { return this._data || null; }
	async saveData(data) { this._data = data; }
}
class Notice {
	constructor(message, duration) { this.message = String(message); this.duration = duration; Notice.log.push(this.message); }
	hide() {}
}
Notice.log = [];
class Modal {
	constructor(app) { this.app = app; this.contentEl = { createEl: () => ({ classList: { add() {} }, setText() {} }), createDiv: () => ({ createEl: () => ({ classList: { add() {} }, setText() {} }) }) }; }
	open() {}
	close() {}
}
class FuzzySuggestModal extends Modal {}
class PluginSettingTab {
	constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = { empty() {} }; }
	display() {}
}
class Setting {
	constructor(el) { this.el = el; this._desc = ""; }
	setName() { return this; }
	setDesc() { return this; }
	addText(cb) { cb({ setValue: () => {}, onChange: async () => {} }); return this; }
	addButton(cb) { cb({ setButtonText: () => ({ onClick: () => {} }) }); return this; }
}
module.exports = { Plugin, Notice, Modal, FuzzySuggestModal, PluginSettingTab, Setting };
