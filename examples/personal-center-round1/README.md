# Personal Center Round 1 Draft

这一版基于 `selected-relaxed` 素材自动首轮拼接，目的是先把结构跑通。

## 结果

回归差异（与目标截图）:
- 1440: 0.4841
- 1024: 0.6104
- 768: 0.7264
- 375: 0.5608

说明：当前仍处于“结构草图阶段”，后续需要继续做：
1. 更精确的字体与字号映射
2. 顶栏与表单块的间距校准
3. 右侧栏模块比例修正
4. ambiguous 资源人工勾选后再跑修补

## 文件说明

- `index.html` / `styles.css`: 首版页面
- `reference/`: 目标截图（回归基准）
- `current/`: 当前渲染截图
- `diff/`: 差异图
- `assets-picked/`: 自动筛选出的 selected/ambiguous 资产列表
