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
 *   - 「外包高手」            → 正常选人（按任务类型 + 难度挑最合适的）
 *   - 「外包高手（独具慧眼）」 → 故意反着选（挑最不适合这个任务的）
 *
 * 一条纪律：领导不亲自干活，只能提问 / 拆解 / 定目标 / 委派。
 * 用人两步走：第一轮派一个子智能体**联网调研**「可选模型各自擅长什么」，拿到能力表
 * （只自己用、不展示给用户）之后，每一件活再按能力表 + 任务难度决定派给谁。
 *
 * **能力表缓存**：调研一次很贵（要联网搜一遍），而结果对这台机器上的每个会话都一样，
 * 所以侦察结果会由本插件自动写到 `<DSH_HOME>/outsourcing-expert/models.json`，之后所有会话
 * 直接把表内联进提示段用，不再侦察。缓存存在时：
 *   - 提示段换成「直接用表」的版本（附上表正文）；
 *   - 代码里的「先查名册」「第一条必须前台」两道门随之取消——它们只为保证侦察真的发生。
 * 表**只在空的时候写**，永不自动覆盖：想换新表就删文件或跑 `/outsourcing-models-clear`
 * （要连当前会话一起重来，用 `/outsourcing-models-init`）。
 *
 * 与宿主 dsh 0.2.0-rc.2 的契约，逐条按源码核过：
 *
 *   - 插件模块必须具名导出 `name` / `inject` / `apply(ctx, config)`。配置由 apply
 *     的第二参数传入——不存在 `config` 服务，把它写进 `inject` 会让插件的 fiber
 *     永远停在 PENDING（服务到不了位），表现就是「装了但完全没生效」。
 *   - 入口模块必须是 ESM：package.json 的 `"type": "module"`（或入口用 `.mjs`）。缺了它，
 *     Node 按 CommonJS 解析 `export` 会直接 SyntaxError，该行既不挂载、也不会大声报错。
 *   - `systemPrompt.section({ name, order, text })` —— 字段名是 `text`，不是 `content`；
 *     `text` 是函数时**每次装配都会重新求值**（所以缓存能随文件变化），但它拿到的
 *     `AssembleContext` 只有 `{ scope?, signal? }`：**没有会话、没有工作区**。这就是缓存
 *     只能是机器级全局一份的原因（模型能力本来也与工作区无关）。
 *   - 该段必须标 `interpolate: false`：宿主对 `{{变量}}` 是严格的，源码注释原话是
 *     *"Malformed, unknown, or undefined references in other sections throw"*——缓存正文是
 *     模型写的，里面出现 `{{model}}` 这类字面量就会**打断整轮装配**。
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

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'outsourcing-expert'

/**
 * 必需服务。只列真正必需的两个：`tools`（拦截）与 `systemPrompt`（注入纪律段）。
 * 列了不存在的服务会让插件在那种组合里一直等下去、永不激活。
 * `commands` 与 `sessionTitle` 是可有可无的，走 `ctx.get(...)` 取。
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

/** 名册工具：缓存为空时那道「先查名册再委派」的门靠它判定。 */
const ROSTER_TOOL = 'list_subagent_models'

/** 能力表缓存：目录名、新格式（JSON）文件名、旧格式（markdown，只读兼容）文件名。 */
const CACHE_DIR_NAME = 'outsourcing-expert'
const CACHE_FILENAME = 'models.json'
const LEGACY_CACHE_FILENAME = 'models.md'
const CACHE_MARKER = 'dsh-outsourcing-expert'

/** 缓存正文上限（字符）。它会被内联进**每次请求**的系统提示，所以必须封顶。 */
const MAX_TABLE_CHARS = 6000

/**
 * 一个会话里最多容几次「侦察结果不像能力表」。标记要**留到真的写进缓存为止**（否则第一条
 * 翻车结果就会把后续那次合格的能力表挡在门外——实测踩过），但也不能无限挂着，超过这次数
 * 就放弃本会话。
 */
const MAX_RECON_TRIES = 3

/**
 * 能力档位词。用来判断一段侦察结果「像不像一张能力表」——不像就不写进缓存，
 * 宁缺勿脏：写坏了会污染之后所有会话的提示段。
 */
const TIER_WORDS = ['轻量快速', '均衡', '代码专精', '旗舰强推理', '多模态']

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
 * 正常模式按「任务类型 + 难度」在能力表里挑最合适的，反向模式照「不适合什么」那栏
 * 挑最不合适的。
 * @param {boolean} reverse
 * @returns {string}
 */
function selectionRule(reverse) {
  if (reverse) {
    return '**独具慧眼（挑最不合适）**：照能力表「不适合什么」那栏反着挑——优先选那栏'
      + '**明确写了这个任务类型**的模型；没有明写的，选「擅长什么」里最不沾这一类的；'
      + '两处都没有，才挑档位与难度最不匹配的（难活配最弱、简单活配最重的那个）。'
      + '这是这个模式刻意的「用人不当」，照做即可；**别把挑法本身当理由讲**——按上面'
      + '「说话方式」那条的说法，讲成「我觉得它合适」的样子。'
  }
  return '**能力对齐（类型 + 难度两维）**：先按**任务类型**挑「擅长什么」正好命中这一类的'
    + '模型；命中多个再按难度定档：简单 →轻量快速，中等 →均衡，困难 →代码专精或强推理，'
    + '极难 →旗舰强推理；同档里优先挑「不适合什么」没提到这一类的。类型全表都没命中时，'
    + '只按难度定档。'
}

/**
 * 「为什么是它」在委派那一刻该怎么说。两个 preset 的差别就在这一句上：正常模式讲匹配，
 * 独具慧眼反过来讲「为什么不匹配」（刻意的用人不当）。
 * @param {boolean} reverse
 * @returns {string}
 */
function selectionReason(reverse) {
  if (reverse) {
    return '- **理由要装作看不出它不合适**：像普通模式那样给一条「匹配」的理由——先点出这个'
      + '任务的类型与难度档，再一口咬定该模型擅长这类活（拿它的档位名、名字里的特征，或一句'
      + '「正合适」当依据就够）。**不要说破**这是故意挑的，也不要提「它不适合这个任务」：'
      + '你就当自己真以为它最合适。'
  }
  return '- **理由讲「为什么它合适」**：点出这个任务的类型与难度档，以及该模型「擅长什么」'
    + '怎么正好接得住它——例如「困难档的长链路重构，v4-pro 是旗舰强推理，擅长这类活」。'
}

