const { test, expect } = require("@playwright/test");

function storedZip(entries) {
  const files = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    files.push(local, nameBytes, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, centralBytes, eocd]);
}

async function fresh(page) {
  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

test.describe("Writer release contract", () => {
  test.beforeEach(async ({ page }) => fresh(page));

  test("loads a local-first workspace", async ({ page }) => {
    await expect(page).toHaveTitle("Writer");
    await expect(page.locator("#doc-title")).toHaveValue("Chapter One");
    await expect(page.locator("#status-scope")).toHaveText("Local-only");
    await expect(page.locator("#status-model")).toHaveText("Canned transforms · Preview (no AI)");
  });

  test("first run explains Preview and can be dismissed", async ({ page }) => {
    await expect(page.getByLabel("Welcome to Writer")).toContainText("fixed placeholder text");
    await page.getByRole("button", { name: "Got it" }).click();
    await expect(page.getByLabel("Welcome to Writer")).toBeHidden();
    await page.reload();
    await expect(page.getByLabel("Welcome to Writer")).toBeHidden();
  });

  test("editor changes persist and create a recovery snapshot", async ({ page }) => {
    const editor = page.getByPlaceholder("Write here. Select text and use Rewrite / Expand / Shorten, or place the cursor and press Continue.");
    await editor.fill("# Safe draft\n\nCanonical text.");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const recovery = await page.evaluate(() => JSON.parse(localStorage.getItem("writer.recovery.v1")));
    expect(recovery.project.docs[0].content).toBe("# Safe draft\n\nCanonical text.");
    await page.reload();
    await expect(editor).toHaveValue("# Safe draft\n\nCanonical text.");
  });

  test("Continue requires preflight and acceptance", async ({ page }) => {
    const editor = page.locator("#editor");
    const before = await editor.inputValue();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Continue — review before submission" })).toBeVisible();
    await expect(editor).toHaveValue(before);
    await page.getByRole("button", { name: "Run continue" }).click();
    await expect(page.getByRole("heading", { name: "Preview — Continue" })).toBeVisible();
    await expect(editor).toHaveValue(before);
    await page.getByRole("button", { name: "Insert at cursor" }).click();
    await expect(editor).not.toHaveValue(before);
    await expect(page.getByRole("button", { name: "Revisions 1" })).toBeVisible();
  });

  test("discard keeps source and records no revision", async ({ page }) => {
    const editor = page.locator("#editor");
    const before = await editor.inputValue();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Run continue" }).click();
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(editor).toHaveValue(before);
    await expect(page.getByRole("button", { name: "Revisions 0" })).toBeVisible();
  });

  test("selection commands refuse empty selections", async ({ page }) => {
    await page.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(page.locator("#toast")).toContainText("Select some text first");
    await page.getByRole("button", { name: "Shorten", exact: true }).click();
    await expect(page.locator("#toast")).toContainText("Select some text first");
  });

  test("baked-in rewrite tones reach preflight without changing the manuscript", async ({ page }) => {
    const editor = page.locator("#editor");
    const before = await editor.inputValue();
    await editor.selectText();
    await page.getByRole("button", { name: "Rewrite ▾" }).click();
    await page.getByRole("button", { name: "Sensual", exact: true }).click();
    await expect(page.locator("#pf-instruction")).toContainText("sensual, embodied tone");
    await expect(page.locator("#pf-instruction")).toContainText("consent");
    await expect(editor).toHaveValue(before);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("Rewrite opens as a toolbar tray that does not cover the manuscript", async ({ page }) => {
    const editor = page.locator("#editor");
    const before = await editor.boundingBox();
    await page.getByRole("button", { name: "Rewrite ▾" }).click();
    const tray = page.locator(".rewrite-menu");
    const after = await editor.boundingBox();
    const trayBox = await tray.boundingBox();
    expect(trayBox).not.toBeNull();
    expect(after.y).toBeGreaterThan(before.y);
    expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(after.y + 1);
  });

  test("rewrite intensity controls preserve events and boundaries", async ({ page }) => {
    const editor = page.locator("#editor");
    const before = await editor.inputValue();
    await editor.selectText();
    await page.getByRole("button", { name: "Rewrite ▾" }).click();
    await page.getByRole("button", { name: "More violent", exact: true }).click();
    await expect(page.locator("#pf-instruction")).toContainText("existing violence");
    await expect(page.locator("#pf-instruction")).toContainText("do not invent additional violent acts");
    await expect(editor).toHaveValue(before);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("character voice rewrite uses selected project lore as authority", async ({ page }) => {
    const editor = page.locator("#editor");
    const before = await editor.inputValue();
    await editor.selectText();
    await page.getByRole("button", { name: "Rewrite ▾" }).click();
    await page.getByRole("button", { name: "Val in Wanderer — dry engineer", exact: true }).click();
    await expect(page.locator("#pf-instruction")).toContainText("dry engineer speech");
    await expect(page.locator("#pf-instruction")).toContainText("production Bible as authority");
    await expect(page.locator("#pf-instruction")).toContainText("do not invent catchphrases");
    await expect(editor).toHaveValue(before);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("plot improvisation proposes lore-aware moves without changing the manuscript", async ({ page }) => {
    const editor = page.locator("#editor");
    const before = await editor.inputValue();
    await page.getByRole("button", { name: "Plot Improv", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Plot Improv — review before submission" })).toBeVisible();
    await expect(page.locator("#pf-instruction")).toContainText("8 distinct next plot moves");
    await expect(page.locator("#pf-instruction")).toContainText("selected project lore");
    await expect(page.locator("#pf-instruction")).toContainText("do not draft the scene");
    await expect(editor).toHaveValue(before);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("Preview renders escaped Markdown safely", async ({ page }) => {
    await page.locator("#editor").fill("# Heading\n\n<script>window.pwned=true</script>\n\n**bold**");
    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("button", { name: "Toggle Markdown preview", exact: true }).click();
    await expect(page.locator("#preview h1")).toHaveText("Heading");
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    await expect(page.locator("#preview")).toContainText("<script>");
  });

  test("AI sidecar does not change the manuscript until insertion", async ({ page }) => {
    const editor = page.locator("#editor");
    const before = await editor.inputValue();
    await page.getByPlaceholder("Ask, brainstorm, or draft. Nothing enters the manuscript until you insert it.").fill("Draft one line");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("This is the built-in Preview provider", { exact: false })).toBeVisible();
    await expect(editor).toHaveValue(before);
    await page.getByRole("button", { name: "At cursor" }).click();
    await expect(editor).not.toHaveValue(before);
    await expect(page.getByRole("button", { name: "Revisions 1" })).toBeVisible();
  });

  test("privacy receipts record exact request metadata", async ({ page }) => {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Run continue" }).click();
    await page.getByRole("button", { name: "Discard" }).click();
    await page.getByRole("button", { name: "Tools" }).click();
    await page.getByRole("button", { name: "Privacy receipts…" }).click();
    await expect(page.getByRole("heading", { name: "Privacy receipts" })).toBeVisible();
    await expect(page.locator(".receipt")).toContainText("destination: This device");
    await expect(page.locator(".receipt")).toContainText("Chapter One");
  });

  test("manual snapshot is append-only and restorable as a new document", async ({ page }) => {
    await page.getByRole("button", { name: "File" }).click();
    await page.getByRole("button", { name: "Snapshot version" }).click();
    await page.getByRole("button", { name: "Revisions 1" }).click();
    await page.locator(".rev-item").click();
    await page.getByRole("button", { name: "Restore “before” as new document" }).click();
    await expect(page.locator("#doc-title")).toHaveValue(/restored/i);
    await expect(page.getByRole("button", { name: "Revisions 1" })).toBeVisible();
  });

  test("opens a Word document as a new editable Writer document", async ({ page }) => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Imported Chapter</w:t></w:r></w:p>
          <w:p><w:r><w:t>The opening has </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold words</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>
          <w:tbl>
            <w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>Mara</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Captain</w:t></w:r></w:p></w:tc></w:tr>
          </w:tbl>
        </w:body>
      </w:document>`;
    const docx = storedZip({ "word/document.xml": documentXml });

    await page.getByRole("button", { name: "File", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open document (.docx, .txt, .rtf, .md)…" })).toBeVisible();
    await page.locator("#document-file-input").setInputFiles({
      name: "My Novel.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: docx,
    });

    await expect(page.locator("#doc-title")).toHaveValue("My Novel — Writer Copy");
    await expect(page.locator("#editor")).toHaveValue(/# Imported Chapter/);
    await expect(page.locator("#editor")).toHaveValue(/\*\*bold words\*\*/);
    await expect(page.locator("#editor")).toHaveValue(/\| Name \| Role \|/);
    await expect(page.locator("#toast")).toContainText("original file will never be overwritten");
    await expect(page.locator("#doc-meta")).toContainText("working copy of My Novel.docx");
    await expect(page.locator("#doc-meta")).toContainText("source protected");
  });

  for (const sample of [
    { name: "Notes.txt", mimeType: "text/plain", source: "Plain text notes.", expected: "Plain text notes." },
    { name: "Davenport.md", mimeType: "text/markdown", source: "# Davenport Notes\n\nPortable Markdown.", expected: "# Davenport Notes\n\nPortable Markdown." },
    { name: "Legacy.rtf", mimeType: "text/rtf", source: String.raw`{\rtf1\ansi Legacy \b bold\b0  text.\par Next paragraph.}`, expected: "Legacy **bold** text.\n\nNext paragraph." },
  ]) {
    test(`opens ${sample.name.split(".").pop()} files without changing the source format`, async ({ page }) => {
      await page.locator("#document-file-input").setInputFiles({
        name: sample.name,
        mimeType: sample.mimeType,
        buffer: Buffer.from(sample.source),
      });
      await expect(page.locator("#doc-title")).toHaveValue(sample.name.replace(/\.[^.]+$/, "") + " — Writer Copy");
      await expect(page.locator("#editor")).toHaveValue(sample.expected);
      await expect(page.locator("#toast")).toContainText("original file will never be overwritten");
    });
  }

  test("reopening a source creates a numbered Writer copy", async ({ page }) => {
    const source = {
      name: "Draft.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Draft"),
    };
    await page.locator("#document-file-input").setInputFiles(source);
    await expect(page.locator("#doc-title")).toHaveValue("Draft — Writer Copy");
    await page.locator("#document-file-input").setInputFiles(source);
    await expect(page.locator("#doc-title")).toHaveValue("Draft — Writer Copy 2");
  });

  test("themes and focus mode remain usable", async ({ page }) => {
    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("button", { name: "Theme: Ink (dark)" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "ink");
    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("button", { name: "Focus mode (minimal skin)" }).click();
    await expect(page.locator("#project-panel")).toBeHidden();
    await expect(page.locator("#editor")).toBeVisible();
  });

  test("cloud model is blocked under local-only scope", async ({ page }) => {
    await page.getByRole("button", { name: /Model:/ }).first().click();
    await page.getByRole("button", { name: /Gemini 2.5 Flash \(free tier\)/ }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Run continue" }).click();
    await expect(page.locator("#toast")).toContainText("Local-only");
    await expect(page.getByRole("heading", { name: "Continue — review before submission" })).toBeVisible();
  });

  test("empty chat is ignored", async ({ page }) => {
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-user")).toHaveCount(0);
  });

  test("narrow view keeps editor reachable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#editor")).toBeVisible();
    await expect(page.locator("#workspace")).toBeVisible();
    await expect(page.locator("#toolbar-standard")).toBeHidden();
  });

  for (const [label, ext] of [
    ["Export copy as Markdown", ".md"],
    ["Export copy as Plain text", ".txt"],
    ["Export copy as HTML", ".html"],
  ]) {
    test(`${ext} export is a copy and leaves source unchanged`, async ({ page }) => {
      const editor = page.locator("#editor");
      const before = "# Export proof\n\nCanonical source remains unchanged.";
      await editor.fill(before);
      await page.getByRole("button", { name: "File", exact: true }).click();
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: label, exact: true }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(new RegExp(`\\${ext}$`));
      await expect(editor).toHaveValue(before);
    });
  }

  test("unavailable Ollama reports failure without changing source", async ({ page }) => {
    const editor = page.locator("#editor");
    const before = await editor.inputValue();
    await editor.fill(before + " ");
    await editor.fill(before);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const p = JSON.parse(localStorage.getItem("writer.project.v1"));
      p.settings.providerId = "ollama";
      p.settings.modelId = "qwen3:8b";
      p.settings.ollamaHost = "http://127.0.0.1:9";
      localStorage.setItem("writer.project.v1", JSON.stringify(p));
    });
    await page.reload();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Run continue" }).click();
    await expect(page.locator("#toast")).toContainText("Request failed", { timeout: 10000 });
    await expect(editor).toHaveValue(before);
    await expect(page.getByRole("button", { name: "Revisions 0" })).toBeVisible();
  });

  test("Kobold writing provider is available and stays local", async ({ page }) => {
    await page.getByRole("button", { name: /Model:/ }).first().click();
    await expect(page.getByRole("button", { name: /Kobold writing model/ })).toContainText("stays local");
  });

  test("Kobold generation follows preflight and revision acceptance", async ({ page }) => {
    await page.route("http://localhost:5001/api/v1/generate", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ results: [{ text: "The fog folded over the harbor lights." }] }),
      });
    });
    const editor = page.locator("#editor");
    const before = await editor.inputValue();
    await editor.fill(before + " ");
    await editor.fill(before);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const p = JSON.parse(localStorage.getItem("writer.project.v1"));
      p.settings.providerId = "kobold";
      p.settings.modelId = "Kobold writing model";
      p.settings.koboldHost = "http://localhost:5001";
      localStorage.setItem("writer.project.v1", JSON.stringify(p));
    });
    await page.reload();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Run continue" }).click();
    await expect(page.getByRole("heading", { name: "Preview — Continue" })).toBeVisible();
    await expect(page.locator(".diff-box").filter({ hasText: "The fog folded over the harbor lights." })).toBeVisible();
    await page.getByRole("button", { name: "Insert at cursor" }).click();
    await expect(editor).toHaveValue(/The fog folded over the harbor lights\./);
    await expect(page.getByRole("button", { name: "Revisions 1" })).toBeVisible();
  });

  test("free cloud providers are clearly labeled", async ({ page }) => {
    await page.getByRole("button", { name: /Model:/ }).first().click();
    await expect(page.getByRole("button", { name: /Gemini 2.5 Flash \(free tier\)/ })).toContainText("leaves device");
    await expect(page.getByRole("button", { name: /Qwen 3.6 27B \(free plan\)/ })).toContainText("leaves device");
    await expect(page.getByRole("button", { name: /Free Models Router/ })).toContainText("leaves device");
    await expect(page.getByText("Claude Sonnet 5", { exact: true })).toHaveCount(0);
  });

  test("fiction model catalog labels adult models and classic Kobold lineage", async ({ page }) => {
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.getByRole("button", { name: "Fiction model catalog…" }).click();
    await expect(page.getByRole("heading", { name: "Kobold fiction model catalog" })).toBeVisible();
    await expect(page.getByText("Erebus v3 7B · Q4_K_M")).toBeVisible();
    await expect(page.locator(".model-badge.adult")).toHaveText("Adult fiction");
    await expect(page.getByText(/Nerys.*Janeway.*Skein.*Erebus/)).toBeVisible();
    await expect(page.getByText(/OPT releases restrict commercial use/)).toBeVisible();
  });

  test("imports a production guide as approved Davenport knowledge", async ({ page }) => {
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.getByRole("button", { name: "Knowledge & training…" }).click();
    await page.locator("#knowledge-file-input").setInputFiles({
      name: "Company Man Guide.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Company Man Voice\n\nTerse dialogue. Corporate vocabulary."),
    });
    await page.locator("#ki-role").selectOption("style");
    await page.getByRole("button", { name: "Import knowledge" }).click();
    await expect(page.locator("#doc-title")).toHaveValue("Company Man Guide");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    const imported = await page.evaluate(() => {
      const p = JSON.parse(localStorage.getItem("writer.project.v1"));
      return p.docs.find((doc) => doc.name === "Company Man Guide");
    });
    expect(imported.role).toBe("style");
    expect(imported.folder).toBe("lore");
    expect(imported.state).toBe("APPROVED");
  });

  test("training corpus exports only explicitly approved manuscript work", async ({ page }) => {
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.getByRole("button", { name: "Knowledge & training…" }).click();
    await page.locator('select[data-doc-state]').first().selectOption("APPROVED");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export approved training corpus" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/approved-training\.jsonl$/);
  });

  test("long lore retrieval selects relevant passages instead of the whole bible", async ({ page }) => {
    const result = await page.evaluate(() => {
      const filler = Array.from({ length: 80 }, (_, i) => `Section ${i}\n\nUnrelated accounting material for department ${i}.`).join("\n\n");
      const lore = `${filler}\n\n# Orphan Engine\n\nThe Orphan engine requires a cobalt ignition key and produces violet exhaust.`;
      return retrieveRelevantPassages(lore, "Describe the Orphan engine ignition and exhaust", 500);
    });
    expect(result.retrieved).toBe(true);
    expect(result.content).toContain("cobalt ignition key");
    expect(result.content.length).toBeLessThan(800);
  });

  test("fiction writing tools use the same preflight safety contract", async ({ page }) => {
    const editor = page.locator("#editor");
    await editor.selectText();
    await page.getByRole("button", { name: "Describe", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Describe — review before submission" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Feedback — review before submission" })).toBeVisible();
  });
});
