import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detectLikelyQuestion,
  findRelatedQuestionSuggestions,
  groupQuestions,
  mergeChatHistory,
  normalizeQuestionText,
  questionIdFor,
  questionPriorityScore,
  sortQuestionsByPriority,
} from '../src/questionTracking.ts'
import type { QuestionMessage } from '../src/questionTracking.ts'
import { questionDetectionDataset } from './questionDetectionDataset.ts'

function message(messageId: string, text: string, chatterName = 'viewer', timestamp = '2026-10-29T12:00:00.000Z'): QuestionMessage {
  return { messageId, text, chatterName, timestamp }
}

test('detects clear questions and common question phrases', () => {
  assert.equal(detectLikelyQuestion('Can you recommend a co-op game?'), true)
  assert.equal(detectLikelyQuestion('What time do streams usually start'), true)
  assert.equal(detectLikelyQuestion('Who won the match'), true)
  assert.equal(detectLikelyQuestion('Does anyone know the stream schedule'), true)
  assert.equal(detectLikelyQuestion('How do I unlock this character'), true)
})

test('does not treat question words inside statements or common exclamations as questions', () => {
  assert.equal(detectLikelyQuestion('That new overlay shows what the alert looks like.'), false)
  assert.equal(detectLikelyQuestion('I wonder how the boss fight ends.'), false)
  assert.equal(detectLikelyQuestion('That is what I meant.'), false)
  assert.equal(detectLikelyQuestion('What a great run!'), false)
  assert.equal(detectLikelyQuestion('How beautiful this scenery is.'), false)
})

test('synthetic Twitch question evaluation exceeds precision and recall targets', () => {
  const scored = questionDetectionDataset.filter((item) => item.expected !== null)
  const truePositive = scored.filter((item) => item.expected && detectLikelyQuestion(item.text)).length
  const falsePositive = scored.filter((item) => item.expected === false && detectLikelyQuestion(item.text)).length
  const falseNegative = scored.filter((item) => item.expected && !detectLikelyQuestion(item.text)).length
  const precision = truePositive / (truePositive + falsePositive)
  const recall = truePositive / (truePositive + falseNegative)
  const f1 = 2 * precision * recall / (precision + recall)
  assert.ok(precision >= 0.9, `precision was ${precision}`)
  assert.ok(recall >= 0.9, `recall was ${recall}`)
  assert.ok(f1 >= 0.9, `F1 was ${f1}`)
  assert.equal(questionDetectionDataset.length - scored.length, 5, 'ambiguous records stay outside binary scoring')
})

test('normalizes capitalization, repeated whitespace, and trailing punctuation', () => {
  assert.equal(normalizeQuestionText('  WHAT   time is the stream?!  '), 'what time is the stream')
  assert.equal(normalizeQuestionText('What time is the stream...'), 'what time is the stream')
  assert.equal(normalizeQuestionText('どこで配信する？'), 'どこで配信する')
})

test('groups exact normalized repeats, counts unique message IDs and authors, and keeps first and last times', () => {
  const messages = [
    message('m-1', 'What time is the stream?', 'Mira', '2026-10-29T12:00:00.000Z'),
    message('m-1', 'What time is the stream?', 'Mira', '2026-10-29T12:00:00.000Z'),
    message('m-2', '  WHAT TIME is the stream!! ', 'Mira', '2026-10-29T12:01:00.000Z'),
    message('m-3', 'What time is the stream?', 'pixelPanda', '2026-10-29T12:02:00.000Z'),
  ]

  const questions = groupQuestions(messages)

  assert.equal(questions.length, 1)
  assert.equal(questions[0].text, 'What time is the stream?')
  assert.deepEqual(questions[0].messageIds, ['m-1', 'm-2', 'm-3'])
  assert.deepEqual(questions[0].authors, ['Mira', 'pixelPanda'])
  assert.equal(questions[0].firstSeenAt, '2026-10-29T12:00:00.000Z')
  assert.equal(questions[0].lastSeenAt, '2026-10-29T12:02:00.000Z')
  assert.equal(questions[0].status, 'unanswered')
})

test('keeps distinct questions in separate stable groups', () => {
  const first = message('m-1', 'Where is the VOD?')
  const second = message('m-2', 'Where is the stream?')
  const questions = groupQuestions([second, first])
  const vod = questions.find((question) => question.text === 'Where is the VOD?')!
  const stream = questions.find((question) => question.text === 'Where is the stream?')!

  assert.equal(vod.text, 'Where is the VOD?')
  assert.equal(stream.text, 'Where is the stream?')
  assert.equal(vod.id, questionIdFor('live', 'where is the vod'))
  assert.notEqual(vod.id, stream.id)
  assert.notEqual(
    groupQuestions([first], {}, 'demo')[0].id,
    groupQuestions([first], {}, 'live')[0].id,
  )
})

