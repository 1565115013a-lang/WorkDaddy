# WorkDaddy CSS 变量常量全量清单

> 来源：`scripts/daemon.js`（内置主题 `BUILTIN_THEMES`）、`scripts/inject.js`（检查器/皮肤生成/样式）、`scripts/theme-patches.js`（深色化补丁）。
> 变量分三大命名空间：**`--vscode-*`**（body 层，整体布局）、**`--wb-*`**（:root 层，组件 token）、**`--dc-*`**（WorkDaddy 自定义面板 token）；另有一批 **`--cb-*`**（WorkBuddy 官方 CodeBuddy 变量，被深色化补丁二次赋值）。

---

## 一、主题检查器使用的 9 个核心常量（用户示例出处，inject.js:5174）

| 中文名 | 变量 | 官方深色值 |
|---|---|---|
| 背景-主 | `--wb-bg-primary` | `#0a0a0a` |
| 背景-面板 | `--wb-bg-secondary` | `#111113` |
| 侧边栏背景 | `--wb-sidebar-bg` | `#0c0c0e` |
| 文字-主 | `--wb-color-text-primary` | `#f2f2f4` |
| 文字-次 | `--wb-color-text-secondary` | `rgba(242,242,244,0.72)` |
| 边框 | `--wb-border-default` | `rgba(255,255,255,0.12)` |
| 按钮背景 | `--wb-button-primary-bg` | `rgba(255,255,255,0.92)` |
| vscode背景 | `--vscode-editor-background` | `#0a0a0a` |
| vscode文字 | `--vscode-editor-foreground` | `#f2f2f4` |

> 这 9 个是主题检查器悬停检测用的最小集。完整主题文件需要下方全套变量。

---

## 二、内置主题完整 Schema（daemon.js:4119 `BUILTIN_THEMES`，三套共用）

### 2.1 `--vscode-*` 层（50 个）

```
--vscode-editor-background            --vscode-editor-foreground
--vscode-sideBar-background           --vscode-sideBar-foreground    --vscode-sideBar-border
--vscode-activityBar-background       --vscode-activityBar-foreground
--vscode-activityBar-inactiveForeground
--vscode-activityBarBadge-background  --vscode-activityBarBadge-foreground
--vscode-titleBar-activeBackground    --vscode-titleBar-activeForeground
--vscode-tab-activeBackground         --vscode-tab-activeForeground
--vscode-tab-inactiveBackground       --vscode-tab-inactiveForeground
--vscode-tab-border
--vscode-input-background             --vscode-input-foreground
--vscode-input-border                 --vscode-input-placeholderForeground
--vscode-button-background            --vscode-button-foreground
--vscode-button-hoverBackground
--vscode-list-activeSelectionBackground  --vscode-list-activeSelectionForeground
--vscode-list-hoverBackground         --vscode-list-inactiveSelectionBackground
--vscode-menu-background              --vscode-menu-foreground
--vscode-dropdown-background          --vscode-dropdown-foreground  --vscode-dropdown-border
--vscode-panel-background             --vscode-panel-border
--vscode-badge-background             --vscode-badge-foreground
--vscode-foreground                   --vscode-descriptionForeground
--vscode-focusBorder
--vscode-scrollbarSlider-background   --vscode-scrollbarSlider-hoverBackground
--vscode-editorGroupHeader-tabsBackground  --vscode-editorGroupHeader-tabsBorder
--vscode-editorGroup-border
--vscode-statusBar-background         --vscode-statusBar-foreground
--vscode-checkbox-background          --vscode-checkbox-border    --vscode-checkbox-foreground
--vscode-editorWidget-background      --vscode-editorWidget-border
```

### 2.2 `--wb-*` 组件层（44 个）

**背景**
```
--wb-bg-primary     --wb-bg-secondary   --wb-bg-tertiary  --wb-bg-popover
--wb-bg-hover       --wb-bg-active      --wb-bg-overlay   --wb-card-bg
```

**文字**
```
--wb-text-strong    --wb-text-medium    --wb-text-muted    --wb-text-weak
--wb-color-text-primary   --wb-color-text-secondary   --wb-color-text-tertiary
--wb-color-text-disabled
```

**边框**
```
--wb-border-default  --wb-border-subtle  --wb-border-strong  --wb-border-hover
```

**按钮**
```
--wb-button-primary-bg  --wb-button-primary-fg  --wb-button-primary-bg-hover
```

**状态**
```
--wb-status-success  --wb-status-warning  --wb-status-error  --wb-status-info
```

**知识库（kb）**
```
--wb-kb-tabs-container-bg  --wb-kb-tabs-container-border
--wb-kb-card-bg  --wb-kb-card-bg-soft  --wb-kb-card-border
```

### 2.3 `--dc-*` 层（14 个，WorkDaddy 面板专用）