/**
 * 这个会话到底该点哪个委派工具的名字。
 *
 * 各 preset 的工具集不同——用户的 `leader` preset **只注册了 `subagent_fork`，没有 `subagent`**；
 * 提示里点名一个不存在的工具，模型就会直接去调它，宿主回 `ToolNotFoundError: unknown tool
 * "subagent"`（2026-10-02 真机日志实测）。所以提示里只提真实存在的那个。
 * @param {Set<string> | undefined} available - 本会话工具名；undefined 表示拿不到（此时不做过滤）
 * @returns {{ main: string, hint: string }}
 */
function delegationNaming(available) {
  const has = (tool) => available === undefined || available.has(tool)
  const roster = has('list_subagent_models')
  if (has('subagent')) {
    return {
      main: 'subagent',
      roster,
      hint: has('subagent_fork')
        ? '需要你当前对话上下文时用 `subagent_fork`，全新独立子任务用 `subagent`。'
        : '',
    }
  }
  if (has('subagent_fork')) {
    return { main: 'subagent_fork', roster, hint: '本 preset 只有 `subagent_fork`：独立子任务也用它。' }
  }
  return { main: 'subagent', roster, hint: '' }
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
 * 子会话标题里用的模型名：没指定就是「默认路线」。
 * 标题上限只有 80 字节，卡片那行「未指定 → 用配置的默认路线」放在标题里太占地方
 * （实测标题变成「未指定 → 用配置的默认路线 · 任务」，任务被挤掉）。
 * @param {unknown} exec
 * @returns {string}
 */
function shortRoute(exec) {
  const provider = delegationField(exec, 'provider')
  const model = delegationField(exec, 'model')
  if (provider === undefined || model === undefined) return '默认路线'
  const effort = delegationField(exec, 'reasoning_effort')
  return `${provider} / ${model}${effort === undefined ? '' : `（effort ${effort}）`}`
}

/**
 * 写进子会话标题的文本：**模型在前**（标题上限 80 字节，截断时先丢任务），再接任务。
 * @param {string} route - 本次委派的模型（或「默认路线」）
 * @param {string | undefined} task - 本次委派的任务（`description`）
 * @returns {string}
 */
function composeChildTitle(route, task) {
  return task === undefined ? route : `${route} · ${task}`
}

// --- 能力表缓存：路径解析、读写、体检 ---------------------------------------

/** 展开 `~` / `~/` / `~\`（与宿主 `expandHomePath` 同规则）。 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * 解析缓存目录。配置项 `storeDir` 就是「放着 models.json 的那个目录」，原样使用；
 * 不配置时按宿主 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 优先级取
 * `$DSH_HOME`（空白视为未设）→ `~/.dsh`，再拼 `outsourcing-expert`。
 * 这里内联实现是为了不给插件引入运行期依赖（顺带避开 peer 依赖版本范围那套坑）。
 * @param {unknown} configured - 配置项 `storeDir`
 * @returns {string} 绝对路径（不创建）
 */
function resolveStoreDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return resolve(expandHome(configured.trim()))
  }
  const fromEnv = process.env.DSH_HOME
  const home = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
  return resolve(expandHome(home), CACHE_DIR_NAME)
}