test('scopes identical live question groups by broadcaster and stream session', () => {
  const messages = [message('same-message', 'When is the next stream?')]
  const first = groupQuestions(messages, {}, 'live', { broadcasterId: 'broadcaster-a', sessionId: 'session-1' })[0]!
  const nextStream = groupQuestions(messages, {}, 'live', { broadcasterId: 'broadcaster-a', sessionId: 'session-2' })[0]!
  const otherChannel = groupQuestions(messages, {}, 'live', { broadcasterId: 'broadcaster-b', sessionId: 'session-1' })[0]!
  assert.notEqual(first.id, nextStream.id)
  assert.notEqual(first.id, otherChannel.id)
  assert.equal(first.id, groupQuestions(messages, {}, 'live', { broadcasterId: 'broadcaster-a', sessionId: 'session-1' })[0]?.id)
})

test('suggests only conservative schedule paraphrases without merging IDs or crossing sessions', () => {
  const messages = [
    message('m-1', 'When is the next tournament?', 'a'),
    message('m-2', 'Any update on the tournament?', 'b'),
    message('m-3', 'Are you hosting another tournament soon?', 'c'),
    message('m-4', 'Where is the VOD?', 'd'),
    message('m-5', 'Where is the stream?', 'e'),
  ]
  const scope = { broadcasterId: 'broadcaster', sessionId: 'stream-one' }
  const groups = groupQuestions(messages, {}, 'live', scope)
  const links = findRelatedQuestionSuggestions(groups)
  const tournamentQuestions = groups.filter((question) => question.normalizedText.includes('tournament'))
  assert.equal(tournamentQuestions.length, 3, 'canonical groups remain separate')
  assert.ok(tournamentQuestions.every((question) => (links.get(question.id)?.length ?? 0) === 2))
  assert.equal(links.has(groups.find((question) => question.normalizedText.includes('vod'))!.id), false)
  const anotherSession = groupQuestions(messages.slice(0, 3), {}, 'live', { ...scope, sessionId: 'stream-two' })
  assert.equal(findRelatedQuestionSuggestions([...groups, ...anotherSession]).get(tournamentQuestions[0]!.id)?.length, 2)
})

test('synthetic paraphrase suggestions improve pair coverage without changing canonical groups', () => {
  const labeled = questionDetectionDataset.filter((item) => item.expected && item.semanticGroup)
  const messages = labeled.map((item, index) => message(`eval-${index}`, item.text, `viewer-${index}`))
  const groups = groupQuestions(messages, {}, 'demo')
  const labelByNormalizedText = new Map(labeled.map((item) => [normalizeQuestionText(item.text), item.semanticGroup!]))
  const links = findRelatedQuestionSuggestions(groups)
  let goldPairs = 0
  let suggestedPairs = 0
  let truePositivePairs = 0
  for (let first = 0; first < groups.length; first += 1) {
    for (let second = first + 1; second < groups.length; second += 1) {
      const a = groups[first]!
      const b = groups[second]!
      const relatedInTruth = labelByNormalizedText.get(a.normalizedText) === labelByNormalizedText.get(b.normalizedText)
      const suggested = links.get(a.id)?.includes(b.id) ?? false
      if (relatedInTruth) goldPairs += 1
      if (suggested) {
        suggestedPairs += 1
        if (relatedInTruth) truePositivePairs += 1
      }
    }
  }
  const precision = truePositivePairs / suggestedPairs
  const recall = truePositivePairs / goldPairs
  assert.ok(precision >= 0.9, `suggestion precision was ${precision}`)
  assert.ok(recall >= 0.8, `suggestion recall was ${recall}`)
  assert.ok(groups.every((question) => question.id.startsWith('demo:')), 'suggestion layer preserves canonical IDs')
})

