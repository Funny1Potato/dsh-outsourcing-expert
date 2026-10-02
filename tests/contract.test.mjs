/**
 * 契约测试：钉住本插件与 dsh 0.2.0-rc.2 的接口形状，以及拦截/放行/纪律段的行为。
 *
 * 不依赖宿主：用一个记录型 ctx 桩，直接把 apply 接上去，检查它注册了什么、
 * 返回值符不符合契约。跑法：`npm test`（即 node --test）。
 *
 * 这里每一条断言都对应一个真实踩过的坑或一条明确的产品要求：
 *   - 导出必须是 name / inject / apply（旧的 default 导出 + inject:['config'] 不生效）。
 *   - 提示段字段必须是 `text`（旧的 `content` 会让装配拿不到正文）。
 *   - 拒绝必须是 `{ kind: 'deny' }`（旧的 `{ type: 'deny' }` 不是 PreToolDecision）。
 *   - 白名单必须含委派工具本身，否则领导连派活都被自己拦掉。
 *   - 子 Agent 判据看会话头，不是「登记过的 id」。
 *   - 选人理由是唯一允许的过程话（其余过程旁白仍禁）、能力表不外露、模型名写进 `description`（提示层要求，用文案断言钉住）。
 *   - 能力表缓存：空表时才拦「没查名册就委派」，侦察结果通过体检才写盘，表存在时不再要求
 *     前台、不再要求名册，提示段换成「直接用表」并把表正文内联进去。
 *   - 提示段必须 `interpolate: false`：宿主对 `{{变量}}` 是严格的，模型写的表里出现
 *     `{{model}}` 会抛错打断整轮装配。
 *   - 两个 preset 只靠 `reverseHiring` 区分；工具仍为 0，命令只有 `/outsourcing-models`。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../src/index.js'

/** 每个桩拿到的临时缓存目录；整个文件跑完统一删掉。 */
const TEMP_DIRS = []
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/**
 * 记录型 ctx 桩：把插件注册的每样东西都收起来，供断言检查。
 * `exposeBackgroundFlag: false` 模拟「这个 preset 的委派工具没暴露 run_in_background」，
 * 用来验证插件在这种情况下不会把领导锁死。
 * `exposeRosterTool: false` 模拟「这个组合里没有 list_subagent_models」，用来验证
 * 「先查名册」那道门会自己让开、不会把领导锁死。
 *
 * 每个桩都会拿到一个**独立的临时缓存目录**（config.storeDir），因为能力表缓存是按路径
 * 读写的——不隔离的话测试会去读真机上的 `~/.dsh/outsourcing-expert/models.json`。
 */
function mount(config, options = {}) {
  const { exposeBackgroundFlag = true, exposeRosterTool = true, toolNames } = options
  const listeners = []
  const sections = []
  const tools = []
  const commands = []
  /** 子会话命名记录与「live 会话」桩：`children` 里放了哪个 id，就代表哪个子会话是活的。 */
  const renames = []
  const children = new Map()
  const storeDir = mkdtempSync(join(tmpdir(), 'dsh-outsourcing-expert-test-'))
  TEMP_DIRS.push(storeDir)
  const delegationSchema = (schemaName) => ({
    name: schemaName,
    parameters: { properties: exposeBackgroundFlag ? { run_in_background: {} } : {} },
  })
  const ctx = {
    on: (eventName, listener) => listeners.push({ eventName, listener }),
    systemPrompt: { section: (section) => sections.push(section) },
    tools: {
      register: (definition) => tools.push(definition),
      schemas: (agent) => (agent === undefined
        ? []
        : toolNames !== undefined
          ? toolNames.map(delegationSchema)
          : [
            delegationSchema('subagent'),
            delegationSchema('subagent_fork'),
            ...exposeRosterTool ? [{ name: 'list_subagent_models', parameters: { properties: {} } }] : [],
          ]),
    },
    get: (key) => {
      // 命令系统是可选的：插件挂得上就该注册 `/outsourcing-models`，取不到也不该崩。
      if (key === 'commands') return { register: (definition) => commands.push(definition) }
      if (key === 'sessions') return { get: (id) => children.get(id) }
      if (key === 'sessionTitle') {
        return {
          rename: (session, title) => {
            // 会话已释放/不在 live store 时，真实的 rename 会抛错。
            if (session?.broken === true) throw new Error('session is not live in this store')
            renames.push({ session, title })
            return { title }
          },
        }
      }
      return undefined
    },
  }
  apply(ctx, { storeDir, ...config })
  const listener = (eventName) => {
    const found = listeners.filter(entry => entry.eventName === eventName)
    assert.equal(found.length, 1, `${eventName} 应恰好注册一个监听器，实得 ${found.length}`)
    return found[0].listener
  }
  const command = (commandName) => commands.find(entry => entry.name === commandName)
  return { listeners, sections, tools, commands, renames, children, listener, command, storeDir }
}

/** 缓存文件路径（与插件内部约定一致：storeDir/models.json，JSON 格式）。 */
const cacheFile = (storeDir) => join(storeDir, 'models.json')

/** 旧格式缓存文件路径（markdown，只读兼容）。 */
const legacyCacheFile = (storeDir) => join(storeDir, 'models.md')

/**
 * 直接写一份缓存，模拟「之前某次会话已经侦察过」。默认写结构化 `raw`（新 JSON 格式）；
 * 想测结构化分支就在 `meta` 里传 `models`。
 */