/** 按码点安全截断（避免把代理对切成半个字）。 */
function clampChars(text, max) {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max).join('')}\n…（本表超出 ${max} 字符上限，已截断）`
}

/** 取结果里的纯文本（委派结果正文优先，前台委派的结构化 `value.output` 兜底）。 */
function resultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text !== '') return text
  const output = result?.value?.output
  return typeof output === 'string' ? output.trim() : ''
}

/**
 * 这段文字像不像一张能力表：至少两行带 `provider/model` 形状，并且出现能力档位词。
 * 两道都要过——否则它更可能是一次普通干活的结论，写进缓存会污染所有后续会话。
 */
function looksLikeCapabilityTable(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
  const modelLines = lines.filter(line => /[A-Za-z0-9._-]+\s*\/\s*[A-Za-z0-9._-]+/.test(line)).length
  return modelLines >= 2 && TIER_WORDS.some(word => text.includes(word))
}

/** 切 markdown 表格的一行：去掉首尾竖线，按 `|` 分格并去空白。 */
function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

/**
 * 从侦察返回的 markdown 表里解析出结构化能力表。取第一个 `|` 开头的表格，按表头关键词
 * 定位列；表头对不上、或正文不足两行就返回空数组——**结构化是常态，解析不出来就退回原文
 * （存 JSON 的 `raw` 字段），绝不因为解析失败把整张表丢掉**。
 * @param {string} text - 侦察返回的正文
 * @returns {{ model: string, tier: string, strengths: string, weaknesses: string, sources: string }[]}
 */
function parseCapabilityTable(text) {
  const lines = text.split(/\r?\n/)
  const headerIndex = lines.findIndex(line => /^\s*\|/.test(line))
  if (headerIndex < 0) return []
  const header = splitTableRow(lines[headerIndex])
  const locate = (patterns) => header.findIndex(cell => patterns.some(pattern => cell.includes(pattern)))
  const indexProvider = locate(['provider'])
  const indexModel = locate(['provider/model', 'provider / model', '模型', 'model'])
  const indexTier = locate(['档位', 'tier'])
  const indexStrengths = locate(['擅长'])
  const indexWeaknesses = locate(['不适合'])
  const indexSources = locate(['来源', 'source'])
  if (indexModel < 0 || indexTier < 0) return []

  const rows = []
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!/^\s*\|/.test(line)) break
    const cells = splitTableRow(line)
    // 分隔行（|---|---|）
    if (cells.every(cell => /^:?-+:?$/.test(cell))) continue
    const model = cells[indexModel] ?? ''
    if (model === '') continue
    // provider 与 model 分成两列时拼回去；同一列（`provider/model`）时不重复。
    const provider = indexProvider >= 0 && indexProvider !== indexModel ? cells[indexProvider] ?? '' : ''
    rows.push({
      model: provider === '' ? model : `${provider}/${model}`,
      tier: cells[indexTier] ?? '',
      strengths: indexStrengths >= 0 ? cells[indexStrengths] ?? '' : '',
      weaknesses: indexWeaknesses >= 0 ? cells[indexWeaknesses] ?? '' : '',
      sources: indexSources >= 0 ? cells[indexSources] ?? '' : '',
    })
  }
  return rows
}

/**
 * 解析名册（`list_subagent_models` 的返回正文）：客户端里**实际配置**的供应商与路线。
 *
 * 为什么需要它：侦察兵是联网查来的，很容易按模型名把 provider 写成真实厂商/发布者
 * （`deepseek` / `anthropic` / `openai`），而客户端里配置的供应商名往往完全另一个样
 * （`deepseek-account`）。写歪的表一旦落盘就会长期误导后续委派（拿着不存在的 provider
 * 去调，直接被策略拒），所以落盘前要拿名册把 provider 校准回去。
 *
 * 名册两种行都认：`providerId — 供应商名`（不传参数时列 provider）与
 * `providerId/modelId — 模型名: 说明`（传 provider 时列模型）。
 * @param {string} text - 名册工具返回的正文
 * @returns {{
 *   providers: Set<string>,
 *   aliases: Map<string, string>,
 *   routes: Map<string, { provider: string, model: string }>,
 * }}
 */
function parseRoster(text) {
  const providers = new Set()
  /** 小写别名（provider id / 显示名）→ 名册原文的 provider id。 */
  const aliases = new Map()
  /** 小写 model id → 名册原文的 `{ provider, model }`。 */
  const routes = new Map()
  const addAlias = (key, provider) => {
    if (key.length > 0 && !aliases.has(key.toLowerCase())) aliases.set(key.toLowerCase(), provider)
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    // 名册每行的形状是「标识 — 人话」；分隔符取 harness 用的 em dash（也容忍 ` - `）。
    const cut = line.search(/\s[—–-]\s/)
    const head = (cut === -1 ? line : line.slice(0, cut)).trim()
    if (head === '') continue
    const slash = head.indexOf('/')
    if (slash > 0 && slash < head.length - 1) {
      // 按**第一个** `/` 切：model id 本身可能带 `/`（例如 openrouter 上的厂商前缀）。
      const provider = head.slice(0, slash).trim()
      const model = head.slice(slash + 1).trim()
      if (provider === '' || model === '') continue
      providers.add(provider)
      addAlias(provider, provider)
      const key = model.toLowerCase()
      if (!routes.has(key)) routes.set(key, { provider, model })
      continue
    }
    // 没有 `/` 的行是 provider 列表：`providerId — 供应商名`。
    if (!/^[\w.-]+$/.test(head)) continue
    providers.add(head)
    addAlias(head, head)
    const tail = cut === -1 ? '' : line.slice(cut).replace(/^\s+[—–-]\s+/, '')
    const display = tail.split(':')[0].trim()
    if (display.length >= 3) addAlias(display, head)
  }
  return { providers, aliases, routes }
}

/** 供应商名的宽松匹配：`deepseek` ↔ 名册里的 `deepseek-account`（唯一命中才算）。 */
function looseProvider(provider, roster) {
  const token = provider.toLowerCase()
  if (token === '') return undefined
  const matches = [...roster.providers].filter((candidate) => {
    const id = candidate.toLowerCase()
    return id.startsWith(`${token}-`) || id.startsWith(`${token}_`)
      || token.startsWith(`${id}-`) || token.startsWith(`${id}_`)
  })
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * 把表里的一格 `provider/model` 校准成名册原文；对不上名册就返回 undefined（这行不可信）。
 * 先按 model 对（模型 id 是侦察兵从清单里抄的，最可靠），对上了整条换成名册原文；model 对
 * 不上再按 provider 对（大小写差异，或 `deepseek` ↔ `deepseek-account` 这类加后缀写法）。
 * @param {string} route - 表里的 `provider/model` 单元格（也可能只有 model）
 * @param {ReturnType<typeof parseRoster>} roster
 * @returns {string | undefined}
 */
function alignRouteToRoster(route, roster) {
  const slash = route.indexOf('/')
  const provider = (slash === -1 ? '' : route.slice(0, slash)).trim()
  const model = (slash === -1 ? route : route.slice(slash + 1)).trim()
  if (model === '') return undefined
  const pair = roster.routes.get(model.toLowerCase())
  if (pair !== undefined) return `${pair.provider}/${pair.model}`
  const canonical = roster.aliases.get(provider.toLowerCase()) ?? looseProvider(provider, roster)
  return canonical === undefined ? undefined : `${canonical}/${model}`
}

/**
 * 用名册校准整张表。**拿不到名册就不动**（没有权威来源，宁可不校准也不乱改）；有名册时
 * 对不上名册的行直接丢掉——留着只会让后续委派拿着一个不存在的 provider 去调，当场被拒。
 * @param {{ model?: unknown }[]} rows - 解析出的结构化能力表
 * @param {ReturnType<typeof parseRoster> | undefined} roster
 * @returns {{ model?: unknown }[]}
 */
function alignRowsToRoster(rows, roster) {
  if (roster === undefined || roster.providers.size === 0) return rows
  const aligned = []
  for (const row of rows) {
    const route = alignRouteToRoster(String(row?.model ?? ''), roster)
    if (route === undefined) continue
    aligned.push({ ...row, model: route })
  }
  return aligned
}

/** 把结构化能力表渲染回 markdown 表——提示段与命令显示共用同一份渲染，避免两处不一致。 */
function renderCapabilityRows(models) {
  const cell = (value) => String(value).replace(/\|/g, '\\|')
  const head = '| provider/model | 能力档位 | 擅长什么 | 不适合什么 | 来源 |\n| --- | --- | --- | --- | --- |'
  const body = models
    .map(row => `| ${cell(row.model)} | ${cell(row.tier)} | ${cell(row.strengths)} | ${cell(row.weaknesses)} | ${cell(row.sources)} |`)
    .join('\n')
  return `${head}\n${body}`
}

/**
 * 缓存正文的渲染形式（提示段与 `outsourcing-models` 命令共用）：
 * 结构化就渲染成表，否则（老格式 / 解析不出结构）用原文。
 * @param {{ models?: unknown[], raw?: string }} cache
 * @returns {string}
 */
function renderCache(cache) {
  const models = Array.isArray(cache.models) ? cache.models : []
  return models.length > 0 ? renderCapabilityRows(models) : (cache.raw ?? '')
}

/** 解析首行的元信息注释；手写的文件（没有这一行）返回 undefined。 */
function parseCacheMeta(head) {
  const match = new RegExp(`^<!--\\s*${CACHE_MARKER}\\s*(\\{.*\\})\\s*-->$`).exec(head.trim())
  if (match === null) return undefined
  try {
    const parsed = JSON.parse(match[1])
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 建一个能力表缓存读写器。文件格式：首行是元信息注释，其余是能力表正文——
 * 首行缺失（手工写的文件）时整个文件都算正文。
 * @param {string} dir - 缓存目录
 */
function createStore(dir) {
  const file = join(dir, CACHE_FILENAME)
  const legacyFile = join(dir, LEGACY_CACHE_FILENAME)

  /** 老 markdown 格式（首行元信息注释 + 正文）——只读兼容，让人手里的旧缓存继续可用。 */
  const readLegacy = () => {
    let raw
    try {
      raw = readFileSync(legacyFile, 'utf8')
    } catch {
      return undefined
    }
    const newline = raw.indexOf('\n')
    const head = newline === -1 ? raw : raw.slice(0, newline)
    const meta = parseCacheMeta(head)
    const body = (meta === undefined ? raw : newline === -1 ? '' : raw.slice(newline + 1)).trim()
    if (body === '') return undefined
    return {
      raw: body,
      ...typeof meta?.updatedAt === 'string' ? { updatedAt: meta.updatedAt } : {},
      ...typeof meta?.source === 'string' ? { source: meta.source } : {},
    }
  }

  return {
    file,
    /**
     * 读出缓存：先读 JSON（`models` 优先、解析不出结构时用 `raw`），没有再退回老 markdown。
     * 文件不存在、读不了、或正文为空都返回 undefined（等价于「没有缓存」）。
     * @returns {{ models?: unknown[], raw?: string, updatedAt?: string, source?: string } | undefined}
     */
    read() {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed !== null && typeof parsed === 'object') {
          const models = Array.isArray(parsed.models)
            ? parsed.models.filter(row => row !== null && typeof row === 'object'
              && typeof row.model === 'string' && typeof row.tier === 'string')
            : []
          const raw = typeof parsed.raw === 'string' ? parsed.raw.trim() : ''
          if (models.length > 0 || raw !== '') {
            return {
              ...models.length > 0 ? { models } : {},
              ...raw !== '' ? { raw } : {},
              ...typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {},
              ...typeof parsed.source === 'string' ? { source: parsed.source } : {},
            }
          }
        }
      } catch {
        // 损坏 / 不是 JSON → 当作没有，退回老格式看一眼
      }
      return readLegacy()
    },
    /**
     * 写入缓存（JSON；先写 `.tmp` 再改名，避免半截文件被读到）。
     * 能按表头解析出结构就存 `models` 数组，否则存 `raw` 原文——**两种都是 JSON**，
     * 绝不因为解析失败丢掉整张表。
     *
     * 例外：拿到了名册（`list_subagent_models` 的结果）时，表先按名册校准 provider、
     * 对不上的行丢掉；校准不出两张表就**整份不写、返回 undefined**——这时候退回 `raw`
     * 等于把那个派不动的 provider 原样存进去，只会继续误导后续委派。
     * 写成功后顺手删掉老 markdown，免得两份互相打架。
     * @param {string} text - 侦察返回的正文
     * @param {string} [source] - 供人看的来源说明
     * @param {ReturnType<typeof parseRoster>} [roster] - 名册（权威的供应商与路线）
     * @returns {object | undefined} 写进去的内容；整份没写时为 undefined
     */
    write(text, source, roster) {
      const body = clampChars(text.trim(), MAX_TABLE_CHARS)
      const models = alignRowsToRoster(parseCapabilityTable(body), roster)
      const structured = models.length >= 2
      if (!structured && roster !== undefined && roster.providers.size > 0) return undefined
      const payload = {
        updatedAt: new Date().toISOString(),
        ...source === undefined ? {} : { source },
        ...(structured ? { models } : { raw: body }),
      }
      mkdirSync(dir, { recursive: true })
      const temp = `${file}.tmp`
      writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(temp, file)
      rmSync(legacyFile, { force: true })
      return payload
    },
    /** 删掉缓存（新旧两份）；不存在时静默成功。 */
    clear() {
      rmSync(file, { force: true })
      rmSync(legacyFile, { force: true })
    },
  }
}

/** 把缓存时间压成一天粒度，只用于提示段里那句「侦察时间：…」。 */
function formatCacheDate(cache) {
  const parsed = Date.parse(cache?.updatedAt ?? '')
  return Number.isNaN(parsed) ? '未知' : new Date(parsed).toISOString().slice(0, 10)
}

// --- 提示段正文 -------------------------------------------------------------

/** 每次委派都要遵守的 description 格式（两个分支共用）。 */
const DELEGATION_FORMAT = '**每次委派的 `description` 都要以模型开头**：'
  + '`<provider>/<model>：<任务>`，例如 `deepseek-account/deepseek-v4-pro：读 README 并总结`。'
  + '这里 `provider` 是**客户端里配置的供应商名**（照名册/能力表原文抄，可能带 `-account` 这类'
  + '后缀）——**不是模型的真实厂商/发布者**，把它写成 `deepseek` / `anthropic` / `openai` '
  + '这种就对不上名册、委派会被拒。没指定模型、交给默认路线时就写 `默认路线：<任务>`；'
  + '父会话里那张卡片折叠时只显示这一行——用户扫一眼就知道活派给了谁。'

/**
 * 「按能力表派活」那几条纪律，两个分支共用。
 * @param {boolean} reverse - 是否反向用人
 * @param {boolean} escalateOnFailure - 失败后是否允许升级模型重试一次
 * @param {boolean} hasCache - 是否已有缓存（决定「表里没有的模型怎么办」那句怎么写）
 * @returns {string}
 */
function hiringSteps(reverse, escalateOnFailure, hasCache, naming) {
  // 有缓存时不能再说「也就是 list_subagent_models 报过的模型里」——那张表是缓存来的，
  // 这个会话根本没调过名册。
  const scope = hasCache
    ? '你只能在**表内**选：表里有的模型名照抄（provider 与 model 都要对上），别自己编一个；'
    : '你只能在**能力表内**（也就是 \`list_subagent_models\` 报过的模型里）选，绝不编造模型名；'
  const fallback = hasCache
    ? '确实需要表外的模型时，省略 `provider` / `model` 交给默认路线，并说明原因；'
    : '能力表为空（侦察失败）时才退回上面那套名称启发式；'
  return `1. **判难度与类型**：先把这项子任务归到「${DIFFICULTY_BANDS.join(' / ')}」四档之一，
   再判它主要属于哪类活——写/改代码、联网调研、读文档与总结、数据分析、图像/视频/语音理解、
   纯问答（拿不准就取最主要的那类）。
