# 外包高手（dsh-outsourcing-expert）

一个 DSH 插件包：声明两个 agent preset，把「领导」变成**不亲自干活、把活全外包出去**的角色——先摸清可选模型各自擅长什么，再按任务难度决定每一件活交给谁。

| preset | id | 选人规则 |
| --- | --- | --- |
| **外包高手** | `outsourcing-expert` | 能力对齐：简单 →轻量快速，中等 →均衡，困难 →代码专精或强推理，极难 →旗舰强推理 |
| **外包高手（反向用人）** | `outsourcing-expert-reverse` | 故意反着来：任务越难越用**弱**模型，越简单越用**强**模型 |

两个 preset 只差插件行配置里的 `reverseHiring`；**没有运行时开关**，选哪个就是哪个。

> **改名历史与 id 冻结**：早先包名与 preset id 都叫 `incompetent-leader`（显示名一直是「外包高手」）；发布前统一改成了 `outsourcing-expert` / `dsh-outsourcing-expert`。**这之后 id 就定死了**——preset id 会被会话头、界面设置、客户端缓存长期引用，再改会让已有会话与已保存的选择指向不存在的 preset（`agent-preset/not-found`）。以后想换显示名，只改 `name` / `description`。
>
> 用旧 id 建过的会话需要**新建会话重新选 preset**。

**只在使用这两个 preset 的会话里生效**：preset 的 `plugins` 挂在该 preset 自己的 scope 下，scope 化的拦截器与提示段由宿主按会话过滤；别的 preset（standard、ptc、`leader`…）的会话完全看不到。

## English summary

A DSH (DeepSeek Harness) plugin bundle that declares two agent presets in which the top-level agent does no work itself. Every non-management tool call (`read`, `write`, `pwsh`, `web_search`, `workflow`, `skill`, …) is **denied at the harness boundary**, so the task has to go to a subagent; the first delegation of a session must run in the foreground, and a further delegation is refused while one is in flight. The prompt has the leader spend one web-research pass on the available subagent models, then name the chosen provider and model in each delegation. A second preset, `outsourcing-expert-reverse`, deliberately picks weaker models for harder tasks.

Install: `dsh plugin --profile <profile> add github:Funny1Potato/dsh-outsourcing-expert`, then start a new session and pick 外包高手. Only the two presets this bundle declares are affected; other presets are untouched.

## 它做什么

### 1. 硬拦截（`tools/pre-execute` 瀑布）

领导每次要调用「干活」工具（`read` / `write` / `edit` / `pwsh` / `bash` / `grep` / `web_search` / `workflow` / `skill` / 自省……）时，插件在派发前直接返回 **`{ kind: 'deny' }`**，并附一条说明要求改用 `subagent` / `subagent_fork` 外包出去。**没有任何副作用被执行。**

放行名单（内置，可用配置项 `allowTools` 追加）：

| 类别 | 工具 |
| --- | --- |
| 沟通与规划 | `ask_user_question`、`todo_write`、`exit_plan_mode` |
| 目标 | `get_goal`、`create_goal`、`update_goal`（见下方「定目标」） |
| 委派 | `subagent`、`subagent_fork` |
| 照看下属 | `list_subagent_models`、`list_agents`、`send_message`、`interrupt_agent` |

**子 Agent 免检**：判据是会话头 `origin === 'subagent'` 或 `delegationDepth > 0`——宿主自己就是用这个字段区分顶层会话与子会话的。所以直接子 Agent、孙子 Agent、`workflow` 与 teammate 派生的子 Agent 都照常干活，resume 后依然成立。宿主内部不带 agent 的调用也放行。

### 2. 说话方式（提示层）

- **不自述过程**：不写「我先去取模型名册」「我现在派个子智能体去调研」这类旁白，直接做、直接给结果。
- **模型名要出现在卡片上（两条腿）**：
  - **折叠时看的是 `description`**：纪律段要求模型把选定模型写进委派参数 `description` 开头，格式 `<provider>/<model>：<任务>`（走默认路线时写 `默认路线：<任务>`）。父会话里那张卡片**折叠**只显示这一行，客户端按工具名写死、宿主侧改不了，所以模型名只能由模型自己写进参数。**这一条是提示层**，漏写就只有展开才看得到。
  - **展开后另有插件自动补的一行**：每条委派结果里会被插件在**正文最前面**插一行
    `▸ 委派模型：<provider> / <model>（effort）｜任务：<description>`（没指定模型时写「未指定 → 用配置的默认路线」）。
    之所以必须在最前面：界面折叠卡片只取结果里**第一个**非空文本块当预览（`ui-trajectory` 的 `summarizeResult`），追加在末尾就只有展开才看得见。
    这是插件在 `tools/post-execute` 里改写结果正文加上的（只换正文、**不动结构化 value**，所以后台委派的 subagentId 之类照旧），**不依赖模型自己说**——模型漏写或写错，展开后仍能看到真实路由。失败（`isError`）的结果不加这行。