```
--dc-bg-primary  --dc-bg-secondary  --dc-bg-tertiary  --dc-bg-hover
--dc-text-primary  --dc-text-secondary  --dc-text-tertiary
--dc-border  --dc-border-light  --dc-card-bg
--dc-primary  --dc-primary-hover  --dc-primary-active  --dc-btn-text
```

### 2.4 三套内置主题值

- **default（默认浅色）**：`colors: {}` 空对象，即完全用 WorkBuddy 官方变量，不覆盖。
- **oled-dark（OLED 纯黑，deep）**、**eye-care（护眼绿）**、**cyber-purple（赛博紫）**：同一 schema 三套值，见 daemon.js:4121-4278。
- 示例值（oled-dark 深色）：`--wb-bg-primary:#0a0a0c`、`--wb-bg-secondary:#131316`、`--wb-color-text-primary:#e6e6e9`、`--wb-border-subtle:#202025`、`--wb-button-primary-bg:rgba(255,255,255,0.92)`、`--dc-bg-primary:#0a0a0c`……

> 注：内置主题的深色值与官方实际运行值（第一节表）是两套近似色，主题应用时直接覆盖页面变量。

---

## 三、运行期读取/适配的其他变量（代码引用，未在内置主题 schema 中）

### 3.1 图片皮肤生成（inject.js:5776-5800，随图生成主题时写入）

背景系：`--wb-bg-modal` `--wb-bg-card` `--wb-bg-content` `--wb-main-area-background`
`--wb-home-bg-secondary` `--wb-home-composer-card-bg` `--wb-sidebar-bg` `--wb-home-bg-primary`
`--cb-colleagues-dashboard-bg`

文字系：`--wb-color-text-solid` `--wb-voice-input-text-primary`（加 `--wb-text-strong`/`--wb-color-text-primary`）

vscode 系：`--vscode-panel-background` `--vscode-tab-activeBackground` `--vscode-sideBar-background`
`--vscode-activityBar-background` `--vscode-editorGroupHeader-tabsBackground`

固定值：`--wb-border-strong` `--wb-border-subtle` `--wb-button-primary-bg-hover` `--wb-status-*`

### 3.2 主题探测 selectors 映射（daemon.js:4353-4357）

```
.teams-container.is-mac          → --wb-home-bg-primary  --wb-home-bg-secondary
.project-detail-view__chat-input → --wb-bg-primary
.project-detail-view__chat-input--task → --wb-bg-primary  --wb-color-border-secondary
[class*="mainArea"]              → --wb-bg-hover
.workbuddy-collab                → --wb-border-info  --wb-bg-info  --wb-bg-action
```

### 3.3 theme-patches.js 深色化补丁引用的官方变量

**wb 扩展 token**：`--wb-bg-modal` `--wb-bg-card` `--wb-bg-input` `--wb-bg-pill-active`
`--wb-accent`（fallback `#f53f3f`）`--wb-accent-blue` `--wb-color-link` `--wb-color-border-secondary`
`--wb-icon-secondary` `--wb-icon-tertiary` `--wb-color-bg-primary-hover-strong`
`--wb-palette-brand-8`（官方青绿 rgb(0,194,154)）`--wb-palette-gray-3`

**cb 系官方变量（深色化时被覆盖赋值）**：
```
--cb-bg-secondary: var(--wb-bg-tertiary)     --cb-border: var(--wb-border-subtle)
--wb-palette-gray-3: var(--wb-bg-primary)
--cb-markdown-table-cell-bg:  var(--wb-bg-primary)
--cb-markdown-table-header-bg: var(--wb-bg-secondary)
--cb-markdown-table-border-color: var(--wb-border-strong)
--cb-markdown-border-color: var(--wb-border-strong)
```
其余引用（未赋值，仅 var() 读取）：`--cb-colleagues-dashboard-bg` `--cb-hover-bg` `--cb-panel-bg-primary`
`--cb-text-primary` `--cb-text-secondary` `--cb-text-tertiary` `--cb-vscode-sideBar-background`
`--cb-markdown-code-block-*` `--cb-markdown-table-color-bg`

---

## 四、全部变量清单速查（按命名空间计数）

| 命名空间 | 数量 | 说明 |
|---|---|---|
| `--vscode-*` | 50 | body 层整体布局（内置主题 Schema） |
| `--wb-*` | 44 | :root 组件 token（内置主题 Schema） |
| `--dc-*` | 14 | WorkDaddy 面板 token（内置主题 Schema） |
| `--wb-*` 扩展引用 | 21 | 皮肤生成/补丁/探测器引用（非 Schema） |
| `--cb-*` | 15 | WorkBuddy 官方变量，补丁覆盖或引用 |
| `--wb-palette-*` | 2 | `--wb-palette-brand-8`、`--wb-palette-gray-3` |