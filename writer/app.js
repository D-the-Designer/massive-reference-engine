/* ════════════════════════════════════════════════════════════════
   Writer 0.1 — local-first writing app with modular AI assistance.

   Principles enforced in code (see UX spec):
   - Writing stays primary; AI is a command surface.
   - No invisible replacement: every AI transformation goes through
     a pre-flight disclosure and a diff preview before touching text.
   - Context is visible: operation, model, context items, and scope
     are shown before submission and recorded on acceptance.
   - The project survives the app: plain Markdown files, optional
     writer-project.json, revisions stored separately as JSON.
   - Exports create copies; the source document is never replaced.
   ════════════════════════════════════════════════════════════════ */
"use strict";

/* ── tiny helpers ─────────────────────────────────────────────── */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ── constants ────────────────────────────────────────────────── */
const STORE_KEY = "writer.project.v1";
const GEMINI_SECRET_KEY = "writer.secret.gemini";
const GROQ_SECRET_KEY = "writer.secret.groq";
const OPENROUTER_SECRET_KEY = "writer.secret.openrouter";
const RECOVERY_KEY = "writer.recovery.v1";
const FIRST_RUN_KEY = "writer.firstRun.seen.v1";
const FOLDERS = [
  { key: "manuscript", label: "Manuscript" },
  { key: "outline", label: "Outline" },
  { key: "lore", label: "Lore & style" },
  { key: "sources", label: "Sources" },
];
const DAV_STATES = ["RAW", "WORKING", "REVIEW", "APPROVED", "FINAL", "ARCHIVED"];
const KNOWLEDGE_ROLES = {
  lore: { label: "Lore / Production Bible", folder: "lore" },
  style: { label: "Style guide", folder: "lore" },
  source: { label: "Research source", folder: "sources" },
};
const PRIVACY = {
  local: { label: "Local-only", desc: "Cloud models are blocked. Nothing leaves this device." },
  hybrid: { label: "Hybrid", desc: "Cloud models allowed, but each cloud request needs an explicit per-request approval." },
  cloud: { label: "Cloud-enabled", desc: "Cloud models allowed after a one-time consent." },
};
const FICTION_MODELS = [
  {
    name: "Erebus v3 7B · Q4_K_M",
    category: "Adult fiction",
    modelId: "hf.co/KoboldAI/Mistral-7B-Erebus-v3-GGUF:Q4_K_M",
    url: "https://huggingface.co/KoboldAI/Mistral-7B-Erebus-v3-GGUF",
    license: "Apache 2.0",
    size: "about 4.4 GB",
    note: "Recommended local starting point for explicit fiction. Runs comfortably in the same hardware class as Qwen 8B.",
  },
  {
    name: "Tiefighter 13B · Q4_K_M",
    category: "Hybrid fiction / roleplay",
    modelId: "hf.co/KoboldAI/LLaMA2-13B-Tiefighter-GGUF:Q4_K_M",
    url: "https://huggingface.co/KoboldAI/LLaMA2-13B-Tiefighter-GGUF",
    license: "Llama 2",
    size: "about 7.9 GB",
    note: "Stronger, slower model for novels, roleplay, chat, and adventures; includes adult-capable upstream material.",
  },
  {
    name: "BookAdventures 8B",
    category: "Novel / adventure",
    url: "https://huggingface.co/KoboldAI/Llama-3.1-8B-BookAdventures-GGUF",
    license: "Check model card",
    size: "varies by quant",
    note: "Newer KoboldAI book and adventure model for general story writing.",
  },
  {
    name: "Infinity3M Kobo 8B",
    category: "Long-form fiction",
    url: "https://huggingface.co/KoboldAI/LLaMA-3.1-8B-Infinity3M-Kobo",
    license: "Check model card",
    size: "varies by quant",
    note: "Newer KoboldAI fiction option; inspect available quantizations before installing.",
  },
];

/* ── state ────────────────────────────────────────────────────── */
let project = null;          // the whole persisted project object
let dirHandle = null;        // File System Access directory handle (optional)
let geminiKey = null;
let groqKey = null;
let openRouterKey = null;
let pendingOp = null;        // the AI operation currently in preflight/diff
let pendingKnowledgeFile = null;
let ollamaModels = null;     // detected model list, session only
let koboldModels = null;     // model currently loaded by KoboldAI/KoboldCpp

function defaultProject() {
  const now = Date.now();
  const mk = (folder, name, content, role = folder === "manuscript" ? "manuscript" : folder === "outline" ? "outline" : folder === "sources" ? "source" : "lore") => ({
    id: uid(), folder, name, content, role,
    state: folder === "manuscript" || folder === "outline" ? "WORKING" : "APPROVED",
    tags: [], created: now, modified: now,
  });
  const docs = [
    mk("manuscript", "Chapter One", "The harbor was quiet at that hour, and the water held the color of old pewter.\n\nMara counted the boats twice before she let herself believe one was missing. It was really just the small blue skiff, the one nobody trusted past the breakwater, but its absence sat in her chest like a stone.\n\nShe walked the length of the dock very slowly, listening.\n"),
    mk("outline", "Outline", "# Working outline\n\n1. Mara notices the missing skiff at dawn.\n2. The harbormaster claims nothing is wrong.\n3. A note, half-soaked, names her brother.\n"),
    mk("lore", "Style guide", "# Style guide\n\n- Close third person, past tense, single POV per scene.\n- Plain, concrete language; no more than one metaphor per paragraph.\n- Sentences average short; vary rhythm at scene turns.\n"),
    mk("lore", "Lore: The Harbor", "# The Harbor\n\nA fishing town of about 900 people. The breakwater was rebuilt after the storm of '31; older residents still call the ruined arm \"the old teeth.\"\n"),
    mk("sources", "Research notes", "# Research notes\n\n- Tide tables: two tides daily, roughly 6h13m apart.\n- Skiffs of this size can't safely cross the bar after force 5.\n"),
  ];
  return {
    version: 1,
    name: "My Project",
    created: now,
    docs,
    activeDocId: docs[0].id,
    chat: [],
    revisions: [],
    privacyReceipts: [],
    settings: {
      theme: "parchment",
      font: "serif",
      size: 17,
      privacy: "local",
      providerId: "preview",
      modelId: "preview",
      cloudConsent: false,
      ollamaHost: "http://localhost:11434",
      ollamaModel: "qwen3:8b",
      koboldHost: "http://localhost:5001",
      koboldModel: "Kobold writing model",
      koboldTemperature: 0.8,
      koboldRepPenalty: 1.1,
      koboldMaxTokens: 512,
      geminiModel: "gemini-2.5-flash",
      groqModel: "qwen/qwen3.6-27b",
      openRouterModel: "openrouter/free",
      panels: { project: true, sidecar: true },
      contextChecked: null, // filled on first use
    },
  };
}

function ensureProjectSchema() {
  project.version = Math.max(Number(project.version) || 1, 2);
  project.docs.forEach((doc) => {
    doc.role ||= doc.folder === "manuscript" ? "manuscript" : doc.folder === "outline" ? "outline" : doc.folder === "sources" ? "source" : /style/i.test(doc.name) ? "style" : "lore";
    doc.state = DAV_STATES.includes(doc.state) ? doc.state : (doc.folder === "manuscript" || doc.folder === "outline" ? "WORKING" : "APPROVED");
    doc.tags = Array.isArray(doc.tags) ? doc.tags : [];
  });
  project.training ||= { captureApproved: true, updated: Date.now() };
}

function loadProject() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.docs) && p.docs.length) return p;
    }
  } catch (e) { console.warn("Writer: could not load saved project", e); }
  return defaultProject();
}

function writeRecoverySnapshot(reason = "autosave") {
  try {
    flushEditor();
    const snapshot = { savedAt: Date.now(), reason, project };
    localStorage.setItem(RECOVERY_KEY, JSON.stringify(snapshot));
    const el = $("#status-recovery");
    if (el) el.textContent = "Recovery " + new Date(snapshot.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    console.warn("Writer: recovery snapshot failed", e);
  }
}

const persist = debounce(() => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(project));
    writeRecoverySnapshot("autosave");
    $("#status-save").textContent = dirHandle ? "Saved · syncing folder…" : "Saved";
  } catch (e) {
    console.error(e);
    $("#status-save").textContent = "Save failed";
  }
  if (dirHandle) fsSyncSoon();
}, 400);

function markDirty() {
  $("#status-save").textContent = "Saving…";
  persist();
}

/* ── doc accessors ────────────────────────────────────────────── */
const activeDoc = () => project.docs.find((d) => d.id === project.activeDocId) || project.docs[0];
const docsIn = (folder) => project.docs.filter((d) => d.folder === folder);

function setActiveDoc(id) {
  flushEditor();
  project.activeDocId = id;
  renderProjectPanel();
  renderEditor();
  markDirty();
}

function addDoc(folder) {
  const name = window.prompt(`Name for the new ${folder} document:`, "Untitled");
  if (name === null) return;
  const now = Date.now();
  const doc = {
    id: uid(), folder, name: name.trim() || "Untitled", content: "",
    role: folder === "manuscript" ? "manuscript" : folder === "outline" ? "outline" : folder === "sources" ? "source" : "lore",
    state: "WORKING", tags: [], created: now, modified: now,
  };
  project.docs.push(doc);
  setActiveDoc(doc.id);
  toast(`Added “${doc.name}” to ${folder}.`);
}

/* ── Word (.docx) import — local, dependency-free, source unchanged ── */
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

function wordAttr(el, name) {
  return el?.getAttributeNS(WORD_NS, name) || el?.getAttribute("w:" + name) || el?.getAttribute(name) || "";
}

function wordChildren(el, name) {
  return Array.from(el?.children || []).filter((child) => child.localName === name);
}

function wordDesc(el, name) {
  return Array.from(el?.getElementsByTagNameNS(WORD_NS, name) || []);
}