2. **按能力表选人**：${selectionRule(reverse)}
   ${scope}
   ${fallback}
   **选定后要显式传给 \`${naming.main}\`**（\`provider\` + \`model\`，必要时带 \`reasoning_effort\`），
   并按上面的格式把它写进 \`description\`——只在心里想、不写进调用参数，等于没选：
   模型会走默认路线，卡片上也看不到。
${escalateOnFailure
    ? '3. **失败升级**：某个委派失败或明显没做好时，允许**换更高一档的模型重试一次**；\n'
      + '   第二次仍失败就停下来向用户汇报，不要无限重试。\n'
      + '4. '
    : '3. '}**并行优先**：\`${naming.main}\` 默认后台运行（\`run_in_background\` 默认 true），结果落定时
   你会收到通知——相互独立的活一次派出去、别串行干等；只有下一步确实依赖某个结果时才传
   \`run_in_background: false\`。**有前台委派在飞的时候新的委派会被拦下**，那说明你本该用
   后台。${naming.hint}`
}

/** 还没有缓存时的「用人」部分：先侦察，再派活。 */
function reconPlan(reverse, escalateOnFailure, naming) {
  // 名册工具不一定存在（leader preset 就没有）：那时候不能叫它去查名册，否则又是一次
  // 「unknown tool」。代码里的那道门也会跟着自动让开（hasTool 检查）。
  const gateRoster = naming.roster
    ? '1. **先查名册**：还没调过 \`list_subagent_models\` 就发第一条委派，会被拒绝——名册是侦察\n   的前提，也是你之后贴给侦察兵的清单。'
    : '1. **本 preset 没有 \`list_subagent_models\`**：跳过查名册，直接用你已知的模型名当清单。'
  const stepRoster = naming.roster
    ? '1. **取名册**：调 \`list_subagent_models\`（**参数整个省略**——写成空字符串会被拒；\n'
      + '   无参数 → 已授权的 provider 列表，再按 provider 逐个查它公布的模型）。把返回的\n'
      + '   **完整模型清单**抄下来（provider 名照抄，别换成模型的真实厂商）。该工具不可用、\n'
      + '   或没列出任何模型时：**不要瞎猜**——跳过侦察，把 \`provider\` / \`model\` /\n'
      + '   \`reasoning_effort\` 全部省略交给默认路线。'
    : '1. **清单从哪来**：本 preset 没有 \`list_subagent_models\`，就用你已知的模型名当清单；'
      + '实在\n   列不出来，就把 \`provider\` / \`model\` / \`reasoning_effort\` 全省略、交给默认路线。'
  return `## 用人两步走：先摸清人选，再决定派谁

${DELEGATION_FORMAT}

你不了解这些模型各自擅长什么，而**本机还没有能力表缓存**，所以第一次委派之前必须先派人去查。

### 第一轮：侦察可选模型的能力

⚠ **两道顺序是硬的，做不到会被当场拦下**：

${gateRoster}
2. **侦察必须前台**：传 \`run_in_background: false\` 当场等结果，而且**那一轮只发这一次
   委派**——不要在同一轮里顺手把干活的活也派出去。

${stepRoster}
2. **随机挑一个当侦察兵**：从这份清单里**随机**选一个模型，不要挑「看起来最强」的。
   这一轮不按难度选人——它的任务是调研，不是干正事。
3. **派它去联网调研**（用 \`${naming.main}\`，并显式传入你随机挑中的那个 \`provider\` / \`model\`）：
   - **这一轮必须传 \`run_in_background: false\`**——你的下一步（决定派谁）依赖它的结果，
     要当场等它返回；
   - 把**完整的可选模型清单**贴进委派提示——它看不到你手上的这份清单；
   - 告诉它**自己用 \`web_search\` 查、不要再往下委派**——侦察兵已经到了委派深度上限
     （上限随 dsh 客户端配置），再派一个子智能体会被系统拒绝，它就交不回能力表；
   - 要求它对清单里的每个模型用 \`web_search\` 查「擅长什么、适合哪类任务、评测/口碑如何」，
     并**附上来源链接**；
   - 要求它按固定格式返回一张**能力表**：每个模型一行，写清 provider/model、能力档位
     （轻量快速 / 均衡 / 代码专精 / 旗舰强推理 / 多模态…）、擅长什么、不适合什么、来源；
   - **provider 一栏必须照抄你贴给它的清单原文**：那是客户端里配置的供应商名（可能带
     \`-account\` 这类后缀），**不是模型的真实厂商/发布者**——不要写成 \`deepseek\` /
     \`anthropic\` / \`openai\` 这种，写错就对不上名册、这张表会被丢掉重来；
   - **这份结果会被自动缓存到本机**（之后所有会话直接复用、不再侦察），所以格式要守住：
     **至少两行、每行含 provider/model，并且出现能力档位词**——达不到就不会被缓存，
     下个会话还得重来。
4. **能力表只留在你自己手里**：它是你的选人依据，**不要展示给用户**。搜索不到、或某些
   模型查不到资料时，按名称启发式补上并标注「未核实」，同样不必展示：flash/lite/mini/small=
   轻量快速，standard/medium=均衡，coder/code=代码专精，pro/max/ultra/thinking/reasoner=
   旗舰强推理，无法归类=均衡。

### 之后每一轮：按能力表派活

${hiringSteps(reverse, escalateOnFailure, false, naming)}`
}

