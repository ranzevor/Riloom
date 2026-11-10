import { URL } from "node:url";
import { writeFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import standalone from "ajv/dist/standalone/index.js";
import {
  commands,
  requestSchema,
  assetSchema,
  drawItemSchema,
} from "./dist/schema.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  strictNumbers: true,
  code: { source: true, esm: true },
});
ajv.addSchema(assetSchema, "asset");
ajv.addSchema(drawItemSchema, "drawing");
const exports = { assetValidator: "asset", drawingValidator: "drawing" };
const entries = [];
for (const [index, command] of Object.keys(commands).entries()) {
  const name = "request" + index;
  ajv.addSchema(requestSchema(command), name);
  exports[name] = name;
  entries.push(JSON.stringify(command) + ": " + name);
}
let code = standalone.default(ajv, exports);
code = code.replace(
  /const (\w+) = require\("([^"\n]+)"\)\.default;/g,
  'import * as $1Module from "$2.js"; const $1 = typeof $1Module.default === "function" ? $1Module.default : $1Module.default.default;',
);
code += "\nexport const requestValidators = {" + entries.join(",") + "};\n";
await writeFile(new URL("./dist/compiled.js", import.meta.url), code);
