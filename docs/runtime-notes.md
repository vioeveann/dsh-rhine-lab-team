# 运行时笔记（S0 实测）

这些是踩出来的、和文档写的不一样的地方，后面改代码前先看这一页。

## 子会话必须走 subagent 运行时

用 `ctx.agents.create()` 手工建的 agent 会被 `agent/pre-step` 拒掉：轮次开了、消息不领、`turn/end` 立刻结束，八条事件里连 `user/message` 都没有。缺的是 subagent 运行时在创建时附带的那份 delegated policy。

改成 `ctx.subagents.startActivation({ provider: 'spawn', childId, cwd, prompt, parent, delivery: 'caller', signal })` 就正常了。

## 拿结果：用 `result`，不要等 `whenIdle`

`startActivation` 返回的 activation 上有 `result: Promise<SubagentResult>`，`result.output` 就是子会话最后一条非空 assistant 消息的 content blocks。

- `delivery: 'parent'` —— 结果作为完成通知回到父会话，工具调用本身拿不到。
- `delivery: 'caller'` —— 只回给调用方，配合 `await started.result` 就能同步返回。

`agent.whenIdle()` 在刚创建时不可靠：它会在轮次真正开始前就 resolve。

## `cwd` 只改工作目录，不改沙箱根

原生 `subagent` 工具和 `startActivation` 的 `cwd` 都走 `workingDirectory.set()`，**子会话 header 里的 `cwd` 仍是父会话的**。而 sandbox policy 用的是 `session.header.cwd`。

所以围栏是「整个工作区」，不是「每个 Bot 一个任务目录」。实测：子会话写桌面的报错是
`[sandbox: file access denied under workspace-write mode]`。

要按 Bot 隔离，得让 header 带 cwd，那就得自己建 session —— 但那条路正是上面被拒的那种。**暂定：工作区级围栏 + 产物只由秘书写。**

## 人设注入的时机

`agent/created` 在第一次组装提示词之前触发，在那里给 `agent.ctx.systemPrompt.section()` 挂人设有效（实测子会话能准确自报「我是 Nova，团队里的研究员…」）。

用 `startActivation` 时没有 `setup` 回调，所以只走这条路。

## 插件的 import 限制

link 安装的插件**不能** `import '@deepseek-ai/*'`：那些包在 app.asar 里，不在 profile 的 node_modules。工具定义用纯对象注册（`ctx.tools.register({...})`），只校验 `output.schema`，参数要自己校验。

服务用 `ctx.get('tools')` / `ctx.get('agents')` / `ctx.get('subagents')` 取，不声明 `inject`（声明了要重启才生效）。

## 热更

- 客户端半区（`client.js`）改完刷新页面即可。
- 主机半区：`index.js` 是加载器，改它要重启；`host/*.js` 每次激活带时间戳动态 import，改完关开一次 bundle 就生效。

## 开关怎么接到主机（2026-11-18）

浏览器里的开关不能直接调主机服务，所以走一条 HTTP 路由：

- 主机端注册 `POST /dsh-team/team-mode`（`ctx.get('webServer')`，注意服务名是 **camelCase `webServer`**，写 `webserver` 会拿到 undefined）。
- 请求体 `{ sessionId, on }`，状态存内存 + `.state/team-mode.json`，重启后还在。
- `team_dispatch` 的 `when` 只看这个表：根会话 + 开关为真才可见。**关掉开关，工具会从模型工具表里消失**。
- 客户端 toggle 变化时 `fetch` 上报；session id 先从插槽 props 取，取不到再从 URL 里正则捞 `session-<uuid>`。

风险：这条路由**没有鉴权**（DSH 只在回环监听，且内置路由也不做服务器级认证）。本机够用，将来如果绑非回环地址要自己加一层。