function seedCache(storeDir, body, meta = {}) {
  mkdirSync(storeDir, { recursive: true })
  const payload = {
    updatedAt: '2026-10-01T00:00:00.000Z',
    source: '子智能体侦察（x / mimo）',
    ...meta,
  }
  if (payload.models === undefined && payload.raw === undefined) payload.raw = body
  writeFileSync(cacheFile(storeDir), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/** 一份通过体检（≥2 行 provider/model + 档位词）的能力表文本。 */
const CAPABILITY_TABLE = [
  '| 模型 | 档位 | 擅长 | 不适合 | 来源 |',
  '| --- | --- | --- | --- | --- |',
  '| deepseek-account/deepseek-v4-pro | 旗舰强推理 | 复杂重构 | 闲聊 | https://example.com/a |',
  '| xiaomi-tp/mimo-v2.6-flash | 轻量快速 | 单文件改动 | 长链路推理 | https://example.com/b |',
].join('\n')

/** 一次工具调用的 exec 桩。`depth` 决定它是领导（0）还是下属（≥1），`args` 是它的参数。 */
function exec(toolName, depth = 0, args = {}) {
  return {
    name: toolName,
    arguments: args,
    agent: { id: `agent-${depth}`, session: { id: `agent-${depth}`, header: { delegationDepth: depth } } },
  }
}

/** 代表「放行到下游」的哨兵值（pre-execute 用它判断是否被拦）。 */
const ALLOWED = Symbol('allowed')
const next = () => Promise.resolve(ALLOWED)

/** post-execute 的 `next()` 按契约返回一个 PostToolDecision，不是哨兵。 */
const nextPost = () => Promise.resolve({ kind: 'accept' })

/** 模拟「先查名册」：缓存为空时，这是发第一条委派的前提（同一批次里 pre-execute 按顺序跑）。 */
const readRoster = (preExecute) => preExecute(exec('list_subagent_models'), next)

test('模块导出符合 Cordis 插件契约', () => {
  assert.equal(name, 'outsourcing-expert')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  assert.equal(typeof apply, 'function')
  // 旧代码把不存在的服务名写进 inject，插件会永远停在 PENDING。
  assert.ok(!inject.includes('config'), "inject 不能包含 'config'：配置由 apply 的第二参数传入")
})

test('只注册四个监听器、一个提示段与一个命令，不注册任何工具', () => {
  const { listeners, sections, tools, commands } = mount({})
  assert.deepEqual(
    listeners.map(entry => entry.eventName).sort(),
    ['agent/pre-step', 'subagent/start', 'tools/post-execute', 'tools/pre-execute'],
  )
  assert.equal(sections.length, 1)
  assert.equal(tools.length, 0, '不应注册工具')
  // 「选人开关」早就去掉了；现在只有能力表缓存的三条命令：看 / 清空 / 重新侦察。
  assert.deepEqual(
    commands.map(entry => entry.name),
    ['outsourcing-models', 'outsourcing-models-clear', 'outsourcing-models-init'],
  )
})

test('提示段用 text 字段、关掉变量插值，且正文可渲染', () => {
  const { sections } = mount({})
  const [section] = sections
  assert.equal(section.name, 'outsourcing-expert:discipline')
  assert.equal(typeof section.order, 'number')
  assert.equal(typeof section.text, 'function')
  assert.ok(!('content' in section), 'PromptSection 的字段是 text，不是 content')
  // 缓存正文是模型写的，可能含 `{{model}}`；宿主对 {{变量}} 是严格的（未知引用抛错）。
  assert.equal(section.interpolate, false, '必须关掉插值，否则模型写的表能打断整轮装配')

  const text = section.text()
  assert.match(text, /外包高手/)
  assert.match(text, /subagent_fork/)
  assert.match(text, /list_subagent_models/)
  // 「用人两步走」：第一轮随机派侦察兵联网调研模型能力，之后按能力表选人。
  assert.match(text, /随机/)
  assert.match(text, /web_search/)
  assert.match(text, /能力表/)
  // 选定的模型必须落到调用参数上（selection 与 description 两处），否则卡片只会显示「未指定」。
  assert.match(text, /选定后要显式传给\s*`subagent`/)
  assert.match(text, /把它写进\s*`description`/)
})

test('子会话拿不到领导纪律段（否则侦察兵也会去派子智能体撞委派深度上限）', () => {
  const { sections } = mount({})
  const section = sections[0]

  // 领导（顶层会话）：正常拿到全文
  const leader = { session: { id: 'leader-1', header: { delegationDepth: 0 } } }
  assert.ok(section.text({ agent: leader, scope: leader }).length > 0, '领导要拿到全文')

  // 子会话（origin 标记或深度标记任一命中）：返回空串 → renderPrompt 会把空段丢掉
  for (const child of [
    { session: { id: 'child-1', header: { origin: 'subagent' } } },
    { session: { id: 'child-2', header: { delegationDepth: 1 } } },
  ]) {
    assert.equal(section.text({ agent: child, scope: child }), '', '子会话不该拿到领导纪律')
  }

  // 拿不准（没有上下文 / 读不到会话头）时按领导处理：宁可多给也不要漏给
  assert.ok(section.text().length > 0, '空上下文按领导处理')
  assert.ok(section.text({ agent: {} }).length > 0, '没有会话头也按领导处理')
})

test('纪律段：选人理由是唯一允许的过程话、能力表不外露、模型名写进 description', () => {
  const text = mount({}).sections[0].text()

  // 选人理由是**唯一**允许的过程话；其余过程旁白仍禁止——两条合并成一条，免得模型
  // 为了守「不自述过程」而把理由也一起省掉（实测就是这么发生的）。
  assert.match(text, /只准说一句过程话：选人理由/)
  assert.match(text, /唯一\*\*允许的过程话|这是\*\*唯一\*\*允许的过程话/)
  // 结论必须由子智能体产出：连简单问答也不许自己直接答（留寒暄与向用户追问两个例外）。
  assert.match(text, /结论不由你产出/)
  assert.match(text, /很简单的问答/)
  assert.match(text, /纯寒暄与确认/)
  assert.match(text, /向用户追问/)
  assert.match(text, /能力表只留在你自己手里/)
  assert.match(text, /不要展示给用户/)
  assert.match(text, /不要写「我先去取模型名册」/, '其余过程旁白仍要明确禁止')
  assert.match(text, /交付最终结果时不要再重复/)
  // 理由从「可选」改成「必须」：发出委派那一刻要说清为什么是它。
  assert.match(text, /发出委派那一刻/)
  assert.ok(!/（可选）/.test(text), '选人理由已改成必须，不该再写「可选」')

  // 父会话卡片**折叠**时只显示调用参数 description，所以要求模型把模型名写在它开头；
  // 插件在结果正文最前面自动补的那行是展开后的兜底（见下面的标注测试）。
  assert.match(text, /每次委派的\s*`description`\s*都要以模型开头/)
  assert.match(text, /`<provider>\/<model>：<任务>`/)
  assert.match(text, /`默认路线：<任务>`/)

  // 明确不该出现的要求：把过程/能力表讲给用户听。
  assert.ok(!/贴给用户看|写给用户看/.test(text), '不应再要求把过程或能力表讲给用户')
})

test('两个 preset 只差 reverseHiring：正常按类型+难度挑最合适的，反向挑最不合适的', () => {
  const aligned = mount({}).sections[0].text()
  assert.match(aligned, /能力对齐（类型 \+ 难度两维）/)
  assert.match(aligned, /先按\*\*任务类型\*\*挑「擅长什么」/)
  assert.match(aligned, /极难 →旗舰强推理/)
  assert.ok(!/独具慧眼/.test(aligned), '正常模式不该出现反向规则')
  // 选人理由：正常模式讲「为什么它合适」，不能是反着说的那套。
  assert.match(aligned, /理由讲「为什么它合适」/)
  assert.ok(!/理由要反着说/.test(aligned), '正常模式的理由不该反着说')

  const reversed = mount({ reverseHiring: true }).sections[0].text()
  assert.match(reversed, /独具慧眼（挑最不合适）/)
  assert.match(reversed, /「不适合什么」那栏反着挑/)
  assert.match(reversed, /难活配最弱/, '没有「不适合」线索时才退回难度反选')
  assert.ok(!/能力对齐/.test(reversed), '反向模式不该出现能力对齐规则')
  // 选人理由：反向模式要装作「它合适」，不许说破这是故意挑的。
  assert.match(reversed, /理由要装作看不出它不合适/)
  assert.match(reversed, /不要说破/)
  assert.ok(!/不擅长所以才选它/.test(reversed), '不该教它说「因为不擅长才选它」')
  assert.ok(!/理由讲「为什么它合适」/.test(reversed), '反向模式不该套用正常模式那条理由模板')
})

test('失败升级按配置出现或消失', () => {
  assert.match(mount({}).sections[0].text(), /失败升级/)
  assert.ok(!/失败升级/.test(mount({ escalateOnFailure: false }).sections[0].text()))
  // 关掉升级后，并行优先仍是最后一条，编号不应出现空洞
  assert.match(mount({ escalateOnFailure: false }).sections[0].text(), /3\. \*\*并行优先\*\*/)
})

test('领导调用干活工具被拒，且拒绝形状是 kind:deny', async () => {
  const { listener } = mount({})
  const preExecute = listener('tools/pre-execute')

  for (const toolName of ['read', 'write', 'edit', 'pwsh', 'bash', 'web_search', 'workflow', 'skill']) {
    const decision = await preExecute(exec(toolName), next)
    assert.equal(decision.kind, 'deny', `${toolName} 应被拦下`)
    assert.ok(!('type' in decision), 'PreToolDecision 用 kind，不是 type')
    assert.match(decision.reason, /外包高手/)
    assert.match(decision.reason, /subagent/)
    // 开关已取消，拒绝文案不该再提开关或设置工具。
    assert.ok(!/用人不当|leader_settings/.test(decision.reason), '拒绝文案不该再提已移除的开关')
  }
})

test('白名单内的管理工具与委派工具放行', async () => {
  const { listener } = mount({})
  const preExecute = listener('tools/pre-execute')

  for (const toolName of [
    'ask_user_question', 'todo_write', 'exit_plan_mode',
    'get_goal', 'create_goal', 'update_goal',
    'list_subagent_models', 'list_agents', 'send_message', 'interrupt_agent',
  ]) {
    assert.equal(await preExecute(exec(toolName), next), ALLOWED, `${toolName} 应放行`)
  }

  // 两个委派工具也放行，但要先查名册、再满足下面的顺序纪律（所以放在顺序测试里逐条断言）。
  await readRoster(preExecute)
  assert.equal(await preExecute(exec('subagent', 0, { run_in_background: false }), next), ALLOWED)

  // 旧的开关工具已移除，也不再放行。
  assert.equal((await preExecute(exec('leader_settings'), next)).kind, 'deny')
})

test('顺序纪律：第一条委派必须是前台，前台在飞时不许再派', async () => {
  const { listener } = mount({})
  const preExecute = listener('tools/pre-execute')
  const postExecute = listener('tools/post-execute')

  // ⓪ 缓存为空时，还没查名册就想委派 → 被「先查名册」那道门拦下
  const noRoster = await preExecute(exec('subagent', 0, { description: '侦查' }), next)
  assert.equal(noRoster.kind, 'deny')
  assert.match(noRoster.reason, /list_subagent_models/)
  assert.match(noRoster.reason, /还没有模型能力表缓存/)

  // 查过名册（同一批次的 pre-execute 按顺序跑，所以不必等它成功）
  await readRoster(preExecute)

  // ① 第一条委派没传 run_in_background: false（默认后台）→ 拦
  const first = await preExecute(exec('subagent', 0, { description: '侦查' }), next)
  assert.equal(first.kind, 'deny')
  assert.match(first.reason, /run_in_background: false/)
  assert.match(first.reason, /第一轮侦查/)

  // 传了前台 → 放行，并进入「前台在飞」
  assert.equal(await preExecute(exec('subagent', 0, { run_in_background: false }), next), ALLOWED)

  // ② 同一轮里再派一条（前台或后台都算）→ 拦
  const sibling = await preExecute(exec('subagent_fork', 0, { run_in_background: false }), next)
  assert.equal(sibling.kind, 'deny')
  assert.match(sibling.reason, /还在跑/)
  assert.equal((await preExecute(exec('subagent', 0, { run_in_background: true }), next)).kind, 'deny')

  // 前台那条一落定（post-execute，连抛错的工具都会收到）就放开；此时并行派后台是允许的
  await postExecute(
    exec('subagent', 0, { run_in_background: false }),
    { isError: true, content: [], error: { message: 'x' } },
    nextPost,
  )
  assert.equal(await preExecute(exec('subagent', 0, { run_in_background: true }), next), ALLOWED)
  assert.equal(await preExecute(exec('subagent_fork', 0, { run_in_background: true }), next), ALLOWED)

  // 第一条之后就不再强制前台了
  assert.equal((await preExecute(exec('leader_settings'), next)).kind, 'deny')
})

test('委派结果里由插件补一行「模型 + 任务」，不依赖模型自己说', async () => {
  const { listener } = mount({})
  const postExecute = listener('tools/post-execute')
  const args = {
    description: '读 README',
    provider: 'xiaomi-tp',
    model: 'mimo-v2.6-pro',
    reasoning_effort: 'high',
    run_in_background: true,
  }
  const background = { isError: false, value: { kind: 'background', jobId: 'j1' }, content: [{ type: 'text', text: '已受理' }] }

  const decision = await postExecute(exec('subagent', 0, args), background, nextPost)
  assert.equal(decision.kind, 'accept')
  assert.ok(!Object.hasOwn(decision, 'value'), '同时给 content 与 value 会被注册表判为非法')
  assert.equal(decision.content.length, 2, '原有正文要保留')
  // 必须排在第一个：客户端折叠卡片只把第一个文本块当预览。
  assert.match(decision.content[0].text, /^▸ 委派模型：xiaomi-tp \/ mimo-v2\.6-pro（effort high）｜任务：读 README$/)
  assert.equal(decision.content[1].text, '已受理')

  // 没指定模型（交给默认路线）时如实说明
  const fallback = await postExecute(
    exec('subagent_fork', 0, { description: '改测试' }),
    { isError: false, value: 1, content: [] },
    nextPost,
  )
  assert.match(fallback.content[0].text, /未指定 → 用配置的默认路线｜任务：改测试/)

  // 错误结果、非委派工具都不加标注（前者是失败信息，后者与本插件的职责无关）
  const failed = await postExecute(
    exec('subagent', 0, args),
    { isError: true, content: [{ type: 'text', text: '炸了' }], error: { message: '炸了' } },
    nextPost,
  )
  assert.ok(!failed.content, '错误结果原样放行，不加标注')
  const other = await postExecute(exec('read', 0), { isError: false, value: 1, content: [] }, nextPost)
  assert.ok(!other.content, '非委派工具原样放行')

  // 下游策略优先：被拦截、或整块替换了 value，都原样放行
  const blocked = await postExecute(
    exec('subagent', 0, args),
    background,
    () => Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: '不许委派' }] }),
  )
  assert.equal(blocked.kind, 'block')
  const replaced = await postExecute(
    exec('subagent', 0, args),
    background,
    () => Promise.resolve({ kind: 'accept', value: 42 }),
  )
  assert.equal(replaced.value, 42)
})