test('paraphrase layer improves pairwise recall over exact normalized grouping with no synthetic false merges', () => {
  const scored = questionDetectionDataset.filter((item) => item.expected !== null && item.semanticGroup)
  const questions = groupQuestions(scored.filter((item) => item.expected).map((item, index) => message(`pair-${index}`, item.text)), {}, 'demo')
  const links = findRelatedQuestionSuggestions(questions)
  const groupIdByText = new Map(questions.map((question) => [question.normalizedText, question.id]))
  let goldPairs = 0
  let exactTruePositives = 0
  let suggestionPairs = 0
  let suggestionTruePositives = 0
  for (let first = 0; first < scored.length; first += 1) {
    for (let second = first + 1; second < scored.length; second += 1) {
      const a = scored[first]!
      const b = scored[second]!
      const gold = Boolean(a.expected && b.expected && a.semanticGroup && a.semanticGroup === b.semanticGroup)
      const aText = normalizeQuestionText(a.text)
      const bText = normalizeQuestionText(b.text)
      const exact = Boolean(a.expected && b.expected && aText === bText)
      const aId = groupIdByText.get(aText)
      const bId = groupIdByText.get(bText)
      const suggested = exact || Boolean(aId && bId && links.get(aId)?.includes(bId))
      if (gold) goldPairs += 1
      if (exact && gold) exactTruePositives += 1
      if (suggested) {
        suggestionPairs += 1
        if (gold) suggestionTruePositives += 1
      }
    }
  }
  const baselineRecall = exactTruePositives / goldPairs
  const suggestionPrecision = suggestionTruePositives / suggestionPairs
  const suggestionRecall = suggestionTruePositives / goldPairs
  assert.equal(goldPairs, 12)
  assert.equal(baselineRecall, 1 / 12)
  assert.equal(suggestionPrecision, 1)
  assert.equal(suggestionRecall, 11 / 12)
})

test('ignores empty or malformed records and safely preserves Unicode and long question text', () => {
  const longUnicodeQuestion = `How does this emoji wave work? ${'✨'.repeat(1_000)}`
  const [question] = groupQuestions([
    message('', 'Where is this?'),
    message('bad-time', 'Where is this?', 'viewer', 'not a date'),
    message('unicode', longUnicodeQuestion, '夜空'),
    message('empty', '   '),
  ])

  assert.equal(question.text, longUnicodeQuestion)
  assert.deepEqual(question.authors, ['夜空'])
  assert.equal(question.messageIds.length, 1)
})

test('preserves an answered state when matching messages arrive on later polls', () => {
  const beforeNewMessage = groupQuestions([message('m-1', 'Where is the VOD?')])
  const savedStatuses = { [beforeNewMessage[0].id]: 'answered' as const }
  const afterNewMessage = groupQuestions([
    message('m-1', 'Where is the VOD?'),
    message('m-2', 'WHERE IS THE VOD?!', 'anotherViewer', '2026-10-29T12:01:00.000Z'),
  ], savedStatuses)

  assert.equal(afterNewMessage[0].messageIds.length, 2)
  assert.equal(afterNewMessage[0].status, 'answered')
})

test('priority uses manual adjustments, distinct authors and recency, not repeat count', () => {
  const [oneAuthor] = groupQuestions([
    message('m-1', 'When is the next stream?', 'same-viewer'),
    message('m-2', 'When is the next stream?', 'same-viewer', '2026-10-29T12:01:00.000Z'),
  ])
  const [severalAuthors] = groupQuestions([
    message('m-1', 'When is the next stream?', 'viewer-a'),
    message('m-2', 'When is the next stream?', 'viewer-b', '2026-10-29T12:01:00.000Z'),
  ])
  assert.equal(oneAuthor.messageIds.length, 2)
  assert.equal(oneAuthor.authors.length, 1)
  assert.ok(severalAuthors.priorityScore > oneAuthor.priorityScore)
  assert.ok(questionPriorityScore({ ...oneAuthor, manualPriority: 2 }) > severalAuthors.priorityScore)
})

test('priority ordering has stable tie breaks and does not mutate the input list', () => {
  const [later, earlier] = groupQuestions([
    message('m-2', 'Where is the VOD?', 'viewer', '2026-10-29T12:02:00.000Z'),
    message('m-1', 'Where is the stream?', 'viewer', '2026-10-29T12:01:00.000Z'),
  ])
  const input = [later, earlier]
  const sorted = sortQuestionsByPriority(input)
  assert.deepEqual(sorted.map((question) => question.id), [later.id, earlier.id].sort())
  assert.deepEqual(input, [later, earlier])
})

test('merges overlapping polling history once and keeps messages chronological', () => {
  const firstPoll = [
    message('m-2', 'Second message', 'viewer', '2026-10-29T12:02:00.000Z'),
    message('m-1', 'First message', 'viewer', '2026-10-29T12:01:00.000Z'),
  ]
  const history = mergeChatHistory([], firstPoll)
  const next = mergeChatHistory(history, [
    message('m-3', 'Third message', 'viewer', '2026-10-29T12:03:00.000Z'),
    firstPoll[0],
  ])
  const unchanged = mergeChatHistory(next, [...next].reverse())

  assert.deepEqual(history.map((item) => item.messageId), ['m-1', 'm-2'])
  assert.deepEqual(next.map((item) => item.messageId), ['m-1', 'm-2', 'm-3'])
  assert.equal(unchanged, next)
  assert.deepEqual(mergeChatHistory([], [firstPoll[0], firstPoll[1]], 1).map((item) => item.messageId), ['m-2'])
})
