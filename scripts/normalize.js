#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import * as cheerio from "cheerio";

const ROOT = process.cwd();
const GENERATED_DIR = path.join(ROOT, "generated");
const NORMALIZED_DIR = path.join(ROOT, "normalized");
const REPORTS_DIR = path.join(ROOT, "reports");

const INPUT_HTML = path.join(GENERATED_DIR, "index.html");
const INPUT_CSS = path.join(GENERATED_DIR, "styles.css");
const OUT_HTML = path.join(NORMALIZED_DIR, "index.html");
const OUT_CSS = path.join(NORMALIZED_DIR, "styles.css");
const REPORT_PATH = path.join(REPORTS_DIR, "normalize-report.json");

const RULES_PATH = path.join(ROOT, "rules.json");
const TOKENS_PATH = path.join(ROOT, "design-tokens.json");
const MANIFEST_PATH = path.join(ROOT, "asset-manifest.json");

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flattenTokens(tokens) {
  const entries = [];
  for (const [group, groupValues] of Object.entries(tokens || {})) {
    if (!groupValues || typeof groupValues !== "object") continue;
    for (const [name, value] of Object.entries(groupValues)) {
      const key = `--${group}-${name}`;
      if (typeof value === "string") entries.push({ key, value });
    }
  }
  return entries;
}

function buildRootBlock(tokenEntries) {
  const lines = tokenEntries.map(({ key, value }) => `  ${key}: ${value};`);
  return `:root {\n${lines.join("\n")}\n}\n\n`;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function semanticizeHtml(html, rules, report) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const semanticRules = [
    { cls: /(^|\s)(header|page-header)(\s|$)/, tag: "header" },
    { cls: /(^|\s)(main|page-main|content)(\s|$)/, tag: "main" },
    { cls: /(^|\s)(nav|navbar|navigation)(\s|$)/, tag: "nav" },
    { cls: /(^|\s)(footer|page-footer)(\s|$)/, tag: "footer" }
  ];

  for (const rule of semanticRules) {
    $("div").each((_, el) => {
      const className = ($(el).attr("class") || "").trim();
      if (!rule.cls.test(` ${className} `)) return;
      const attrs = el.attribs || {};
      const inner = $(el).html() || "";
      const attrString = Object.entries(attrs)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, "&quot;")}"`)
        .join(" ");
      const replacement = `<${rule.tag}${attrString ? ` ${attrString}` : ""}>${inner}</${rule.tag}>`;
      $(el).replaceWith(replacement);
      report.semanticReplacements += 1;
    });
  }

  if (rules?.a11y?.requireImgAlt) {
    $("img").each((_, img) => {
      if (!$(img).attr("alt")) {
        $(img).attr("alt", "");
        report.addedImgAlt += 1;
      }
    });
  }

  return $.html();
}

function applyAssetManifest(html, css, manifest, report) {
  let nextHtml = html;
  let nextCss = css;

  for (const asset of manifest.assets || []) {
    if (!asset.name || !asset.path) continue;

    const placeholders = [
      `__ASSET__${asset.name}__`,
      `asset://${asset.name}`,
      `{{asset:${asset.name}}}`
    ];

    for (const placeholder of placeholders) {
      const re = new RegExp(escapeRegex(placeholder), "g");
      const htmlHits = (nextHtml.match(re) || []).length;
      const cssHits = (nextCss.match(re) || []).length;
      if (htmlHits + cssHits > 0) {
        nextHtml = nextHtml.replace(re, asset.path);
        nextCss = nextCss.replace(re, asset.path);
        report.assetReplacements += htmlHits + cssHits;
      }
    }
  }

  return { html: nextHtml, css: nextCss };
}

function replaceTokenValues(css, tokenEntries, rules, report) {
  if (!rules?.tokensPolicy?.strict) return css;

  // Longest first to avoid partial replacement collisions.
  const sorted = [...tokenEntries].sort((a, b) => b.value.length - a.value.length);
  let nextCss = css;

  for (const { key, value } of sorted) {
    const re = new RegExp(escapeRegex(value), "g");
    const hits = nextCss.match(re);
    if (!hits?.length) continue;
    nextCss = nextCss.replace(re, `var(${key})`);
    report.tokenReplacements += hits.length;
  }

  return nextCss;
}

function auditCss(css, rules, report) {
  const allowedRaw = new Set(rules?.tokensPolicy?.allowRawValues || []);

  const hexColors = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  for (const c of hexColors) {
    if (!allowedRaw.has(c)) report.rawHexColors.add(c);
  }

  const rawPx = css.match(/\b\d+(?:\.\d+)?px\b/g) || [];
  for (const px of rawPx) {
    if (!allowedRaw.has(px)) report.rawPxValues.add(px);
  }
}

async function main() {
  if (!existsSync(INPUT_HTML) || !existsSync(INPUT_CSS)) {
    throw new Error(
      `Missing generated files. Expected:\n- ${INPUT_HTML}\n- ${INPUT_CSS}`
    );
  }

  await fs.mkdir(NORMALIZED_DIR, { recursive: true });
  await fs.mkdir(REPORTS_DIR, { recursive: true });

  const [rules, tokens, manifest] = await Promise.all([
    readJson(RULES_PATH),
    readJson(TOKENS_PATH),
    readJson(MANIFEST_PATH)
  ]);

  const tokenEntries = flattenTokens(tokens);
  const rootBlock = buildRootBlock(tokenEntries);

  const report = {
    generatedAt: new Date().toISOString(),
    semanticReplacements: 0,
    addedImgAlt: 0,
    assetReplacements: 0,
    tokenReplacements: 0,
    rawHexColors: new Set(),
    rawPxValues: new Set()
  };

  let [html, css] = await Promise.all([
    fs.readFile(INPUT_HTML, "utf8"),
    fs.readFile(INPUT_CSS, "utf8")
  ]);

  html = semanticizeHtml(html, rules, report);

  ({ html, css } = applyAssetManifest(html, css, manifest, report));

  css = replaceTokenValues(css, tokenEntries, rules, report);

  const responsiveInject = `\n/* injected responsive container rules */\n.container{max-width:${rules?.layout?.containerMaxWidth || 1200}px;margin-inline:auto;padding-inline:${rules?.layout?.containerPadding?.desktop || 24}px;}\n@media (max-width:${rules?.breakpoints?.[2] || 768}px){.container{padding-inline:${rules?.layout?.containerPadding?.tablet || 20}px;}}\n@media (max-width:${rules?.breakpoints?.[3] || 375}px){.container{padding-inline:${rules?.layout?.containerPadding?.mobile || 16}px;}}\n`;

  css = `${rootBlock}${css}${responsiveInject}`;

  auditCss(css, rules, report);

  const finalReport = {
    ...report,
    rawHexColors: [...report.rawHexColors],
    rawPxValues: [...report.rawPxValues]
  };

  await Promise.all([
    fs.writeFile(OUT_HTML, html, "utf8"),
    fs.writeFile(OUT_CSS, css, "utf8"),
    fs.writeFile(REPORT_PATH, JSON.stringify(finalReport, null, 2), "utf8")
  ]);

  console.log(`[normalize] done -> ${OUT_HTML}`);
  console.log(`[normalize] done -> ${OUT_CSS}`);
  console.log(`[normalize] report -> ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(`[normalize] failed: ${error.message}`);
  process.exit(1);
});
