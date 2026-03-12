#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const ROOT = process.cwd();
const RULES_PATH = path.join(ROOT, "rules.json");

const NORMALIZED_HTML = path.join(ROOT, "normalized", "index.html");
const CURRENT_DIR = path.join(ROOT, "current");
const TARGET_DIR = path.join(ROOT, "target");
const DIFF_DIR = path.join(ROOT, "diff");
const REPORTS_DIR = path.join(ROOT, "reports");
const REPORT_PATH = path.join(REPORTS_DIR, "regression-report.json");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function blitToCanvas(src, width, height) {
  const out = new PNG({ width, height, colorType: 6 });
  PNG.bitblt(src, out, 0, 0, src.width, src.height, 0, 0);
  return out;
}

async function screenshotAllBreakpoints(breakpoints, screenshotHeight) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await fs.mkdir(CURRENT_DIR, { recursive: true });

  for (const width of breakpoints) {
    await page.setViewportSize({ width, height: screenshotHeight });
    await page.goto(`file://${NORMALIZED_HTML}`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({
      path: path.join(CURRENT_DIR, `${width}.png`),
      fullPage: false,
      type: "png"
    });
  }

  await browser.close();
}

async function compareAtBreakpoint(width, threshold, maxDiffRatio) {
  const targetPath = path.join(TARGET_DIR, `${width}.png`);
  const currentPath = path.join(CURRENT_DIR, `${width}.png`);
  const diffPath = path.join(DIFF_DIR, `${width}.png`);

  if (!existsSync(targetPath)) {
    return {
      breakpoint: width,
      status: "missing-target",
      targetPath,
      currentPath,
      diffRatio: null,
      passed: false,
      message: "Target screenshot is missing"
    };
  }

  const [targetBuffer, currentBuffer] = await Promise.all([
    fs.readFile(targetPath),
    fs.readFile(currentPath)
  ]);

  const target = PNG.sync.read(targetBuffer);
  const current = PNG.sync.read(currentBuffer);

  const canvasWidth = Math.max(target.width, current.width);
  const canvasHeight = Math.max(target.height, current.height);

  const targetCanvas = blitToCanvas(target, canvasWidth, canvasHeight);
  const currentCanvas = blitToCanvas(current, canvasWidth, canvasHeight);
  const diff = new PNG({ width: canvasWidth, height: canvasHeight, colorType: 6 });

  const diffPixels = pixelmatch(
    targetCanvas.data,
    currentCanvas.data,
    diff.data,
    canvasWidth,
    canvasHeight,
    { threshold }
  );

  const totalPixels = canvasWidth * canvasHeight;
  const diffRatio = diffPixels / totalPixels;
  const passed = diffRatio <= maxDiffRatio;

  await fs.writeFile(diffPath, PNG.sync.write(diff));

  return {
    breakpoint: width,
    status: "ok",
    targetSize: [target.width, target.height],
    currentSize: [current.width, current.height],
    canvasSize: [canvasWidth, canvasHeight],
    dimensionMismatch: target.width !== current.width || target.height !== current.height,
    diffPixels,
    totalPixels,
    diffRatio,
    threshold: maxDiffRatio,
    passed,
    diffPath
  };
}

async function main() {
  if (!existsSync(NORMALIZED_HTML)) {
    throw new Error(`Missing normalized HTML: ${NORMALIZED_HTML}`);
  }

  const rules = await readJson(RULES_PATH);
  const breakpoints = rules?.breakpoints || [1440, 1024, 768, 375];
  const screenshotHeight = rules?.screenshotHeight || 1600;
  const maxDiffRatio = rules?.regression?.maxDiffRatio ?? 0.03;
  const pixelmatchThreshold = rules?.regression?.pixelmatchThreshold ?? 0.1;

  await Promise.all([
    fs.mkdir(DIFF_DIR, { recursive: true }),
    fs.mkdir(REPORTS_DIR, { recursive: true })
  ]);

  await screenshotAllBreakpoints(breakpoints, screenshotHeight);

  const results = [];
  for (const width of breakpoints) {
    // eslint-disable-next-line no-await-in-loop
    const result = await compareAtBreakpoint(width, pixelmatchThreshold, maxDiffRatio);
    results.push(result);
  }

  const failed = results.some((r) => !r.passed);
  const summary = {
    generatedAt: new Date().toISOString(),
    breakpoints,
    maxDiffRatio,
    pixelmatchThreshold,
    failed,
    results
  };

  await fs.writeFile(REPORT_PATH, JSON.stringify(summary, null, 2), "utf8");

  for (const r of results) {
    if (r.status !== "ok") {
      console.log(`[regression] ${r.breakpoint}px -> ${r.status}`);
      continue;
    }
    console.log(
      `[regression] ${r.breakpoint}px diffRatio=${r.diffRatio.toFixed(4)} limit=${maxDiffRatio} ${
        r.passed ? "PASS" : "FAIL"
      }`
    );
  }
  console.log(`[regression] report -> ${REPORT_PATH}`);

  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(`[regression] failed: ${error.message}`);
  process.exit(1);
});
