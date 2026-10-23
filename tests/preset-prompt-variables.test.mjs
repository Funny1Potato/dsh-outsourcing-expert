/**
 * 回归测试：`cordis.patch.yml` 里 persona 的 prefix/suffix 只能引用宿主**真正注册过**
 * 的模板变量，否则任何用这三份 preset 的会话，第一条消息就会在 prompt 装配阶段崩掉。
 *
 * 真机踩过（issue #1，DSH 0.2.1-rc.2）：三份 preset 的 suffix 末尾还留着 0.1.x 时代的
 * `Your working directory is {{cwd}}.`，而 0.2.x 的装配是严格解析的，未注册变量直接抛：
 *   unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
 *   registered variables: provider, model
 * 症状是「一启动就失败」：预设能注册、能出现在模式下拉里，但一条消息都发不出去。
 *
 * 0.2.x 只登记了两个变量（dsh-agent-loop/lib/index.js 里的 `systemPrompt.variable(...)`）：
 * `provider`、`model`。工作目录**不走模板变量**——persona 行默认
 * `includeRuntimeContext: true`，宿主把「当前工作目录」等运行时上下文单独作为 context
 * 段塞进去（见 @deepseek-ai/dsh-persona README）。所以这里断言白名单只有这两个。
 *
 * 不引 YAML 解析器：本包零依赖，而且 patch 里用了 `!!js` 自定义标签，顺手的解析器也
 * 吃不下。直接扫全文里的 `{{name}}`，注释行除外（注释不会被渲染，写什么都不影响）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** 包根目录下的 patch 文件：本测试文件在 tests/ 里。 */
const PATCH_FILE = new URL('../cordis.patch.yml', import.meta.url)

/** 0.2.x 宿主注册的全部 prompt 变量。多一个都别加——装了旧变量会让整轮失败。 */
const REGISTERED_VARIABLES = ['model', 'provider']

/** 变量名规则，照抄宿主的 VARIABLE_NAME（`/^[a-z][a-z0-9_]*$/`）。 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/**
 * 收集 patch 里所有会被宿主插值的 `{{name}}`。
 *
 * `#` 开头的整行是 YAML 注释，宿主永远看不到，跳过；块标量里的正文缩进很多，
 * 本文件不会出现「缩进后才像注释」的正文行，所以按「行首（可缩进）#」判注释即可。
 * @returns {{ name: string, line: number, text: string }[]} 变量名、行号与原文
 */
function templateVariables(text) {
  const found = []
  text.split('\n').forEach((raw, index) => {
    if (/^\s*#/.test(raw)) return
    for (const match of raw.matchAll(/\{\{([^{}]*)\}\}/g)) {
      found.push({ name: match[1].trim(), line: index + 1, text: raw.trim() })
    }
  })
  return found
}

test('persona 文案不引用未注册的模板变量（{{cwd}} 会让会话第一条消息就失败）', () => {
  const text = readFileSync(PATCH_FILE, 'utf8')
  const unknown = templateVariables(text).filter(({ name }) => !REGISTERED_VARIABLES.includes(name))
  assert.deepEqual(
    unknown.map(({ name, line, text: hint }) => `{{${name}}} @ ${line} 行：${hint}`),
    [],
    '宿主只注册了 ' + REGISTERED_VARIABLES.join(' / ') + '；工作目录由运行时上下文注入，不要写进 persona',
  )
})

test('模板变量写法成对且符合宿主的变量名规则', () => {
  const text = readFileSync(PATCH_FILE, 'utf8')
  const opens = (text.match(/\{\{/g) ?? []).length
  const closes = (text.match(/\}\}/g) ?? []).length
  // 未闭合的 `{{` 在装配时同样是抛错（malformed prompt variable reference）。
  assert.equal(opens, closes, '`{{` 与 `}}` 必须成对出现')

  const malformed = templateVariables(text).filter(({ name }) => !VARIABLE_NAME.test(name))
  assert.deepEqual(malformed.map(({ name, line }) => `{{${name}}} @ ${line} 行`), [])
})

test('三份 preset 的 persona 都还在（删变量不该删到整段文案）', () => {
  const text = readFileSync(PATCH_FILE, 'utf8')
  // 三份 preset 各有一次 prefix/suffix：变量被清掉之后这几行必须原样留着。
  assert.equal((text.match(/prefix: You are a coding agent powered by the \{\{model\}\} model\./g) ?? []).length, 3)
  assert.equal((text.match(/^ *suffix: \|$/gm) ?? []).length, 3)
})