test('子会话出现时按发起方认领「模型 + 任务」写成标题（模型在前），且只命名一次', async () => {
  const mounted = mount({})
  const preExecute = mounted.listener('tools/pre-execute')
  const subagentStart = mounted.listener('subagent/start')
  mounted.children.set('child-1', { id: 'child-1', header: { parentSession: 'agent-0' } })

  await readRoster(preExecute)
  await preExecute(exec('subagent', 0, {
    description: '读 README',
    provider: 'xiaomi-tp',
    model: 'mimo-v2.6-pro',
    run_in_background: false,
  }), next)

  subagentStart({ runId: 'run-1', id: 'child-1' })
  assert.equal(mounted.renames.length, 1)
  assert.equal(mounted.renames[0].session.id, 'child-1')
  // 模型在前：标题有 80 字节上限、截断时先丢任务。
  assert.equal(mounted.renames[0].title, 'xiaomi-tp / mimo-v2.6-pro · 读 README')

  // `{ global: true }` 会让同一事件被投递两次：认领已消费，所以不会重复命名。
  subagentStart({ runId: 'run-1', id: 'child-1' })
  assert.equal(mounted.renames.length, 1)
})

test('提示只点名这个 preset 真有的工具：没有 subagent 时绝不能叫它用 subagent', () => {
  // 真机踩过：leader preset 只注册了 subagent_fork，而纪律段通篇写「用 subagent」，
  // 模型照做 → 宿主 ToolNotFoundError: unknown tool "subagent"。
  const forkOnly = mount({}, { toolNames: ['subagent_fork'] })
  // 装配时宿主总会给 context（scope/agent），这里照真机传一个普通 agent
  const text = forkOnly.sections[0].text({ agent: exec('read').agent })

  assert.match(text, /选定后要显式传给 `subagent_fork`/)
  assert.match(text, /本 preset 只有 `subagent_fork`/)
  assert.ok(!/`subagent`/.test(text), '不能出现裸的 `subagent`——那会让模型去调一个不存在的工具')
  // 名册工具也不存在：不能再叫它去查名册
  assert.match(text, /本 preset 没有 `list_subagent_models`/)
})

