"use strict";

// Small JSON state file (device id, session tokens, login attempts, halt
// flag). Replaces node-localstorage. Writes are atomic (temp file + rename).

const fs = require("node:fs");
const path = require("node:path");

class Store {
  constructor({ dir, log }) {
    this.dir = dir;
    this.file = path.join(dir, "state.json");
    this.log = log;
    fs.mkdirSync(dir, { recursive: true });
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code !== "ENOENT") this.log?.warn("state file unreadable; starting empty", { error_class: "state" });
      return {};
    }
  }

  get(key) {
    return this.data[key];
  }

  update(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete this.data[k];
      else this.data[k] = v;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
