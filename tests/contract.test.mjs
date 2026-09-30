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
 *   - 不自述过程、能力表不外露、用人理由只讲一次、模型名写进 `description`（提示层要求，用文案断言钉住）。
 *   - 两个 preset 只靠 `reverseHiring` 区分；没有开关，所以不注册任何工具与命令。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../src/index.js'

/**
 * 记录型 ctx 桩：把插件注册的每样东西都收起来，供断言检查。
 * `exposeBackgroundFlag: false` 模拟「这个 preset 的委派工具没暴露 run_in_background」，
 * 用来验证插件在这种情况下不会把领导锁死。
 */
function mount(config, options = {}) {
  const { exposeBackgroundFlag = true } = options
  const listeners = []
  const sections = []
  const tools = []
  const commands = []
  /** 子会话命名记录与「live 会话」桩：`children` 里放了哪个 id，就代表哪个子会话是活的。 */
  const renames = []
  const children = new Map()
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
        : [delegationSchema('subagent'), delegationSchema('subagent_fork')]),
    },
    get: (key) => {
      // 故意提供 commands 服务：插件即使能拿到它，也不该注册任何命令。
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
  apply(ctx, config)
  const listener = (eventName) => {
    const found = listeners.filter(entry => entry.eventName === eventName)
    assert.equal(found.length, 1, `${eventName} 应恰好注册一个监听器，实得 ${found.length}`)
    return found[0].listener
  }
  return { listeners, sections, tools, commands, renames, children, listener }
}

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

test('模块导出符合 Cordis 插件契约', () => {
  assert.equal(name, 'outsourcing-expert')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  assert.equal(typeof apply, 'function')
  // 旧代码把不存在的服务名写进 inject，插件会永远停在 PENDING。
  assert.ok(!inject.includes('config'), "inject 不能包含 'config'：配置由 apply 的第二参数传入")
})

test('只注册四个监听器与一个提示段，不注册任何工具或命令', () => {
  const { listeners, sections, tools, commands } = mount({})
  assert.deepEqual(
    listeners.map(entry => entry.eventName).sort(),
    ['agent/pre-step', 'subagent/start', 'tools/post-execute', 'tools/pre-execute'],
  )
  assert.equal(sections.length, 1)
  // 「选人开关去掉」之后，插件不再需要任何模型面向的工具或斜杠命令。
  assert.equal(tools.length, 0, '不应注册工具')
  assert.equal(commands.length, 0, '不应注册命令')
})

test('提示段用 text 字段，且正文可渲染', () => {
  const { sections } = mount({})
  const [section] = sections
  assert.equal(section.name, 'outsourcing-expert:discipline')
  assert.equal(typeof section.order, 'number')
  assert.equal(typeof section.text, 'function')
  assert.ok(!('content' in section), 'PromptSection 的字段是 text，不是 content')

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

test('纪律段：不自述过程、能力表不外露、理由只讲一次、模型名写进 description', () => {
  const text = mount({}).sections[0].text()

  assert.match(text, /不自述过程/, '要明确禁止过程旁白')
  assert.match(text, /能力表只留在你自己手里/)
  assert.match(text, /不要展示给用户/)
  assert.match(text, /理由只讲一次/)
  assert.match(text, /交付最终结果时不要再重复/)

  // 父会话卡片**折叠**时只显示调用参数 description，所以要求模型把模型名写在它开头；
  // 插件在结果正文最前面自动补的那行是展开后的兜底（见下面的标注测试）。
  assert.match(text, /每次委派的\s*`description`\s*都要以模型开头/)
  assert.match(text, /`<provider>\/<model>：<任务>`/)
  assert.match(text, /`默认路线：<任务>`/)

  // 明确不该出现的要求：把过程/能力表讲给用户听。
  assert.ok(!/贴给用户看|写给用户看/.test(text), '不应再要求把过程或能力表讲给用户')
})

test('两个 preset 只差 reverseHiring：默认能力对齐，反向模式刻意反着来', () => {
  const aligned = mount({}).sections[0].text()
  assert.match(aligned, /能力对齐/)
  assert.match(aligned, /极难 →旗舰强推理/)
  assert.ok(!/反向用人/.test(aligned), '正常模式不该出现反向规则')

  const reversed = mount({ reverseHiring: true }).sections[0].text()
  assert.match(reversed, /反向用人/)
  assert.match(reversed, /任务越难故意用\*\*越弱\*\*的模型/)
  assert.ok(!/能力对齐/.test(reversed), '反向模式不该出现能力对齐规则')
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

  // 两个委派工具也放行，但要满足下面的顺序纪律（所以放在顺序测试里逐条断言）。
  assert.equal(await preExecute(exec('subagent', 0, { run_in_background: false }), next), ALLOWED)

  // 旧的开关工具已移除，也不再放行。
  assert.equal((await preExecute(exec('leader_settings'), next)).kind, 'deny')
})

test('顺序纪律：第一条委派必须是前台，前台在飞时不许再派', async () => {
  const { listener } = mount({})
  const preExecute = listener('tools/pre-execute')
  const postExecute = listener('tools/post-execute')

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

test('没跑起来的委派会丢掉待认领项，不会张冠李戴', async () => {
  const mounted = mount({})
  const preExecute = mounted.listener('tools/pre-execute')
  const postExecute = mounted.listener('tools/post-execute')
  const subagentStart = mounted.listener('subagent/start')
  mounted.children.set('child-x', { id: 'child-x', header: { parentSession: 'agent-0' } })
  const failed = { isError: true, content: [], error: { message: 'x' } }

  // ① 第一条委派（前台）放行后失败 → 它的待认领项在结果里被丢掉
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
  assert.doesNotThrow(() => apply(bare, undefined))
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

test('没有 commands 服务时也照常工作（可选读取）', () => {
  const listeners = []
  const ctx = {
    on: (eventName, listener) => listeners.push({ eventName, listener }),
    systemPrompt: { section: () => {} },
    tools: { register: () => {} },
    get: () => undefined,
  }
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.equal(listeners.filter(entry => entry.eventName === 'tools/pre-execute').length, 1)
})