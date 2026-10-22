"use strict";

// Derive ha/dashboard.yaml from the upstream dashboard. Run it after each
// upstream merge that changes files/HomeAssistant_Dashboard_GWM.yaml:
//   (cd haval-h6-mqtt && npm run dashboard)
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const root = path.join(__dirname, "..");
const YAML = createRequire(path.join(root, "haval-h6-mqtt", "package.json"))("yaml");
const src = path.join(root, "haval-h6-mqtt", "files", "HomeAssistant_Dashboard_GWM.yaml");
const dst = path.join(root, "ha", "dashboard.yaml");

let text = fs.readFileSync(src, "utf8").replaceAll("${VEICULO}", "h6").replaceAll("'+VEICULO.toLowerCase()+'", "h6");
const doc = YAML.parse(text);
delete doc.config_template_card_vars;

// Anything that can act on the car, track it, or embed a GWM page.
const FORBIDDEN = [/\bbutton\./, /\bswitch\./, /\bselect\./, /\block\./, /device_tracker\./, /call-service|perform-action|button\.press/, /endereco_atual/, /imagem_do_veiculo/, /gwmcloud\.com/, /^map$/, /^iframe$/, /veiculos_registrados/];
const bad = (v) => FORBIDDEN.some((re) => re.test(v));
const stats = { removed: 0, actions: 0 };

function hasForbidden(node) {
  if (typeof node === "string") return bad(node);
  if (Array.isArray(node)) return node.some(hasForbidden);
  if (node && typeof node === "object") return Object.entries(node).some(([k, v]) => (k === "type" && typeof v === "string" && bad(v)) || hasForbidden(v));
  return false;
}

function clean(node) {
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) {
      if (hasForbidden(item)) {
        // Keep a container card when only some children are forbidden.
        if (item && typeof item === "object" && !Array.isArray(item) && (item.cards || item.elements || item.entities || item.card || item.chips)) {
          const c = clean(item);
          if (!hasForbidden(c) && Object.keys(c).length) out.push(c);
          else stats.removed++;
        } else stats.removed++;
      } else out.push(clean(item));
    }
    return out;
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (/^(tap|hold|double_tap)_action$/.test(k) && hasForbidden(v)) {
        out[k] = { action: "more-info" };
        stats.actions++;
        continue;
      }
      out[k] = clean(v);
    }
    return out;
  }
  return node;
}

const cleaned = clean(doc);
if (hasForbidden(cleaned)) throw new Error("forbidden references remain");
const header =
  "# Read-only Home Assistant dashboard for gwm-reader, derived from upstream\n" +
  "# files/HomeAssistant_Dashboard_GWM.yaml (havaleiros, MIT) by\n" +
  "# removing every button, switch, select, service call, the map/device\n" +
  "# tracker, the address sensor, the GWM iframe and the GWM image URL.\n" +
  "# Entity ids use VEHICLE_ID=h6; replace \"gwmbrasil_h6_\" if you chose another id.\n";
// Render status_message parts as plain text: strip markdown/HTML characters
// from every part, and never render an unknown record (audit run-1).
const SAFE = "| regex_replace('[^0-9A-Za-zÀ-ÿ .,°%:-]', '')";
const body = YAML.stringify(cleaned, { lineWidth: 0 })
  .replace(/\{\{ partes\[(\d)\] \}\}/g, (_, n) => `{{ partes[${n}] ${SAFE} }}`)
  .replaceAll("• {{ item }}", "{# unknown record: not rendered #}");
fs.writeFileSync(dst, header + body);
console.log(JSON.stringify(stats));