test('被拒时指的也是真有的那个委派工具', async () => {
  const forkOnly = mount({}, { toolNames: ['subagent_fork'] })
  const decision = await forkOnly.listener('tools/pre-execute')(exec('read'), next)
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /`subagent_fork`/)
  assert.ok(!/`subagent`/.test(decision.reason), '拒绝理由也不能点不存在的工具名')
})

test('子会话标题用短路线名：没指定模型时就是「默认路线 · 任务」', async () => {
  const mounted = mount({})
  const preExecute = mounted.listener('tools/pre-execute')
  const subagentStart = mounted.listener('subagent/start')
  mounted.children.set('child-1', { id: 'child-1', header: { parentSession: 'agent-0' } })

  await readRoster(preExecute)
  await preExecute(exec('subagent', 0, { description: '写鹈鹕', run_in_background: false }), next)
  subagentStart({ id: 'child-1' })

  // 标题上限 80 字节，塞不下「未指定 → 用配置的默认路线」那串；卡片上的长文案不在这里用。
  assert.equal(mounted.renames[0].title, '默认路线 · 写鹈鹕')
})

test('没跑起来的委派会丢掉待认领项，不会张冠李戴', async () => {
  const mounted = mount({})
  const preExecute = mounted.listener('tools/pre-execute')
  const postExecute = mounted.listener('tools/post-execute')
  const subagentStart = mounted.listener('subagent/start')
  mounted.children.set('child-x', { id: 'child-x', header: { parentSession: 'agent-0' } })
  const failed = { isError: true, content: [], error: { message: 'x' } }

  // ① 第一条委派（前台）放行后失败 → 它的待认领项在结果里被丢掉
  await readRoster(preExecute)
  await preExecute(exec('subagent', 0, { description: '侦查', run_in_background: false }), next)
  await postExecute(exec('subagent', 0, { run_in_background: false }), failed, nextPost)

  // ② 第二条委派（后台）真的跑起来 → 它认领到的必须是自己的任务
  await preExecute(exec('subagent_fork', 0, {
    description: '干活',
    provider: 'p',
    model: 'm',
    run_in_background: true,
  }), next)
  subagentStart({ id: 'child-x' })

  assert.deepEqual(mounted.renames.map(entry => entry.title), ['p / m · 干活'])
})

