# 组团工作与进度（dsh-teamplan）

把每个会话的计划变成看得见的百分比：计划先审后干，侧栏直接读进度。

## 是什么

一个 DSH 插件，做三件事：

1. **计划先写后干**。非一句话的活，先 `teamplan_commit` 落一份计划：标题、分步、每步预计分钟、交付物、验收口径。
2. **审核是唯一闸门**。计划落盘即「待审核」，`teamplan_mark` 在批准前一律拒绝。批准只能由用户发出、由 `teamplan_approve` 记录，且必须带用户原话。
3. **进度自动可见**。侧栏会话行尾是一枚彩色进度环（环内是百分比），悬停卡片显示进度条与分步状态。

百分比按**预估分钟加权**，不是按步数平均：50 分钟的步骤比 5 分钟的步骤更重。步数同时显示，避免「一步占 90%」的误解。

## 工具

| 工具 | 作用 |
| --- | --- |
| `teamplan_commit` | 落一份新计划，状态 `pending`（待审核）。返回可直接贴给用户的审核清单。 |
| `teamplan_approve` | 记录用户批准。`note` 必填，写用户原话。 |
| `teamplan_mark` | 推进单步（`doing` / `done` / `blocked`）。未批准时抛错。 |
| `teamplan_status` | 读当前计划：状态、百分比、逐步状态。 |
| `teamplan_update` | 改写步骤、交付物、验收口径。已完成的计划不可改写。 |
| `teamplan_ignore` | 从界面移除，不删记录。 |

## 五个状态与配色

| 状态 | 条件 | 颜色 |
| --- | --- | --- |
| 待审核 | 无 `approvedAt` | 灰 `#8A8F98` |
| 进行中 | 已批准、未全完成、无受阻 | 蓝 `#00AAEE` |
| 受阻 | 有步骤 `blocked` | 橙 `#FF7500` |
| 可能受阻 | 有步骤 `doing` 且超过 `blockedAfterMinutes` 没动 | 橙 `#FF7500` |
| 已完成 | 全部步骤 `done` | 绿 `#0D9458` |

「可能受阻」是启发式，不是判定：`mark` 成 `doing` 时写 `doingAt`，超时才推断，模型可以随时 `teamplan_mark` 成 `blocked` 直接明示。两者都取橙色，客户端的区别在步骤字形（`!` 对 `×`）。

语义只在 `lib/model.js` 的 `toneOf()` 一处定义，徽标、入口、浮层、悬停卡共用同一个 `tone` 字段。

全站只剩一套暖色：纸感底 #FBF5E9、墨色字 #3B3025，语义三色是蓝 `#2563A8`（进行中）、橙 `#B45309`（受阻）、绿 `#4F7A2A`（已完成）；弧线与进度条另有更浅的同族 `TONE_FILL`（`#3D82C4` / `#E07B39` / `#6BA84A`），文字用深档、填充用浅档。七个前景色在纸底与侧栏底色上都 ≥4.5:1，`probe-tones` 逐项断言。

宿主悬停卡本身是深色面且不设 `color`。我们没有把文字改成浅色去迁就它，而是**只对承载我们内容的卡片**重新着色：悬停内容根节点带 `data-teamplan-card` 标记，插件注入的样式用 `[class*="_card_"]:has([data-teamplan-card])` 覆写 `--dsw-alias-hovercard-{bg,label-primary,label-secondary,label-tertiary}` 与边框阴影。其它插件的悬停卡不受影响，宿主改版时命不中就自然退回原样式。

## 计划闸门

「先写计划再动手」不是提示词，是两道真闸门，由 `lib/gate.js` 提供。

| `enforce` | 行为 |
| --- | --- |
| `off` | 只保留工具与面板，不拦任何调用。 |
| `writes`（默认） | `write` / `edit` / `apply_patch` / 写文件的 `ops_bash` 在无已批准计划时被拒绝。 |
| `full` | 再加收尾否决：`agent/turn-stopping` 时若本回合试过写且没有计划，`agent.steer` 补一条消息，让机器再跑一步。每回合最多一次，不会死循环。 |

拒绝不是死胡同：`teamplan_commit`、`teamplan_approve`、只读工具永远可用，所以模型总能先补计划再继续。

判定细节：

- 子代理（`header.origin === 'subagent'` 或有 `parentSession`）继承母会话的计划，不被单独拦。
- 待审核、已忽略、已完成的计划都会拒写，并给出各自不同的下一步；`active` / `blocked` / `stalled` 放行——受阻时往往正需要那一次写。
- `ops_bash` 按命令文本判：`>` `tee` `rm` `mv` `cp` `git commit` `npm i` 之类算写，纯读命令放行；带 `script_path` 的一律算写（内容不透明）。
- `teamplan_status` 会报「闸门 writes · 放行 N · 拦下 M · 收尾提醒 K」，这是判断闸门死活最直接的一行。

## 界面

四个座位（Q11 = A 全保留）：