- **能力表不外露**：第一轮侦察得到的能力表只作为自己的选人依据，**不展示给用户**。
- **理由只讲一次**：在委派那一刻说明（可选）；**交付最终结果时不再重复**。

### 3. 用人两步走

1. **第一轮（每个会话一次）——侦察候选模型的能力**
   - 调 `list_subagent_models` 拿到**完整的授权模型名册**（无参数列 provider，再按 provider 列模型）；
   - 从名册里**随机挑一个**模型当「侦察兵」（不挑「看起来最强」的）；
   - 用 `subagent` 显式指定这个模型，并传 `run_in_background: false`（下一步依赖它的结果），把**完整名册**贴进委派提示，要求它用 `web_search` 逐个查「擅长什么、适合哪类任务、评测口碑如何」并附来源，按固定格式返回一张**能力表**；
   - 名册拿不到时**不要瞎猜**：跳过侦察、省略 `provider`/`model` 交给默认路线。
   - **顺序是代码强制的**：这一条委派必须是**前台**（`run_in_background: false`），且那一刻**不许**同时派别的活——默认后台、或把侦查和干活并行发出，都会被当场拒绝并附上改法。
2. **之后每一轮——按能力表外包**：判任务难度 → 从能力表里选人（只能在表内选，绝不编造模型名）→ **选定的模型要显式传给 `subagent`**（`provider` + `model`，必要时带 `reasoning_effort`）**并按 `<provider>/<model>：<任务>` 的格式写进 `description`**（不写进调用参数就等于没选，卡片上也看不到）→ 失败可升级重试一次。
   查不到的模型用名称启发式补上并标注「未核实」：`flash/lite/mini/small`=轻量快速，`standard/medium`=均衡，`coder/code`=代码专精，`pro/max/ultra/thinking/reasoner`=旗舰强推理，无法归类=均衡。

### 4. 定目标必须先问下属

`get_goal` / `create_goal` / `update_goal` **只属于领导**（子 Agent 调会被服务拒绝）。所以纪律段要求：先派一个 subagent 评估并给出建议的目标（objective + max_goal_rounds + 理由），拿到答复后才准 `create_goal`。

### 5. 失败升级（`escalateOnFailure`，默认开）

子任务失败或明显没做好时，允许**换更高一档的模型重试一次**；第二次仍失败就停下来向用户汇报，不无限重试。

### 6. 顺序纪律（代码强制，不只是提示）

提示里写「第一轮必须前台、必须单独一轮」实测会被无视（`subagent` 在 continuable 实例上**默认后台运行**），于是模型会把侦查和干活在同一轮里一起发出去、等不到能力表。所以在代码上兜了两道：

1. **每条会话的第一条委派必须是前台**（`run_in_background: false`）——那一条就是第一轮侦查；默认后台会被拒绝，并附上改法。
2. **有前台委派在飞时，新的委派一律拒绝**——「侦查和干活同时发出」这条路径被堵死。后台委派不受这条限制，所以后续「并行优先」照旧。

状态只用「同一调用的 `pre-execute` / `post-execute` 配对」置位与清位（`post-execute` 连抛错的工具都会收到），再加 `agent/pre-step` 兜底（新的一步开始就说明上一轮已结束），两道保险保证**不会把领导永久锁死**。若某个 preset 的委派工具没暴露 `run_in_background`，第 1 道规则自动跳过（否则同样会锁死）。

### 7. 子会话标题＝「模型 · 任务」（宿主侧自动写，不依赖模型）

每次委派成功后，插件把**子会话的标题**写成 `模型 · 任务`（模型在前；标题上限 80 字节，超了按码点安全截断、先丢任务）。实现走 `sessionTitle.rename`：

