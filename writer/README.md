# Writer 0.1

A reskinnable, **local-first writing application** with modular AI assistance — implementing the *Writer App UX Specification 0.1* as a dependency-free local web app.

> Writer owns the editing experience.
> The user owns the source files.
> Models propose text.
> Exports deliver copies.

## Running it

Open `writer/index.html` in any modern browser. No build step, no server, no network access required — the entire app is three files (`index.html`, `styles.css`, `app.js`) with zero dependencies.

For development and automated validation:

```bash
cd writer
npm install
npx playwright install chromium
npm test
```

The browser suite exercises desktop and phone-sized Chromium, including source
safety, persistence and recovery, AI acceptance and rejection paths, cloud
blocking, unavailable local providers, privacy receipts, revisions, themes,
responsive behavior, and Markdown/TXT/HTML copy exports. GitHub Actions runs
the same suite for Writer pull requests and changes to `main`.

The project is persisted in browser storage automatically. **File ▸ Open document…** opens `.docx`, `.txt`, `.rtf`, and `.md` files as newly named `— Writer Copy` documents; saving never overwrites the original file. Reopening the same source creates a numbered copy rather than colliding with earlier work. Word imports preserve text, headings, basic character formatting, lists, links, and tables as Markdown. RTF imports preserve text and common bold, italic, underline, paragraph, tab, and Unicode formatting. Markdown remains plain portable Markdown, suitable for Davenport Notes or any other Markdown editor. For real portable project files, use **File ▸ Connect project folder…** (Chromium-based browsers): Writer then reads/writes an ordinary folder you can inspect, back up, and open with any tool:

```
My Project/
  manuscript/          plain .md files (canonical source)
  outline/
  lore/
  sources/
  revisions/           revisions-log.json (append-only provenance)
  exports/             copies produced by Export
  writer-project.json  optional metadata — never required to open the text
```

Secrets (cloud API keys) are **never** written into the project folder or `writer-project.json`.

Writer keeps a rolling browser-local recovery snapshot on save, every 30
seconds, and before the page unloads. This is a recovery aid, not a replacement
for connecting a real project folder or downloading backups.

## The workspace

- **Project panel** (left): Manuscript, Outline, Lore & style, Sources, Versions. Collapsible.
- **Editor** (center): Markdown/plain-text source with a rendered Preview toggle. Formatting toolbar writes ordinary Markdown.
- **AI sidecar** (right): chat with the selected model. A response is never part of the manuscript until you insert it — *At cursor*, *Below selection*, *New document*, or *Copy*. Collapsible.
- **View ▸ Focus mode** is the minimal skin: just the document editor.
- Themes (Parchment / Ink / Plain) are pure token swaps in `styles.css`; behavior never changes with the skin.

## AI commands

**Rewrite ▾ (with subtypes) · Expand · Continue · Shorten** — every command follows the same contract:

Writer also includes fiction-focused **Guided Write**, **Describe**, **Brainstorm**, **First Draft**, and **Feedback** commands. Outline, Lore & style, Sources, and manuscript context together act as the project Story Bible; every included item remains visible in pre-flight.

1. A **pre-flight dialog** shows the operation, editable instruction, model, the exact context items included (with word counts), and the privacy scope — before anything is sent.
2. The result opens in a **diff preview**. Nothing has changed yet.
3. You choose **Keep original**, **Replace**, **Insert below**, or **Try again**.
4. Any accepted change appends a **revision record**: document, selection, operation, instruction, provider/model, scope, context item names, timestamp, acceptance choice, and before/after text.

“Keep original” records nothing. Manual snapshots (File ▸ Snapshot version) use the same revision log.

## Providers

Models are replaceable adapters, chosen per task and never hidden:

| Provider | Scope | Notes |
| --- | --- | --- |
| **Preview (no AI)** | stays local | Built-in canned transforms so the whole workflow is testable with no model connected. Deterministic, clearly labeled, not intelligent. |
| **Ollama** | stays local | Point at a local Ollama server (Tools ▸ Providers). “Detect installed models” lists what's pulled. If the browser can't reach it from a `file://` page, start Ollama with `OLLAMA_ORIGINS='*' ollama serve`. |
| **KoboldAI / KoboldCpp** | stays local | Reuses the writing model loaded by a local Kobold server, normally at `http://localhost:5001`. Writer can detect its model and exposes temperature, repetition penalty, and output length. |
| **Gemini API** | leaves device | Limited free tier through Google AI Studio. Free-tier content may be used to improve Google products. |
| **Groq** | leaves device | Published free-plan limits with fast hosted open-model inference, including GPT-OSS. |
| **OpenRouter** | leaves device | `openrouter/free` routes among currently available free models; model choice and availability can vary. |
| **AI Horde** | leaves device | Free community-cloud text generation. Requests are handled by volunteer-operated workers; anonymous use has the lowest queue priority. |
| **Bring your own API** | leaves device | Add multiple OpenAI-compatible chat-completions endpoints and model names. |