- **会话行尾进度环**（插槽 `sidebar.session.row.trailing`）：20px SVG 环，轨道为暖灰、弧为语义色（青=进行中 / 赤陶=受阻 / 橄榄=完成 / 暖灰=待审），环内是等宽数字；100% 时整环闭合、环内换成 ✓。
- **会话悬停卡**（插槽 `sidebar.session.row.hover`）：标题、百分比、3px 进度条、`done/total 步 · 状态`、`done/total 分钟`、最多 5 行步骤。卡片整面改成同一套暖色（见上节），文字不再继承侧栏颜色、也不叠加透明度。
- **侧栏底部「进展」入口**（插槽 `sidebar.footer.action`）：宿主把底栏所有占用者排在**同一条不换行**的 flex 行里。我们给通道加 `flex-wrap: wrap`，座位用 `flex: 0 0 100%; order: -1` 独占一行、排在 remote 之上；按钮本身宽度随内容，与 remote 座位同一 42px 高度、同一圆角与内距，行间距按侧栏对话条目取 1px（不是底栏默认的 4px）。内容只有一行：图标 + 「进展」+ 进行中任务数（有受阻任务时数字变橙），不再显示百分比。座位不设原生 `title`——它已经有 `aria-label`，而原生提示框会盖住正上方弹出浮层。
- **开合是悬停驱动的**：指针进入座位或浮层即打开，离开后 180ms 才收——这段延时正是从座位移到浮层的过桥时间；点击座位仍可固定开合，Esc 随时关闭。
- **全部任务浮层**（插槽 `shell.overlay`）：**锚定在座位正上方**——座位挂载时与悬停时读 `getBoundingClientRect()`，浮层底边取 `视口高 - 座位 top + 8px`、左边缘与座位左沿对齐并在视口内夹紧，因此不会覆盖座位。**高度固定** `min(360px, 52vh)`，列表自己滚动，切换页签或空态都不会塌陷。暖色纸面（#FBF5E9 底、墨色字、1px 暖边），顶部「进行中 / 已完成」两个分段页签。每行左侧进度环 + 标题，下接缩进的进度条与 `done/total 步 · 状态`；点行打开对应会话并自动收起，Esc 或标题栏 × 收起；「已完成」页签每行带「忽略」按钮，**点开某行跳转后该行自动从已完成里移除**（复用 dismiss 接口，记录仍留在磁盘）。

四个座位各自独立挂载：每个插槽的 `slots.inject` 单独 try/catch，每个座位再包一层错误边界。任一座位注册失败或渲染抛错只让那一个座位消失，不会牵连整个界面。

界面崩溃的代价在这里是整页变白：客户端插槽一旦在注册或渲染阶段抛错，React 会卸载整个应用外壳。所以边界保护是必需的，不是可选项。

浏览器每 2 秒轮询 `/plugins/dsh-teamplan/state`，同内容不重渲。两个页签的数据来自同一份响应：`plans` 是进行中，`done` 是保留窗口内已完成的计划。

## 写接口

- `POST /plugins/dsh-teamplan/dismiss`：把计划标为**已读**，写完 `ignoredAt` + `ignoredReason: 'read'` 后从两个页签里立即消失。只隐藏、不删除，记录仍留在 `plans.json`。三种入参：
  - `{"planId":"plan-…"}` — 单条；
  - `{"planIds":["plan-…","plan-…"]}` — 指定一批；
  - `{"scope":"active"|"done"}` — 该页签当前可见的全部（由宿主按保留窗口自己算，客户端不猜）。
  响应 `{ok, dismissed, planIds}`。鉴权与 `state` 走同一道 Connection 闸门。
- 界面上**每一行**都有「已读」按钮（进行中、受阻、已完成都一样），面板头部还有「全部已读」，它清空当前页签并回显「已读 N 项，列表已清空」。

## 存储

`$DSH_HOME/storages/dsh-teamplan/plans.json`（默认 `~/.dsh/storages/dsh-teamplan/plans.json`）。

- 写入串行化，先写 `.tmp` 再 rename。
- 文件损坏时改名 `.corrupt-<时间戳>` 后重建，工具不因一个坏文件停摆。
- `done` 计划保留 `retentionDays`（默认 3）天，读取期过滤，**不靠定时器删文件**。

## 配置

```yaml
- insert:
    - id: teamplan
      name: 'dsh-teamplan'
      config:
        retentionDays: 3
        defaultStepMinutes: 10
        blockedAfterMinutes: 15
        enforce: writes   # off | writes | full
```

## 边界

- 不读写 `dsh-workplan` / `dsh-agent-teams` 的数据，独立存储。
- 不派发执行（第二期用 `executor` 字段外发）。
- 不做统计视图。
- 不新增会话事件类型，只用文件存储。

## 文件

```
package.json          包清单（dsh.bundle.patch / dsh.client）
cordis.patch.yml      挂载到宿主组合
icon.svg              插件图标
locale/{zh,en}.json   标题与说明
lib/index.js          apply：工具 + 路由 + 闸门
lib/model.js          模型：归一化、百分比、状态、取色、审核清单
lib/store.js          存储：串行写、原子替换、损坏自愈
lib/tools.js          6 个 defineTool
lib/spec.js           零依赖的 defineTool 与 schema 编译器
lib/gate.js           写操作闸门 + 收尾否决
lib/routes.js         /plugins/dsh-teamplan/state
client.js             行尾徽标 + 悬停卡
```