/** 已有缓存时的「用人」部分：直接用表，不再侦察；表正文附在本节末尾。 */
function cachedPlan(reverse, escalateOnFailure, cache, naming) {
  return `## 用人：直接按缓存的能力表派活

${DELEGATION_FORMAT}

**能力表已经缓存在本机了**（侦察时间：${formatCacheDate(cache)}），正文就在本节末尾。
**不要再侦察、不要再调 \`list_subagent_models\`**，直接照表选人。

### 按能力表派活

${hiringSteps(reverse, escalateOnFailure, true, naming)}

## 本机缓存的能力表（${formatCacheDate(cache)}）

${renderCache(cache)}`
}

/** 交付前自检（两个分支共用，但「按上面第几条重试」跟着升级开关走）。 */
function selfCheck(escalateOnFailure) {
  const retry = escalateOnFailure
    ? '明显不合格就按上面第 3 条升级重试，或把缺口如实报给用户。'
    : '明显不合格就把缺口如实报给用户，不要自己硬凑一个结论。'
  return `## 交付前自检

子 Agent 的结论**不是事实**，只是待核验的材料：先看它有没有交出完成标准要求的产出，
${retry}你自己无法核验的部分（读文件、跑命令）只能靠「再派一个 subagent 去核」——这也是委派。`
}