function escapeMarkdownText(text) {
  return String(text || "").replace(/([\\`*_{}\[\]<>])/g, "\\$1");
}

async function unzipEntry(bytes, wantedName) {
  const view = new DataView(bytes);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === ZIP_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This does not appear to be a valid .docx file.");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== ZIP_CENTRAL) throw new Error("The Word file has an unsupported ZIP directory.");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(bytes, offset + 46, nameLength));
    if (name === wantedName) {
      if (view.getUint32(localOffset, true) !== ZIP_LOCAL) throw new Error("The Word file contains an invalid entry.");
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = new Uint8Array(bytes.slice(start, start + compressedSize));
      if (method === 0) return compressed;
      if (method !== 8 || typeof DecompressionStream === "undefined") throw new Error("This browser cannot decompress this Word file.");
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function parseWordXml(bytes, label) {
  if (!bytes) return null;
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  if (xml.querySelector("parsererror")) throw new Error(`Word ${label} XML could not be read.`);
  return xml;
}

function wordNumberFormats(numberingXml) {
  const formats = new Map();
  if (!numberingXml) return formats;
  const abstract = new Map();
  for (const node of wordDesc(numberingXml, "abstractNum")) {
    const id = wordAttr(node, "abstractNumId");
    const level = wordDesc(node, "lvl")[0];
    abstract.set(id, wordAttr(wordDesc(level, "numFmt")[0], "val") || "decimal");
  }
  for (const node of wordDesc(numberingXml, "num")) {
    const id = wordAttr(node, "numId");
    const abstractId = wordAttr(wordDesc(node, "abstractNumId")[0], "val");
    formats.set(id, abstract.get(abstractId) || "decimal");
  }
  return formats;
}

function wordRunMarkdown(run) {
  let text = "";
  for (const node of Array.from(run.childNodes || [])) {
    if (node.localName === "t" || node.localName === "instrText") text += node.textContent || "";
    else if (node.localName === "tab") text += "\t";
    else if (node.localName === "br" || node.localName === "cr") text += "  \n";
  }
  text = escapeMarkdownText(text);
  if (!text) return "";
  const props = wordChildren(run, "rPr")[0];
  if (wordChildren(props, "b").length) text = `**${text}**`;
  if (wordChildren(props, "i").length) text = `*${text}*`;
  if (wordChildren(props, "u").length) text = `<u>${text}</u>`;
  return text;
}

function wordParagraphMarkdown(paragraph, links, numberFormats) {
  let text = "";
  for (const child of Array.from(paragraph.children || [])) {
    if (child.localName === "r") text += wordRunMarkdown(child);
    else if (child.localName === "hyperlink") {
      const linked = wordChildren(child, "r").map(wordRunMarkdown).join("");
      const target = links.get(child.getAttributeNS(REL_NS, "id") || child.getAttribute("r:id"));
      text += target ? `[${linked}](${target})` : linked;
    }
  }
  const props = wordChildren(paragraph, "pPr")[0];
  const style = wordAttr(wordChildren(props, "pStyle")[0], "val").toLowerCase();
  if (/^(title|heading1|heading 1)$/.test(style)) return "# " + text;
  if (/^(subtitle|heading2|heading 2)$/.test(style)) return "## " + text;
  if (/^(heading3|heading 3)$/.test(style)) return "### " + text;
  if (/quote/.test(style)) return "> " + text;
  const numPr = wordChildren(props, "numPr")[0];
  if (numPr) {
    const numId = wordAttr(wordChildren(numPr, "numId")[0], "val");
    return (numberFormats.get(numId) === "bullet" ? "- " : "1. ") + text;
  }
  return text;
}

function wordTableMarkdown(table, links, numberFormats) {
  const rows = wordChildren(table, "tr").map((row) =>
    wordChildren(row, "tc").map((cell) =>
      wordChildren(cell, "p").map((p) => wordParagraphMarkdown(p, links, numberFormats)).join("<br>").replace(/\|/g, "\\|")
    )
  ).filter((row) => row.length);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: width }, (_, i) => row[i] || ""));
  return [
    `| ${normalized[0].join(" | ")} |`,
    `| ${normalized[0].map(() => "---").join(" | ")} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

async function docxToMarkdown(file) {
  if (!/\.docx$/i.test(file.name)) throw new Error("Choose a Word .docx file.");
  if (file.size > 50 * 1024 * 1024) throw new Error("That Word file is larger than Writer's 50 MB import limit.");
  const bytes = await file.arrayBuffer();
  const [documentBytes, relBytes, numberingBytes] = await Promise.all([
    unzipEntry(bytes, "word/document.xml"),
    unzipEntry(bytes, "word/_rels/document.xml.rels"),
    unzipEntry(bytes, "word/numbering.xml"),
  ]);
  if (!documentBytes) throw new Error("The file does not contain an editable Word document.");
  const documentXml = parseWordXml(documentBytes, "document");
  const relXml = parseWordXml(relBytes, "relationships");
  const numberingXml = parseWordXml(numberingBytes, "numbering");
  const links = new Map(Array.from(relXml?.getElementsByTagName("Relationship") || []).map((rel) => [rel.getAttribute("Id"), rel.getAttribute("Target")]));
  const numberFormats = wordNumberFormats(numberingXml);
  const body = wordDesc(documentXml, "body")[0];
  const blocks = Array.from(body?.children || []).map((block) => {
    if (block.localName === "p") return wordParagraphMarkdown(block, links, numberFormats);
    if (block.localName === "tbl") return wordTableMarkdown(block, links, numberFormats);
    return "";
  });
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function rtfToMarkdown(source) {
  if (!/^\s*\{\\rtf/i.test(source)) throw new Error("This does not appear to be a valid RTF document.");
  const destinations = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer", "footnote", "filetbl", "listtable", "listoverridetable", "generator"]);
  const stack = [];
  let state = { bold: false, italic: false, underline: false, skip: false, uc: 1 };
  let rendered = { bold: false, italic: false, underline: false };
  let out = "";
  let skipUnicodeFallback = 0;
  const marker = { bold: "**", italic: "*", underline: "<u>" };
  const closer = { bold: "**", italic: "*", underline: "</u>" };
  const sync = (next) => {
    if (rendered.bold === next.bold && rendered.italic === next.italic && rendered.underline === next.underline) return;
    for (const key of ["underline", "italic", "bold"]) if (rendered[key]) out += closer[key];
    for (const key of ["bold", "italic", "underline"]) if (next[key]) out += marker[key];
    rendered = { bold: next.bold, italic: next.italic, underline: next.underline };
  };
  const append = (text) => {
    if (state.skip || !text) return;
    sync(state);
    out += escapeMarkdownText(text);
  };
  const paragraph = () => {
    if (state.skip) return;
    sync({ bold: false, italic: false, underline: false });
    out = out.replace(/[ \t]+$/g, "") + "\n\n";
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") { stack.push({ ...state }); continue; }
    if (char === "}") {
      const restored = stack.pop();
      if (restored) {
        const wasSkipped = state.skip;
        state = restored;
        if (!wasSkipped && !state.skip) sync(state);
      }
      continue;
    }
    if (char !== "\\") {
      if (skipUnicodeFallback > 0) { skipUnicodeFallback--; continue; }
      append(char === "\r" || char === "\n" ? "" : char);
      continue;
    }
    const symbol = source[++i];
    if (symbol === "\\" || symbol === "{" || symbol === "}") { append(symbol); continue; }
    if (symbol === "'") {
      const hex = source.slice(i + 1, i + 3);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        if (skipUnicodeFallback > 0) skipUnicodeFallback--;
        else append(new TextDecoder("windows-1252").decode(Uint8Array.of(parseInt(hex, 16))));
        i += 2;
      }
      continue;
    }
    if (symbol === "*") { state.skip = true; continue; }
    if (symbol === "~") { append(" "); continue; }
    if (symbol === "_") { append("-"); continue; }
    if (!/[a-z]/i.test(symbol || "")) continue;
    let word = symbol;
    while (/[a-z]/i.test(source[i + 1] || "")) word += source[++i];
    let sign = 1;
    if (source[i + 1] === "-") { sign = -1; i++; }
    let digits = "";
    while (/\d/.test(source[i + 1] || "")) digits += source[++i];
    const hasValue = digits.length > 0;
    const value = hasValue ? sign * Number(digits) : 1;
    if (source[i + 1] === " ") i++;
    word = word.toLowerCase();
    if (destinations.has(word)) { state.skip = true; continue; }
    if (state.skip) continue;
    if (word === "b") state.bold = value !== 0;
    else if (word === "i") state.italic = value !== 0;
    else if (word === "ul") state.underline = value !== 0;
    else if (word === "ulnone") state.underline = false;
    else if (word === "plain") state = { ...state, bold: false, italic: false, underline: false };
    else if (word === "par") paragraph();
    else if (word === "line") append("  \n");
    else if (word === "tab") append("\t");
    else if (word === "emdash") append("—");
    else if (word === "endash") append("–");
    else if (word === "bullet") append("•");
    else if (word === "lquote" || word === "rquote") append("’");
    else if (word === "ldblquote" || word === "rdblquote") append("”");
    else if (word === "uc") state.uc = Math.max(0, value);
    else if (word === "u") {
      append(String.fromCodePoint(value < 0 ? value + 65536 : value));
      skipUnicodeFallback = state.uc;
    }
    sync(state);
  }
  sync({ bold: false, italic: false, underline: false });
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function readImportFile(file) {
  if (file.size > 50 * 1024 * 1024) throw new Error("That file is larger than Writer's 50 MB import limit.");
  const extension = (file.name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  if (extension === "docx") return docxToMarkdown(file);
  if (extension === "rtf") return rtfToMarkdown(await file.text());
  if (extension === "txt" || extension === "md" || extension === "markdown") return file.text();
  throw new Error("Choose a .docx, .txt, .rtf, or .md file.");
}

async function importDocument(file, options = {}) {
  try {
    const content = await readImportFile(file);
    const now = Date.now();
    const sourceName = file.name.replace(/\.(docx|txt|rtf|md|markdown)$/i, "").trim() || "Imported document";
    const requestedName = options.keepSourceName ? sourceName : `${sourceName} — Writer Copy`;
    let name = requestedName;
    let copyNumber = 2;
    while (project.docs.some((existing) => existing.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      name = `${requestedName} ${copyNumber++}`;
    }
    const folder = options.folder || "manuscript";
    const doc = {
      id: uid(), folder, name, content,
      role: options.role || (folder === "sources" ? "source" : folder === "lore" ? "lore" : "manuscript"),
      state: options.state || (folder === "manuscript" ? "WORKING" : "APPROVED"),
      tags: options.tags || [], created: now, modified: now, importedFrom: file.name,
    };
    project.docs.push(doc);
    setActiveDoc(doc.id);
    toast(`Opened “${file.name}” as “${name}”. This is a Writer copy; the original file will never be overwritten.`, 6200);
  } catch (error) {
    toast("Could not open document: " + error.message, 5200);
  }
}

/* write the textarea back into the active doc */
function flushEditor() {
  const doc = activeDoc();
  const ta = $("#editor");
  if (doc && ta.value !== doc.content) {
    doc.content = ta.value;
    doc.modified = Date.now();
  }
}

/* ══════════════════════════════════════════════════════════════
   Markdown rendering (small, dependency-free, escaped-first)
   ══════════════════════════════════════════════════════════════ */
function inlineMd(s) {
  let out = esc(s);
  // whitelist the two inline HTML forms Writer itself inserts
  out = out.replace(/&lt;u&gt;/g, "<u>").replace(/&lt;\/u&gt;/g, "</u>");
  out = out.replace(/&lt;span style=&quot;color:(#[0-9a-fA-F]{3,8})&quot;&gt;/g, '<span style="color:$1">').replace(/&lt;\/span&gt;/g, "</span>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/\*([^*]+)\*/g, "<i>$1</i>");
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return out;
}

function renderMarkdown(src) {
  const lines = String(src || "").split("\n");
  const out = [];
  let list = null; // 'ul' | 'ol'
  let inCode = false, codeBuf = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) { out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`); codeBuf = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) { closeList(); out.push(`<blockquote>${inlineMd(bq[1])}</blockquote>`); continue; }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") continue;
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
  closeList();
  return out.join("\n");
}

/* ══════════════════════════════════════════════════════════════
   Word-level diff (LCS)
   ══════════════════════════════════════════════════════════════ */
function diffTokens(a, b) {
  const ta = a.match(/\S+\s*|\s+/g) || [];
  const tb = b.match(/\S+\s*|\s+/g) || [];
  if (ta.length * tb.length > 600000) return null; // too big; caller falls back
  const n = ta.length, m = tb.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = ta[i] === tb[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  const push = (type, text) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { push("eq", ta[i]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { push("del", ta[i]); i++; }
    else { push("ins", tb[j]); j++; }
  }
  while (i < n) { push("del", ta[i]); i++; }
  while (j < m) { push("ins", tb[j]); j++; }
  return ops;
}

function diffHtml(a, b) {
  const ops = diffTokens(a, b);
  if (!ops) return { left: esc(a), right: esc(b) };
  let left = "", right = "";
  for (const op of ops) {
    if (op.type === "eq") { left += esc(op.text); right += esc(op.text); }
    else if (op.type === "del") left += `<span class="d-del">${esc(op.text)}</span>`;
    else right += `<span class="d-ins">${esc(op.text)}</span>`;
  }
  return { left, right };
}

/* ══════════════════════════════════════════════════════════════
   Providers — replaceable model adapters
   Each: { id, name, kind: 'local'|'cloud', models(), call({system, messages, op}) }
   ══════════════════════════════════════════════════════════════ */
const FILLER = /\b(very|really|just|quite|actually|basically|simply|totally|rather|somewhat)\s+/gi;

const PreviewProvider = {
  id: "preview",
  name: "Preview (no AI)",
  kind: "local",
  note: "Built-in canned transforms so the full workflow can be tested with no model connected. Output is deterministic, not intelligent.",
  models: () => [{ id: "preview", label: "Canned transforms", provider: "preview" }],
  async call({ messages, op }) {
    await new Promise((r) => setTimeout(r, 250));
    const passage = (op && op.text) || (messages[messages.length - 1] || {}).content || "";
    switch (op && op.kind) {
      case "rewrite": {
        const t = passage.replace(FILLER, "").replace(/[ \t]{2,}/g, " ").replace(/ +([,.;!?])/g, "$1");
        return t === passage ? passage.replace(/\.\s+/g, ". ").trim() : t;
      }
      case "shorten": {
        const sentences = passage.match(/[^.!?\n]+[.!?]*\s*/g) || [passage];
        const target = Math.max(1, Math.ceil(sentences.length * 0.6));
        return sentences.slice(0, target).join("").trim();
      }
      case "expand":
        return passage.trim() + "\n\n[Preview provider placeholder — connect Ollama or a cloud model in Tools ▸ Providers to generate real prose here.]";
      case "continue":
        return "[Preview provider placeholder — connect Ollama or a cloud model in Tools ▸ Providers, then Continue will draft real prose from the text before the cursor.]";
      case "guided":
        return "[Preview placeholder — Guided Write will follow your direction when a model is connected.]";
      case "describe":
        return passage.trim() + "\n\n[Preview placeholder — Describe will add selective sensory detail when a model is connected.]";
      case "brainstorm":
        return "1. Reverse the apparent goal.\n2. Make the ally's solution create a harder choice.\n3. Let an established setting detail become the obstacle.\n\n[Preview placeholder — connect a model for story-specific ideas.]";
      case "firstdraft":
        return "[Preview placeholder — First Draft will generate a complete scene from the outline and Story Bible when a model is connected.]";
      case "feedback":
        return "[Preview placeholder — Feedback will provide an editorial critique when a model is connected.]";
      default:
        return "This is the built-in Preview provider — a canned responder with no model behind it, here so you can try the workflow. Everything I \"write\" is a fixed placeholder. Connect a local model (Ollama) or a cloud model in Tools ▸ Providers & models for real assistance. Your message and selected context never left this device.";
    }
  },
};

const OllamaProvider = {
  id: "ollama",
  name: "Ollama (local)",
  kind: "local",
  note: "Talks to a local Ollama server. Nothing leaves this device.",
  models() {
    if (ollamaModels && ollamaModels.length) return ollamaModels.map((m) => ({ id: m, label: m, provider: "ollama" }));
    return [{ id: project.settings.ollamaModel, label: project.settings.ollamaModel + " (configured)", provider: "ollama" }];
  },
  async detect() {
    const res = await fetch(project.settings.ollamaHost.replace(/\/$/, "") + "/api/tags");
    if (!res.ok) throw new Error("Ollama responded " + res.status);
    const data = await res.json();
    ollamaModels = (data.models || []).map((m) => m.name);
    return ollamaModels;
  },
  async call({ system, messages }) {
    const res = await fetch(project.settings.ollamaHost.replace(/\/$/, "") + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: project.settings.modelId,
        stream: false,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });
    if (!res.ok) throw new Error("Ollama error " + res.status + " — is the model pulled? (ollama pull " + project.settings.modelId + ")");
    const data = await res.json();
    let text = (data.message && data.message.content) || "";
    text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, ""); // strip reasoning blocks some local models emit
    return text.trim();
  },
};

const KoboldProvider = {
  id: "kobold",
  name: "KoboldAI / KoboldCpp (local)",
  kind: "local",
  note: "Uses the writing model already loaded by a local KoboldAI or KoboldCpp server. Nothing leaves this device.",
  models() {
    const models = koboldModels && koboldModels.length ? koboldModels : [project.settings.koboldModel || "Kobold writing model"];
    return models.map((m) => ({ id: m, label: m + (koboldModels ? "" : " (configured)"), provider: "kobold" }));
  },
  async detect() {
    const host = project.settings.koboldHost.replace(/\/$/, "");
    let names = [];
    try {
      const res = await fetch(host + "/api/v1/model");
      if (res.ok) {
        const data = await res.json();
        const name = data.result || data.model || data.name;
        if (name) names = [String(name)];
      }
    } catch (_) { /* try the OpenAI-compatible endpoint below */ }
    if (!names.length) {
      const res = await fetch(host + "/v1/models");
      if (!res.ok) throw new Error("Kobold server responded " + res.status);
      const data = await res.json();
      names = (data.data || []).map((m) => m.id).filter(Boolean);
    }
    if (!names.length) throw new Error("Server reachable, but no loaded model was reported.");
    koboldModels = names;
    project.settings.koboldModel = names[0];
    return names;
  },
  async call({ system, messages }) {
    const host = project.settings.koboldHost.replace(/\/$/, "");
    const prompt = [system, ...messages.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`), "Assistant:"].join("\n\n");
    const res = await fetch(host + "/api/v1/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        max_length: Number(project.settings.koboldMaxTokens) || 512,
        temperature: Number(project.settings.koboldTemperature) || 0.8,
        rep_pen: Number(project.settings.koboldRepPenalty) || 1.1,
        stop_sequence: ["\nUser:", "\n\nUser:"],
      }),
    });
    if (!res.ok) throw new Error("Kobold error " + res.status + " — is KoboldAI/KoboldCpp running with a model loaded?");
    const data = await res.json();
    const text = data.results && data.results[0] && data.results[0].text;
    if (!text) throw new Error("Kobold returned no generated text.");
    return String(text).trim();
  },
};

const GeminiProvider = {
  id: "gemini", name: "Gemini API (free tier)", kind: "cloud",
  note: "Google offers limited free-tier usage. Requests leave this device; free-tier content may be used to improve Google products.",
  models: () => [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (free tier)", provider: "gemini" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite (free tier)", provider: "gemini" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (free tier limits)", provider: "gemini" },
  ],
  async call({ system, messages }) {
    if (!geminiKey) throw new Error("No Gemini API key set. Tools ▸ Providers & models.");
    const model = encodeURIComponent(project.settings.modelId || project.settings.geminiModel);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })), generationConfig: { temperature: 0.8, maxOutputTokens: 2048 } }),
    });
    if (!res.ok) throw new Error("Gemini error " + res.status + ": " + (await res.text()).slice(0, 180));
    const data = await res.json();
    return (((data.candidates || [])[0] || {}).content?.parts || []).map((p) => p.text || "").join("").trim();
  },
};