- 它写一条持久化的 `session/title` 事件，并且**把标题钉住**——自动起名与兜底标题都不会再覆盖（源码注释：*"pins the title: in-flight automatic generation is superseded and later user messages schedule none"*）；子会话本来就**不会**排 LLM 自动起名（要求 `parentSession === undefined`）。
- 于是在**子智能体头部 / 血缘导航 / 切换器 / 会话列表**里一眼就能看到这一条委派派给了谁，重启与回放后依然在。
- 子会话 id 的来源：子会话出现时会发 `subagent/start`（带子会话 id），此刻它一定是活的；插件在放行委派时已把「模型 + 任务」记在发起方名下，这里按子会话头的 `parentSession` 反查发起方、认领并命名（跑起来的那条在 `start` 里被消费，**没跑起来的那条在委派结果里被丢弃**，否则会张冠李戴）。该事件是 scope 过滤派发的，插件挂在 preset scope 下面，**必须用 `{ global: true }` 才收得到**（副作用是同一事件会被投递两次，靠「认领即消费」天然去重）。
- 全程**尽力而为**：拿不到 live 会话（例如远端子智能体）、服务缺失或 `rename` 抛错，都只记一条 debug 日志，绝不影响委派本身。

## 安装与启用

从 GitHub 装（发布在 <https://github.com/Funny1Potato/dsh-outsourcing-expert>；包里没有 `prepare` / `build` 脚本，源码安装不需要 `allowBuilds` 授权）：

```sh
dsh plugin --profile <profile> add github:Funny1Potato/dsh-outsourcing-expert
```

或从本地 checkout 装：

```sh
dsh plugin --profile <profile> add link:<本目录绝对路径>
```

Desktop 端的 profile 由应用独占管理，装插件走界面（**插件 → 添加插件**，填 `github:Funny1Potato/dsh-outsourcing-expert`、本地目录绝对路径或 `link:<路径>`）。装完后**新建会话**，在 preset 选择里选「外包高手」或「外包高手（反向用人）」。

## 文件

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 唯一的 patch 层：插入两条 `@deepseek-ai/dsh-agent-preset` 声明。两份花名册都以官方 standard preset 为底（原样照抄），只差最后那行插件的 `reverseHiring`——**改花名册时两处一起改** |
| `src/index.js` | 可执行半侧：拦截 + 纪律段（两个 preset 共用同一份代码） |
| `tests/contract.test.mjs` | 契约测试（记录型 ctx 桩，不依赖宿主） |
| `LICENSE` | MIT |

## 配置项（preset 里那行插件的 `config`）

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `allowTools` | `string[]` | **追加**到内置白名单的工具名（只能加，不能减） |
| `reverseHiring` | `bool` | `false`=能力对齐，`true`=反向用人。**两个 preset 唯一的差别** |
| `escalateOnFailure` | `bool` | 失败后是否允许升级模型重试一次（提示层规则） |

## 开发与验证

```sh
node --test        # 契约测试：导出形状、提示段字段、拒绝形状、白名单、子 Agent 判据、两个 preset 的规则差异、说话方式文案
```

## 已知限制

- **硬拦截意味着领导只能问、只能拆、只能委派**，不能自己动手。想退化成纯提示词模式，把 `src/index.js` 里 `tools/pre-execute` 的 `return { kind: 'deny', ... }` 改成 `return next()` 即可。
- **第一轮侦察要花一次联网搜索**（每个会话一次），能力表只活在当前会话的上下文里，没有落盘复用；换会话要重新侦察。
- **选人规则是提示层，不是运行时强制**。宿主的 `tools/pre-execute` **明确排除「改写参数」**（参数此刻已记入日志并展示给用户），插件无法在派发前替领导把 `provider` / `model` 改掉。要真正做到「插件接管选人」，得自己注册一个委派工具并用 `ctx.subagents.start({ agentOptions })` 固定路由——那是另一套实现。
- **两个 preset 都是 native 工具模式**，不涉及 PTC。若拿这份花名册去搭 ptc preset，记得把 `run_code` 加进 `allowTools`（否则领导的唯一原生入口也被拦掉）。
- **运行中的会话不会自动拿到新配置**：改代码或 `cordis.patch.yml` 后需重启 host（或在插件页停用再启用）；已存在的会话保持它创建时的 preset 组合，要**新建会话**才生效。
