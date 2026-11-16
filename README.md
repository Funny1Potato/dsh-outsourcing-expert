# 外包高手（dsh-outsourcing-expert）

[![CI](https://github.com/Funny1Potato/dsh-outsourcing-expert/actions/workflows/ci.yml/badge.svg)](https://github.com/Funny1Potato/dsh-outsourcing-expert/actions/workflows/ci.yml)

一个 DSH 插件包：声明三个 agent preset。其中两个把「领导」变成**不亲自干活、把活全外包出去**的角色——先摸清可选模型各自擅长什么，再按任务的难度与类型决定每一件活交给谁；第三个「领导模式」则是**执行者 + 委派者**（自己也能干活），插件只给它注入全局能力表。

| preset | id | 选人规则 |
| --- | --- | --- |
| **外包高手** | `outsourcing-expert` | 能力对齐：先按**任务类型**挑「擅长」命中该类的模型，再按**难度**定档——简单 →轻量快速，中等 →均衡，困难 →代码专精或强推理，极难 →旗舰强推理 |
| **外包高手（独具慧眼）** | `outsourcing-expert-reverse` | 故意反着来：照能力表「不适合什么」那栏挑，**专挑干不了这个任务**的模型 |
| **领导模式** | `leader` | 自己的纪律 + 全局能力表：保留「执行者 + 委派者」的身份，能自己高效完成的事自己做；委派时判档优先照全局能力表（表外模型按原有的发现 / 联网核实流程） |

外包高手两个 preset 只差插件行配置里的 `reverseHiring`，**没有运行时开关**，选哪个就是哪个；领导模式是第三份 preset（插件行 `mode: leader`），**不硬拦截干活工具**，插件只注入能力表。

**只在使用这三个 preset 的会话里生效**：preset 的 `plugins` 挂在该 preset 自己的 scope 下，scope 化的拦截器与提示段由宿主按会话过滤；别的 preset（standard、ptc…）的会话完全看不到。

## English summary

A DSH (DeepSeek Harness) plugin bundle that declares three agent presets. Two of them — `outsourcing-expert` and `outsourcing-expert-reverse` — make the top-level agent do no work itself: every non-management tool call (`read`, `write`, `pwsh`, `web_search`, `workflow`, `skill`, …) is **denied at the harness boundary**, so the task has to go to a subagent, and the chosen provider and model have to be named in each delegation. Before the first delegation the leader must look up the available subagent models and research them once; that research is cached at `<DSH_HOME>/outsourcing-expert/models.json` and inlined into the system prompt from then on, so later sessions skip it entirely. On DSH 0.2.2-rc.3 delegation returns an activation receipt immediately; the plugin waits for the scout's lifecycle completion before caching its answer and admitting more delegations. `outsourcing-expert-reverse` deliberately picks the model least suited to the task. The third preset, `leader` (领导模式), keeps the standard mode's identity (it may do work itself, nothing is denied) and keeps its own discovery/tiering/web-verification discipline; the plugin only injects the same global capability table (and builds it when empty) into its prompt.

Install: `dsh plugin --profile <profile> add dsh-outsourcing-expert` (or from GitHub: `github:Funny1Potato/dsh-outsourcing-expert`), then start a new session and pick 外包高手, 外包高手（独具慧眼） or 领导模式. Only the three presets this bundle declares are affected; other presets are untouched.

## 它做什么

> 以下 1–5 节描述**外包高手**两个 preset（`mode` 缺省）。**领导模式**（`mode: leader`）不硬拦截、也不搬这套纪律，见第 6 节。

### 1. 硬拦截（`tools/pre-execute` 瀑布）

领导每次要调用「干活」工具（`read` / `write` / `edit` / `pwsh` / `bash` / `grep` / `web_search` / `workflow` / `skill` / 自省……）时，插件在派发前直接返回 **`{ kind: 'deny' }`**，并附一条说明要求改用 `subagent` / `subagent_fork` 外包出去。**没有任何副作用被执行。**

放行名单（内置，可用配置项 `allowTools` 追加）：

| 类别 | 工具 |
| --- | --- |
| 沟通与规划 | `ask_user_question`、`todo_write`、`exit_plan_mode` |
| 目标 | `get_goal`、`create_goal`、`update_goal`（见下方「定目标」） |
| 委派 | `subagent`、`subagent_fork` |
| 照看下属 | `list_subagent_models`、`list_agents`、`send_message`、`interrupt_agent`、`wait_agent` |

**子 Agent 免检**：判据是会话头 `origin === 'subagent'` 或 `delegationDepth > 0`——宿主自己就是用这个字段区分顶层会话与子会话的。所以直接子 Agent、孙子 Agent、`workflow` 与 teammate 派生的子 Agent 都照常干活，resume 后依然成立。宿主内部不带 agent 的调用也放行。**同一套纪律段也只发给顶层领导**（子会话装配时拿到空段）——否则侦察兵会照着「结论不由你产出、外包给子智能体」去派它自己的子智能体，撞委派深度上限、交不回表；persona 里同样写明了「子会话不适用」。

### 2. 说话方式（提示层）

- **只准说一句过程话：选人理由**：每次委派那一刻，必须用一句话说清为什么是它——这是唯一允许的过程话，**交付最终结果时不再重复**。正常模式讲「为什么它合适」（任务类型 + 难度 + 该模型的「擅长」）；**独具慧眼装作看走眼**，给一条听起来匹配的理由、不提它其实不合适。除此之外不写「我先去取模型名册」「我现在派个子智能体去调研」这类旁白。
- **模型名要出现在卡片上（两条腿）**：
  - **折叠时看的是 `description`**：纪律段要求模型把选定模型写进委派参数 `description` 开头，格式 `<provider>/<model>：<任务>`（走默认路线时写 `默认路线：<任务>`）。父会话里那张卡片**折叠**只显示这一行，客户端按工具名写死、宿主侧改不了，所以模型名只能由模型自己写进参数。**这一条是提示层**，漏写就只有展开才看得到。
  - **展开后另有插件自动补的一行**：每条委派结果里会被插件在**正文最前面**插一行
    `▸ 委派模型：<provider> / <model>（effort）｜任务：<description>`（没指定模型时写「未指定 → 用配置的默认路线」）。
    之所以必须在最前面：界面折叠卡片只取结果里**第一个**非空文本块当预览（`ui-trajectory` 的 `summarizeResult`），追加在末尾就只有展开才看得见。
    这是插件在 `tools/post-execute` 里改写结果正文加上的（只换正文、**不动结构化 value**，所以异步启动回执的 `{ kind: 'activation', name }` 保持原样），**不依赖模型自己说**——模型漏写或写错，展开后仍能看到调用中指定的路由。失败（`isError`）的结果不加这行。
- **能力表不外露**：第一轮侦察得到的能力表只作为自己的选人依据，**不展示给用户**。
- **结论不由你产出**：连简单问答（「怎么装」「这是什么」）也先派 `subagent` 去查/去答，拿到结论再转述；也不自己在正文里替子智能体做推导、算数字或下判定。只有纯寒暄确认、向用户追问这两类可以直接接。

### 3. 用人：先侦察（只做一次），再按能力表派活

1. **第一轮（本机没有缓存时）——侦察候选模型的能力**
   - 调 `list_subagent_models` 拿到**完整的授权模型名册**（无参数列 provider，再按 provider 列模型）；
   - 从名册里**随机挑一个**模型当「侦察兵」（不挑「看起来最强」的）；
   - 用 `subagent` 显式指定这个模型，把**完整名册**贴进委派提示，要求它**自己**用 `web_search` 逐个查「擅长什么、适合哪类任务、评测口碑如何」并附来源，按固定格式返回一张**能力表**（别让它再往下委派——它在深度上限，再派会被系统拒）。0.2.2-rc.3 会立即返回名称，需等完成通知再使用结果；可用 `wait_agent` 等待，或结束当前轮让通知唤醒；
   - 名册拿不到时**不要瞎猜**：跳过侦察、省略 `provider`/`model` 交给默认路线。
   - **顺序是代码强制的**：必须**先查名册**才准发第一条委派，侦察尚未完成时不能再派业务任务。启动回执不能解除这道门，也不能当作能力表。对于仍暴露 `run_in_background` 的旧工具，保留原来的前台限制；当前异步工具不传这个已移除的参数。
   - **侦察结果由插件自动落盘**（见下方「能力表缓存」）：异步模式监听 `subagent/end`，按 `runId` 配对，只缓存成功完成的最终回答；之后**所有会话都不再侦察**。
2. **之后每一轮——按能力表外包**：判任务难度**与类型** → 从能力表里选人（只能在表内选，绝不编造模型名）→ **选定的模型要显式传给 `subagent`**（`provider` + `model`，必要时带 `reasoning_effort`）**并按 `<provider>/<model>：<任务>` 的格式写进 `description`**（不写进调用参数就等于没选，卡片上也看不到）→ 失败可升级重试一次。
   查不到的模型用名称启发式补上并标注「未核实」：`flash/lite/mini/small`=轻量快速，`standard/medium`=均衡，`coder/code`=代码专精，`pro/max/ultra/thinking/reasoner`=旗舰强推理，无法归类=均衡。

### 3.5 能力表缓存（侦察一次，之后所有会话直接用）

「这些模型各自擅长什么」是这台机器的属性，与会话、工作区无关，却要花一次联网搜索才能得到——所以侦察成功后插件就把表写下来，之后直接把表**内联进系统提示段**。

| 项 | 值 |
| --- | --- |
| 位置 | `<DSH_HOME>/outsourcing-expert/models.json`（`$DSH_HOME` 未设时即 `~/.dsh`；可用配置项 `storeDir` 改） |
| 格式 | **JSON**（`models.json`）：`updatedAt` / `source`，正文要么是 `models`（按表头解析出的结构化数组：model / tier / 擅长 / 不适合 / 来源），要么是 `raw`（解析不出结构时的原文兜底）——两种都是 JSON，**手工编辑也没问题**。老 `models.md` 仍可读（只读兼容），下次写入自动转成 JSON 并删掉它 |
| 写入时机 | **只在本机没有表时写**。已有表时永不自动覆盖——想换新表就 `/outsourcing-models-clear` 或直接删文件 |
| 体检 | 侦察结果要「像一张能力表」（≥2 行含 `provider/model`，且出现能力档位词）才会被写；不像就不写，宁缺勿脏。**标记只在真的写进去时才消费**——第一条侦察翻车后，本会话后面那次合格的表照样能落盘（连续 3 次都不像才放弃本会话） |
| 上限 | 正文约 6000 字符，超出按码点安全截断（它会进每次请求的系统提示） |
| 命令 | `/outsourcing-models` 看（路径、更新时间、来源、正文）｜`/outsourcing-models-clear` 清空｜`/outsourcing-models-init` 清空**并让当前会话重新侦察一次** |

缓存存在时，提示段换成「直接用表」的版本（表正文附在末尾），并且**名册与侦察等待两道门一起取消**——它们只为保证侦察真的完成。三个 preset 共用同一份缓存（缓存的是一致的事实，不是用人规则）。

### 4. 定目标必须先问下属

`get_goal` / `create_goal` / `update_goal` **只属于领导**（子 Agent 调会被服务拒绝）。所以纪律段要求：先派一个 subagent 评估并给出建议的目标（objective + max_goal_rounds + 理由），拿到答复后才准 `create_goal`。

### 5. 失败升级（`escalateOnFailure`，默认开）

子任务失败或明显没做好时，允许**换更高一档的模型重试一次**；第二次仍失败就停下来向用户汇报，不无限重试。

### 6. 领导模式（第三个 preset）：只加能力表，纪律保持原样

「领导模式」**不搬外包高手那套纪律**：它自己是执行者也是委派者，`read` / `write` / `web_search` 等干活工具**不被拦截**；它的选模纪律（发现 → 判档 → 联网核实 → 内置启发式对照表）完整保留在 persona 里。插件只做两件事：

- 本机有能力表缓存时，把表内联进提示段，并说明「判档优先照表，表里没覆盖的模型再按原有的发现 / 联网核实流程」；
- 本机还没有缓存时，提示段给出建表流程（查名册 → 派一个侦察兵联网调研 → 等完成通知 → 结果自动缓存），建好之前选模仍按它自己的流程走。

建表与缓存机制和外包高手**完全共用**：同一个 `<DSH_HOME>/outsourcing-expert/models.json`，三个 preset 共用一份。

## 安装与启用

从 npm 装（<https://www.npmjs.com/package/dsh-outsourcing-expert>）：

```sh
dsh plugin --profile <profile> add dsh-outsourcing-expert
```

从 GitHub 装也可以（包里没有 `prepare` / `build` 脚本，源码安装不需要 `allowBuilds` 授权）：

```sh
dsh plugin --profile <profile> add github:Funny1Potato/dsh-outsourcing-expert
```

或从本地 checkout 装：

```sh
dsh plugin --profile <profile> add link:<本目录绝对路径>
```

Desktop 端走界面最省事（**插件 → 添加插件**，填包名 `dsh-outsourcing-expert`，或 GitHub 名、本地目录绝对路径、`link:<路径>`）；要用命令行管 `desktop` profile，得用桌面端**自带的那份** `dsh`（`where dsh` 里排第一的那个），别的 dsh 安装会被拒（`profile "desktop" is managed exclusively by the Electron application`）。装完后**新建会话**，在 preset 选择里选「外包高手」「外包高手（独具慧眼）」或「领导模式」。

插件面向 **DSH 0.2.x**。persona 文案里只出现宿主注册过的 `{{model}}` / `{{provider}}`：0.2.x 的 prompt 装配是严格解析的，引用未注册的变量会让整轮直接抛 `unknown prompt variable`（1.2.3 及更早的版本在这里留了一句 0.1.x 时代的 `{{cwd}}`，导致三份 preset 全部发不出消息，见 [issue #1](https://github.com/Funny1Potato/dsh-outsourcing-expert/issues/1)）。工作目录不需要自己写——persona 行默认 `includeRuntimeContext: true`，宿主会把「当前工作目录」等作为运行时上下文单独注入。

## 文件

| 文件 | 作用 |
| --- | --- |
| `cordis.patch.yml` | 唯一的 patch 层：插入三条 `@deepseek-ai/dsh-agent-preset` 声明。三份花名册以官方 standard preset 为底，适配 DSH 0.2.2-rc.2 的导出结构，业务差别在 persona 与本插件的 `config`（`reverseHiring` / `mode`）——**改花名册时三处一起改** |
| `src/index.js` | 可执行半侧：拦截、顺序纪律、纪律段、能力表缓存的读写与三条 `/outsourcing-models*` 命令（三个 preset 共用同一份代码，按插件行 `config.mode` 分行为） |
| `tests/contract.test.mjs` | 契约测试（记录型 ctx 桩，不依赖宿主） |
| `tests/preset-loading.test.mjs` | 三份预设的模块引用回归检查（issue #2，不依赖宿主） |
| `scripts/verify-host.cjs` | 在已安装的宿主中挂载三份预设，用本地模型夹具执行真实异步委派和完成缓存，不调用外部 API |
| `LICENSE` | MIT |

## 配置项（preset 里那行插件的 `config`）

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `allowTools` | `string[]` | **追加**到内置白名单的工具名（只能加，不能减） |
| `reverseHiring` | `bool` | 外包高手用：`false`=按类型与难度挑最合适的，`true`=照「不适合什么」挑最不合适的。**外包高手两个 preset 唯一的差别** |
| `mode` | `'outer' \| 'leader'` | `outer`（缺省）=外包高手：硬拦截干活工具、搬全套纪律；`leader`=领导模式：不拦截，插件只注入能力表（纪律留在 persona） |
| `escalateOnFailure` | `bool` | 失败后是否允许升级模型重试一次（提示层规则） |
| `capabilityCache` | `bool` | 默认 `true`。`false` = 不读写能力表缓存，退回「每个会话各自侦察一次」（两道代码门仍在） |
| `storeDir` | `string` | 缓存目录（放着 `models.json` 的那个目录）。默认 `<DSH_HOME>/outsourcing-expert` |

## 开发与验证

```sh
node --test        # 契约测试：导出形状、提示段字段、拒绝形状、白名单、子 Agent 判据、两个 preset 的规则差异、说话方式文案、能力表缓存的读写与两道门、persona 文案里的模板变量白名单
node --test tests/preset-loading.test.mjs  # issue #2：三个 preset 各挂一次 subagent-control 主入口，不引用失效子路径
node scripts/verify-host.cjs  # Windows 自动定位 PATH 中 dsh.cmd 所属桌面运行时；全程隔离 DSH_HOME
```

### DSH 0.2.2-rc.3 运行期兼容与复验

该版本的官方 standard preset 仍通过 `@deepseek-ai/dsh-tool-subagent` 注册 `subagent` / `subagent_fork`；移除的是旧的前台/后台调用方式。工具只返回启动名称，最终结果通过完成通知送达。配置中的 `modelSelectionSettings` 也已拆为 `modelSelection` 与 `modelDiscovery`，旧字段不能启用选模或名册。本包已同步三份花名册，放行 `wait_agent`，并根据实际 schema 选择等待方式；若会话只有 fork 就只提示 fork，完全没有委派工具时会明确报告配置问题。

从本地 checkout 执行上面的 `node scripts/verify-host.cjs`，或显式指定桌面程序：

```powershell
node scripts/verify-host.cjs "C:\Users\<用户名>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
```

其他平台可用 `node scripts/verify-host.cjs --runtime <含 package.json 和 node_modules 的已安装 dsh 目录>`。脚本为三个 preset 各建独立会话，检查委派、名册、等待工具和选模参数，再通过宿主真实的工具执行器与进程内子 Agent 跑一次调研：确认启动回执不落盘、完成事件才生成能力表。模型输出使用本地固定夹具，不需要 API key，也不验证真实联网调研质量；临时 home 与会话在结束后清理。等待工具的放行另由契约测试覆盖。

桌面复验时将插件安装指向修复后的本地 checkout，重启并分别新建三个预设的会话。先确认 `subagent` 的参数包含 `provider` / `model` / `reasoning_effort`，且不含 `run_in_background`；再请求一次需委派的小任务，确认可以查名册、启动侦察、等完成通知、生成能力表，并继续后续委派。已有缓存可在该新会话用 `/outsourcing-models-init` 重置。

### DSH 0.2.2-rc.2 预设加载复验（issue #2）

`1.2.4` 的三份花名册额外挂了 `@deepseek-ai/dsh-tool-subagent-control/list-agents`，但 **DSH 0.2.2-rc.2 没有导出这个子路径**，因此在预设挂载阶段三份一起失败。该版本的主入口已注册 `list_agents`，修复只删除三处额外挂载，保留主入口与工具白名单；与 issue #1 的 persona 变量问题是两个独立阶段。旧的 0.2.0-rc.2 源码仍有独立子路径，不能用它替代此版本的复验。

1. 使用 **DSH 0.2.2-rc.2**；在「插件 → 添加插件」中填 `link:<修复后的 checkout 绝对路径>`，将当前安装指向本地修复版。CLI profile 可用 `dsh plugin --profile <profile> add link:<修复后的 checkout 绝对路径>`。不要仍用 npm 上未经本次修复的 `1.2.4` 来验证。
2. 重启宿主，打开「设置 → Agent 预设」，确认「外包高手」「外包高手（独具慧眼）」「领导模式」三项均可选，均无「加载失败」。日志中应无 `ERR_PACKAGE_PATH_NOT_EXPORTED` 或指向 `/list-agents` 的加载错误。
3. 分别用 `outsourcing-expert`、`outsourcing-expert-reverse`、`leader` **新建三个会话**。各发送「调用 list_agents 列出当前子智能体，没有子智能体时返回空列表即可」，确认首轮能够开始、工具可用且调用成功；空列表也是成功。检查每个会话的工具列表中 `list_agents` 恰好一项，日志中无重复工具注册错误。
4. 已有会话不会重建 preset 组合，必须用步骤 3 的新会话验收。`node --test` 是离线配置与行为回归检查，不能替代以上真实宿主挂载检查。

## 已知限制

- **硬拦截只作用于外包高手两个 preset**：领导模式（`mode: leader`）自己是执行者，干活工具不拦，插件只注入能力表。想让外包高手退化成纯提示词模式，把 `src/index.js` 里 `tools/pre-execute` 的 `return { kind: 'deny', ... }` 改成 `return next()` 即可。
- **第一轮侦察只需一次**（本机没有缓存时），之后走缓存。但缓存的**质量取决于那一次侦察兵**：它是模型写的表，可能不准；而且换 provider / 加模型后表会过时——`/outsourcing-models-init` 清掉并当场重新侦察。
- **缓存是机器级全局的一份**（`AssembleContext` 只给 `{ scope, signal }`，拿不到会话与工作区，所以也只能是全局）。同一台机器上的所有工作区、三个 preset 共用它。
- **侦察结果格式不达标就不会被缓存**：体检要求「≥2 行含 `provider/model` 且出现能力档位词」。达不到就只是这一次会话没有表，下个会话还得重来（不会写坏缓存）。
- **选人规则是提示层，不是运行时强制**。宿主的 `tools/pre-execute` **明确排除「改写参数」**（参数此刻已记入日志并展示给用户），插件无法在派发前替领导把 `provider` / `model` 改掉。要真正做到「插件接管选人」，得自己注册一个委派工具并用 `ctx.subagents.start({ agentOptions })` 固定路由——那是另一套实现。
- **外包高手两个 preset 都是 native 工具模式**，不涉及 PTC。若拿这份花名册去搭 ptc preset，记得把 `run_code` 加进 `allowTools`（否则领导的唯一原生入口也被拦掉）。
- **运行中的会话不会自动拿到新配置**：改代码或 `cordis.patch.yml` 后需重启 host（或在插件页停用再启用）；已存在的会话保持它创建时的 preset 组合，要**新建会话**才生效。

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
