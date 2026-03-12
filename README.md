# design-to-code-pipeline

一个“截图生码 + 代码规范化 + 多断点视觉回归”的原生 HTML/CSS 流水线。

## 目录结构

```txt
design-to-code-pipeline/
├── assets/                 # 从 Figma 导出的素材
├── generated/              # 模型首轮生成代码（输入）
├── normalized/             # 规范化后的代码（输出）
├── target/                 # 目标截图（1440/1024/768/375）
├── current/                # 当前截图（回归时生成）
├── diff/                   # 差异图（回归时生成）
├── reports/                # normalize/regression 报告
├── scripts/
│   ├── select_assets.py
│   ├── normalize.js
│   └── regression.js
├── asset-manifest.json
├── design-tokens.json
├── rules.json
└── package.json
```

## 快速开始

```bash
npm install
npx playwright install chromium
```

### 1) 准备输入

- 把模型首轮输出放入：
  - `generated/index.html`
  - `generated/styles.css`
- 把目标截图放入：
  - `target/1440.png`
  - `target/1024.png`
  - `target/768.png`
  - `target/375.png`
- 更新配置：
  - `asset-manifest.json`（素材映射）
  - `design-tokens.json`（设计令牌）
  - `rules.json`（自定义规则）

### 2) （可选）全量素材自动筛选

当你从 Zeplin/Figma 导出了大量素材时，可以先做自动筛选：

```bash
# 初始化 Python 环境（一次即可）
python3 -m venv .venv
./.venv/bin/pip install -r requirements-select.txt

# 准备输入
# input/assets_raw/           放解压后的素材
# input/screenshots/target-desktop.png
# input/screenshots/target-mobile.png

npm run select-assets
```

输出：
- `reports/asset-selection/selected-assets.json`
- `reports/asset-selection/ambiguous-assets.json`
- `reports/asset-selection/unused-assets.json`
- `reports/asset-selection/asset-manifest.auto.json`

### 3) 运行规范化

```bash
npm run normalize
```

输出：
- `normalized/index.html`
- `normalized/styles.css`
- `reports/normalize-report.json`

### 3) 运行截图回归

```bash
npm run regress
```

输出：
- `current/*.png`
- `diff/*.png`
- `reports/regression-report.json`

### 4) 一键检查

```bash
npm run check
```

## normalize.js 做了什么

- 基础语义化修正（`div.header -> header` 等）
- 根据规则补充 `img alt`
- 用 `asset-manifest.json` 回填素材占位符（支持 `__ASSET__name__` / `asset://name` / `{{asset:name}}`）
- 将 CSS 中与 token value 相同的值替换为 `var(--token)`（严格模式）
- 注入容器响应式规则
- 输出审计报告（raw hex / raw px）

## regression.js 做了什么

- 用 Playwright 渲染 `normalized/index.html`
- 按断点自动截图
- 用 pixelmatch 计算差异并输出 `diff` 图
- 按 `rules.json` 的阈值判定 PASS/FAIL

## 推荐工作流

1. 图片转代码模型输出 `generated/*`
2. 运行 `normalize`
3. 运行 `regress`
4. 若失败：把 `diff` + 报告喂给修复模型生成最小补丁
5. 重复 2-4，最多 3 轮

## 注意

- 本项目默认只处理**静态页面还原**，不包含业务交互逻辑。
- 若 target 与 current 尺寸不同，会自动补齐画布后比较，并在报告中标记 `dimensionMismatch`。
- 为减少噪声，建议目标截图使用固定字体、固定浏览器、固定缩放比例导出。
