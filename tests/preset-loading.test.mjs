/**
 * Issue #2：DSH 0.2.2-rc.2 不导出 tool-subagent-control/list-agents，
 * 主入口已经注册 list_agents。三份 preset 必须各挂一次主入口，不再挂子路径。
 *
 * 保持零依赖：按本 patch 的顶层声明缩进分块，只检查模块引用，不解析 !!js。
 * 这是配置回归检查；完整宿主挂载的复验步骤见 README「开发与验证」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const presets = patch.split(/^    - id: /m).slice(1).map(body => ({
  declaration: body.slice(0, body.indexOf('\n')).trim(),
  body,
}))
const CONTROL = '@deepseek-ai/dsh-tool-subagent-control'
const EXPECTED_PRESETS = [
  'outsourcing-expert',
  'outsourcing-expert-reverse',
  'leader',
]

test('加载回归检查覆盖全部三个已发布的 preset id', () => {
  assert.deepEqual(presets.map(({ body }) => body.match(/^        id: ([^\r\n]+)$/m)?.[1].trim()), EXPECTED_PRESETS)
})

for (const { declaration, body } of presets) {
  test(`${declaration} 只挂一次 subagent-control 主入口，由它提供 list_agents`, () => {
    const modules = [...body.matchAll(/^\s+name: ['"]?(@deepseek-ai\/[^'"\s]+)['"]?\s*$/gm)]
      .map(([, name]) => name)
    assert.deepEqual(
      modules.filter(name => name === CONTROL || name.startsWith(`${CONTROL}/`)),
      [CONTROL],
      '0.2.2-rc.2 只提供主入口；引用 /list-agents 会导致整份 preset 加载失败',
    )
  })
  test(`${declaration} 使用 0.2.2-rc.3 的选模与名册配置`, () => {
    assert.match(body, /toolName: subagent\r?\n +modelSelection: true\r?\n +modelDiscovery: true/)
    assert.equal((body.match(/modelDiscovery: true/g) ?? []).length, 1, '每个作用域只允许一个名册注册者')
    assert.doesNotMatch(body, /modelSelectionSettings:|backgroundMode:/, '不能保留宿主已移除的配置项')
  })
}
