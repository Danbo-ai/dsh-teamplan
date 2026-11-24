# dsh-teamplan（组团工作与进度）

DSH 插件。把每个会话的计划变成看得见的百分比：**计划先审后干，侧栏直接读进度**。

- 会话行尾一枚彩色进度环显示完成度（环内百分比），悬停卡显示步骤明细。
- 侧栏底部「进展」入口独占一行、在「远程」之上：图标 + 进行中任务数，指针悬停即打开「全部任务」浮层，移开自动收起。
- 「全部任务」浮层：锚在「进展」座位正上方（不覆盖座位）、高度固定，进行中 / 已完成两页签，点行直接跳会话；每一行都能标「已读」（进行中、受阻、已完成都一样），面板头部还有「全部已读」。
- 面板与悬停卡共用一套暖色，语义色统一为绿=已完成、橙=卡住、蓝=进行中。
- 百分比按**预估分钟加权**，同时给步数，避免「一步占九成」。
- 没计划就写文件会被拒绝（`write` / `edit` / `apply_patch` / 写操作的 `ops_bash`），先落计划、用户批准再动手。
- 计划落在插件自己的存储里，不读写 `dsh-workplan` / `dsh-agent-teams` 的数据。

完整说明见 [`docs/DETAIL.md`](docs/DETAIL.md)。

## 安装

包已经在本地 link，装/重装都走 `plugin_manager`：

```
plugin_manager action=install_bundle target=D:\dsh-project\plugin\packages\dsh-teamplan
```

改代码后要重载，先禁用再启用（单次 `enabled:true` 不会重新 import）：

```
plugin_manager action=set_bundle target=dsh-teamplan enabled=false
plugin_manager action=set_bundle target=dsh-teamplan enabled=true
```

`application: applied` 才算生效。

## 工具

| 工具 | 作用 |
| --- | --- |
| `teamplan_commit` | 落计划（`pending` 待审），返回可直接贴给用户的审核清单 |
| `teamplan_approve` | 记录用户批准，`note` 必填，写用户原话 |
| `teamplan_mark` | 推进单步（`doing` / `done` / `blocked`），未批准时抛错 |
| `teamplan_status` | 读状态、百分比、逐步状态，以及闸门计数 |
| `teamplan_update` | 改写步骤 / 交付物 / 验收口径，已完成的计划不能改写 |
| `teamplan_ignore` | 从界面移除，记录保留 |

## 配置

写在 `cordis.patch.yml` 的 `config` 里，装包时带入：

```yaml
retentionDays: 3        # 已完成计划在界面保留几天
defaultStepMinutes: 10  # 步骤没写分钟时的权重
blockedAfterMinutes: 15 # doing 超过多久推断「可能受阻」
enforce: writes         # off | writes | full
```

`enforce`：`off` 只留工具与面板；`writes` 无已批准计划时拒写；`full` 再加收尾否决，每回合最多 `agent.steer` 一次。

## 存储

`$DSH_HOME/storages/dsh-teamplan/plans.json`（默认 `~/.dsh/storages/dsh-teamplan/plans.json`）。

写入串行化、先写临时文件再 rename；文件坏了改名 `.corrupt-<时间戳>` 后重建；`done` 计划按 `retentionDays` 在读取期过滤，不靠定时器删文件。

## 开发与自测

包目录下六个契约测试，全部零依赖、可随时复跑：

```
cd packages/dsh-teamplan
node .tmp/test-model.mjs   # 归一化、百分比、状态推导、存储、state/done 分组、路由
node .tmp/test-tools.mjs   # 6 个工具全生命周期
node .tmp/test-doing.mjs   # doingAt 打点与受阻计时
node .tmp/test-gate.mjs    # 写判定、拒绝规则、每回合一次收尾否决
node .tmp/test-panel.mjs   # 底部入口与浮层的插槽、页签、跳转、忽略契约
node .tmp/probe-tones.mjs  # 深色卡上的 WCAG 对比度与取色断言
```

## 结构

```
lib/index.js   apply：注册工具、状态路由、闸门
lib/model.js   归一化、分钟加权百分比、状态推导、取色、审核清单
lib/store.js   串行写、原子替换、损坏自愈、同步读（闸门路径）
lib/spec.js    零依赖的 defineTool 与作者态 schema 编译器
lib/gate.js    写操作闸门 + 收尾否决 + 计数器
lib/tools.js   6 个工具
lib/routes.js  GET /state、POST /dismiss（过 Connection 鉴权、带 ETag）
client.js      行尾徽标 + 悬停卡 + 侧栏底部入口 + 全部任务浮层
```

## 为什么零依赖

插件以 link 方式装进 profile，Node 按包的真实路径向上解析 `node_modules`，profile 的依赖不在那条链上，所以 `import '@deepseek-ai/dsh-tools'` 会 `ERR_MODULE_NOT_FOUND`。插件因此自带 `lib/spec.js` 复刻作者态 schema 规则，用普通对象注册工具——宿主 `ctx.tools.register()` 只校验 `output.schema` 与 `render`，不校验 brand。