AI Horde works immediately with its anonymous key. A registered AI Horde key
improves queue priority through Kudos. Writer can load the currently available
text models and their reported wait estimates, or use **Fastest available text
model**. Because volunteer workers receive the prompt, use only selected
passages and retrieved lore excerpts; do not send identifying or commercially
sensitive material.

Bring Your Own API connections store the provider name, endpoint, and model in
the project, but never the API key. Keys are session-only unless you explicitly
choose browser storage, and are excluded from project folders, backups,
prompts, revisions, and privacy receipts. Custom endpoints must support the
OpenAI chat-completions request and response format and allow browser requests.

**Tools ▸ Fiction model catalog…** includes curated local-fiction choices with adult-content and license labels. Erebus v3 7B Q4 is the recommended practical adult-fiction starting point for a 16 GB Mac; Tiefighter 13B is a larger optional hybrid. Classic Colab families such as Nerys, Janeway, Skein, Shinen, Lit, and Nerybus are documented as lineage rather than presented as automatic downloads.

### Project knowledge and trainable work

**Tools ▸ Knowledge & training…** imports `.docx`, `.rtf`, `.txt`, or `.md` files as explicit Lore / Production Bible, Style guide, or Research source records. Long knowledge documents use transparent keyword retrieval so AI requests receive relevant passages rather than an entire bible by default. The context receipt names retrieved-excerpt use.

Documents use Davenport states `[RAW]`, `[WORKING]`, `[REVIEW]`, `[APPROVED]`, `[FINAL]`, and `[ARCHIVED]`. Only manuscript documents explicitly marked `[APPROVED]` or `[FINAL]` enter the exportable JSONL training corpus. Exporting a corpus prepares portable data; it does not silently fine-tune or alter a model.

Connected project folders keep Markdown canonical and add optional `davenport-manifest.json`, `knowledge/knowledge-index.json`, and `training/approved-examples.jsonl` sidecars. States are metadata and do not force files to move.

**Privacy scope** is declared before generation and recorded per revision:

- **Local-only** (default) — cloud models are blocked outright.
- **Hybrid** — cloud allowed, but each request needs a per-request approval.
- **Cloud-enabled** — cloud allowed after a one-time consent.

Tools ▸ Model routing suggestions shows suggested starting routes; they are defaults, not claims of superiority, and Writer never auto-switches models.

Tools ▸ Privacy receipts shows a local, append-only summary of every completed
AI request: operation, time, provider/model, destination, privacy scope, excerpt
word count, and context-item names. API keys and full prompts are not copied
into receipts.

## Davenport knowledge compatibility

Writer includes a shared manifest schema and validator for production bibles,
series guides, lore indexes, manuscripts, and style references. Davenport file
state and story canon status are deliberately stored as separate fields.

Validate an external knowledge repository with:

```bash
npm run validate:knowledge -- /absolute/path/to/davenport-knowledge-manifest.json
```

The schema lives at
`schemas/davenport-knowledge-manifest.schema.json`. The full authoring contract
and manifest can live beside the source corpus so Writer never becomes the
authority for canon.

## Export & Davenport compatibility

Export produces a **named copy** — Markdown, plain text, or HTML (the initial rich format) — into `exports/` when a folder is connected, otherwise as a download. It never converts or replaces the source.

Writer is Davenport-**compatible**, not Davenport-branded: authored files stay portable; AI never silently renames, moves, overwrites, or deletes canonical sources; AI output is derived/revision data separated from originals; cloud context is explicitly selected and declared; and Writer is never the only path to open, copy, back up, or restore the work (the files are plain Markdown on disk).

## First-release boundary (spec §11) — status

Included and working: one-project editor (Markdown/TXT source), standard formatting and document structure, project panel (documents/outline/lore/sources), local model connection (Ollama) plus one cloud adapter behind explicit consent, chat + generate/insert + rewrite/expand/continue/shorten, diff preview and revision snapshots, Markdown/TXT export plus HTML as the initial rich export, theme tokens and collapsible panels.

Deliberately not included yet (per spec): DOCX export, PDF import-export, Fountain, Post delivery handoff, collaborative editing, automatic model routing, bulk Davenport ingestion, and an embedded database as primary storage.

## Release and security

Writer is currently version 0.1.0. Changes are documented in
[`CHANGELOG.md`](../CHANGELOG.md); credential-handling guidance is in
[`SECURITY.md`](../SECURITY.md). Browser storage is not an OS keychain: prefer
session-only cloud keys, especially on shared machines.
