# 依赖清单：这个插件贴着 DSH 的哪些私有接口

DSH 升级出问题时，从这份清单往下看：每一行都写了**用途 / 调用位置 / 断了会怎样 / 怎么改**。
断在哪一层，先看 `.debug/selfcheck.json`，再对着这里改。

## 一、客户端（`client.js`）

| 接口 | 用途 | 调用位置 | 断了的表现 | 适配做法 |
|---|---|---|---|---|
| `window.__ModuleLoader__.load({ id, factory })` | 客户端半区的加载入口 | `client.js` 文件头 | 插件整块不加载，面板消失 | 改加载协议；同时看 `package.json` 的 `dsh.bundle` 配置 |
| `factory(require)` 里的 `require('react')` | 面板用宿主注入的 React | 同上 | 面板白屏/报错 | 若宿主不再注入，就要自带渲染器（Preact） |
| `ctx.slots.inject(slot, cb)` + `ctx.slots.register({ name, id, key }, C)` | 注册五个槽位：成员 tab 正文、开始页入口卡、`member` 围栏、团队协作开关 ×2 | `client.js:5864` / `5871` / `5920` / `5999` | 对应区域空白或开关消失 | 槽位名可能改名；先跑自检，看缺哪个服务 |
| `ctx.sidebarRightTabs.register({ id, kind, title, guide })` | 声明右栏「成员」页的类型 | `client.js:5861` | 右栏没有「成员」tab | 换成新的 tab 注册 API |
| `ctx.sidebarRight.openTab(kind, { params })` | 打开右栏并切到成员页（同时负责展开） | `client.js` `openMembersPane` | 点「团队协作」不弹面板（曾因拿不到服务静默失败） | 看新版 openTab 签名；必要时改用独立页 |
| `ctx.get(name)` / `ctx[name]` | 取上面这些服务 | 多处 | 服务为 `undefined` | 自检会报；注意：**只有写进 `inject` 的服务才可访问** |
| `inject: ['slots','sidebarRightTabs','sidebarRight']` | 声明依赖，否则取到 `undefined` | `client.js` 插件定义 | 静默失效（最难查的一类） | 服务改名就改这里，同时改自检清单 |
| `dsh` 客户端 `hooks.tabInfo`（可选） | 自定义入口卡想主动关引导页 | `MembersGuideCard` | 关不掉引导页（不影响功能） | 拿不到就保持现状 |

## 二、宿主（`host/*.js`）

| 接口 | 用途 | 调用位置 | 断了的表现 | 适配做法 |
|---|---|---|---|---|
| `ctx.get('webServer')` / `'webserver'` | 注册全部 HTTP 路由（34 条） | `host/team-mode.js` | 面板所有数据拿不到 | 改服务名；路由 API 变了就整体改 `registerRoute` 一处 |
| `ctx.get('tools')` | 注册 14 个团队工具 | `host/tools.js` | 秘书没有 `team_*` 工具 | 改工具注册 API |
| `ctx.get('agents')` | 找父会话 agent、单聊、返工续聊 | `host/tools.js` | 派活/单聊/续聊失败 | 改 agents 服务 |
| `ctx.get('subagents').startActivation(opts)` | 起子会话干活的入口（新活、单聊） | `host/tools.js`（4 处） | 派不了活 | 签名变了改这几处；字段名 `prompt/parent/cwd/delivery` 要对着新版核 |
| `ctx.get('subagents').sendMessage(sender, targetId, content, { signal })` | 返工续聊：把打回意见投回原会话，目标不在就唤醒 | `host/tools.js`（1 处） | 返工只能新开会话（会退化成旧行为） | 签名变了改续聊那处；`targetId` 是持久 Session id |
| `ctx.get('systemPrompt').section({ name, order, text })` | 注入人设、底座规则、团队知识库 | `host/tools.js:1664/1706/1716`、`host/runtime.js` | Bot 退化成通用助手（**最危险的一类，不报错**） | 改注入方式；改完必须人肉确认人设真的生效 |
| `agent.ctx.tools.restrict({ allow })` | 按能力卡限制子会话工具 | `host/tools.js:1732` | 能力卡失效（Bot 可能拿到不该有的工具） | 改限制 API |
| `agent.session.append('sandbox/mode', …)` | 给子会话设沙箱模式 | `host/tools.js:1693` | 子会话可能写不出去 | 改 session 写入 API |
| `ctx.on('agent/created', …)` | 子会话创建时挂装饰（人设/工具/用量） | `host/tools.js:583` | 装饰全失效 | 事件改名就改这里 |
| `agent.ctx.on('agent/assistant-stream', …)` | 统计真实 token | `host/tools.js:1580/1683` | 成本统计归零（不影响干活） | 事件改名 |
| `agent.ctx.on('agent/status', …)` | 跟踪子会话状态 | `host/tools.js:1595` | 卡片状态不准 | 同上 |
| `ctx.get('agentTeams').setEnabled(agent, true)` | 「原生小子智能体」开关 | `host/tools.js` | 该开关失效 | 服务改名；不勾的 Bot 不受影响 |
| `ctx.get('llm')`（可选） | 给 Bot 指定模型 | `host/runtime.js` | 模型下拉失效 | 可选依赖，取不到就跳过 |

## 三、升级时的操作顺序

1. 装新版 DSH → 打开面板，看顶部红字 + `.debug/selfcheck.json`
2. `missing` 里列出的服务，对照上表找到**调用文件**与**影响面**
3. 修完后跑 `node --test test/*.test.mjs`（244 条，含 UI 行为测试）
4. 真机冒烟四步：**头像显示 → 成员卡列表 → 派一件活 → 晋升一次**
5. 第 4 步里任何一步不对，先看 `.debug/host.log` 里 `event: "selfcheck"` 与 `route-register-failed`

## 四、已知的「静默失效」陷阱（都踩过）

- **服务没写进 `inject`**：`ctx.get` 返回 `undefined`，代码早退，界面看不出问题。→ 已加启动自检。
- **`layout.openRightbar` 名字骗人**：它只「上报呈现方式」，不打开右栏。误用会让右栏浮在主界面上。→ 已彻底不用它。
- **路由注册撞重复会中断整次安装**：一条路由失败，后面的头像、背景全不注册。→ 现在单条失败只记日志，不中断。
- **人设注入失败不报错**：Bot 照样回话，只是不像它本人。→ 升级后必须人肉确认一次。

## 五、版本策略

- `package.json` 的 `engines.dsh` 锁到 `>=0.2.2-rc.1 <0.2.3-0`；跨 minor 必须先适配再放宽。
- DSH 客户端包平均 2 天发一版；**建议每 2–4 周跟一次**，只跟 minor，不必追每个 rc。