function openAICompatibleProvider({ id, name, note, models, key, host }) {
  return { id, name, kind: "cloud", note, models: () => models,
    async call({ system, messages }) {
      const apiKey = key();
      if (!apiKey) throw new Error(`No ${name} API key set. Tools ▸ Providers & models.`);
      const res = await fetch(host, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + apiKey }, body: JSON.stringify({ model: project.settings.modelId, messages: [{ role: "system", content: system }, ...messages], temperature: 0.8, max_tokens: 2048 }) });
      if (!res.ok) throw new Error(name + " error " + res.status + ": " + (await res.text()).slice(0, 180));
      const data = await res.json();
      return (((data.choices || [])[0] || {}).message?.content || "").trim();
    }
  };
}

const GroqProvider = openAICompatibleProvider({
  id: "groq", name: "Groq (free plan)", note: "Fast hosted inference with published free-plan rate limits. Requests leave this device.",
  key: () => groqKey, host: "https://api.groq.com/openai/v1/chat/completions",
  models: [
    { id: "qwen/qwen3.6-27b", label: "Qwen 3.6 27B (free plan)", provider: "groq" },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (free plan)", provider: "groq" },
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B (free plan, open-weight)", provider: "groq" },
  ],
});

const OpenRouterProvider = openAICompatibleProvider({
  id: "openrouter", name: "OpenRouter (free models)", note: "Routes to currently available free models; availability and low rate limits vary. Requests leave this device.",
  key: () => openRouterKey, host: "https://openrouter.ai/api/v1/chat/completions",
  models: [{ id: "openrouter/free", label: "Free Models Router (model varies)", provider: "openrouter" }],
});

const PROVIDERS = { preview: PreviewProvider, ollama: OllamaProvider, kobold: KoboldProvider, gemini: GeminiProvider, groq: GroqProvider, openrouter: OpenRouterProvider };
const currentProvider = () => PROVIDERS[project.settings.providerId] || PreviewProvider;
const currentModelLabel = () => {
  const p = currentProvider();
  const m = p.models().find((m) => m.id === project.settings.modelId);
  return (m ? m.label : project.settings.modelId) + " · " + p.name;
};
const leavesDevice = () => currentProvider().kind === "cloud";

function setModel(providerId, modelId) {
  project.settings.providerId = providerId;
  project.settings.modelId = modelId;
  renderStatus();
  markDirty();
}

/* ══════════════════════════════════════════════════════════════
   Context — visible, user-selected request payload
   ══════════════════════════════════════════════════════════════ */
function contextCandidates() {
  const items = [];
  const ta = $("#editor");
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  if (sel.trim()) items.push({ id: "selection", label: "Current selection", group: "Editor", content: sel });
  const act = activeDoc();
  items.push({ id: "doc:" + act.id, label: act.name + " (active)", group: "Editor", content: ta.value, doc: act });
  for (const f of FOLDERS) {
    for (const d of docsIn(f.key)) {
      if (d.id === act.id) continue;
      items.push({ id: "doc:" + d.id, label: d.name, group: f.label, content: d.content, doc: d });
    }
  }
  return items;
}

function checkedContext() {
  if (!project.settings.contextChecked) {
    // spec default: scene + lore
    const init = { selection: true };
    init["doc:" + activeDoc().id] = true;
    for (const d of docsIn("lore")) init["doc:" + d.id] = true;
    project.settings.contextChecked = init;
  }
  return project.settings.contextChecked;
}

function selectedContextItems() {
  const checked = checkedContext();
  return contextCandidates().filter((c) => checked[c.id]);
}

function contextSummary() {
  const items = selectedContextItems();
  if (!items.length) return "none";
  const names = items.map((i) => i.label.replace(" (active)", ""));
  return names.length <= 2 ? names.join(" + ") : `${names.length} items: ${names.slice(0, 2).join(", ")}…`;
}

function contextChecklistHtml() {
  const checked = checkedContext();
  const groups = {};
  for (const c of contextCandidates()) (groups[c.group] = groups[c.group] || []).push(c);
  return Object.entries(groups).map(([g, items]) => `
    <div class="model-group"><div class="model-group-head">${esc(g)}</div>
      ${items.map((c) => `
        <label class="check-row"><input type="checkbox" data-ctx="${esc(c.id)}" ${checked[c.id] ? "checked" : ""}>
          <span>${esc(c.label)} <span class="muted">${c.content.trim().split(/\s+/).filter(Boolean).length} words</span></span>
        </label>`).join("")}
    </div>`).join("");
}

function bindContextChecklist(root) {
  $$("input[data-ctx]", root).forEach((cb) => cb.addEventListener("change", () => {
    checkedContext()[cb.dataset.ctx] = cb.checked;
    renderStatus();
    markDirty();
  }));
}

