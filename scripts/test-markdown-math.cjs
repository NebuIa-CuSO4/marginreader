/**
 * Regression cases for src/shared/markdownMath.ts
 *
 * Run with:
 *   npx tsc src/shared/markdownMath.ts --outDir .tmp-math --module commonjs \
 *     --target ES2022 --moduleResolution node --skipLibCheck
 *   node scripts/test-markdown-math.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-math-'))
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
execFileSync(
  process.execPath,
  [
    tsc,
    'src/shared/markdownMath.ts',
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'ES2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck'
  ],
  { cwd: root, stdio: 'inherit' }
)

const { normalizeMathMarkdown } = require(path.join(outDir, 'markdownMath.js'))

const cases = [
  ['heading with math', '## 目标 \\(x^2\\) 的推导', '## 目标 $x^2$ 的推导'],
  ['list item', '- 第 1 步：\\(a^2+b^2\\)', '- 第 1 步：$a^2+b^2$'],
  ['ordered list', '1. 先算 \\(\\Delta\\) 再比较', '1. 先算 $\\Delta$ 再比较'],
  ['table row', '| A | \\(17 \\times 16\\) | 65 |', '| A | $17 \\times 16$ | 65 |'],
  ['blockquote stays a quote', '> 注意 \\(\\epsilon\\) 很小', '> 注意 $\\epsilon$ 很小'],
  [
    'inline code with matrix macro is untouched',
    '看这个 `\\begin{bmatrix}` 宏',
    '看这个 `\\begin{bmatrix}` 宏'
  ],
  ['code fence is untouched', '```python\nprint(1)\n```', '```python\nprint(1)\n```'],
  ['bare latex line', '\\frac{a}{b} = c', '$$\n\\frac{a}{b} = c\n$$'],
  ['plain math line', 'x = y^2 + 3', '$$\nx = y^2 + 3\n$$'],
  ['prose with equals sign is untouched', '参数 = 3 的时候结果是对的', '参数 = 3 的时候结果是对的'],
  ['bracket delimiters', '\\[x = y\\]', '\n$$\nx = y\n$$\n']
]

let failures = 0
for (const [name, input, expected] of cases) {
  const actual = normalizeMathMarkdown(input)
  if (actual !== expected) {
    failures += 1
    console.error(`FAIL ${name}\n  input:    ${JSON.stringify(input)}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

// Structural guarantees: never leave an unpaired $$ or wrap a Markdown block.
const structural = [
  '### 1.2 引用块\n> **提示**：KaTeX 的 `\\begin{bmatrix}` 宏。',
  '| A | \\(x\\) |\n|:--|:--|',
  '- 列表 \\(a\\)\n- 列表 \\(b\\)',
  '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}',
  '$$\n\\frac{a}{b}\n$$'
]
for (const input of structural) {
  const out = normalizeMathMarkdown(input)
  const dollars = (out.match(/\$\$/g) || []).length
  if (dollars % 2 !== 0) {
    failures += 1
    console.error(`FAIL unbalanced $$ for ${JSON.stringify(input)} -> ${JSON.stringify(out)}`)
  }
  if (/^\$\$\s*\n\s*(#{1,6}\s|>|-)/m.test(out)) {
    failures += 1
    console.error(`FAIL math block wraps markdown for ${JSON.stringify(input)} -> ${JSON.stringify(out)}`)
  }
}

fs.rmSync(outDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`${failures} failure(s)`)
  process.exit(1)
}
console.log('all markdown math cases passed')
