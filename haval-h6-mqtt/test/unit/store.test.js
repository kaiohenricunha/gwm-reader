"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { Store } = require("../../store");
const { tmpDir } = require("./helpers");

const mode = (p) => fs.statSync(p).mode & 0o777;

test("the data directory is 0700 and the state file 0600, even with a loose umask", () => {
  const old = process.umask(0o000);
  try {
    const dir = path.join(tmpDir(), "data");
    const s = new Store({ dir });
    s.update({ deviceid: "x" });
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(path.join(dir, "state.json")), 0o600);
  } finally {
    process.umask(old);
  }
});

test("an existing loose directory and file are tightened on start", () => {
  const dir = tmpDir();
  fs.chmodSync(dir, 0o777);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ a: 1 }), { mode: 0o666 });
  fs.chmodSync(path.join(dir, "state.json"), 0o666);
  const s = new Store({ dir });
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, "state.json")), 0o600);
  assert.equal(s.get("a"), 1);
});

test("values persist across instances; undefined deletes; corrupt files start empty", () => {
  const dir = tmpDir();
  new Store({ dir }).update({ a: 1, b: 2 });
  const s = new Store({ dir });
  s.update({ b: undefined });
  assert.deepEqual(new Store({ dir }).data, { a: 1 });
  fs.writeFileSync(path.join(dir, "state.json"), "{not json");
  assert.deepEqual(new Store({ dir }).data, {});
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});