/**
 * 纪律段正文。`text` 是函数，每次装配重新拼：白名单跟着配置走，能力表跟着缓存文件走。
 * @param {boolean} reverse - 是否反向用人
 * @param {boolean} escalateOnFailure - 失败后是否允许升级模型重试一次
 * @param {() => string[]} allowList
 * @param {{ models?: unknown[], raw?: string, updatedAt?: string, source?: string } | undefined} cache - 当前缓存
 * @returns {string}
 */
function discipline(reverse, escalateOnFailure, allowList, cache, naming) {
  return [
    `# 外包高手：委派纪律

你不亲自做任何事。读文件、写文件、跑命令、搜索、上网、用 workflow、调 skill……
任何「干活」的调用都会被**硬拦截**（直接 deny，不产生任何副作用）。你被允许的动作
只有管理：

${allowList().map(tool => `- \`${tool}\``).join('\n')}

遇到拦截不要重试，改成委派。`,
    `## 说话方式

- **只准说一句过程话：选人理由**：每次选定模型、发出委派那一刻，**必须**用一句话说清为什么是它
  ——这是**唯一**允许的过程话；**交付最终结果时不要再重复**。除此之外不要写「我先去取模型名册」
  「我现在派一个子智能体去调研」「接下来我会…」这类旁白，也不要复述本纪律，直接做、做完直接给结果。
${selectionReason(reverse)}
- **结论不由你产出**：哪怕是很简单的问答（「怎么装」「这是什么」「帮我算一下」），也不要
  自己直接答——先派 \`${naming.main}\` 去查、去答，拿到它的结论再转述给用户。可以直接接的只有
  两类：纯寒暄与确认、以及**向用户追问**（要用户补信息，最好用 \`ask_user_question\`）。
  同样的，**不要自己在正文里替子智能体做推导、算数字或下判定**——要核实就再派一个子智能体核。`,
    `## 目标（goal）必须先问下属再定

\`get_goal\` / \`create_goal\` / \`update_goal\` **只属于你**（子 Agent 调会被服务拒绝），
所以**你不能自己拍脑袋定目标**。定目标前：

1. **先派一个 \`${naming.main}\`**，在委派提示里写清任务背景、用户诉求、你初步想到的可能目标，
   并要求它**评估并给出建议的目标**：一句话 objective、max_goal_rounds、以及为什么这样定
   （它会用 \`web_search\`、\`read\` 等工具自己调研）。
2. **等它返回**，把它建议的目标、理由与 max_goal_rounds 原样带回。
3. **你再调 \`create_goal\`** 登记。

跳过第 1 步直接 \`create_goal\` 属于越权。`,
    cache === undefined
      ? reconPlan(reverse, escalateOnFailure, naming)
      : cachedPlan(reverse, escalateOnFailure, cache, naming),
    selfCheck(escalateOnFailure),
  ].join('\n\n')
}

/**
 * 挂载「外包高手」。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   allowTools?: string[], reverseHiring?: boolean, escalateOnFailure?: boolean,
 *   capabilityCache?: boolean, storeDir?: string,
 * }} [config]
 */
