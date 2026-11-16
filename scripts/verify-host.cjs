/** Keyless integration check against an installed DSH runtime, with an isolated home. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const presetIds = ['outsourcing-expert', 'outsourcing-expert-reverse', 'leader']
const table = '| provider/model | 能力档位 | 擅长什么 | 不适合什么 | 来源 |\n'
  + '| --- | --- | --- | --- | --- |\n'
  + '| fixture/test-model | 代码专精 | 写代码 | 多模态 | 测试夹具 |\n'
  + '| fixture/other-model | 轻量快速 | 总结 | 复杂推理 | 测试夹具 |'

async function verify(runtime) {
  const scratchRoot = path.resolve(os.tmpdir())
  const scratch = fs.mkdtempSync(path.join(scratchRoot, 'dsh-preset-verify-'))
  // Set before importing the runtime; no user profile, sessions or credentials are read.
  process.env.DSH_HOME = path.join(scratch, 'home')
  const req = createRequire(path.join(runtime, 'package.json'))
  const host = name => import(pathToFileURL(req.resolve(name)).href)
  let ctx
  try {
    const { boot } = await host('@deepseek-ai/dsh-app-boot')
    const { entryListSchema } = await host('@deepseek-ai/cordis-plugin-include')
    const { LlmAdapter } = await host('@deepseek-ai/dsh-llm')
    const yaml = req('js-yaml')
    const readYaml = file => yaml.load(fs.readFileSync(file, 'utf8'), { schema: entryListSchema })
    const baseDir = path.dirname(req.resolve('@deepseek-ai/dsh-base/package.json'))
    const base = readYaml(path.join(baseDir, 'cordis.patch.yml')).flatMap(patch => patch.insert ?? [])
    base.push({ id: 'verify-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: presetIds[0] } })
    const pluginDir = path.resolve(__dirname, '..')
    const patches = readYaml(path.join(pluginDir, 'cordis.patch.yml'))
    // Resolve the same modules from the installed host, without installing into a live profile.
    const localize = value => {
      if (!value || typeof value !== 'object') return
      if (value.name === 'dsh-outsourcing-expert') {
        value.name = pathToFileURL(path.join(pluginDir, 'src/index.js')).href
        value.config.storeDir = path.join(scratch, value.id)
      } else if (typeof value.name === 'string' && value.name.startsWith('@deepseek-ai/')) {
        value.name = pathToFileURL(req.resolve(value.name)).href
      }
      for (const child of Object.values(value)) localize(child)
    }
    localize(patches)
    const config = path.join(scratch, 'cordis.yml')
    fs.writeFileSync(config, yaml.dump(base, { schema: entryListSchema }))
    ctx = await boot('preset-verify', config, patches, undefined, pathToFileURL(runtime + path.sep).href)
    let release
    let completed = 0
    class FixtureAdapter extends LlmAdapter {
      async listModels() { return ['test-model', 'other-model'].map(id => ({ id, name: id })) }
      async *stream(options) {
        await new Promise((resolve, reject) => {
          const abort = () => { reject(options.signal.reason) }
          release = () => { options.signal.removeEventListener('abort', abort); resolve() }
          if (options.signal.aborted) abort()
          else options.signal.addEventListener('abort', abort, { once: true })
        })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: table }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: table } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        completed++
      }
    }
    ctx.llm.registerAdapter(['fixture'], new FixtureAdapter())
    let callId = 0
    for (const id of presetIds) {
      assert.equal((await ctx.agentPresets.resolve(id)).broken, undefined, `${id} failed to mount`)
      const handle = await ctx.agents.create({
        sessionId: `verify-${id}`,
        meta: { cwd: scratch },
        agentOptions: { provider: 'fixture', model: 'test-model' },
        setup: async child => { await ctx.agentPresets.mount(child, id) },
      })
      try {
        const agent = handle.agent
        const schemas = ctx.tools.schemas(agent)
        for (const name of ['subagent', 'subagent_fork', 'list_subagent_models', 'list_agents', 'wait_agent']) {
          assert.equal(schemas.filter(schema => schema.name === name).length, 1, `${id}: ${name} missing or duplicated`)
        }
        const params = schemas.find(schema => schema.name === 'subagent').parameters.properties
        for (const key of ['provider', 'model', 'reasoning_effort']) assert.ok(params[key], `${id}: ${key} missing`)
        assert.equal(params.run_in_background, undefined, 'This check expects the asynchronous delegation API')
        const call = async (name, args = {}) => {
          const batch = await ctx.tools.execute({
            agent, signal: AbortSignal.timeout(10000),
            calls: [{ type: 'tool-call', id: `verify-call-${++callId}`, name, arguments: JSON.stringify(args) }],
          })
          return batch
        }
        await call('list_subagent_models')
        const result = await call('subagent', {
          description: 'fixture/test-model：调研模型', prompt: 'Return the fixture capability table.',
          provider: 'fixture', model: 'test-model',
        })
        assert.match(JSON.stringify(result), /started subagent/, `${id}: delegation failed: ${JSON.stringify(result)}`)
        const store = path.join(scratch, id === 'leader' ? 'outsourcing-expert-leader' : id, 'models.json')
        assert.equal(fs.existsSync(store), false, 'Activation receipt must not be cached')
        // Wait for fixture dispatch to begin, then release a real child-loop completion.
        const deadline = Date.now() + 8000
        while (release === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        assert.ok(release, `${id}: child model was never called`)
        const finish = release
        release = undefined
        finish()
        while (!fs.existsSync(store) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        assert.ok(fs.existsSync(store), `${id}: completion did not populate the capability cache`)
        assert.ok(JSON.parse(fs.readFileSync(store, 'utf8')).models.length >= 2)
        console.log(`PASS ${id}: mounted, model selection enabled, asynchronous child completed and cached`)
      } finally { await handle.dispose() }
    }
    assert.equal(completed, 3)
    console.log(`PASS DSH ${JSON.parse(fs.readFileSync(req.resolve('@deepseek-ai/dsh-tool-subagent/package.json'), 'utf8')).version}: all three presets`)
  } finally {
    try { await ctx?.fiber.dispose() } finally {
      assert.equal(path.dirname(path.resolve(scratch)), scratchRoot)
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  }
}

if (process.argv[2] === '--runtime') {
  verify(path.resolve(process.argv[3])).catch(error => { console.error(error); process.exitCode = 1 })
} else {
  const command = process.argv[2] ?? process.env.PATH.split(path.delimiter)
    .map(dir => path.join(dir, 'dsh.cmd')).find(file => fs.existsSync(file))
  if (!command) throw new Error('Pass the DeepSeek Harness executable, or use --runtime <unpacked dsh directory>')
  const executable = command.endsWith('.cmd') ? path.resolve(path.dirname(command), '../../../../DeepSeek Harness.exe') : path.resolve(command)
  const runtime = path.join(path.dirname(executable), 'resources/app.asar/dsh')
  const result = spawnSync(executable, ['--expose-internals', __filename, '--runtime', runtime], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true, timeout: 45000,
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
