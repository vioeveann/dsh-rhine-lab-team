/**
 * 晋升感言：人设里写了就抄原文，没写就用固定一句。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SPEECH, SPEECH_MAX, extractPersonaSpeech, personaHasSpeech } from '../host/speech.js'

test('没人设时用固定文案', () => {
  assert.equal(DEFAULT_SPEECH, '感谢您的支持与鼓励，我会继续努力做得更好！')
})

test('人设里有没有写感言，按「晋升感言」四个字认', () => {
  assert.equal(personaHasSpeech('我是审计员，只挑问题。'), false)
  assert.equal(personaHasSpeech('晋升感言：就说一句「我记着」。'), true)
})

test('一行式：冒号后面的原样抄出来', () => {
  const soul = '# Nova · 灵魂\n\n我是研究员。\n\n晋升感言：谢谢博士，我接着把页码核到底。\n'
  assert.equal(extractPersonaSpeech(soul), '谢谢博士，我接着把页码核到底。')
})

test('小标题式：标题下面那几行拼起来', () => {
  const soul = [
    '# Nova · 灵魂',
    '',
    '## 晋升感言',
    '谢谢博士。',
    '接下来我只做一件事：每份材料都标到页。',
    '',
    '## 别的',
    '这一行不该被抄进去。',
  ].join('\n')
  assert.equal(extractPersonaSpeech(soul), '谢谢博士。 接下来我只做一件事：每份材料都标到页。')
})

test('整体裹了引号就剥掉，但不改里面的字', () => {
  assert.equal(extractPersonaSpeech('晋升感言：“往下走一步。”'), '往下走一步。')
  assert.equal(extractPersonaSpeech('晋升感言：「我记着这句。」'), '我记着这句。')
})

test('没有效内容时返回空串，调用方会退回固定文案', () => {
  assert.equal(extractPersonaSpeech(''), '')
  assert.equal(extractPersonaSpeech('我是审计员。'), '')
  assert.equal(extractPersonaSpeech('## 晋升感言\n\n下一节\n'), '')
  assert.equal(extractPersonaSpeech(null), '')
})

test('太长的感言会截到上限', () => {
  const soul = '晋升感言：' + '字'.repeat(SPEECH_MAX + 80)
  assert.equal(extractPersonaSpeech(soul).length, SPEECH_MAX)
})

test('按阶段取：升一阶只抄一阶那句，升二阶只抄二阶那句', () => {
  const soul = [
    '晋升感言：',
    '普通晋升到精英化一阶：一阶要说的话。',
    '精英化一阶晋升到精英化二阶：二阶要说的话。',
  ].join('\n')
  assert.equal(extractPersonaSpeech(soul, 1), '一阶要说的话。')
  assert.equal(extractPersonaSpeech(soul, 2), '二阶要说的话。')
  // 只给了一行、没有阶段标注：任意阶段都用它
  assert.equal(extractPersonaSpeech('晋升感言：通用的一句。', 2), '通用的一句。')
  // 空模板：这一阶没写就返回空串，调用方退回固定文案
  const blank = ['晋升感言：', '普通晋升到精英化一阶：', '精英化一阶晋升到精英化二阶：'].join('\n')
  assert.equal(extractPersonaSpeech(blank, 2), '')
})

test('短阶段标签：升一阶只抄一阶，升二阶只抄二阶，标签不带进去', () => {
  const soul = [
    '# 缪尔赛思 · 灵魂',
    '',
    '晋升感言（用户自行填写，会在晋升时展示）：',
    '精英化一阶：你赠送的礼物，我一定会好好保存的，作为回报，就一起去影院吧。',
    '精英化二阶：露水会被蒸腾，其中的一切都将消失不见。我还有机会见到天降雨露，重新与同胞聚首相认吗？',
    '',
    '一、一句话',
    '莱茵生命生态科主任。',
  ].join('\n')
  assert.equal(
    extractPersonaSpeech(soul, 1),
    '你赠送的礼物，我一定会好好保存的，作为回报，就一起去影院吧。',
  )
  assert.equal(
    extractPersonaSpeech(soul, 2),
    '露水会被蒸腾，其中的一切都将消失不见。我还有机会见到天降雨露，重新与同胞聚首相认吗？',
  )
})

test('短阶段标签空着时返回空串，不会把另一阶的感言顶上来', () => {
  const soul = [
    '晋升感言（用户自行填写，会在晋升时展示）：',
    '精英化一阶：',
    '精英化二阶：二阶才写的话。',
  ].join('\n')
  assert.equal(extractPersonaSpeech(soul, 1), '')
  assert.equal(extractPersonaSpeech(soul, 2), '二阶才写的话。')
})

test('短标签下面隔空行写的整段感言也能读出来', () => {
  const soul = [
    '晋升感言：',
    '精英化一阶：',
    '',
    '第一段。',
    '第二段。',
    '',
    '精英化二阶：二阶的话。',
  ].join('\n')
  assert.equal(extractPersonaSpeech(soul, 1), '第一段。\n第二段。')
  assert.equal(extractPersonaSpeech(soul, 2), '二阶的话。')
})

test('带说明的抬头不会被当成感言；空模板读出空串', () => {
  const blank = [
    '晋升感言（在下方填写，在晋升时候会体现）：',
    '普通晋升到精英化一阶：',
    '精英化一阶晋升到精英化二阶：',
  ].join('\n')
  assert.equal(extractPersonaSpeech(blank, 1), '')
  assert.equal(extractPersonaSpeech(blank, 2), '')
  // 抬头带说明、下面直接写一句（没有阶段标签）
  assert.equal(extractPersonaSpeech('晋升感言（在下方填写，在晋升时候会体现）：谢谢博士。', 1), '谢谢博士。')
})
