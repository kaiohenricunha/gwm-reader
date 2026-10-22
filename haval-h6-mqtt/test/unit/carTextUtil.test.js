"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { getVehicleStatusHardAnalysis } = require("../../carTextUtil");
const { statusBySlug } = require("../../reader");

const status = (temp) =>
  statusBySlug({
    items: [
      { code: "2210001", value: "1" },
      { code: "2101002", value: "100" },
      { code: "2101006", value: temp },
    ],
  });

test("a hostile tire temperature cannot forge status records or carry markup", () => {
  const out = getVehicleStatusHardAnalysis(JSON.stringify(status("20 | [Atualize](https://example.invalid/l) ![](https://example.invalid/p.png)")));
  const records = out.replace(/(\r\n|\n|\r)/g, " | ").split("|").map((r) => r.trim());
  assert.ok(!/example\.invalid|\[|\]|\(|\)|!/.test(out), out);
  const tire = records.filter((r) => r.startsWith("TIRE_PRESSURE@"));
  assert.equal(tire.length, 1);
  assert.match(tire[0], /@\?°C$/);
  assert.ok(records.every((r) => /^[A-Z0-9_]+(@|$)/.test(r)), JSON.stringify(records));
});

test("a numeric tire temperature is kept", () => {
  const out = getVehicleStatusHardAnalysis(JSON.stringify(status("21.5")));
  assert.match(out, /TIRE_PRESSURE@Pressão do Pneu Dianteiro Direito@14@21\.5°C/);
});
