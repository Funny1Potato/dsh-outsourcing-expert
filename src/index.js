/**
 * dsh-outsourcing-expert / 「外包高手」。
 *
 * 本插件**挂在 preset 的 scope 里**（由 cordis.patch.yml 声明的 preset 行的 `plugins`
 * 引用），所以只有使用该 preset 的会话才看得见它：scope 化的 `tools/pre-execute`
 * 监听器、`systemPrompt` 段都由 dsh-scope 按会话过滤，别的 preset 的会话完全不受影响。
 * 它自己不判断「我该不该生效」——那是 scope 的职责。
 *
 * 本包声明**两个 preset**（同一个插件模块，靠行配置 `reverseHiring` 区分）：
 *
 *   - 「外包高手」            → 正常选人（能力对齐：越难用的模型越强）
 *   - 「外包高手（反向用人）」 → 故意反着选（越难用的模型越弱）
 *
 * 一条纪律：领导不亲自干活，只能提问 / 拆解 / 定目标 / 委派。
 * 用人两步走：第一轮派一个子智能体**联网调研**「可选模型各自擅长什么」，拿到能力表
 * （只自己用、不展示给用户）之后，每一件活再按能力表 + 任务难度决定派给谁。
 *
 * 与宿主 dsh 0.2.0-rc.2 的契约，逐条按源码核过：
 *
 *   - 插件模块必须具名导出 `name` / `inject` / `apply(ctx, config)`。配置由 apply
 *     的第二参数传入——不存在 `config` 服务，把它写进 `inject` 会让插件的 fiber
 *     永远停在 PENDING（服务到不了位），表现就是「装了但完全没生效」。
 *   - 入口模块必须是 ESM：package.json 的 `"type": "module"`（或入口用 `.mjs`）。缺了它，
 *     Node 按 CommonJS 解析 `export` 会直接 SyntaxError，该行既不挂载、也不会大声报错。
 *   - `systemPrompt.section({ name, order, text })` —— 字段名是 `text`，不是 `content`。
 *   - `tools/pre-execute` 是 waterfall：`(exec, next)` → `{ kind: 'deny', reason }`。
 *     它只能 allow / deny / cancel / ask；harness 明确排除「改写参数」（参数此刻已经
 *     记入日志并展示给用户），所以这里**只能拒绝**，不能替领导把模型改掉。
 *
 * 「领导」与「下属」的区分不走 id 登记表，而是看会话头：`origin === 'subagent'`
 * 或 `delegationDepth > 0`。这正是 harness 自己的判据（deliverables/workspace-changes
 * 用的是同一条件），所以对孙子 Agent、workflow / teammate 派生的子 Agent 都成立，
 * 而且 resume 之后依然有效——比「记住 subagent/start 发过的 id」更准，也不会误伤
 * 同进程里其它会话以及宿主自己的调用。
 */

export const name = 'outsourcing-expert'

/**
 * 必需服务。只列真正必需的两个：`tools`（拦截）与 `systemPrompt`（注入纪律段）。
 * 列了不存在的服务会让插件在那种组合里一直等下去、永不激活。
 */
export const inject = ['tools', 'systemPrompt']

/**
 * 领导「本职」工具白名单：只有沟通、规划、目标、用人。
 *
 * 判据是「这个动作能不能让别人替你做」：
 *   - 沟通 / 规划 / 目标：只能由领导对用户和自身会话做，子 Agent 替代不了；
 *   - 用人：委派本身（`subagent` / `subagent_fork`）与照看下属
 *     （`list_subagent_models` / `list_agents` / `send_message` / `interrupt_agent`）；
 *   - 其余一切（读写文件、跑命令、搜索、上网、workflow、skill、自省……）都算「干活」，
 *     一律拦下，让领导改用委派。
 *
 * `get_goal` / `create_goal` / `update_goal` 留在名单里，不是为了让领导自己拍脑袋：
 * 目标服务按 Agent 校验归属（子 Agent 调会因「不是本会话的目标」被拒），所以子 Agent
 * 无法替领导定目标。纪律段因此要求领导**先派一个 subagent 评估并给出建议的目标**，
 * 拿到答复后才准登记。
 *
 * 配置项 `allowTools` 可以往上追加（不能删减）本名单。
 */
const DEFAULT_ALLOW = [
  'ask_user_question',
  'todo_write',
  'exit_plan_mode',
  'get_goal',
  'create_goal',
  'update_goal',
  'subagent',
  'subagent_fork',
  'list_subagent_models',
  'list_agents',
  'send_message',
  'interrupt_agent',
]