test('子会话命名尽力而为：没有待认领 / 不在册 / 无 parentSession / rename 抛错 / 服务缺失 都安静跳过', async () => {
  const mounted = mount({})
  const preExecute = mounted.listener('tools/pre-execute')
  const subagentStart = mounted.listener('subagent/start')
  await readRoster(preExecute)
  await preExecute(exec('subagent', 0, { description: '侦查', run_in_background: false }), next)

  subagentStart({ id: 'missing' })                        // 会话不在册
  mounted.children.set('orphan', { id: 'orphan', header: {} })
  subagentStart({ id: 'orphan' })                         // 没有 parentSession
  assert.equal(mounted.renames.length, 0)

  mounted.children.set('broken', { id: 'broken', header: { parentSession: 'agent-0' }, broken: true })
  subagentStart({ id: 'broken' })                         // rename 抛错（会话已释放）
  assert.equal(mounted.renames.length, 0)

  // 组合里没有 sessionTitle 服务时也不该崩
  const services = []
  const children = new Map([['child-1', { id: 'child-1', header: { parentSession: 'agent-0' } }]])
  const bare = {
    on: (eventName, listener) => services.push({ eventName, listener }),
    systemPrompt: { section: () => {} },
    tools: {
      register: () => {},
      schemas: () => [{ name: 'subagent', parameters: { properties: { run_in_background: {} } } }],
    },
    get: (key) => (key === 'sessions' ? { get: (id) => children.get(id) } : undefined),
  }
  assert.doesNotThrow(() => apply(bare, { storeDir: join(tmpdir(), 'dsh-outsourcing-expert-bare') }))
  const barePre = services.find(entry => entry.eventName === 'tools/pre-execute').listener
  const bareStart = services.find(entry => entry.eventName === 'subagent/start').listener
  await barePre(exec('subagent', 0, { description: '活', run_in_background: false }), next)
  bareStart({ id: 'child-1' })
})

