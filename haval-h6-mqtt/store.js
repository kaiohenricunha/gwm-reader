"use strict";

// Small JSON state file (device id, session tokens, login attempts, halt
// flag). Replaces node-localstorage. The directory is kept at mode 0700 and
// every file at 0600, whatever the umask. Writes are atomic (temp + rename).

const fs = require("node:fs");
const path = require("node:path");

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

class Store {
  constructor({ dir, log }) {
    this.dir = dir;
    this.file = path.join(dir, "state.json");
    this.log = log;
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE); // mkdir does not change an existing directory, and umask applies
    if (fs.existsSync(this.file)) fs.chmodSync(this.file, FILE_MODE);
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
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: FILE_MODE });
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { DIR_MODE, FILE_MODE, Store };
