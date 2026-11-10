import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await realpath(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const ignoredDirectories = new Set([".git", ".local", "node_modules", "dist"]);
const files = [];
const errors = [];
const markdownFiles = new Map();

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await collect(filename);
    } else if (entry.isFile()) {
      files.push(filename);
    }
  }
}

function withoutCode(text) {
  return text.replace(/^([ 	]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, "");
}

function anchors(text) {
  const result = new Set();
  const counts = new Map();
  const source = withoutCode(text);
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = match[1].replace(/<[^>]+>/g, "").toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "").replace(/ /g, "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  for (const match of source.matchAll(/\bid=["']([^"']+)["']/g)) result.add(match[1]);
  return result;
}

function links(text) {
  const source = withoutCode(text).replace(/`[^`\n]*`/g, "");
  const result = [];
  for (const match of source.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)) {
    result.push(match[1] ?? match[2]);
  }
  for (const match of source.matchAll(/\[!\[[^\]\n]*\]\([^)]+\)\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
    result.push(match[1] ?? match[2]);
  }
  const definitions = new Map();
  for (const match of source.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) {
    definitions.set(match[1].toLowerCase(), match[2]);
    result.push(match[2]);
  }
  for (const match of source.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const label = (match[2] || match[1]).toLowerCase();
    if (definitions.has(label)) {
      result.push(definitions.get(label));
    } else {
      errors.push(`Undefined link reference [${label}]`);
    }
  }
  return result;
}

function withinRoot(filename) {
  const relative = path.relative(root, filename);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

await collect(root);
for (const filename of files) {
  const relative = path.relative(root, filename);
  const extension = path.extname(filename);
  const isMarkdown = extension === ".md" || relative === "LICENSE";
  const isText = isMarkdown || [".json", ".yml", ".yaml", ".mjs", ".txt"].includes(extension)
    || [".editorconfig", ".gitattributes", ".gitignore", "DCO", ".github/CODEOWNERS"].includes(relative.replaceAll("\\", "/"));
  if (!isText) continue;
  const buffer = await readFile(filename);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    errors.push(`${relative}: invalid UTF-8`);
    continue;
  }
  if (text.startsWith("\uFEFF")) errors.push(`${relative}: UTF-8 BOM`);
  if (text.includes("\r")) errors.push(`${relative}: expected LF line endings`);
  if (text && !text.endsWith("\n")) errors.push(`${relative}: missing final newline`);
  if (extension === ".json") {
    try {
      JSON.parse(text);
    } catch (error) {
      errors.push(`${relative}: ${error.message}`);
    }
  }
  if (isMarkdown) markdownFiles.set(filename, { text, anchors: anchors(text) });
}

let linkCount = 0;
for (const [filename, document] of markdownFiles) {
  for (const target of links(document.text)) {
    if (/^(https?:|mailto:)/i.test(target)) continue;
    linkCount++;
    const label = `${path.relative(root, filename)} -> ${target}`;
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) throw new Error("unsupported link protocol");
      const [pathname, fragment] = target.split("#", 2);
      const resolved = pathname
        ? path.resolve(path.dirname(filename), decodeURIComponent(pathname))
        : filename;
      if (!withinRoot(resolved)) throw new Error("link leaves the repository");
      const actual = await realpath(resolved);
      if (!withinRoot(actual)) throw new Error("link resolves outside the repository");
      if (!(await stat(actual)).isFile()) throw new Error("link must name a file");
      if (fragment && !markdownFiles.get(actual)?.anchors.has(decodeURIComponent(fragment))) {
        throw new Error("missing document anchor");
      }
    } catch (error) {
      errors.push(`${label}: ${error.code === "ENOENT" ? "missing target" : error.message}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${markdownFiles.size} Markdown documents and ${linkCount} local links; JSON and text format checks passed.`);
}
