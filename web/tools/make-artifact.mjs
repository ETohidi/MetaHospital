// Writes dist/artifact.html: index.html without its document skeleton (doctype, html,
// head, body, charset/viewport metas), which the claude.ai artifact host adds itself.
// Everything else - styles/, src/ - is published alongside it unchanged.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
const head = page.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = page.match(/<body>([\s\S]*?)<\/body>/)[1];
const cleanHead = head
  .split("\n")
  .filter((line) => !/<meta (charset|name="viewport")/.test(line))
  .join("\n");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "artifact.html"), `${cleanHead.trim()}\n${body.trim()}\n`);
console.log("wrote dist/artifact.html");