test('顺序纪律的兜底与边界', async () => {
  const { listener } = mount({})
  const preExecute = listener('tools/pre-execute')
  const preStep = listener('agent/pre-step')

  // 兜底：post-execute 没来（状态没清掉）时，新的一步开始就清掉「前台在飞」。
  await readRoster(preExecute)
  assert.equal(await preExecute(exec('subagent', 0, { run_in_background: false }), next), ALLOWED)
  assert.equal((await preExecute(exec('subagent', 0, { run_in_background: true }), next)).kind, 'deny')
  assert.equal(await preStep({ agent: exec('subagent').agent }, next), ALLOWED)
  assert.equal(await preExecute(exec('subagent', 0, { run_in_background: true }), next), ALLOWED)

  // 只管领导：下属第一条委派、宿主无 agent 的调用都不受顺序纪律约束。
  assert.equal(await preExecute(exec('subagent', 1, { description: '子 Agent 自己派活' }), next), ALLOWED)
  assert.equal(await preExecute({ name: 'subagent', arguments: {} }, next), ALLOWED)

  // schema 没暴露 run_in_background 的 preset：不强制前台（否则会锁死）。
  const loose = mount({}, { exposeBackgroundFlag: false })
  assert.equal(await loose.listener('tools/pre-execute')(exec('subagent', 0, {}), next), ALLOWED)
})

test('子 Agent 不受拦截（含孙子 Agent 与 fork 子会话）', async () => {
  const { listener } = mount({})
  const preExecute = listener('tools/pre-execute')

  for (const depth of [1, 2, 3]) {
    assert.equal(await preExecute(exec('write', depth), next), ALLOWED, `depth=${depth} 的下属应放行`)
  }

  // origin 标记也是权威判据（深度字段缺失时仍能认出子会话）
  const forked = { name: 'read', agent: { id: 'child', session: { id: 'child', header: { origin: 'subagent' } } } }
  assert.equal(await preExecute(forked, next), ALLOWED)
})

test('不带 agent 的调用与无名调用放行，避免误伤宿主', async () => {
  const { listener } = mount({})
  const preExecute = listener('tools/pre-execute')

  assert.equal(await preExecute({ name: 'read' }, next), ALLOWED)
  assert.equal(await preExecute({ name: '' }, next), ALLOWED)
  assert.equal(await preExecute(undefined, next), ALLOWED)
})

test('配置可以追加白名单（空串被过滤）', async () => {
  const { listener } = mount({ allowTools: ['web_search', ''] })
  const preExecute = listener('tools/pre-execute')

  assert.equal(await preExecute(exec('web_search'), next), ALLOWED, 'allowTools 追加的工具应放行')
  assert.equal((await preExecute(exec('edit'), next)).kind, 'deny', '未追加的干活工具仍被拦')
})

test('没有 commands 服务时也照常工作（缓存开着、命令注册可选）', () => {
  const listeners = []
  const ctx = {
    on: (eventName, listener) => listeners.push({ eventName, listener }),
    systemPrompt: { section: () => {} },
    tools: { register: () => {} },
    get: () => undefined,
  }
  assert.doesNotThrow(() => apply(ctx, { storeDir: join(tmpdir(), 'dsh-outsourcing-expert-nocommands') }))
  assert.equal(listeners.filter(entry => entry.eventName === 'tools/pre-execute').length, 1)
})

