#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const manifestPath = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(manifestPath)) {
  console.error("Usage: node scripts/validate-knowledge-manifest.mjs /path/to/davenport-knowledge-manifest.json");
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const root = path.resolve(path.dirname(manifestPath), "..");
const states = new Set(["RAW", "WORKING", "REVIEW", "APPROVED", "FINAL", "ARCHIVED"]);
const roles = new Set(["lore", "style", "source", "manuscript", "outline", "decision-log", "contradiction-ledger"]);
const canon = new Set(["canon", "working canon", "provisional", "alternate", "deprecated", "influence only", "range", "in-universe claim", "mixed"]);
const policies = new Set(["retrieval", "training-approved", "reference-only", "blocked"]);
const authorities = new Set(["creator-authored", "creator-reviewed synthesis", "raw archive", "AI synthesis", "external reference", "repository audit"]);
const errors = [];
const ids = new Set();

if (manifest.schema !== "davenport.knowledge.manifest.v1") errors.push("schema must be davenport.knowledge.manifest.v1");
if (!String(manifest.project || "").trim()) errors.push("project is required");
if (!Array.isArray(manifest.records)) errors.push("records must be an array");

for (const [index, record] of (manifest.records || []).entries()) {
  const at = `records[${index}]`;
  if (!/^SRC-\d{4,}$/.test(record.source_id || "")) errors.push(`${at}.source_id must match SRC-####`);
  if (ids.has(record.source_id)) errors.push(`${at}.source_id duplicates ${record.source_id}`);
  ids.add(record.source_id);
  if (!record.title) errors.push(`${at}.title is required`);
  if (!roles.has(record.role)) errors.push(`${at}.role is invalid`);
  if (!states.has(record.state)) errors.push(`${at}.state is invalid`);
  if (!canon.has(record.canon_status)) errors.push(`${at}.canon_status is invalid`);
  if (!policies.has(record.ai_policy)) errors.push(`${at}.ai_policy is invalid`);
  if (!authorities.has(record.authority)) errors.push(`${at}.authority is invalid`);
  if (!record.source_family) errors.push(`${at}.source_family is required`);
  if (!Array.isArray(record.scope)) errors.push(`${at}.scope must be an array`);
  if (!Array.isArray(record.retrieval_keys)) errors.push(`${at}.retrieval_keys must be an array`);
  if (!record.provenance) errors.push(`${at}.provenance is required`);
  if (!record.path) errors.push(`${at}.path is required`);
  else if (!fs.existsSync(path.resolve(root, record.path))) errors.push(`${at}.path does not exist: ${record.path}`);
  if (record.ai_policy === "training-approved" && record.role !== "manuscript" && record.role !== "style") {
    errors.push(`${at}: training-approved is limited to manuscript or style records`);
  }
}

if (errors.length) {
  console.error(`INVALID ${manifestPath}`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`VALID ${manifestPath}`);
console.log(`${manifest.records.length} records · ${ids.size} unique source IDs · all paths present`);