function retrievalTerms(text) {
  const stop = new Set(["the", "and", "that", "this", "with", "from", "into", "your", "after", "before", "about", "what", "when", "where", "have", "will", "would", "should", "could", "their", "there", "they", "them", "then", "only", "write", "text", "passage"]);
  return new Set((String(text || "").toLowerCase().match(/[a-z0-9']{3,}/g) || []).filter((word) => !stop.has(word)));
}

function retrieveRelevantPassages(content, query, limit = 4200) {
  const text = String(content || "").trim();
  if (text.length <= limit) return { content: text, retrieved: false };
  const terms = retrievalTerms(query);
  const chunks = text.split(/\n(?=#{1,3}\s)|\n{2,}/).map((chunk, index) => ({ chunk: chunk.trim(), index })).filter((item) => item.chunk);
  const scored = chunks.map((item) => {
    const words = retrievalTerms(item.chunk);
    let score = 0;
    for (const term of terms) if (words.has(term)) score += term.length > 7 ? 3 : 1;
    if (/^#{1,3}\s/.test(item.chunk)) score += 0.25;
    return { ...item, score };
  });
  const selected = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  if (!selected.length) selected.push(...scored.slice(0, 3));
  const kept = [];
  let length = 0;
  for (const item of selected) {
    if (length && length + item.chunk.length > limit) continue;
    kept.push(item);
    length += item.chunk.length + 2;
    if (length >= limit) break;
  }
  return { content: kept.sort((a, b) => a.index - b.index).map((item) => item.chunk).join("\n\n"), retrieved: true };
}

/* ══════════════════════════════════════════════════════════════
   Modal infrastructure
   ══════════════════════════════════════════════════════════════ */
function openModal(html, opts = {}) {
  const root = $("#modal-root");
  const card = $("#modal-card");
  card.className = opts.wide ? "modal-wide" : "";
  card.id = "modal-card";
  card.innerHTML = html;
  root.hidden = false;
  return card;
}
function closeModal() { $("#modal-root").hidden = true; $("#modal-card").innerHTML = ""; }

/* ══════════════════════════════════════════════════════════════
   AI operations: preflight → run → diff preview → accept
   ══════════════════════════════════════════════════════════════ */
const OP_DEFS = {
  rewrite: { label: "Rewrite", needsSelection: true },
  expand: { label: "Expand", needsSelection: true },
  shorten: { label: "Shorten", needsSelection: true },
  continue: { label: "Continue", needsSelection: false },
  guided: { label: "Guided Write", needsSelection: false },
  describe: { label: "Describe", needsSelection: true },
  brainstorm: { label: "Brainstorm", needsSelection: false },
  plotimprov: { label: "Plot Improv", needsSelection: false },
  firstdraft: { label: "First Draft", needsSelection: false },
  feedback: { label: "Feedback", needsSelection: false },
};

const REWRITE_SUBTYPES = {
  default: "Rewrite the passage to improve clarity and flow. Preserve the meaning, point of view, and tense.",
  clearer: "Rewrite the passage to be clearer. Preserve the meaning, point of view, and tense.",
  stronger: "Rewrite the passage with stronger, more active language. Preserve the meaning, point of view, and tense.",
  literary: "Rewrite the passage in a more literary register. Preserve the meaning, point of view, and tense.",
  simpler: "Rewrite the passage in simpler language. Preserve the meaning, point of view, and tense.",
  "tone-warm": "Rewrite the passage with a warm, humane tone. Preserve meaning, point of view, tense, characterization, and established facts. Do not make it sentimental unless the source already is.",
  "tone-dry": "Rewrite the passage with a dry, understated tone and restrained humor where appropriate. Preserve meaning, point of view, tense, characterization, and established facts.",
  "tone-playful": "Rewrite the passage with a playful, lively tone. Preserve meaning, point of view, tense, characterization, and established facts; avoid turning serious stakes into a joke.",
  "tone-tense": "Rewrite the passage with mounting tension and tighter narrative pressure. Preserve meaning, point of view, tense, characterization, and established facts; do not invent new danger.",
  "tone-ominous": "Rewrite the passage with an ominous, unsettling tone using implication and atmosphere. Preserve meaning, point of view, tense, characterization, and established facts; avoid melodrama.",
  "tone-gritty": "Rewrite the passage with a gritty, physical, unsentimental tone. Preserve meaning, point of view, tense, characterization, and established facts; avoid gratuitous bleakness.",
  "tone-intimate": "Rewrite the passage with an intimate, emotionally close tone attentive to vulnerability, subtext, and small physical details. Preserve meaning, point of view, tense, characterization, and established facts.",
  "tone-sensual": "Rewrite the passage with a sensual, embodied tone attentive to desire, touch, breath, and sensory detail. Preserve meaning, point of view, tense, characterization, consent, boundaries, and established facts; do not escalate the level of sexual activity.",
  "tone-romantic": "Rewrite the passage with a romantic tone centered on emotional connection, longing, and specific character chemistry. Preserve meaning, point of view, tense, characterization, consent, and established facts; avoid generic sentiment.",
  "tone-cinematic": "Rewrite the passage with a cinematic tone: strong visual beats, purposeful movement, and controlled pacing. Preserve meaning, point of view, tense, characterization, and established facts; keep it prose, not screenplay format.",
  "tone-cleaner": "Rewrite the passage with cleaner language and less explicit sexual, profane, or graphic description. Preserve the events, meaning, point of view, tense, characterization, emotional stakes, and established facts; imply rather than erase.",
  "tone-filthier": "Rewrite the passage with filthier, more explicit, and more vulgar language appropriate to the characters and scene. Preserve the existing events, meaning, point of view, tense, characterization, consent, boundaries, and established facts; do not invent or escalate sexual acts.",
  "tone-harsher": "Rewrite the passage with a harsher, blunter, less forgiving tone. Sharpen conflict, consequences, and difficult emotions while preserving the events, meaning, point of view, tense, characterization, and established facts; avoid empty cruelty.",
  "tone-more-violent": "Rewrite the passage to portray its existing violence with greater physical intensity, impact, urgency, and consequence. Preserve the same events, meaning, point of view, tense, characterization, and established facts; do not invent additional violent acts or targets.",
  "tone-less-violent": "Rewrite the passage to portray its existing violence less graphically and with greater restraint. Preserve the same events, plot consequences, meaning, point of view, tense, characterization, and established facts; reduce depiction rather than erasing what happened.",
  "voice-gonzo": "Rewrite the passage in a Hunter S. Thompson-style gonzo voice filtered through an aggressive 1980s Rolling Stone feature: first-person immediacy where the existing point of view permits it, feverish observation, acid wit, cultural diagnosis, swagger, paranoia, and sharply specific reportage. Preserve the passage's events, tense, characterization, and established facts; do not copy recognizable phrases or turn every sentence into caricature.",
  "voice-film-novelization": "Rewrite the passage in the voice of a 1970s film novelization: lean scene-setting, tactile production detail, direct interiority, muscular transitions, visible blocking, and occasional explanatory texture that a camera could not provide. Preserve meaning, point of view, tense, characterization, and established facts; keep it prose rather than screenplay format.",
  "voice-pulp": "Rewrite the passage in a confident pulp-novel voice: propulsive sentences, vivid concrete nouns, hard-edged atmosphere, economical characterization, strong hooks, and unabashed dramatic momentum. Preserve meaning, point of view, tense, characterization, and established facts; avoid parody, generic noir pastiche, and purple overload.",
  "voice-val-wanderer": "Rewrite the passage in Val Renberg's voice from Wanderer: dry engineer speech, practical observation, compressed humor, material and systems-minded metaphors, emotional restraint, and the competence of someone who notices what can fail and how to fix it. Treat selected Orphan Sky lore and the production Bible as authority for Val's characterization. Preserve meaning, point of view, tense, continuity, and established facts; do not invent catchphrases, biography, or technical facts.",
  dialogue: "Do a dialogue pass on the passage: sharpen the spoken lines and attributions, leaving narration as unchanged as possible.",
  description: "Do a description pass on the passage: sharpen sensory and physical detail, leaving dialogue unchanged.",
};

function beginOperation(kind, subtype) {
  flushEditor();
  const ta = $("#editor");
  const def = OP_DEFS[kind];
  let selStart = ta.selectionStart, selEnd = ta.selectionEnd;
  let text = ta.value.slice(selStart, selEnd);
  if (def.needsSelection && !text.trim()) {
    toast(`Select some text first, then choose ${def.label}.`);
    return;
  }
  let instruction;
  if (kind === "rewrite") {
    if (subtype === "tone") {
      const tone = window.prompt("Change tone to (e.g. warmer, dry, ominous):", "");
      if (tone === null) return;
      instruction = `Rewrite the passage in a ${tone.trim() || "different"} tone. Preserve the meaning, point of view, and tense.`;
    } else if (subtype === "custom") {
      instruction = "";
    } else {
      instruction = REWRITE_SUBTYPES[subtype] || REWRITE_SUBTYPES.default;
    }
  } else if (kind === "expand") {
    instruction = "Expand the passage with additional material, keeping the point of view, tense, and any project constraints in the context. Return the full expanded passage.";
  } else if (kind === "shorten") {
    instruction = "Condense the passage while retaining the action, the facts, and the emotional turn. Return the condensed passage.";
  } else if (kind === "continue") {
    const before = ta.value.slice(0, selStart);
    text = before.slice(-2500);
    selEnd = selStart;
    instruction = "Continue the text naturally from where the excerpt ends. Return only the new prose, with no preamble and no repetition of the excerpt.";
  } else if (kind === "guided") {
    const direction = window.prompt("What should happen next?", "");
    if (direction === null) return;
    text = ta.value.slice(Math.max(0, selStart - 2500), selStart);
    selEnd = selStart;
    instruction = `Write the next passage following this direction: ${direction.trim() || "advance the scene naturally"}. Preserve POV, tense, voice, and Story Bible facts. Return prose only.`;
  } else if (kind === "describe") {
    instruction = "Enrich this passage with specific sensory detail across sight, sound, smell, touch, and taste where relevant. Avoid purple prose and preserve POV, tense, facts, and pacing. Return the full revised passage.";
  } else if (kind === "brainstorm") {
    const topic = window.prompt("What should Writer brainstorm?", "Plot turns, complications, or character choices");
    if (topic === null) return;
    text = ta.value.slice(Math.max(0, selStart - 2000), selStart);
    selEnd = selStart;
    instruction = `Brainstorm 10 distinct, story-specific ideas for: ${topic.trim()}. Use the Story Bible and current draft. Keep each idea concise and avoid generic suggestions.`;
  } else if (kind === "plotimprov") {
    text = ta.value.slice(Math.max(0, selStart - 5000), selStart);
    selEnd = selStart;
    instruction = "Improvise 8 distinct next plot moves that could grow naturally from the current scene. Each move must be surprising but causally plausible, arise from existing character motives, material circumstances, unresolved tensions, or selected project lore, and create a useful choice or consequence. Vary scale and emotional direction. Do not contradict established canon, invent unsupported lore, solve the central conflict too easily, or merely repeat the obvious next beat. Give each option a short title and 2–3 concrete sentences; do not draft the scene.";
  } else if (kind === "firstdraft") {
    text = ta.value.slice(Math.max(0, selStart - 2500), selStart);
    selEnd = selStart;
    instruction = "Draft the next complete scene from the outline, current manuscript, and Story Bible. Target 800–1,000 words. Preserve POV, tense, continuity, character motives, and established style. Return prose only.";
  } else if (kind === "feedback") {
    text = ta.value.slice(0, 8000);
    selStart = ta.selectionStart; selEnd = selStart;
    instruction = "Give concise editorial feedback on this draft: strengths, continuity issues, unclear motivations, pacing, prose habits, and three highest-value revisions. Do not rewrite the draft.";
  }
  pendingOp = { kind, subtype: subtype || null, instruction, text, selStart, selEnd, docId: activeDoc().id, docName: activeDoc().name };
  showPreflight();
}

function modelOptionsHtml() {
  let html = "";
  for (const p of Object.values(PROVIDERS)) {
    html += `<optgroup label="${esc(p.name)}${p.kind === "cloud" ? " — leaves device" : " — stays local"}">`;
    for (const m of p.models()) {
      const sel = project.settings.providerId === p.id && project.settings.modelId === m.id ? "selected" : "";
      html += `<option value="${esc(p.id)}::${esc(m.id)}" ${sel}>${esc(m.label)}</option>`;
    }
    html += "</optgroup>";
  }
  return html;
}

function scopeBannerHtml() {
  if (!leavesDevice()) {
    return `<div class="scope-banner local" id="scope-banner"><b>Stays local.</b> This request is handled on this device by ${esc(currentProvider().name)}. No context leaves the machine.</div>`;
  }
  const p = project.settings.privacy;
  let extra = "";
  if (p === "local") extra = `<br><b>Blocked:</b> privacy scope is Local-only. Change the scope below or pick a local model to proceed.`;
  if (p === "hybrid") extra = `<br><label class="check-row" style="margin-top:6px"><input type="checkbox" id="hybrid-approve"> <span>I approve sending the listed context to the cloud <b>for this request</b>.</span></label>`;
  if (p === "cloud" && !project.settings.cloudConsent) extra = `<br><label class="check-row" style="margin-top:6px"><input type="checkbox" id="cloud-consent"> <span>I understand and consent to cloud requests for this project (remembered).</span></label>`;
  return `<div class="scope-banner cloud" id="scope-banner"><b>Leaves this device.</b> The listed context will be sent to ${esc(currentProvider().name)} over the network.${extra}</div>`;
}

function showPreflight() {
  const op = pendingOp;
  const def = OP_DEFS[op.kind];
  const card = openModal(`
    <h2 class="modal-title">${def.label} — review before submission</h2>
    <p class="modal-sub">Writer shows the operation, model, context, and privacy scope before anything is sent. Nothing changes your text until you accept a preview.</p>
    ${op.kind === "continue"
      ? `<div class="field"><span class="field-label">Text before cursor (sent as excerpt)</span><div class="excerpt">${esc(op.text.slice(-600) || "(document is empty)")}</div></div>`
      : `<div class="field"><span class="field-label">Selected text (${op.text.trim().split(/\s+/).filter(Boolean).length} words)</span><div class="excerpt">${esc(op.text)}</div></div>`}
    <div class="field"><label class="field-label" for="pf-instruction">Instruction sent to the model</label>
      <textarea id="pf-instruction" rows="2">${esc(op.instruction)}</textarea></div>
    <div class="field"><label class="field-label" for="pf-model">Model</label>
      <select id="pf-model">${modelOptionsHtml()}</select>
      <div class="muted" style="margin-top:4px">${esc(currentProvider().note || "")}</div></div>
    <div class="field"><span class="field-label">Context included in this request</span>
      <div id="pf-context">${contextChecklistHtml()}</div></div>
    <div class="field"><label class="field-label" for="pf-privacy">Privacy scope</label>
      <select id="pf-privacy">${Object.entries(PRIVACY).map(([k, v]) => `<option value="${k}" ${project.settings.privacy === k ? "selected" : ""}>${v.label} — ${v.desc}</option>`).join("")}</select></div>
    <div id="pf-banner">${scopeBannerHtml()}</div>
    <div class="modal-actions">
      <button class="secondary-btn" id="pf-cancel">Cancel</button>
      <button class="primary-btn" id="pf-run">Run ${def.label.toLowerCase()}</button>
    </div>
  `);
  bindContextChecklist(card);
  $("#pf-model", card).addEventListener("change", (e) => {
    const [pid, mid] = e.target.value.split("::");
    setModel(pid, mid);
    $("#pf-banner", card).innerHTML = scopeBannerHtml();
  });
  $("#pf-privacy", card).addEventListener("change", (e) => {
    project.settings.privacy = e.target.value;
    renderStatus(); markDirty();
    $("#pf-banner", card).innerHTML = scopeBannerHtml();
  });
  $("#pf-cancel", card).addEventListener("click", () => { pendingOp = null; closeModal(); });
  $("#pf-run", card).addEventListener("click", async () => {
    op.instruction = $("#pf-instruction", card).value.trim() || op.instruction;
    const gate = cloudGate(card);
    if (!gate.ok) { toast(gate.reason); return; }
    const btn = $("#pf-run", card);
    btn.disabled = true; btn.textContent = "Running…";
    try {
      await runPendingOp();
    } catch (e) {
      btn.disabled = false; btn.textContent = "Run " + def.label.toLowerCase();
      toast("Request failed: " + e.message, 5000);
    }
  });
}

/* enforce privacy scope for cloud models; reads consent checkboxes in `card` */
function cloudGate(card) {
  if (!leavesDevice()) return { ok: true };
  const p = project.settings.privacy;
  if (p === "local") return { ok: false, reason: "Privacy scope is Local-only — cloud models are blocked." };
  if (p === "hybrid") {
    const cb = card && $("#hybrid-approve", card);
    if (!cb || !cb.checked) return { ok: false, reason: "Hybrid scope: tick the per-request cloud approval first." };
    return { ok: true };
  }
  if (!project.settings.cloudConsent) {
    const cb = card && $("#cloud-consent", card);
    if (!cb || !cb.checked) return { ok: false, reason: "Cloud-enabled scope needs the one-time consent checkbox." };
    project.settings.cloudConsent = true;
    markDirty();
  }
  return { ok: true };
}

function buildRequest(op) {
  const ctx = selectedContextItems().filter((c) => !(op.kind !== "continue" && c.id === "selection")); // selection is already the passage
  const system = "You are a writing assistant inside Writer, a local-first writing app. Follow the instruction exactly. Return only the resulting prose — no preamble, no quotation marks around the result, no commentary.";
  let user = "";
  const contextNames = [];
  const query = `${op.instruction}\n${op.text}`;
  for (const c of ctx) {
    const shouldRetrieve = c.doc && ["lore", "style", "source"].includes(c.doc.role);
    const selected = shouldRetrieve ? retrieveRelevantPassages(c.content, query) : { content: c.content.trim(), retrieved: false };
    user += `[Context — ${c.label}${selected.retrieved ? " · relevant excerpts" : ""}]\n${selected.content}\n\n`;
    contextNames.push(c.label + (selected.retrieved ? " (relevant excerpts)" : ""));
  }
  user += `Instruction: ${op.instruction}\n\n`;
  user += op.kind === "continue" ? `Excerpt (continue after this):\n${op.text}` : `Passage:\n${op.text}`;
  return { system, messages: [{ role: "user", content: user }], contextNames, op };
}

async function runPendingOp() {
  const op = pendingOp;
  const req = buildRequest(op);
  const result = await currentProvider().call(req);
  if (!result || !result.trim()) throw new Error("The model returned an empty result.");
  op.result = result.trim();
  op.provider = currentProvider().name;
  op.model = project.settings.modelId;
  op.scope = leavesDevice() ? (project.settings.privacy === "hybrid" ? "hybrid" : "cloud-enabled") : "local-only";
  op.contextNames = req.contextNames;
  op.ts = Date.now();
  project.privacyReceipts ||= [];
  project.privacyReceipts.push({
    id: uid(), ts: op.ts, operation: op.kind, provider: op.provider, model: op.model,
    scope: op.scope, destination: leavesDevice() ? currentProvider().name : "This device",
    contextItems: [...op.contextNames], excerptWords: op.text.trim().split(/\s+/).filter(Boolean).length,
  });
  markDirty();
  showDiffPreview();
}

function showDiffPreview() {
  const op = pendingOp;
  const isInsert = ["continue", "guided", "brainstorm", "firstdraft", "feedback"].includes(op.kind);
  const original = isInsert ? (op.text.slice(-800) || "(empty)") : op.text;
  const { left, right } = isInsert ? { left: esc(original), right: `<span class="d-ins">${esc(op.result)}</span>` } : diffHtml(original, op.result);
  const card = openModal(`
    <h2 class="modal-title">Preview — ${OP_DEFS[op.kind].label}</h2>
    <p class="modal-sub">Nothing has changed yet. Choose what happens to your text.</p>
    <div class="diff-cols">
      <div><div class="diff-col-head">${isInsert ? "Reference text" : "Original"}</div><div class="diff-box">${left}</div></div>
      <div><div class="diff-col-head">Proposed</div><div class="diff-box">${right}</div></div>
    </div>
    <div class="diff-provenance">
      ${esc(op.provider)} · ${esc(op.model)} · ${esc(op.scope)} · context: ${esc(op.contextNames.join(", ") || "none")} · ${esc(fmtTime(op.ts))}<br>
      Requested: “${esc(op.instruction)}” — the result reflects what was requested, not a guarantee of preserved voice.
    </div>
    <div class="modal-actions">
      <button class="secondary-btn spread" id="dp-keep">${isInsert ? "Discard" : "Keep original"}</button>
      <button class="secondary-btn" id="dp-retry">Try again</button>
      ${isInsert ? "" : `<button class="secondary-btn" id="dp-below">Insert below</button>`}
      <button class="primary-btn" id="dp-replace">${isInsert ? "Insert at cursor" : "Replace"}</button>
    </div>
  `, { wide: true });
  $("#dp-keep", card).addEventListener("click", () => { pendingOp = null; closeModal(); toast("Original kept. No revision recorded."); });
  $("#dp-retry", card).addEventListener("click", () => showPreflight());
  const below = $("#dp-below", card);
  if (below) below.addEventListener("click", () => acceptOperation("insert-below"));
  $("#dp-replace", card).addEventListener("click", () => acceptOperation(isInsert ? "insert-at-cursor" : "replace"));
}

function acceptOperation(choice) {
  const op = pendingOp;
  const ta = $("#editor");
  if (project.activeDocId !== op.docId) setActiveDoc(op.docId);
  const doc = activeDoc();
  let before, after, newCaret;
  if (choice === "replace") {
    before = op.text;
    after = op.result;
    doc.content = ta.value.slice(0, op.selStart) + op.result + ta.value.slice(op.selEnd);
    newCaret = op.selStart + op.result.length;
  } else if (choice === "insert-below") {
    before = op.text;
    after = op.text + "\n\n" + op.result;
    const insert = "\n\n" + op.result;
    doc.content = ta.value.slice(0, op.selEnd) + insert + ta.value.slice(op.selEnd);
    newCaret = op.selEnd + insert.length;
  } else { // insert-at-cursor (continue)
    before = "";
    after = op.result;
    const needsGap = op.selStart > 0 && !/\n\n$/.test(ta.value.slice(0, op.selStart));
    const insert = (needsGap ? "\n\n" : "") + op.result;
    doc.content = ta.value.slice(0, op.selStart) + insert + ta.value.slice(op.selStart);
    newCaret = op.selStart + insert.length;
  }
  doc.modified = Date.now();
  recordRevision({
    docId: doc.id, docName: doc.name,
    selStart: op.selStart, selEnd: op.selEnd,
    operation: op.kind + (op.subtype ? ":" + op.subtype : ""),
    instruction: op.instruction,
    provider: op.provider, model: op.model, scope: op.scope,
    contextItems: op.contextNames,
    choice, before, after,
  });
  pendingOp = null;
  closeModal();
  renderEditor();
  ta.focus();
  ta.setSelectionRange(newCaret, newCaret);
  markDirty();
  toast("Accepted — revision recorded.");
}

/* ══════════════════════════════════════════════════════════════
   Revisions & provenance (append-only)
   ══════════════════════════════════════════════════════════════ */
function recordRevision(fields) {
  project.revisions.push({ id: uid(), ts: Date.now(), ...fields });
  renderStatus();
}

function takeSnapshot() {
  flushEditor();
  const doc = activeDoc();
  recordRevision({
    docId: doc.id, docName: doc.name, selStart: 0, selEnd: doc.content.length,
    operation: "snapshot", instruction: "Manual snapshot", provider: "—", model: "—",
    scope: "local-only", contextItems: [], choice: "snapshot", before: doc.content, after: doc.content,
  });
  markDirty();
  toast("Snapshot recorded.");
}

function showPrivacyReceipts() {
  const receipts = [...(project.privacyReceipts || [])].reverse();
  const rows = receipts.length ? receipts.map((r) => `
    <div class="receipt">
      <b>${esc(r.operation)}</b> · ${esc(r.provider)} / ${esc(r.model)}
      <div class="muted">${esc(fmtTime(r.ts))} · ${esc(r.scope)} · destination: ${esc(r.destination)} · excerpt: ${Number(r.excerptWords || 0)} words</div>
      <div class="muted">Context sent: ${esc((r.contextItems || []).join(", ") || "none")}</div>
    </div>`).join("") : `<p class="muted">No AI requests have been run in this project.</p>`;
  const card = openModal(`
    <h2 class="modal-title">Privacy receipts</h2>
    <p class="modal-sub">An append-only local account of what each AI request sent, where it went, and which model handled it. Prompt text and secrets are not duplicated here.</p>
    ${rows}
    <div class="modal-actions"><button class="secondary-btn" id="receipt-close">Close</button></div>
  `);
  $("#receipt-close", card).addEventListener("click", closeModal);
}

function showRevisions() {
  const revs = [...project.revisions].reverse();
  const list = revs.length ? revs.map((r) => `
    <button class="rev-item" data-rev="${r.id}">
      <div class="rev-line1"><span class="rev-op">${esc(r.operation)}</span><span>${esc(r.docName)}</span><span class="muted">${esc(fmtTime(r.ts))}</span></div>
      <div class="rev-line2">${esc(r.provider)} · ${esc(r.model)} · ${esc(r.scope)} · context: ${esc((r.contextItems || []).join(", ") || "none")} · ${esc(r.choice)}</div>
    </button>`).join("")
    : `<p class="muted">No revisions yet. Accepted AI changes and manual snapshots appear here.</p>`;
  const card = openModal(`
    <h2 class="modal-title">Revisions</h2>
    <p class="modal-sub">Append-only records of snapshots and accepted transformations: operation, model, scope, context sent, and before/after text.</p>
    ${list}
    <div class="modal-actions"><button class="secondary-btn" id="rev-close">Close</button></div>
  `, { wide: true });
  $("#rev-close", card).addEventListener("click", closeModal);
  $$(".rev-item", card).forEach((b) => b.addEventListener("click", () => showRevisionDetail(b.dataset.rev)));
}

function showRevisionDetail(id) {
  const r = project.revisions.find((x) => x.id === id);
  if (!r) return;
  const { left, right } = diffHtml(r.before || "", r.after || "");
  const card = openModal(`
    <h2 class="modal-title">${esc(r.operation)} — ${esc(r.docName)}</h2>
    <p class="modal-sub">${esc(fmtTime(r.ts))} · ${esc(r.provider)} · ${esc(r.model)} · ${esc(r.scope)} · choice: ${esc(r.choice)}<br>
    Instruction: “${esc(r.instruction)}” · context sent: ${esc((r.contextItems || []).join(", ") || "none")}</p>
    <div class="diff-cols">
      <div><div class="diff-col-head">Before</div><div class="diff-box">${left}</div></div>
      <div><div class="diff-col-head">After</div><div class="diff-box">${right}</div></div>
    </div>
    <div class="modal-actions">
      <button class="secondary-btn spread" id="rd-back">← All revisions</button>
      <button class="secondary-btn" id="rd-restore">Restore “before” as new document</button>
      <button class="secondary-btn" id="rd-close">Close</button>
    </div>
  `, { wide: true });
  $("#rd-back", card).addEventListener("click", showRevisions);
  $("#rd-close", card).addEventListener("click", closeModal);
  $("#rd-restore", card).addEventListener("click", () => {
    const now = Date.now();
    const doc = { id: uid(), folder: "manuscript", name: r.docName + " (restored " + fmtTime(r.ts) + ")", content: r.before || "", created: now, modified: now };
    project.docs.push(doc);
    setActiveDoc(doc.id);
    closeModal();
    toast("Restored as a new document — the original was not touched.");
  });
}

/* ══════════════════════════════════════════════════════════════
   Sidecar chat
   ══════════════════════════════════════════════════════════════ */
function renderChat() {
  const log = $("#chat-log");
  log.innerHTML = project.chat.map((m, i) => m.role === "user"
    ? `<div class="msg msg-user">${esc(m.text)}</div>`
    : `<div class="msg msg-ai"><div class="msg-meta">${esc(m.provider || "")} · ${esc(m.model || "")} · ${esc(m.scope || "")}${m.contextNames && m.contextNames.length ? " · context: " + esc(m.contextNames.join(", ")) : ""}</div>${esc(m.text)}<div class="msg-insert"><button data-chatins="cursor" data-i="${i}">At cursor</button><button data-chatins="below" data-i="${i}">Below selection</button><button data-chatins="newdoc" data-i="${i}">New document</button><button data-chatins="copy" data-i="${i}">Copy</button></div></div>`
  ).join("") || `<div class="msg-note">Chat with the selected model. A response is never part of the manuscript until you insert it deliberately.</div>`;
  log.scrollTop = log.scrollHeight;
}

async function sendChat(text) {
  project.chat.push({ role: "user", text, ts: Date.now() });
  renderChat();
  markDirty();
  if (leavesDevice()) {
    const p = project.settings.privacy;
    if (p === "local") { toast("Privacy scope is Local-only — cloud models are blocked. Pick a local model or change the scope."); return; }
    if (p === "hybrid" || !project.settings.cloudConsent) {
      const ok = window.confirm(`This chat message and the selected context (${contextSummary()}) will be sent to ${currentProvider().name}. Send?`);
      if (!ok) return;
      if (p === "cloud") { project.settings.cloudConsent = true; markDirty(); }
    }
  }
  const btn = $("#chat-form button[type=submit]");
  btn.disabled = true;
  try {
    flushEditor();
    const ctx = selectedContextItems();
    const system = "You are a writing assistant in the sidecar of Writer, a local-first writing app. Be concrete and concise. Drafted prose you produce is a proposal; the writer decides whether to insert it.";
    let preamble = "";
    for (const c of ctx) preamble += `[Context — ${c.label}]\n${c.content.trim()}\n\n`;
    const history = project.chat.slice(-8).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
    if (preamble && history.length) history[history.length - 1] = { role: "user", content: preamble + history[history.length - 1].content };
    const reply = await currentProvider().call({ system, messages: history, op: { kind: "chat" } });
    project.chat.push({
      role: "assistant", text: reply, ts: Date.now(),
      provider: currentProvider().name, model: project.settings.modelId,
      scope: leavesDevice() ? "cloud" : "local-only",
      contextNames: ctx.map((c) => c.label),
    });
  } catch (e) {
    project.chat.push({ role: "assistant", text: "⚠ " + e.message, ts: Date.now(), provider: currentProvider().name, model: project.settings.modelId, scope: "error", contextNames: [] });
  }
  btn.disabled = false;
  renderChat();
  markDirty();
}

function insertFromChat(i, mode) {
  const m = project.chat[i];
  if (!m) return;
  if (mode === "copy") {
    navigator.clipboard && navigator.clipboard.writeText(m.text).then(() => toast("Copied."), () => toast("Copy failed."));
    return;
  }
  flushEditor();
  const ta = $("#editor");
  if (mode === "newdoc") {
    const now = Date.now();
    const doc = { id: uid(), folder: "manuscript", name: "From AI " + fmtTime(now), content: m.text, created: now, modified: now };
    project.docs.push(doc);
    recordRevision({ docId: doc.id, docName: doc.name, selStart: 0, selEnd: 0, operation: "insert-from-ai", instruction: "Chat response inserted as new document", provider: m.provider, model: m.model, scope: m.scope, contextItems: m.contextNames || [], choice: "new-document", before: "", after: m.text });
    setActiveDoc(doc.id);
    toast("Inserted as a new document.");
    return;
  }
  const doc = activeDoc();
  const pos = mode === "below" ? ta.selectionEnd : ta.selectionStart;
  const needsGap = pos > 0 && !/\n\n$/.test(ta.value.slice(0, pos));
  const insert = (needsGap ? "\n\n" : "") + m.text;
  doc.content = ta.value.slice(0, pos) + insert + ta.value.slice(pos);
  doc.modified = Date.now();
  recordRevision({ docId: doc.id, docName: doc.name, selStart: pos, selEnd: pos, operation: "insert-from-ai", instruction: "Chat response inserted " + (mode === "below" ? "below selection" : "at cursor"), provider: m.provider, model: m.model, scope: m.scope, contextItems: m.contextNames || [], choice: mode === "below" ? "below-selection" : "at-cursor", before: "", after: m.text });
  renderEditor();
  const caret = pos + insert.length;
  ta.focus(); ta.setSelectionRange(caret, caret);
  markDirty();
  toast("Inserted — revision recorded.");
}

/* ══════════════════════════════════════════════════════════════
   Export — always a copy, never the source
   ══════════════════════════════════════════════════════════════ */
function download(filename, mime, content) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function exportHtmlDoc(doc) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(doc.name)}</title>
<style>
body{max-width:680px;margin:48px auto;padding:0 24px;font-family:Georgia,'Iowan Old Style',serif;font-size:18px;line-height:1.65;color:#1d1a15;background:#fdfcfa}
h1,h2,h3{line-height:1.25} blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:16px;color:#555}
pre{background:#f2f0ec;padding:12px;border-radius:6px;overflow-x:auto;font-size:14px} code{font-family:ui-monospace,monospace}
hr{border:0;border-top:1px solid #ccc;width:40%;margin:2em auto}
</style></head><body>
<h1>${esc(doc.name)}</h1>
${renderMarkdown(doc.content)}
<hr><p style="font-size:12px;color:#888">Exported copy from Writer · ${esc(new Date().toLocaleString())} · the source document is unchanged.</p>
</body></html>`;
}

async function exportDoc(format) {
  flushEditor();
  const doc = activeDoc();
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
  const base = `${slug(doc.name)}-export-${stamp.replace(/\s/g, "-")}`;
  let filename, mime, content;
  if (format === "md") { filename = base + ".md"; mime = "text/markdown"; content = doc.content; }
  else if (format === "txt") { filename = base + ".txt"; mime = "text/plain"; content = doc.content.replace(/^#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1"); }
  else { filename = base + ".html"; mime = "text/html"; content = exportHtmlDoc(doc); }
  if (dirHandle) {
    try {
      const exports = await dirHandle.getDirectoryHandle("exports", { create: true });
      const fh = await exports.getFileHandle(filename, { create: true });
      const w = await fh.createWritable();
      await w.write(content);
      await w.close();
      toast(`Export written to exports/${filename} — source unchanged.`);
      return;
    } catch (e) { console.warn("folder export failed, falling back to download", e); }
  }
  download(filename, mime, content);
  toast(`Exported a copy (${filename}) — source unchanged.`);
}

/* ══════════════════════════════════════════════════════════════
   Project folder (File System Access API, optional)
   ══════════════════════════════════════════════════════════════ */
const fsSyncSoon = debounce(fsSyncAll, 900);

async function connectFolder() {
  if (!window.showDirectoryPicker) {
    toast("This browser doesn't support folder access. The project stays in browser storage; use File ▸ Download project backup.", 5200);
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    let hasExisting = false;
    try { await handle.getFileHandle("writer-project.json"); hasExisting = true; } catch (_) { /* new folder */ }
    dirHandle = handle;
    if (hasExisting && window.confirm("This folder already contains a Writer project. Load it (replacing the in-browser project)?")) {
      await fsLoadAll();
    } else {
      await fsSyncAll();
    }
    $("#folder-status").textContent = "Folder: " + handle.name;
    renderAll();
    toast("Project folder connected. Files are written as plain Markdown.");
  } catch (e) {
    if (e && e.name !== "AbortError") toast("Folder connection failed: " + e.message, 5000);
  }
}

async function fsWriteFile(dir, name, content) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}

async function fsSyncAll() {
  if (!dirHandle) return;
  try {
    for (const f of FOLDERS) {
      const dir = await dirHandle.getDirectoryHandle(f.key, { create: true });
      for (const d of docsIn(f.key)) await fsWriteFile(dir, slug(d.name) + ".md", d.content);
    }
    const revDir = await dirHandle.getDirectoryHandle("revisions", { create: true });
    await fsWriteFile(revDir, "revisions-log.json", JSON.stringify(project.revisions, null, 2));
    await dirHandle.getDirectoryHandle("exports", { create: true });
    const trainingDir = await dirHandle.getDirectoryHandle("training", { create: true });
    await fsWriteFile(trainingDir, "approved-examples.jsonl", trainingCorpusRecords().map((record) => JSON.stringify(record)).join("\n") + (trainingCorpusRecords().length ? "\n" : ""));
    const knowledgeDir = await dirHandle.getDirectoryHandle("knowledge", { create: true });
    await fsWriteFile(knowledgeDir, "knowledge-index.json", JSON.stringify({ schema: "davenport.writer.knowledge.v1", records: knowledgeIndex() }, null, 2));
    const meta = {
      writer: "0.1", name: project.name,
      note: "Optional metadata. The Markdown files are canonical; this file is never required to open them. No secrets are stored here.",
      docs: project.docs.map((d) => ({ id: d.id, folder: d.folder, name: d.name, file: slug(d.name) + ".md", role: d.role, state: d.state, tags: d.tags || [], importedFrom: d.importedFrom || null, created: d.created, modified: d.modified })),
      activeDocId: project.activeDocId,
      settings: { theme: project.settings.theme, font: project.settings.font, size: project.settings.size, privacy: project.settings.privacy, providerId: project.settings.providerId, modelId: project.settings.modelId, ollamaHost: project.settings.ollamaHost, ollamaModel: project.settings.ollamaModel, koboldHost: project.settings.koboldHost, koboldModel: project.settings.koboldModel, koboldTemperature: project.settings.koboldTemperature, koboldRepPenalty: project.settings.koboldRepPenalty, koboldMaxTokens: project.settings.koboldMaxTokens },
    };
    await fsWriteFile(dirHandle, "writer-project.json", JSON.stringify(meta, null, 2));
    await fsWriteFile(dirHandle, "davenport-manifest.json", JSON.stringify({
      schema: "davenport.project.manifest.v1",
      project: project.name,
      local_first: true,
      canonical_files: "Markdown documents in manuscript/, outline/, lore/, and sources/",
      states: DAV_STATES,
      assets: project.docs.map((d) => ({
        id: d.id, path: `${d.folder}/${slug(d.name)}.md`, type: "text/markdown",
        state: d.state, role: d.role, tags: d.tags || [], source: d.importedFrom || null,
        created: new Date(d.created).toISOString(), updated: new Date(d.modified).toISOString(),
      })),
    }, null, 2));
    $("#status-save").textContent = "Saved · folder synced";
  } catch (e) {
    console.error("folder sync failed", e);
    $("#status-save").textContent = "Folder sync failed";
  }
}

async function fsLoadAll() {
  const now = Date.now();
  const docs = [];
  let meta = null;
  try {
    const fh = await dirHandle.getFileHandle("writer-project.json");
    meta = JSON.parse(await (await fh.getFile()).text());
  } catch (_) { /* optional by design */ }
  for (const f of FOLDERS) {
    let dir;
    try { dir = await dirHandle.getDirectoryHandle(f.key); } catch (_) { continue; }
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file" || !/\.(md|txt|markdown)$/i.test(name)) continue;
      const content = await (await handle.getFile()).text();
      const metaDoc = meta && meta.docs && meta.docs.find((d) => d.file === name && d.folder === f.key);
      docs.push({
        id: (metaDoc && metaDoc.id) || uid(),
        folder: f.key,
        name: (metaDoc && metaDoc.name) || name.replace(/\.(md|txt|markdown)$/i, ""),
        content,
        role: (metaDoc && metaDoc.role) || (f.key === "manuscript" ? "manuscript" : f.key === "outline" ? "outline" : f.key === "sources" ? "source" : /style/i.test(name) ? "style" : "lore"),
        state: (metaDoc && metaDoc.state) || (f.key === "manuscript" || f.key === "outline" ? "WORKING" : "APPROVED"),
        tags: (metaDoc && metaDoc.tags) || [],
        importedFrom: metaDoc && metaDoc.importedFrom,
        created: (metaDoc && metaDoc.created) || now,
        modified: (metaDoc && metaDoc.modified) || now,
      });
    }
  }
  if (!docs.length) { toast("No documents found in the folder's manuscript/outline/lore/sources subfolders."); return; }
  let revisions = [];
  try {
    const revDir = await dirHandle.getDirectoryHandle("revisions");
    const fh = await revDir.getFileHandle("revisions-log.json");
    revisions = JSON.parse(await (await fh.getFile()).text()) || [];
  } catch (_) { /* none yet */ }
  project.docs = docs;
  project.revisions = revisions;
  if (meta) {
    project.name = meta.name || project.name;
    if (meta.settings) Object.assign(project.settings, meta.settings);
    project.activeDocId = (docs.find((d) => d.id === meta.activeDocId) || docs[0]).id;
  } else {
    project.activeDocId = docs[0].id;
  }
  project.settings.contextChecked = null;
  markDirty();
}

/* ══════════════════════════════════════════════════════════════
   Editor formatting (Markdown-aware, undo-preserving)
   ══════════════════════════════════════════════════════════════ */
function replaceSelection(newText, selectInserted) {
  const ta = $("#editor");
  ta.focus();
  const start = ta.selectionStart;
  let done = false;
  try { done = document.execCommand("insertText", false, newText); } catch (_) { /* fall through */ }
  if (!done) {
    ta.setRangeText(newText, ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (selectInserted) ta.setSelectionRange(start, start + newText.length);
}

function wrapSelection(prefix, suffix, placeholder) {
  const ta = $("#editor");
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || placeholder || "text";
  replaceSelection(prefix + sel + suffix, true);
}

function prefixLines(prefixFn) {
  const ta = $("#editor");
  const v = ta.value;
  let s = ta.selectionStart, e = ta.selectionEnd;
  s = v.lastIndexOf("\n", s - 1) + 1;
  if (e < v.length && v[e] !== "\n") { const nl = v.indexOf("\n", e); e = nl === -1 ? v.length : nl; }
  const block = v.slice(s, e);
  const lines = block.split("\n").map((line, i) => prefixFn(line, i));
  ta.setSelectionRange(s, e);
  replaceSelection(lines.join("\n"), true);
}

function applyParagraphStyle(style) {
  prefixLines((line) => {
    const bare = line.replace(/^(#{1,3}|>)\s+/, "");
    if (style === "p") return bare;
    if (style === "quote") return "> " + bare;
    const marks = { h1: "#", h2: "##", h3: "###" }[style];
    return marks + " " + bare;
  });
}

const FORMAT_ACTIONS = {
  "fmt-bold": () => wrapSelection("**", "**", "bold"),
  "fmt-italic": () => wrapSelection("*", "*", "italic"),
  "fmt-underline": () => wrapSelection("<u>", "</u>", "underlined"),
  "fmt-ul": () => prefixLines((l) => (/^[-*]\s/.test(l) ? l : "- " + l)),
  "fmt-ol": () => prefixLines((l, i) => (/^\d+\.\s/.test(l) ? l : i + 1 + ". " + l)),
  "fmt-quote": () => prefixLines((l) => (/^>\s/.test(l) ? l : "> " + l)),
  "ins-h1": () => applyParagraphStyle("h1"),
  "ins-h2": () => applyParagraphStyle("h2"),
  "ins-h3": () => applyParagraphStyle("h3"),
  "ins-quote": () => applyParagraphStyle("quote"),
  "ins-divider": () => replaceSelection("\n\n---\n\n"),
  "ins-code": () => wrapSelection("\n```\n", "\n```\n", "code"),
  "ins-link": () => {
    const url = window.prompt("Link URL:", "https://");
    if (url) wrapSelection("[", `](${url.trim()})`, "link text");
  },
};

/* ══════════════════════════════════════════════════════════════
   Settings / info modals
   ══════════════════════════════════════════════════════════════ */
function showModelPicker() {
  const rows = [];
  for (const p of Object.values(PROVIDERS)) {
    rows.push(`<div class="model-group"><div class="model-group-head">${esc(p.name)}</div>`);
    for (const m of p.models()) {
      const sel = project.settings.providerId === p.id && project.settings.modelId === m.id;
      rows.push(`<button class="model-row ${sel ? "selected" : ""}" data-pick="${esc(p.id)}::${esc(m.id)}">
        <span>${esc(m.label)}</span>
        <span class="model-badge ${p.kind}">${p.kind === "cloud" ? "leaves device" : "stays local"}</span>
      </button>`);
    }
    rows.push(`<div class="muted">${esc(p.note || "")}</div></div>`);
  }
  const card = openModal(`
    <h2 class="modal-title">Model</h2>
    <p class="modal-sub">Suggestions are defaults, not claims of superiority. You can always override the route (Tools ▸ Model routing suggestions).</p>
    ${rows.join("")}
    <div class="modal-actions">
      <button class="secondary-btn spread" data-action="providers">Provider settings…</button>
      <button class="secondary-btn" id="mp-close">Close</button>
    </div>`);
  $("#mp-close", card).addEventListener("click", closeModal);
  $$("[data-pick]", card).forEach((b) => b.addEventListener("click", () => {
    const [pid, mid] = b.dataset.pick.split("::");
    setModel(pid, mid);
    closeModal();
    toast("Model: " + currentModelLabel());
  }));
}

function showContextChooser() {
  flushEditor();
  const card = openModal(`
    <h2 class="modal-title">Context</h2>
    <p class="modal-sub">Exactly these items are included in AI requests and chat messages. The collapsed summary always names them.</p>
    ${contextChecklistHtml()}
    <div class="modal-actions"><button class="secondary-btn" id="cc-close">Done</button></div>`);
  bindContextChecklist(card);
  $("#cc-close", card).addEventListener("click", () => { closeModal(); renderStatus(); });
}

function showPrivacyChooser() {
  const card = openModal(`
    <h2 class="modal-title">Privacy scope</h2>
    <p class="modal-sub">Declared before generation, shown on every request, and recorded in each revision.</p>
    ${Object.entries(PRIVACY).map(([k, v]) => `
      <label class="check-row"><input type="radio" name="priv" value="${k}" ${project.settings.privacy === k ? "checked" : ""}>
        <span><b>${v.label}</b><span class="muted">${v.desc}</span></span></label>`).join("")}
    <div class="modal-actions"><button class="secondary-btn" id="pv-close">Done</button></div>`);
  $$("input[name=priv]", card).forEach((r) => r.addEventListener("change", () => {
    project.settings.privacy = r.value;
    renderStatus(); markDirty();
  }));
  $("#pv-close", card).addEventListener("click", closeModal);
}

function showProviders() {
  const remembered = !!localStorage.getItem(GEMINI_SECRET_KEY) || !!localStorage.getItem(GROQ_SECRET_KEY) || !!localStorage.getItem(OPENROUTER_SECRET_KEY);
  const card = openModal(`
    <h2 class="modal-title">Providers &amp; models</h2>
    <p class="modal-sub">Local and cloud models are replaceable providers, selected per task. Secrets are never written into the project folder.</p>
    <div class="model-group"><div class="model-group-head">Ollama (local)</div>
      <div class="field"><label class="field-label" for="pr-ollama-host">Server</label>
        <input type="text" id="pr-ollama-host" value="${esc(project.settings.ollamaHost)}"></div>
      <div class="field"><label class="field-label" for="pr-ollama-model">Default model</label>
        <input type="text" id="pr-ollama-model" value="${esc(project.settings.ollamaModel)}"></div>
      <button class="secondary-btn" id="pr-detect">Detect installed models</button>
      <span class="muted" id="pr-detect-out">${ollamaModels ? ollamaModels.length + " detected" : ""}</span>
    </div>
    <div class="model-group"><div class="model-group-head">KoboldAI / KoboldCpp (local writing models)</div>
      <div class="field"><label class="field-label" for="pr-kobold-host">Server</label>
        <input type="text" id="pr-kobold-host" value="${esc(project.settings.koboldHost || "http://localhost:5001")}"></div>
      <div class="field"><label class="field-label" for="pr-kobold-model">Loaded model label</label>
        <input type="text" id="pr-kobold-model" value="${esc(project.settings.koboldModel || "Kobold writing model")}"></div>
      <div class="provider-grid">
        <div class="field"><label class="field-label" for="pr-kobold-temp">Temperature</label><input type="number" id="pr-kobold-temp" min="0" max="2" step="0.05" value="${Number(project.settings.koboldTemperature ?? 0.8)}"></div>
        <div class="field"><label class="field-label" for="pr-kobold-rep">Repetition penalty</label><input type="number" id="pr-kobold-rep" min="1" max="2" step="0.05" value="${Number(project.settings.koboldRepPenalty ?? 1.1)}"></div>
        <div class="field"><label class="field-label" for="pr-kobold-max">Maximum new tokens</label><input type="number" id="pr-kobold-max" min="32" max="4096" step="32" value="${Number(project.settings.koboldMaxTokens ?? 512)}"></div>
      </div>
      <button class="secondary-btn" id="pr-kobold-detect">Detect loaded writing model</button>
      <span class="muted" id="pr-kobold-out">${koboldModels ? "Found: " + esc(koboldModels.join(", ")) : ""}</span>
    </div>
    <div class="model-group"><div class="model-group-head">Free-tier cloud APIs</div>
      <div class="scope-banner cloud"><b>Leaves this device.</b> Free plans have rate limits and provider-specific data policies. Gemini free-tier content may be used to improve Google products. Use Local-only with Ollama or Kobold for private drafts.</div>
      <div class="field"><label class="field-label" for="pr-gemini-key">Gemini API key</label><input type="password" id="pr-gemini-key" placeholder="${geminiKey ? "•••• key set for this session" : "Google AI Studio key"}"></div>
      <div class="field"><label class="field-label" for="pr-groq-key">Groq API key</label><input type="password" id="pr-groq-key" placeholder="${groqKey ? "•••• key set for this session" : "Groq free-plan key"}"></div>
      <div class="field"><label class="field-label" for="pr-openrouter-key">OpenRouter API key</label><input type="password" id="pr-openrouter-key" placeholder="${openRouterKey ? "•••• key set for this session" : "OpenRouter free-model key"}"></div>
      <label class="check-row"><input type="checkbox" id="pr-remember" ${remembered ? "checked" : ""}>
        <span>Remember cloud keys in this browser's local storage
        <span class="muted">Off = kept in memory for this session only. A browser cannot use the OS keychain; prefer session-only on shared machines.</span></span></label>
    </div>
    <div class="modal-actions">
      <button class="secondary-btn" id="pr-cancel">Cancel</button>
      <button class="primary-btn" id="pr-save">Save</button>
    </div>`);
  $("#pr-detect", card).addEventListener("click", async () => {
    project.settings.ollamaHost = $("#pr-ollama-host", card).value.trim();
    const out = $("#pr-detect-out", card);
    out.textContent = "Detecting…";
    try {
      const models = await OllamaProvider.detect();
      out.textContent = models.length ? "Found: " + models.join(", ") : "Server reachable, no models pulled.";
    } catch (e) {
      out.textContent = "Not reachable (" + e.message + "). Is Ollama running? You may need OLLAMA_ORIGINS set — see README.";
    }
  });
  $("#pr-kobold-detect", card).addEventListener("click", async () => {
    project.settings.koboldHost = $("#pr-kobold-host", card).value.trim() || "http://localhost:5001";
    const out = $("#pr-kobold-out", card);
    out.textContent = "Detecting…";
    try {
      const models = await KoboldProvider.detect();
      $("#pr-kobold-model", card).value = models[0];
      out.textContent = "Found: " + models.join(", ");
    } catch (e) {
      out.textContent = "Not reachable (" + e.message + "). Start KoboldAI/KoboldCpp with a model loaded.";
    }
  });
  $("#pr-cancel", card).addEventListener("click", closeModal);
  $("#pr-save", card).addEventListener("click", () => {
    project.settings.ollamaHost = $("#pr-ollama-host", card).value.trim() || "http://localhost:11434";
    project.settings.ollamaModel = $("#pr-ollama-model", card).value.trim() || "qwen3:8b";
    project.settings.koboldHost = $("#pr-kobold-host", card).value.trim() || "http://localhost:5001";
    project.settings.koboldModel = $("#pr-kobold-model", card).value.trim() || "Kobold writing model";
    project.settings.koboldTemperature = Number($("#pr-kobold-temp", card).value) || 0.8;
    project.settings.koboldRepPenalty = Number($("#pr-kobold-rep", card).value) || 1.1;
    project.settings.koboldMaxTokens = Number($("#pr-kobold-max", card).value) || 512;
    const gKey = $("#pr-gemini-key", card).value.trim(); if (gKey) geminiKey = gKey;
    const qKey = $("#pr-groq-key", card).value.trim(); if (qKey) groqKey = qKey;
    const rKey = $("#pr-openrouter-key", card).value.trim(); if (rKey) openRouterKey = rKey;
    if ($("#pr-remember", card).checked) {
      if (geminiKey) localStorage.setItem(GEMINI_SECRET_KEY, geminiKey);
      if (groqKey) localStorage.setItem(GROQ_SECRET_KEY, groqKey);
      if (openRouterKey) localStorage.setItem(OPENROUTER_SECRET_KEY, openRouterKey);
    } else {
      localStorage.removeItem(GEMINI_SECRET_KEY); localStorage.removeItem(GROQ_SECRET_KEY); localStorage.removeItem(OPENROUTER_SECRET_KEY);
    }
    markDirty();
    renderStatus();
    closeModal();
    toast("Provider settings saved.");
  });
}

function showRouting() {
  const card = openModal(`
    <h2 class="modal-title">Model routing suggestions</h2>
    <p class="modal-sub">Suggested starting routes. Writer can suggest a route but never hides or auto-switches it — you always pick the model.</p>
    <table class="routing">
      <tr><th>Task</th><th>Suggested route</th><th>Reason</th></tr>
      <tr><td>Private notes, summaries, outlines</td><td>Local Qwen / Ollama</td><td>Private and inexpensive.</td></tr>
      <tr><td>Unconstrained creative variants</td><td>Local exploratory models</td><td>Local exploratory work.</td></tr>
      <tr><td>Broad brainstorming, first-pass critique</td><td>Low-cost cloud model</td><td>Cheap breadth.</td></tr>
      <tr><td>Fine prose and developmental editing</td><td>Claude (cloud)</td><td>Optional quality-focused pass.</td></tr>
    </table>
    <div class="modal-actions"><button class="secondary-btn" id="rt-close">Close</button></div>`);
  $("#rt-close", card).addEventListener("click", closeModal);
}

function showFictionModels() {
  const installed = new Map((ollamaModels || []).map((name) => [name.toLowerCase(), name]));
  const rows = FICTION_MODELS.map((model) => {
    const installedId = model.modelId && installed.get(model.modelId.toLowerCase());
    return `<div class="model-group">
      <div class="model-group-head">${esc(model.name)} <span class="model-badge ${/adult/i.test(model.category) ? "adult" : "local"}">${esc(model.category)}</span></div>
      <p class="muted">${esc(model.note)}</p>
      <p class="muted">Download: ${esc(model.size)} · License: ${esc(model.license)}</p>
      <div class="modal-actions" style="justify-content:flex-start">
        ${installedId ? `<button class="primary-btn" data-fiction-use="${esc(installedId)}">Use in Writer</button>` : ""}
        <a class="secondary-btn" href="${esc(model.url)}" target="_blank" rel="noopener">Model page</a>
      </div>
    </div>`;
  }).join("");
  const card = openModal(`
    <h2 class="modal-title">Kobold fiction model catalog</h2>
    <p class="modal-sub">Curated local models for fiction. Adult models are clearly labeled. Writer never downloads a model from this screen without your action.</p>
    <div class="scope-banner local"><b>Classic Colab lineage:</b> Nerys (novel/adventure), Janeway and Picard (novels), Skein and Adventure (text adventures), Erebus/Shinen/Lit (adult fiction), and Nerybus (Nerys–Erebus blend). Some older OPT releases restrict commercial use, so they are references rather than default recommendations.</div>
    ${rows}
    <div class="modal-actions">
      <button class="secondary-btn spread" id="fm-detect">Refresh installed Ollama models</button>
      <button class="secondary-btn" id="fm-close">Close</button>
    </div>`);
  $$("[data-fiction-use]", card).forEach((button) => button.addEventListener("click", () => {
    setModel("ollama", button.dataset.fictionUse);
    closeModal();
    toast("Adult-fiction model selected: " + currentModelLabel());
  }));
  $("#fm-detect", card).addEventListener("click", async () => {
    try {
      await OllamaProvider.detect();
      closeModal();
      showFictionModels();
      toast("Installed models refreshed.");
    } catch (error) {
      toast("Ollama is not reachable: " + error.message, 4200);
    }
  });
  $("#fm-close", card).addEventListener("click", closeModal);
}

function trainingCorpusRecords() {
  const records = [];
  for (const doc of project.docs.filter((item) => item.role === "manuscript" && ["APPROVED", "FINAL"].includes(item.state))) {
    const paragraphs = doc.content.split(/\n{2,}/).filter((part) => part.trim());
    let chunk = "";
    for (const paragraph of paragraphs) {
      if (chunk && (chunk + "\n\n" + paragraph).split(/\s+/).length > 900) {
        records.push({ type: "approved-prose", project: project.name, document: doc.name, state: doc.state, text: chunk, source_file: slug(doc.name) + ".md" });
        chunk = "";
      }
      chunk += (chunk ? "\n\n" : "") + paragraph;
    }
    if (chunk.trim()) records.push({ type: "approved-prose", project: project.name, document: doc.name, state: doc.state, text: chunk, source_file: slug(doc.name) + ".md" });
  }
  return records;
}

function knowledgeIndex() {
  return project.docs.filter((doc) => ["lore", "style", "source"].includes(doc.role) && !["ARCHIVED"].includes(doc.state)).map((doc) => ({
    id: doc.id, name: doc.name, role: doc.role, state: doc.state, tags: doc.tags || [],
    source_file: `${doc.folder}/${slug(doc.name)}.md`,
    content: doc.content,
  }));
}

function exportTrainingCorpus() {
  flushEditor();
  const records = trainingCorpusRecords();
  if (!records.length) {
    toast("No training examples yet. Mark finished manuscript documents [APPROVED] or [FINAL] first.", 5000);
    return;
  }
  download(slug(project.name) + "-approved-training.jsonl", "application/x-ndjson", records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  toast(`Exported ${records.length} approved training example${records.length === 1 ? "" : "s"}.`);
}

function exportKnowledgeIndex() {
  const records = knowledgeIndex();
  download(slug(project.name) + "-knowledge-index.json", "application/json", JSON.stringify({ schema: "davenport.writer.knowledge.v1", project: project.name, generated: new Date().toISOString(), records }, null, 2));
  toast(`Exported ${records.length} lore/style/source record${records.length === 1 ? "" : "s"}.`);
}

function showKnowledgeImport(file) {
  pendingKnowledgeFile = file;
  const card = openModal(`
    <h2 class="modal-title">Import project knowledge</h2>
    <p class="modal-sub">${esc(file.name)} will be copied into Writer as a Markdown knowledge document. The original remains unchanged.</p>
    <div class="field"><label class="field-label" for="ki-role">Knowledge role</label>
      <select id="ki-role">${Object.entries(KNOWLEDGE_ROLES).map(([id, role]) => `<option value="${id}">${esc(role.label)}</option>`).join("")}</select></div>
    <div class="field"><label class="field-label" for="ki-state">Davenport state</label>
      <select id="ki-state">${DAV_STATES.map((state) => `<option value="${state}" ${state === "APPROVED" ? "selected" : ""}>[${state}]</option>`).join("")}</select></div>
    <div class="modal-actions"><button class="secondary-btn" id="ki-cancel">Cancel</button><button class="primary-btn" id="ki-import">Import knowledge</button></div>`);
  $("#ki-cancel", card).addEventListener("click", () => { pendingKnowledgeFile = null; closeModal(); });
  $("#ki-import", card).addEventListener("click", async () => {
    const role = $("#ki-role", card).value;
    const state = $("#ki-state", card).value;
    const roleDef = KNOWLEDGE_ROLES[role];
    const selectedFile = pendingKnowledgeFile;
    pendingKnowledgeFile = null;
    closeModal();
    await importDocument(selectedFile, { folder: roleDef.folder, role, state, keepSourceName: true });
  });
}

function showKnowledgeTraining() {
  flushEditor();
  const knowledge = knowledgeIndex();
  const approvedCount = project.docs.filter((doc) => doc.role === "manuscript" && ["APPROVED", "FINAL"].includes(doc.state)).length;
  const rows = project.docs.map((doc) => `
    <tr><td>${esc(doc.name)}</td><td>${esc(doc.role.toUpperCase())}</td><td>
      <select data-doc-state="${esc(doc.id)}">${DAV_STATES.map((state) => `<option value="${state}" ${doc.state === state ? "selected" : ""}>[${state}]</option>`).join("")}</select>
    </td></tr>`).join("");
  const card = openModal(`
    <h2 class="modal-title">Knowledge &amp; training</h2>
    <p class="modal-sub">Retrieval uses relevant passages from selected lore, style, and source documents. Training export includes only manuscript documents you explicitly mark [APPROVED] or [FINAL]. It does not modify model weights by itself.</p>
    <div class="scope-banner local"><b>Davenport-compatible:</b> Markdown files remain canonical. State, role, tags, and provenance live in the optional manifest; changing state does not move a file.</div>
    <table class="routing"><tr><th>Document</th><th>Role</th><th>State</th></tr>${rows}</table>
    <p class="muted">${knowledge.length} knowledge documents · ${approvedCount} approved/final manuscript documents eligible for training export.</p>
    <div class="modal-actions">
      <button class="secondary-btn spread" id="kt-import">Import Bible or guide…</button>
      <button class="secondary-btn" id="kt-export-knowledge">Export knowledge index</button>
      <button class="primary-btn" id="kt-export-training">Export approved training corpus</button>
      <button class="secondary-btn" id="kt-close">Close</button>
    </div>`, { wide: true });
  $$("[data-doc-state]", card).forEach((select) => select.addEventListener("change", () => {
    const doc = project.docs.find((item) => item.id === select.dataset.docState);
    if (doc) { doc.state = select.value; doc.modified = Date.now(); markDirty(); renderProjectPanel(); }
  }));
  $("#kt-import", card).addEventListener("click", () => $("#knowledge-file-input").click());
  $("#kt-export-knowledge", card).addEventListener("click", exportKnowledgeIndex);
  $("#kt-export-training", card).addEventListener("click", exportTrainingCorpus);
  $("#kt-close", card).addEventListener("click", closeModal);
}

function showAbout() {
  const card = openModal(`
    <h2 class="modal-title">Writer 0.1</h2>
    <p class="modal-sub">A reskinnable, local-first writing app with modular AI assistance.</p>
    <div class="prose" style="font-size:14px">
      <p><b>Writer owns the editing experience. You own the source files. Models propose text. Exports deliver copies.</b></p>
      <ul>
        <li>Every AI transformation is previewed before it changes text; accepted changes create revision records with full provenance.</li>
        <li>Projects are plain Markdown folders — no database or vendor account is ever the only copy.</li>
        <li>Cloud context is explicitly selected and declared; local-only mode blocks cloud models entirely.</li>
        <li>Davenport-compatible: canonical sources are never silently renamed, moved, overwritten, or deleted by AI.</li>
      </ul>
    </div>
    <div class="modal-actions"><button class="secondary-btn" id="ab-close">Close</button></div>`);
  $("#ab-close", card).addEventListener("click", closeModal);
}

function showShortcuts() {
  const card = openModal(`
    <h2 class="modal-title">Keyboard shortcuts</h2>
    <div class="prose" style="font-size:14px"><ul>
      <li><b>Ctrl/Cmd + B / I / U</b> — bold, italic, underline</li>
      <li><b>Ctrl/Cmd + S</b> — save now</li>
      <li><b>Ctrl/Cmd + Z / Y</b> — undo / redo (native editor history)</li>
      <li><b>Escape</b> — close menus and dialogs</li>
    </ul></div>
    <div class="modal-actions"><button class="secondary-btn" id="sc-close">Close</button></div>`);
  $("#sc-close", card).addEventListener("click", closeModal);
}

/* ══════════════════════════════════════════════════════════════
   Rendering
   ══════════════════════════════════════════════════════════════ */
function renderProjectPanel() {
  const root = $("#project-sections");
  root.innerHTML = FOLDERS.map((f) => `
    <div class="proj-section">
      <div class="proj-section-head"><span>${f.label}</span><button class="proj-add" data-add="${f.key}" title="New ${f.label} document">＋</button></div>
      ${docsIn(f.key).map((d) => `
        <button class="proj-doc ${d.id === project.activeDocId ? "active" : ""}" data-doc="${d.id}" title="[${esc(d.state)}] ${esc(d.role)}">
          <span class="doc-dot">●</span><span>${esc(d.name)} <small class="muted">[${esc(d.state)}]</small></span>
        </button>`).join("") || `<div class="proj-doc muted" style="cursor:default">empty</div>`}
    </div>`).join("");
  $$("[data-doc]", root).forEach((b) => b.addEventListener("click", () => setActiveDoc(b.dataset.doc)));
  $$("[data-add]", root).forEach((b) => b.addEventListener("click", () => addDoc(b.dataset.add)));
}

function renderEditor() {
  const doc = activeDoc();
  const ta = $("#editor");
  ta.value = doc.content;
  ta.dataset.font = project.settings.font;
  ta.style.fontSize = project.settings.size + "px";
  $("#doc-title").value = doc.name;
  $("#doc-meta").textContent = doc.folder
    + (doc.importedFrom ? ` · working copy of ${doc.importedFrom} · source protected` : "")
    + " · edited " + fmtTime(doc.modified);
  if (!$("#preview").hidden) $("#preview").innerHTML = renderMarkdown(doc.content);
  renderStatus();
}

function renderStatus() {
  const doc = activeDoc();
  const text = $("#editor").value || doc.content;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  $("#status-words").textContent = words + " words";
  $("#status-chars").textContent = text.length + " characters";
  const scope = PRIVACY[project.settings.privacy].label;
  const scopeEl = $("#status-scope");
  scopeEl.textContent = scope;
  scopeEl.className = "pill " + (project.settings.privacy === "local" ? "local" : "cloud");
  const modelEl = $("#status-model");
  modelEl.textContent = currentModelLabel();
  modelEl.className = "pill " + (leavesDevice() ? "cloud" : "local");
  $("#model-chip-label").textContent = currentModelLabel();
  $("#context-chip-label").textContent = contextSummary();
  $("#privacy-chip-label").textContent = scope;
  $("#rev-count").textContent = project.revisions.length;
  $("#rev-count-2").textContent = project.revisions.length;
  $("#sidecar-model").textContent = "Model: " + currentModelLabel();
  $("#sidecar-context").textContent = "Context: " + contextSummary();
  const sc = $("#sidecar-scope");
  sc.textContent = leavesDevice() ? "leaves device" : "stays local";
  sc.style.color = leavesDevice() ? "var(--danger)" : "var(--ok)";
}

function renderAll() {
  document.documentElement.dataset.theme = project.settings.theme;
  $("#project-name").textContent = project.name;
  $("#project-panel").classList.toggle("collapsed", !project.settings.panels.project);
  $("#sidecar").classList.toggle("collapsed", !project.settings.panels.sidecar);
  $("#font-select").value = project.settings.font;
  $("#size-select").value = String(project.settings.size);
  renderProjectPanel();
  renderEditor();
  renderChat();
}

/* ══════════════════════════════════════════════════════════════
   Actions & events
   ══════════════════════════════════════════════════════════════ */
const ACTIONS = {
  "new-doc": () => addDoc("manuscript"),
  "open-document": () => $("#document-file-input").click(),
  "connect-folder": connectFolder,
  "save-now": () => { flushEditor(); markDirty(); toast("Saved."); },
  "snapshot": takeSnapshot,
  "export-md": () => exportDoc("md"),
  "export-txt": () => exportDoc("txt"),
  "export-html": () => exportDoc("html"),
  "backup-json": () => { flushEditor(); download(slug(project.name) + "-backup.json", "application/json", JSON.stringify(project, null, 2)); toast("Backup downloaded."); },
  "undo": () => { $("#editor").focus(); document.execCommand("undo"); },
  "redo": () => { $("#editor").focus(); document.execCommand("redo"); },
  "select-all": () => { const ta = $("#editor"); ta.focus(); ta.select(); },
  "toggle-project": () => { project.settings.panels.project = !project.settings.panels.project; renderAll(); markDirty(); },
  "toggle-sidecar": () => { project.settings.panels.sidecar = !project.settings.panels.sidecar; renderAll(); markDirty(); if (project.settings.panels.sidecar) $("#chat-input").focus(); },
  "toggle-preview": () => {
    flushEditor();
    const pv = $("#preview");
    pv.hidden = !pv.hidden;
    $("#editor").hidden = !pv.hidden;
    $("#preview-btn").classList.toggle("active", !pv.hidden);
    if (!pv.hidden) pv.innerHTML = renderMarkdown(activeDoc().content);
  },
  "focus-mode": () => { $("#app").classList.toggle("focus-mode"); },
  "theme-parchment": () => { project.settings.theme = "parchment"; renderAll(); markDirty(); },
  "theme-ink": () => { project.settings.theme = "ink"; renderAll(); markDirty(); },
  "theme-plain": () => { project.settings.theme = "plain"; renderAll(); markDirty(); },
  "providers": showProviders,
  "fiction-models": showFictionModels,
  "knowledge-training": showKnowledgeTraining,
  "privacy-settings": showPrivacyChooser,
  "privacy-receipts": showPrivacyReceipts,
  "routing": showRouting,
  "revisions": showRevisions,
  "about": showAbout,
  "shortcuts": showShortcuts,
};

function closeMenus() { $$(".menu.open").forEach((m) => m.classList.remove("open")); }

function bindEvents() {
  $("#document-file-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await importDocument(file);
  });
  $("#knowledge-file-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) showKnowledgeImport(file);
  });

  // menus: click title to toggle, click elsewhere to close
  document.addEventListener("click", (e) => {
    const title = e.target.closest(".menu-title");
    if (title) {
      const menu = title.parentElement;
      const wasOpen = menu.classList.contains("open");
      closeMenus();
      if (!wasOpen) menu.classList.add("open");
      e.stopPropagation();
      return;
    }
    if (!e.target.closest(".menu-drop")) closeMenus();
  });

  // generic actions
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (el) {
      closeMenus();
      const fn = ACTIONS[el.dataset.action] || FORMAT_ACTIONS[el.dataset.action];
      if (fn) fn();
      return;
    }
    const rw = e.target.closest("[data-rewrite]");
    if (rw) { closeMenus(); beginOperation("rewrite", rw.dataset.rewrite); return; }
    const ai = e.target.closest("[data-ai]");
    if (ai) { closeMenus(); beginOperation(ai.dataset.ai); return; }
    const ci = e.target.closest("[data-chatins]");
    if (ci) { insertFromChat(Number(ci.dataset.i), ci.dataset.chatins); return; }
  });

  $("#model-chip").addEventListener("click", showModelPicker);
  $("#sidecar-model").addEventListener("click", showModelPicker);
  $("#context-chip").addEventListener("click", showContextChooser);
  $("#sidecar-context").addEventListener("click", showContextChooser);
  $("#privacy-chip").addEventListener("click", showPrivacyChooser);
  $("#modal-backdrop").addEventListener("click", () => { if (!pendingOp) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeMenus(); if (!pendingOp) closeModal(); }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "s") { e.preventDefault(); ACTIONS["save-now"](); }
      else if (k === "b" && e.target.id === "editor") { e.preventDefault(); FORMAT_ACTIONS["fmt-bold"](); }
      else if (k === "i" && e.target.id === "editor") { e.preventDefault(); FORMAT_ACTIONS["fmt-italic"](); }
      else if (k === "u" && e.target.id === "editor") { e.preventDefault(); FORMAT_ACTIONS["fmt-underline"](); }
    }
  });

  const ta = $("#editor");
  ta.addEventListener("input", () => {
    const doc = activeDoc();
    doc.content = ta.value;
    doc.modified = Date.now();
    renderStatus();
    markDirty();
  });
  ta.addEventListener("select", debounce(renderStatus, 200));

  $("#doc-title").addEventListener("change", () => {
    const doc = activeDoc();
    const name = $("#doc-title").value.trim();
    if (name && name !== doc.name) {
      doc.name = name;
      doc.modified = Date.now();
      renderProjectPanel();
      markDirty();
    }
  });

  $("#style-select").addEventListener("change", (e) => { applyParagraphStyle(e.target.value); e.target.value = "p"; });
  $("#font-select").addEventListener("change", (e) => { project.settings.font = e.target.value; renderEditor(); markDirty(); });
  $("#size-select").addEventListener("change", (e) => { project.settings.size = Number(e.target.value); renderEditor(); markDirty(); });
  $("#color-input").addEventListener("change", (e) => wrapSelection(`<span style="color:${e.target.value}">`, "</span>", "colored text"));

  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendChat(text);
  });
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); }
  });
}

/* ── boot ─────────────────────────────────────────────────────── */
function init() {
  project = loadProject();
  ensureProjectSchema();
  project.privacyReceipts ||= [];
  geminiKey = localStorage.getItem(GEMINI_SECRET_KEY) || null;
  groqKey = localStorage.getItem(GROQ_SECRET_KEY) || null;
  openRouterKey = localStorage.getItem(OPENROUTER_SECRET_KEY) || null;
  checkedContext();
  bindEvents();
  renderAll();
  const firstRun = $("#first-run");
  if (!localStorage.getItem(FIRST_RUN_KEY)) firstRun.hidden = false;
  $("#first-run-dismiss").addEventListener("click", () => {
    localStorage.setItem(FIRST_RUN_KEY, "1");
    firstRun.hidden = true;
  });
  window.addEventListener("beforeunload", () => writeRecoverySnapshot("before-unload"));
  setInterval(() => writeRecoverySnapshot("periodic"), 30000);
}
init();