test('能力表缓存：侦察结果自动落盘，之后提示段换成「直接用表」并内联表正文', async () => {
  const mounted = mount({})
  const preExecute = mounted.listener('tools/pre-execute')
  const postExecute = mounted.listener('tools/post-execute')
  const recon = { description: 'x/mimo：侦察模型能力表', provider: 'x', model: 'mimo', run_in_background: false }

  assert.match(mounted.sections[0].text(), /用人两步走/, '一开始没有表：仍是侦察版提示')

  await readRoster(preExecute)
  assert.equal(await preExecute(exec('subagent', 0, recon), next), ALLOWED)

  // 侦察结果落定 → 通过体检 → 写进缓存
  await postExecute(
    exec('subagent', 0, recon),
    { isError: false, content: [{ type: 'text', text: CAPABILITY_TABLE }] },
    nextPost,
  )
  const written = JSON.parse(readFileSync(cacheFile(mounted.storeDir), 'utf8'))
  assert.equal(typeof written.updatedAt, 'string', 'JSON 必须带更新时间')
  assert.equal(written.source, '子智能体侦察（x / mimo）', '记下是哪条侦察得到的')
  // 结构化是常态：按表头解析出的 models 数组（不是一坨 markdown）
  assert.ok(Array.isArray(written.models) && written.models.length >= 2, '应解析成结构化 models 数组')
  assert.equal(written.models[1].model, 'xiaomi-tp/mimo-v2.6-flash')
  assert.equal(written.models[0].tier, '旗舰强推理')

  // 提示段换成「直接用表」：不再侦察，表正文内联进来
  const text = mounted.sections[0].text()
  assert.match(text, /能力表已经缓存在本机了/)
  assert.match(text, /不要再侦察、不要再调\s*`list_subagent_models`/)
  assert.match(text, /## 本机缓存的能力表（\d{4}-\d{2}-\d{2}）/)
  assert.match(text, /xiaomi-tp\/mimo-v2\.6-flash/)
  assert.ok(!/用人两步走/.test(text), '有表时不该再讲「两步走」')
  assert.ok(!/第一轮侦查必须先做/.test(text), '有表时不该再要求前台侦察')
  // 选人那几条纪律还在，而且「表里没有的模型怎么办」换成了带缓存的说法
  assert.match(text, /选定后要显式传给\s*`subagent`/)
  assert.match(text, /确实需要表外的模型时/)
})

test('缓存只在空的时候写：已有表时既不覆盖，也不要求前台或名册', async () => {
  const mounted = mount({})
  seedCache(mounted.storeDir, CAPABILITY_TABLE)
  const preExecute = mounted.listener('tools/pre-execute')
  const postExecute = mounted.listener('tools/post-execute')
  const before = readFileSync(cacheFile(mounted.storeDir), 'utf8')

  // 有表：第一条委派直接后台并行也放行（不必前台、不必先查名册）
  assert.equal(await preExecute(exec('subagent', 0, { run_in_background: true }), next), ALLOWED)

  // 落定的结果即使又是一张表，也不覆盖已有缓存
  await postExecute(
    exec('subagent', 0, { run_in_background: true }),
    { isError: false, content: [{ type: 'text', text: CAPABILITY_TABLE }] },
    nextPost,
  )
  assert.equal(readFileSync(cacheFile(mounted.storeDir), 'utf8'), before, '已有缓存不该被覆盖')
})

test('侦察结果不像能力表就不写缓存（宁缺勿脏）', async () => {
  const mounted = mount({})
  const preExecute = mounted.listener('tools/pre-execute')
  const postExecute = mounted.listener('tools/post-execute')

  await readRoster(preExecute)
  await preExecute(exec('subagent', 0, { description: '侦查', run_in_background: false }), next)
  await postExecute(
    exec('subagent', 0, { run_in_background: false }),
    { isError: false, content: [{ type: 'text', text: '我读完了 README，结论是它描述了插件的用法。' }] },
    nextPost,
  )
  assert.ok(!existsSync(cacheFile(mounted.storeDir)), '不像能力表就不该留下文件')
  assert.match(mounted.sections[0].text(), /用人两步走/, '没有表时仍是侦察版提示')

  // 侦察失败时同样不写
  const second = mount({})
  const pre2 = second.listener('tools/pre-execute')
  const post2 = second.listener('tools/post-execute')
  await readRoster(pre2)
  await pre2(exec('subagent', 0, { description: '侦查', run_in_background: false }), next)
  await post2(
    exec('subagent', 0, { run_in_background: false }),
    { isError: true, content: [], error: { message: '炸了' } },
    nextPost,
  )
  assert.ok(!existsSync(cacheFile(second.storeDir)), '失败的结果不该写进缓存')
})

test('第一条侦察结果不像能力表时不消费标记，第二条合格的仍能落盘', async () => {
  const mounted = mount({})
  const preExecute = mounted.listener('tools/pre-execute')
  const postExecute = mounted.listener('tools/post-execute')
  const broken = { isError: false, content: [{ type: 'text', text: '无法完成联网调研：subagent depth 2 exceeds maxDepth 1' }] }
  const table = { isError: false, content: [{ type: 'text', text: CAPABILITY_TABLE }] }

  await readRoster(preExecute)

  // ① 第一条（前台）＝侦察，结果不像能力表 → 不写，但标记要留着
  await preExecute(exec('subagent', 0, { run_in_background: false }), next)
  await postExecute(exec('subagent', 0, { run_in_background: false }), broken, nextPost)
  assert.ok(!existsSync(cacheFile(mounted.storeDir)), '不像能力表就不该写')

  // ② 第二条（后台）＝重侦察，结果是合格能力表 → 这次必须写进去
  await preExecute(exec('subagent', 0, { run_in_background: true }), next)
  await postExecute(exec('subagent', 0, { run_in_background: true }), table, nextPost)
  assert.ok(existsSync(cacheFile(mounted.storeDir)), '第二条合格的结果应被缓存——实测漏掉的就是它')
  assert.match(readFileSync(cacheFile(mounted.storeDir), 'utf8'), /deepseek-account\/deepseek-v4-pro/)
})

test('连续多次不像能力表就放弃本会话（标记不能无限挂着）', async () => {
  const mounted = mount({})
  const preExecute = mounted.listener('tools/pre-execute')
  const postExecute = mounted.listener('tools/post-execute')
  const broken = { isError: false, content: [{ type: 'text', text: '没查到，交不了表' }] }
  const table = { isError: false, content: [{ type: 'text', text: CAPABILITY_TABLE }] }

  await readRoster(preExecute)
  await preExecute(exec('subagent', 0, { run_in_background: false }), next)
  await postExecute(exec('subagent', 0, { run_in_background: false }), broken, nextPost)

  // 第 2、3 次仍不像表 → 计数到 MAX_RECON_TRIES（3）就丢标记
  for (const fg of [true, false]) {
    await preExecute(exec('subagent', 0, { run_in_background: fg }), next)
    await postExecute(exec('subagent', 0, { run_in_background: fg }), broken, nextPost)
  }
  assert.ok(!existsSync(cacheFile(mounted.storeDir)))

  // 标记已丢：即使这次交出真表也不写（防止一条远处的委派被误当成侦察）
  await preExecute(exec('subagent', 0, { run_in_background: true }), next)
  await postExecute(exec('subagent', 0, { run_in_background: true }), table, nextPost)
  assert.ok(!existsSync(cacheFile(mounted.storeDir)), '放弃之后不应再写')
})

test('边界：没有 list_subagent_models 时那道门让开；capabilityCache: false 退回每会话侦察', async () => {
  // 组合里没有名册工具 → 不拦（否则就是把人锁死）
  const noRoster = mount({}, { exposeRosterTool: false })
  assert.equal(
    await noRoster.listener('tools/pre-execute')(exec('subagent', 0, { run_in_background: false }), next),
    ALLOWED,
  )

  // 关掉缓存 → 回到「每个会话各自侦察一次」：仍要求前台、仍要求先查名册，但不写文件、不注册命令
  const off = mount({ capabilityCache: false })
  const preExecute = off.listener('tools/pre-execute')
  const postExecute = off.listener('tools/post-execute')
  assert.equal(off.commands.length, 0, '缓存关掉时不注册命令')
  assert.equal((await preExecute(exec('subagent', 0, { run_in_background: true }), next)).kind, 'deny')
  await readRoster(preExecute)
  await preExecute(exec('subagent', 0, { description: '侦察', run_in_background: false }), next)
  await postExecute(
    exec('subagent', 0, { run_in_background: false }),
    { isError: false, content: [{ type: 'text', text: CAPABILITY_TABLE }] },
    nextPost,
  )
  assert.ok(!existsSync(cacheFile(off.storeDir)), '缓存关掉时不该写文件')
  assert.match(off.sections[0].text(), /用人两步走/)
})

test('三条命令：看 / 清空 / 初始化（手写文件也认）', () => {
  const mounted = mount({})
  const show = mounted.command('outsourcing-models').handler
  const clear = mounted.command('outsourcing-models-clear').handler

  const empty = show()
  assert.equal(empty.kind, 'success')
  assert.match(empty.text, /还没有能力表缓存/)
  assert.match(empty.text, /models\.json/)

  seedCache(mounted.storeDir, CAPABILITY_TABLE)
  const shown = show()
  assert.equal(shown.kind, 'success')
  assert.match(shown.text, /更新：2026-10-01T00:00:00\.000Z/)
  assert.match(shown.text, /deepseek-account\/deepseek-v4-pro/)

  // 手工写的老格式（markdown、没有首行元信息）也要认：先移开 JSON，只留老文件
  rmSync(cacheFile(mounted.storeDir), { force: true })
  writeFileSync(legacyCacheFile(mounted.storeDir), CAPABILITY_TABLE, 'utf8')
  assert.match(show().text, /更新：未知/)
  assert.match(mounted.sections[0].text(), /本机缓存的能力表（未知）/)

  const cleared = clear()
  assert.equal(cleared.kind, 'success')
  assert.match(cleared.text, /已清空/)
  // 清空只说「下一条新会话会重新侦察」，要连当前会话一起重来得用 init——文案里要指过去。
  assert.match(cleared.text, /outsourcing-models-init/)
  assert.ok(!existsSync(cacheFile(mounted.storeDir)), 'JSON 那份应被删')
  assert.ok(!existsSync(legacyCacheFile(mounted.storeDir)), '老 markdown 那份也要被删')
  assert.match(show().text, /还没有能力表缓存/)
})

test('`/outsourcing-models-init`：清缓存 + 把本会话两道门重新装上', async () => {
  const mounted = mount({})
  const preExecute = mounted.listener('tools/pre-execute')
  seedCache(mounted.storeDir, CAPABILITY_TABLE)

  // 有表：第一条委派直接后台也放行（两道门是关的）
  assert.equal(await preExecute(exec('subagent', 0, { run_in_background: true }), next), ALLOWED)

  const init = mounted.command('outsourcing-models-init').handler
  const result = init({ rawInput: '', agent: { id: 'agent-0' } })
  assert.equal(result.kind, 'success')
  assert.ok(!existsSync(cacheFile(mounted.storeDir)), '初始化先清掉旧表')
  assert.match(result.text, /list_subagent_models/)

  // 门重新装上：没查名册就委派 → 拦；查过名册 + 前台 → 放行
  const denied = await preExecute(exec('subagent', 0, { run_in_background: false }), next)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /list_subagent_models/)
  await readRoster(preExecute)
  assert.equal(await preExecute(exec('subagent', 0, { run_in_background: false }), next), ALLOWED)
  assert.match(mounted.sections[0].text(), /用人两步走/, '表没了，提示段也回到侦察版')
})