export function apply(ctx, config = {}) {
  const settings = config ?? {}
  const reverseHiring = settings.reverseHiring === true
  const escalateOnFailure = settings.escalateOnFailure !== false
  const cacheEnabled = settings.capabilityCache !== false
  const extraAllowed = Array.isArray(settings.allowTools)
    ? settings.allowTools.filter(tool => typeof tool === 'string' && tool.length > 0)
    : []
  const allowTools = new Set([...DEFAULT_ALLOW, ...extraAllowed])

  // 能力表缓存。关掉它（capabilityCache: false）就退回「每个会话各自侦察一次」的老行为。
  const store = createStore(resolveStoreDir(settings.storeDir))
  const readCache = () => (cacheEnabled ? store.read() : undefined)

  // --- 1. 硬拦截 + 顺序纪律 ----------------------------------------------
  // 顺序纪律是实测逼出来的：`subagent` 在 continuable 实例上**默认后台运行**，光在提示里
  // 写「第一轮必须传 run_in_background: false」照样会被无视——模型会把侦查和干活在同一轮
  // 里一起发出去，等不到能力表。这里用两道状态把它兜死（都只按发起方 agent 记）：
  //   ① 缓存为空时，第一条委派必须是**前台等结果**（那一条就是第一轮侦查）；
  //   ② 缓存为空时，还没查过名册（`list_subagent_models`）之前不许委派——否则模型会直接
  //      派活，侦察永远不发生，缓存也就永远是空的；
  //   ③ 有前台委派在飞时，不许再派下一条（后台委派不受这条限制，所以「并行优先」照旧）。
  // 缓存存在时 ①② 自动取消：那时没有侦察要做，第一条委派可以是后台并行的。
  // 置位/清位只用「同一调用的 pre-execute / post-execute 配对」——post-execute 连抛错的
  // 工具都会收到；再加 agent/pre-step 兜底：新的一步开始就说明上一轮已结束、不可能还有
  // 前台调用在飞。两道保险合起来保证不会把领导永久锁死。
  const delegatedOnce = new Set()
  const foregroundInFlight = new Set()
  /** 已经调过名册工具的发起方（缓存为空时的那道门）。 */
  const rosterRead = new Set()
  /**
   * 发起方 → 名册解析结果。侦察表落盘前照它把 provider 校准回配置里的名字
   * （侦察兵联网查来的表容易写成模型的真实厂商名）。合并多次调用：先列 provider、
   * 再逐个 provider 列模型。
   */
  const rosters = new Map()
  /** 待缓存的侦察：发起方 → 那条委派的模型路线（跑完就写进缓存）。 */
  const reconPending = new Map()
  /** 发起方 → 已经试过几次「结果不像能力表」（配合 MAX_RECON_TRIES 用）。 */
  const reconAttempts = new Map()
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
    queue.push({ route: shortRoute(exec), task: delegationTask(exec) })
    // 只用于配对，压到 4 条就够，异常路径下也不会无限长。
    pendingClaims.set(agentId, queue.slice(-4))
  }

  const claimDelegation = (agentId) => {
    const queue = pendingClaims.get(agentId)
    const claim = queue?.shift()
    if (queue !== undefined && queue.length === 0) pendingClaims.delete(agentId)
    return claim
  }

  /** 本会话真实存在的工具名集合；拿不到就返回 undefined（此时提示不做过滤，宁可多列）。 */
  const availableTools = (agent) => {
    try {
      const names = ctx.tools.schemas(agent)
        .map(schema => schema?.name)
        .filter(name => typeof name === 'string' && name !== '')
      return names.length > 0 ? new Set(names) : undefined
    } catch {
      return undefined
    }
  }

  /** 某个工具在当前 preset 的 schema 里有没有（用它判断「这组合里到底有没有这个工具」）。 */
  const hasTool = (agent, toolName) => {
    try {
      return ctx.tools.schemas(agent).some(candidate => candidate?.name === toolName)
    } catch {
      return false
    }
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

  /** 把一次名册结果并进这个发起方的名册（同一会话可能要查好几次：先 list provider 再逐个列模型）。 */
  const rememberRoster = (agentId, text) => {
    const parsed = parseRoster(text)
    if (parsed.providers.size === 0) return
    const merged = rosters.get(agentId)
      ?? { providers: new Set(), aliases: new Map(), routes: new Map() }
    for (const provider of parsed.providers) merged.providers.add(provider)
    for (const [key, value] of parsed.aliases) if (!merged.aliases.has(key)) merged.aliases.set(key, value)
    for (const [key, value] of parsed.routes) if (!merged.routes.has(key)) merged.routes.set(key, value)
    // 重新 set 一次把这条挪到末尾，超出容量先丢最旧的——长跑进程里不会无限涨。
    rosters.delete(agentId)
    rosters.set(agentId, merged)
    while (rosters.size > 32) rosters.delete(rosters.keys().next().value)
  }

  /**
   * 把这次侦察结果写进缓存。
   * @param {string} agentId - 发起侦察的会话（据它取名册，校准表里的 provider）
   * @param {string} route - 侦察那条委派的模型路线
   * @param {unknown} result - 委派结果
   * @returns {boolean} 真的写进去了才为 true——调用方据此决定要不要把「待缓存」标记消费掉
   */
  const persistRecon = (agentId, route, result) => {
    const text = resultText(result)
    if (text === '' || !looksLikeCapabilityTable(text)) {
      ctx.logger?.debug?.('outsourcing-expert: 侦察结果不像能力表，未写入缓存')
      return false
    }
    try {
      const written = store.write(text, `子智能体侦察（${route}）`, rosters.get(agentId))
      if (written === undefined) {
        ctx.logger?.debug?.('outsourcing-expert: 侦察表对不上名册，整份未写入缓存')
        return false
      }
      ctx.logger?.debug?.(`outsourcing-expert: 能力表已缓存到 ${store.file}`)
      return true
    } catch (error) {
      ctx.logger?.debug?.(`outsourcing-expert: 能力表写入失败：${String(error)}`)
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

    // 名册一到手就记下：缓存为空时那道「先查名册再委派」的门据此放行。
    // 在 pre-execute 记（而不是等它成功）是因为模型常把「取名册」和「派侦察兵」放在
    // 同一轮的同一个批次里，而同一批次的 pre-execute 是按顺序逐个跑的——等 post-execute
    // 就会把自己的侦察兵一起拦掉。
    if (leader && toolName === ROSTER_TOOL) rosterRead.add(agent.id)

    if (leader && DELEGATION_TOOLS.has(toolName) && supportsBackgroundFlag(agent, toolName)) {
      const id = agent.id
      // 这一条之前是否必须先做侦察：缓存开着且还没有表时要做；缓存整个关掉时按老行为
      // 「每个会话各自侦察一次」也要做（否则关掉缓存就等于把两道门也一起关了）。
      const needsRecon = cacheEnabled ? readCache() === undefined : true
      const first = !delegatedOnce.has(id)

      if (needsRecon && first && !rosterRead.has(id) && hasTool(agent, ROSTER_TOOL)) {
        return {
          kind: 'deny',
          reason: '【外包高手】本机还没有模型能力表缓存，而你还没查过名册：先调 '
            + '`list_subagent_models` 把可选模型清单拿到手，再发第一条委派（那一条就是侦察）。'
            + '侦察结果会被自动缓存到本机，之后所有会话都不用再侦察。',
        }
      }
      if (foregroundInFlight.has(id)) {
        return {
          kind: 'deny',
          reason: '【外包高手】你有一条前台委派还在跑，先等它返回再派下一条。需要并行的活请'
            + '用 `run_in_background: true`（后台）分开派，不要和前台委派挤在同一轮里。',
        }
      }
      const foreground = exec?.arguments?.run_in_background === false
      if (needsRecon && first && !foreground) {
        return {
          kind: 'deny',
          reason: '【外包高手】第一轮侦查必须先做、而且必须当场等结果：这次委派请传 '
            + '`run_in_background: false`，并且那一轮只发这一次委派。拿到能力表之后再进入'
            + '正常派活。',
        }
      }
      delegatedOnce.add(id)
      if (foreground) foregroundInFlight.add(id)
      // 空表时的第一条委派就是侦察：记下它的路线，等结果落定后写进缓存。
      if (cacheEnabled && needsRecon && first) reconPending.set(id, delegationRoute(exec))
      // 记下这次委派的「模型 + 任务」：等 `subagent/start` 里按发起方认领并写成子会话标题。
      rememberDelegation(id, exec)
      return next()
    }

    if (allowTools.has(toolName)) return next()
    if (agent === undefined || isSubagent(agent)) return next()

    return {
      kind: 'deny',
      reason: `【外包高手】你不亲自调用「${toolName}」。你只负责提问、拆解、定目标与委派：`
        + `请改用 \`${delegationNaming(availableTools(agent)).main}\` 把这件事外包出去。`
        + delegationNaming(availableTools(agent)).hint,
    }
  })

  // 委派一落定：① 放开「前台在飞」；② 侦察那条的结果写进能力表缓存；③ 在结果正文里补
  // 一行「模型 + 任务」——这行由插件拼出来，所以委派卡片上一定看得到，不依赖模型自己说明。
  // 先走完下游（钩子之类的策略），再合并：下游若拦截、或整块替换了 value，就原样放行
  // （同时给 content 与 value 会被注册表判为非法）。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const agent = exec?.agent
    const delegation = DELEGATION_TOOLS.has(exec?.name)
    if (agent !== undefined && delegation) foregroundInFlight.delete(agent.id)

    // 名册结果是「客户端里实际配置的供应商与路线」的权威来源：先记住，侦察表落盘前照它
    // 校准 provider（侦察兵联网查来的表容易把 provider 写成模型的真实厂商名，照抄那个
    // 后续委派会被策略拒）。合并多次调用：先 list provider、再逐个 provider 列模型。
    if (agent !== undefined && exec?.name === ROSTER_TOOL && result?.isError !== true) {
      rememberRoster(agent.id, resultText(result))
    }

    // 侦察结果缓存：只有「空表时那条被标成侦察的委派」才会命中，而且要求它成功。
    // 关键：**只有真的写进缓存才丢标记**——第一条结果不像能力表（侦察兵翻车、被深度上限
    // 拒了…）时留着它，后面那次合格的能力表才不会被漏掉。实测踩过：16:13 清空后第一条
    // 侦察返回「subagent depth 2 exceeds maxDepth 1」，第二次才交出真表，却因为标记已被
    // 消费而一张都没存上。连续 MAX_RECON_TRIES 次都不像表，就放弃本会话，防止标记无限挂着。
    // 注意只有**前台**委派的结果里才有子智能体的产出（后台那条只带回执），而侦察按纪律
    // 本来就是前台，所以这里不会漏。
    if (agent !== undefined && delegation && !isSubagent(agent) && reconPending.has(agent.id)) {
      if (result?.isError !== true) {
        const route = reconPending.get(agent.id)
        if (persistRecon(agent.id, route, result)) {
          reconPending.delete(agent.id)
          reconAttempts.delete(agent.id)
          rosters.delete(agent.id)
        } else {
          const tries = (reconAttempts.get(agent.id) ?? 0) + 1
          if (tries >= MAX_RECON_TRIES) {
            reconPending.delete(agent.id)
            reconAttempts.delete(agent.id)
            rosters.delete(agent.id)
            ctx.logger?.debug?.(`outsourcing-expert: 侦察连续 ${tries} 次不像能力表，本会话放弃缓存`)
          } else {
            reconAttempts.set(agent.id, tries)
          }
        }
      }
    }

    const downstream = await next()
    if (!delegation) return downstream
    if (result?.isError === true) {
      // 这条委派没跑起来（参数不合法、被别的策略拒了…）：把它的待认领项丢掉，否则下一件
      // 子会话会张冠李戴（实测踩过：失败的前台委派把任务安到了别的子会话头上）。
      if (agent !== undefined && !isSubagent(agent)) claimDelegation(agent.id)
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
    // 缓存正文是模型写的，可能含 `{{...}}` 字面量；宿主对 {{变量}} 是严格的
    // （未知引用直接抛错，打断整轮装配），所以这一段必须关掉插值。
    interpolate: false,
    // 子会话**不给**这套领导纪律：它们继承同一个 preset，把「结论不由你产出、所有工作都
    // 外包给子智能体」也发给侦察兵，它就会去派自己的子智能体——撞委派深度上限、交不回表
    // （实测：子会话返回 "subagent depth exceeds maxDepth"）。`AssembleContext` 的 `agent`
    // 与 `scope` 都是 agent 对象本身（宿主 `assembleContextFor()` 就是这么拼的）；
    // 拿不准（读不到头）时按领导处理，宁可多给也不要漏给。
    text: (context = {}) => {
      const agent = context.agent ?? context.scope
      if (isSubagent(agent)) return ''
      // 提示里只列**这个 preset 真有的**工具与委派工具名：点名一个不存在的工具，模型会
      // 直接去调它，宿主回 `ToolNotFoundError: unknown tool "subagent"`（真机实测）。
      const available = availableTools(agent)
      const naming = delegationNaming(available)
      const listed = available === undefined
        ? [...allowTools]
        : [...allowTools].filter(tool => available.has(tool))
      return discipline(reverseHiring, escalateOnFailure, () => listed, readCache(), naming)
    },
  })

  // --- 3. 三条命令：看 / 清空 / 重新侦察 -----------------------------------
  // 命令也是 scope 化的，所以只有这两个 preset 的会话看得见。`commands` 不是必需服务，
  // 取不到就安静跳过（这个组合里没有命令系统而已）。三条各做一件事，不靠参数分派。
  if (cacheEnabled) {
    const commands = ctx.get('commands')

    commands?.register?.({
      name: 'outsourcing-models',
      description: '查看本机缓存的模型能力表（外包高手）',
      handler: () => {
        const cache = store.read()
        if (cache === undefined) {
          return {
            kind: 'success',
            text: `本机还没有能力表缓存。\n路径：${store.file}\n`
              + '下一条会话在派第一条委派之前会先做一次侦察，侦察结果会自动写到这里。',
          }
        }
        return {
          kind: 'success',
          text: `路径：${store.file}\n更新：${cache.updatedAt ?? '未知'}\n`
            + `来源：${cache.source ?? '未知'}\n\n${renderCache(cache)}`,
        }
      },
    })

    commands?.register?.({
      name: 'outsourcing-models-clear',
      description: '清空本机缓存的模型能力表（外包高手）',
      handler: () => {
        try {
          store.clear()
        } catch (error) {
          return { kind: 'error', text: `清空失败：${String(error)}` }
        }
        return {
          kind: 'success',
          text: `已清空 ${store.file}\n`
            + '下一条新会话在派第一条委派之前会重新侦察一次。本会话不强制重来'
            + '——要连当前会话一起重来，用 /outsourcing-models-init。',
        }
      },
    })

    commands?.register?.({
      name: 'outsourcing-models-init',
      description: '清掉能力表缓存并让当前会话重新侦察一次（外包高手）',
      handler: (invocation) => {
        try {
          store.clear()
        } catch (error) {
          return { kind: 'error', text: `清空失败：${String(error)}` }
        }
        const id = invocation?.agent?.id
        if (typeof id === 'string') {
          // 只重置「这个会话是否已经侦察过」这一组状态：下一次委派重新受「先查名册 +
          // 前台侦察」两道门约束。在飞的委派状态（foregroundInFlight）不动——那条会
          // 由它自己的 post-execute / pre-step 清掉。
          delegatedOnce.delete(id)
          rosterRead.delete(id)
          reconPending.delete(id)
        }
        return {
          kind: 'success',
          text: '已清空能力表缓存，本会话也重新初始化：下一条委派之前必须先调 '
            + 'list_subagent_models 拿名册，再派一个前台侦察兵；侦察结果会自动写回缓存。',
        }
      },
    })
  }
}