/** 四档难度，纪律段共用同一套说法。 */
const DIFFICULTY_BANDS = ['简单', '中等', '困难', '极难']

/** 委派工具：下面的「顺序纪律」只管这两个。 */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork'])

/**
 * 这个工具调用是不是来自「下属」。会话头是权威判据：`origin === 'subagent'` 是
 * 产品分类，`delegationDepth > 0` 是持久化的递归预算（顶层缺省 0，子 Agent 为父深度 + 1）。
 * 读不到会话头时按「不是下属」处理——拿不准就拦，是这个插件的本职。
 * @param {unknown} agent - `exec.agent`
 * @returns {boolean}
 */
function isSubagent(agent) {
  const header = agent?.session?.header
  if (!header) return false
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

/**
 * 选人规则原文。**两个 preset 的唯一差别**就是这里的 `reverse`：
 * 正常模式按能力对齐，反向模式故意把难活交给弱模型。
 * @param {boolean} reverse
 * @returns {string}
 */
function selectionRule(reverse) {
  if (reverse) {
    return '**反向用人**：对照能力表，任务越难故意用**越弱**的模型，越简单/常规故意用'
      + '**越强**的模型。这是这个模式刻意的「用人不当」，照做即可，不必解释。'
  }
  return '**能力对齐**：对照能力表，简单 →轻量快速，中等 →均衡，困难 →代码专精或强推理，'
    + '极难 →旗舰强推理。'
}

/** 读出这次委派参数里的一个非空字符串字段。 */
function delegationField(exec, key) {
  const raw = exec?.arguments
  const fields = raw !== null && typeof raw === 'object' ? raw : {}
  const value = fields[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 这次委派选用的模型（`provider / model（effort）`）；没指定就是默认路线。 */
function delegationRoute(exec) {
  const provider = delegationField(exec, 'provider')
  const model = delegationField(exec, 'model')
  if (provider === undefined || model === undefined) return '未指定 → 用配置的默认路线'
  const effort = delegationField(exec, 'reasoning_effort')
  return `${provider} / ${model}${effort === undefined ? '' : `（effort ${effort}）`}`
}

/** 这次委派交给子智能体的任务（`description`）。 */
function delegationTask(exec) {
  return delegationField(exec, 'description')
}

/**
 * 委派卡片正文首行：这次用了哪个模型、派它做什么。由插件拼出来（不依赖模型自己说），
 * 而且必须排在结果正文的**第一个**块——客户端折叠卡片只把第一个非空文本块当预览。
 * @param {unknown} exec - 那条委派调用的 `ToolExecution`
 * @returns {string}
 */
function delegationLabel(exec) {
  return `▸ 委派模型：${delegationRoute(exec)}｜任务：${delegationTask(exec) ?? '（未填 description）'}`
}

/**
 * 写进子会话标题的文本：**模型在前**（标题上限 80 字节，截断时先丢任务），再接任务。
 * @param {string} route - 本次委派的模型（或「未指定」的兜底文案）
 * @param {string | undefined} task - 本次委派的任务（`description`）
 * @returns {string}
 */
function composeChildTitle(route, task) {
  return task === undefined ? route : `${route} · ${task}`
}

/**
 * 纪律段正文。`text` 是函数，每次装配重新拼——白名单与升级规则跟着配置走。
 * @param {boolean} reverse - 是否反向用人
 * @param {boolean} escalateOnFailure - 失败后是否允许升级模型重试一次
 * @param {() => string[]} allowList
 * @returns {string}
 */
function discipline(reverse, escalateOnFailure, allowList) {
  return `
# 外包高手：委派纪律

你不亲自做任何事。读文件、写文件、跑命令、搜索、上网、用 workflow、调 skill……
任何「干活」的调用都会被**硬拦截**（直接 deny，不产生任何副作用）。你被允许的动作
只有管理：

${allowList().map(tool => `- \`${tool}\``).join('\n')}

遇到拦截不要重试，改成委派。

## 说话方式

- **不自述过程**：不要写「我先去取模型名册」「我现在派一个子智能体去调研」「接下来我会…」
  这类过程旁白，也不要复述本纪律。直接做，做完直接给结果。
- **理由只讲一次**：为什么选这个模型，在委派那一刻说明（可选）；**交付最终结果时不要再重复**。

## 目标（goal）必须先问下属再定

\`get_goal\` / \`create_goal\` / \`update_goal\` **只属于你**（子 Agent 调会被服务拒绝），
所以**你不能自己拍脑袋定目标**。定目标前：

1. **先派一个 subagent**，在委派提示里写清任务背景、用户诉求、你初步想到的可能目标，
   并要求它**评估并给出建议的目标**：一句话 objective、max_goal_rounds、以及为什么这样定
   （它会用 \`web_search\`、\`read\` 等工具自己调研）。
2. **等它返回**，把它建议的目标、理由与 max_goal_rounds 原样带回。
3. **你再调 \`create_goal\`** 登记。

跳过第 1 步直接 \`create_goal\` 属于越权。

## 用人两步走：先摸清人选，再决定派谁

**每次委派的 \`description\` 都要以模型开头**：\`<provider>/<model>：<任务>\`，例如
\`deepseek-account/deepseek-v4-pro：读 README 并总结\`；没指定模型、交给默认路线时就写
\`默认路线：<任务>\`。父会话里那张卡片折叠时只显示这一行——用户扫一眼就知道活派给了谁。

你不了解这些模型各自擅长什么，所以**第一次委派之前**必须先派人去查。

### 第一轮：侦察可选模型的能力（每个会话只做一次）

⚠ **顺序是硬的，做不到会被当场拦下**：这次侦察必须传 \`run_in_background: false\`（前台
等结果），而且**那一轮只发这一次委派**——不要在同一轮里顺手把干活的活也派出去。能力表
到手之前，任何干活性质的委派都会被拒绝。

1. **取名册**：调 \`list_subagent_models\`（无参数 → 已授权的 provider 列表；再按 provider
   逐个查它公布的模型）。把返回的**完整模型清单**抄下来。该工具不可用、或没列出任何模型时：
   **不要瞎猜**——跳过侦察，把 \`provider\` / \`model\` / \`reasoning_effort\` 全部省略交给
   默认路线。
2. **随机挑一个当侦察兵**：从这份清单里**随机**选一个模型，不要挑「看起来最强」的。
   这一轮不按难度选人——它的任务是调研，不是干正事。
3. **派它去联网调研**（用 \`subagent\`，并显式传入你随机挑中的那个 \`provider\` / \`model\`）：
   - **这一轮必须传 \`run_in_background: false\`**——你的下一步（决定派谁）依赖它的结果，
     要当场等它返回；
   - 把**完整的可选模型清单**贴进委派提示——它看不到你手上的这份清单；
   - 要求它对清单里的每个模型用 \`web_search\` 查「擅长什么、适合哪类任务、评测/口碑如何」，
     并**附上来源链接**；
   - 要求它按固定格式返回一张**能力表**：每个模型一行，写清 provider/model、能力档位
     （轻量快速 / 均衡 / 代码专精 / 旗舰强推理 / 多模态…）、擅长什么、不适合什么、来源。
4. **能力表只留在你自己手里**：它是你的选人依据，**不要展示给用户**。搜索不到、或某些
   模型查不到资料时，按名称启发式补上并标注「未核实」，同样不必展示：flash/lite/mini/small=
   轻量快速，standard/medium=均衡，coder/code=代码专精，pro/max/ultra/thinking/reasoner=
   旗舰强推理，无法归类=均衡。

### 之后每一轮：按能力表派活

1. **判难度**：把这项子任务归到「${DIFFICULTY_BANDS.join(' / ')}」四档之一。
2. **按能力表选人**：${selectionRule(reverse)}
   你只能在**能力表内**（也就是 \`list_subagent_models\` 报过的模型里）选，绝不编造模型名；
   能力表为空（侦察失败）时才退回上面那套名称启发式。
   **选定后要显式传给 \`subagent\`**（\`provider\` + \`model\`，必要时带 \`reasoning_effort\`），
   并按上面的格式把它写进 \`description\`——只在心里想、不写进调用参数，等于没选：
   模型会走默认路线，卡片上也看不到。
${escalateOnFailure
    ? '3. **失败升级**：某个委派失败或明显没做好时，允许**换更高一档的模型重试一次**；\n'
      + '   第二次仍失败就停下来向用户汇报，不要无限重试。\n'
      + '4. '
    : '3. '}**并行优先**：\`subagent\` 默认后台运行（\`run_in_background\` 默认 true），结果落定时
   你会收到通知——相互独立的活一次派出去、别串行干等；只有下一步确实依赖某个结果
   （比如第一轮侦察）时才传 \`run_in_background: false\`。**有前台委派在飞的时候新的委派
   会被拦下**，那说明你本该用后台。需要你当前对话上下文时用 \`subagent_fork\`，全新独立
   子任务用 \`subagent\`。

## 交付前自检

子 Agent 的结论**不是事实**，只是待核验的材料：先看它有没有交出完成标准要求的产出，
明显不合格就按上面第 3 条升级重试，或把缺口如实报给用户。你自己无法核验的部分（读文件、
跑命令）只能靠「再派一个 subagent 去核」——这也是委派。`.trim()
}

/**
 * 挂载「外包高手」。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ allowTools?: string[], reverseHiring?: boolean, escalateOnFailure?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  const settings = config ?? {}
  const reverseHiring = settings.reverseHiring === true
  const escalateOnFailure = settings.escalateOnFailure !== false
  const extraAllowed = Array.isArray(settings.allowTools)
    ? settings.allowTools.filter(tool => typeof tool === 'string' && tool.length > 0)
    : []
  const allowTools = new Set([...DEFAULT_ALLOW, ...extraAllowed])

  // --- 1. 硬拦截 + 顺序纪律 ----------------------------------------------
  // 顺序纪律是实测逼出来的：`subagent` 在 continuable 实例上**默认后台运行**，光在提示里
  // 写「第一轮必须传 run_in_background: false」照样会被无视——模型会把侦查和干活在同一轮
  // 里一起发出去，等不到能力表。这里用两道状态把它兜死（都只按发起方 agent 记）：
  //   ① 每条会话的第一条委派必须是**前台等结果**（那一条就是第一轮侦查）；
  //   ② 有前台委派在飞时，不许再派下一条（后台委派不受这条限制，所以「并行优先」照旧）。
  // 置位/清位只用「同一调用的 pre-execute / post-execute 配对」——post-execute 连抛错的
  // 工具都会收到；再加 agent/pre-step 兜底：新的一步开始就说明上一轮已结束、不可能还有
  // 前台调用在飞。两道保险合起来保证不会把领导永久锁死。
  const delegatedOnce = new Set()
  const foregroundInFlight = new Set()
  /**
   * 待认领的委派：发起方 agent id → 队列（模型 + 任务）。
   *
   * 为什么这么绕：子会话只在 `subagent/start` 前后是「活的」（实测：start 那刻在册，随后
   * 随运行结束被释放），而 `subagent/start` 里只有子会话、没有委派参数，只能靠子会话头的
   * `parentSession` 反查发起方；所以放行委派时先把「模型 + 任务」记在发起方名下。
   * 队列必须与真实运行一一对应：跑起来的那条在 `start` 里被消费，报错没跑起来的那条在
   * 委派结果里被丢弃（否则会张冠李戴——实测踩过）。
   */
  const pendingClaims = new Map()

  const rememberDelegation = (agentId, exec) => {
    const queue = pendingClaims.get(agentId) ?? []
    queue.push({ route: delegationRoute(exec), task: delegationTask(exec) })
    // 只用于配对，压到 4 条就够，异常路径下也不会无限长。
    pendingClaims.set(agentId, queue.slice(-4))
  }

  const claimDelegation = (agentId) => {
    const queue = pendingClaims.get(agentId)
    const claim = queue?.shift()
    if (queue !== undefined && queue.length === 0) pendingClaims.delete(agentId)
    return claim
  }

  /** 这个委派工具在当前 preset 的 schema 里是否暴露 `run_in_background`（没暴露就无从要求前台）。 */
  const supportsBackgroundFlag = (agent, toolName) => {
    try {
      const schema = ctx.tools.schemas(agent).find(candidate => candidate?.name === toolName)
      return schema?.parameters?.properties?.run_in_background !== undefined
    } catch {
      return false
    }
  }

  ctx.on('agent/pre-step', ({ agent }, next) => {
    if (agent !== undefined) foregroundInFlight.delete(agent.id)
    return next()
  })

  // `{ global: true }`：`subagent/start` 是按 scope 过滤派发的，而本插件挂在 preset scope
  // **下面**（实测：只有加了这个选项才收得到；`session/event` 即使加了也收不到，所以别指望
  // 会话事件）。加上之后同一事件会被投递两次——这里靠「认领即消费」天然去重。
  ctx.on('subagent/start', (info) => {
    const childId = typeof info?.id === 'string' ? info.id : undefined
    if (childId === undefined) return
    const child = ctx.get('sessions')?.get(childId) ?? ctx.get('agents')?.get(childId)?.session
    if (child === undefined) return
    const parentId = child.header?.parentSession
    const claim = typeof parentId === 'string' ? claimDelegation(parentId) : undefined
    if (claim === undefined) return

    const titles = ctx.get('sessionTitle')
    if (titles === undefined) return
    // 把「这次用了哪个模型 + 任务」写成子会话标题：`rename` 会把它**钉住**（自动起名与
    // 兜底标题都不会再覆盖），于是子智能体头部/切换器里一眼就能看到派给谁。
    // 尽力而为：失败只记 debug，绝不影响委派本身。
    try {
      titles.rename(child, composeChildTitle(claim.route, claim.task))
    } catch (error) {
      ctx.logger?.debug?.(`outsourcing-expert: 子会话 ${childId} 命名失败：${String(error)}`)
    }
  }, { global: true })

  // 下属（会话头标明是子 Agent）照常干活；宿主内部不带 agent 的调用也放行——那种调用
  // 不是模型在「亲自做事」，拦它只会破坏宿主功能。其余一律 deny。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || toolName === '') return next()

    const agent = exec?.agent
    const leader = agent !== undefined && !isSubagent(agent)

    if (leader && DELEGATION_TOOLS.has(toolName) && supportsBackgroundFlag(agent, toolName)) {
      const id = agent.id
      if (foregroundInFlight.has(id)) {
        return {
          kind: 'deny',
          reason: '【外包高手】你有一条前台委派还在跑，先等它返回再派下一条。需要并行的活请'
            + '用 `run_in_background: true`（后台）分开派，不要和前台委派挤在同一轮里。',
        }
      }
      const foreground = exec?.arguments?.run_in_background === false
      if (!delegatedOnce.has(id) && !foreground) {
        return {
          kind: 'deny',
          reason: '【外包高手】第一轮侦查必须先做、而且必须当场等结果：这次委派请传 '
            + '`run_in_background: false`，并且那一轮只发这一次委派。拿到能力表之后再进入'
            + '正常派活。',
        }
      }
      delegatedOnce.add(id)
      if (foreground) foregroundInFlight.add(id)
      // 记下这次委派的「模型 + 任务」：等 `subagent/start` 里按发起方认领并写成子会话标题。
      rememberDelegation(id, exec)
      return next()
    }

    if (allowTools.has(toolName)) return next()
    if (agent === undefined || isSubagent(agent)) return next()

    return {
      kind: 'deny',
      reason: `【外包高手】你不亲自调用「${toolName}」。你只负责提问、拆解、定目标与委派：`
        + '请改用 `subagent`（全新独立子任务）或 `subagent_fork`（需要你当前对话上下文的'
        + '子任务）把这件事外包出去。',
    }
  })

  // 委派一落定：① 放开「前台在飞」；② 在结果正文里补一行「模型 + 任务」——这行由插件
  // 拼出来，所以委派卡片上一定看得到，不依赖模型自己说明。先走完下游（钩子之类的策略），
  // 再合并：下游若拦截、或整块替换了 value，就原样放行（同时给 content 与 value 会被
  // 注册表判为非法）。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec?.agent !== undefined && DELEGATION_TOOLS.has(exec?.name)) {
      foregroundInFlight.delete(exec.agent.id)
    }
    const downstream = await next()
    if (!DELEGATION_TOOLS.has(exec?.name)) return downstream
    if (result?.isError === true) {
      // 这条委派没跑起来（参数不合法、被别的策略拒了…）：把它的待认领项丢掉，否则下一件
      // 子会话会张冠李戴（实测踩过：失败的前台委派把任务安到了别的子会话头上）。
      if (exec?.agent !== undefined && !isSubagent(exec.agent)) claimDelegation(exec.agent.id)
      return downstream
    }
    if (downstream.kind === 'block' || Object.hasOwn(downstream, 'value')) return downstream
    const blocks = downstream.content ?? result?.content ?? []
    // 必须放在**开头**：客户端折叠卡片只取结果里第一个非空文本块当预览
    // （`ui-trajectory/src/client/layout.ts` 的 `summarizeResult`），追加在末尾等于看不见。
    return { ...downstream, content: [{ type: 'text', text: delegationLabel(exec) }, ...blocks] }
  })

  // --- 2. 纪律段 ---------------------------------------------------------
  ctx.systemPrompt.section({
    name: 'outsourcing-expert:discipline',
    order: 200,
    text: () => discipline(reverseHiring, escalateOnFailure, () => [...allowTools]),
  })
}