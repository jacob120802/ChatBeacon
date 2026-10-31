import test from 'node:test'
import assert from 'node:assert/strict'
import { detectLikelyQuestion, findRelatedQuestionSuggestions, groupQuestions } from '../src/questionTracking.ts'

// Independent synthetic holdout, not used to tune detection rules. Keep failures
// visible in reported metrics rather than rewriting examples to fit the detector.
const holdout: [string, boolean][] = [
  ['hey beacon, which controller is that?', true], ['CAN YOU explain the shortcut', true],
  ['what map is this', true], ['any chance of a tutorial tonight', true],
  ['why did the boss reset', true], ['your mic model?', true],
  ['Will you try co-op tomorrow', true], ['Could we see your settings', true],
  ['stream at 8 again?', true], ['¿cuándo empieza la siguiente partida?', true],
  ['配信はいつですか', true], ['where did you find that armor', true],
  ['is the server open', true], ['can someone tell me the song', true],
  ['how many tries did that take', true], ['any plans for another speedrun', true],
  ['I know how that works now', false], ['What a brilliant finish', false],
  ['how awesome was that run!', false], ['!vote 3', false], ['/me asks why', false],
  ['KEKW???', false], ['https://example.test/clip?id=123', false],
  ['The song is called Where We Go', false], ['what I meant was the left door', false],
  ['That is why I love this stream', false], ['is anyone here from yesterday?', false],
  ['Poggers Poggers', false], ['????????', false], ['gg well played', false],
  ['I wonder if the next update is tomorrow', false], ['When the timer ends we win', false],
]

test('reports frozen synthetic holdout detection and related-wording metrics', (context) => {
  let tp = 0, fp = 0, fn = 0, tn = 0
  for (const [text, expected] of holdout) {
    const actual = detectLikelyQuestion(text)
    if (actual && expected) tp += 1
    else if (actual) fp += 1
    else if (expected) fn += 1
    else tn += 1
  }
  const precision = tp / (tp + fp), recall = tp / (tp + fn)
  context.diagnostic(JSON.stringify({ dataset: 'synthetic-holdout-32', tp, fp, fn, tn, precision, recall, f1: 2 * precision * recall / (precision + recall) }))
  assert.equal(tp + fp + fn + tn, holdout.length)
  assert.ok(precision >= 0.8 && recall >= 0.7, 'Investigate detector regression; do not tune against this holdout')
  const pairs: [string, string, boolean][] = [
    ['When is the next tournament?', 'Are you hosting another tournament soon?', true],
    ['When is the next stream?', 'Will you stream again soon?', true],
    ['When is the next tournament?', 'Which weapon should I use?', false],
    ['When does the stream start?', 'When does the tournament start?', false],
  ]
  let suggestions = 0, correct = 0
  for (const [a, b, related] of pairs) {
    const messages = [a, b].map((text, i) => ({ messageId: String(i), text, chatterName: `viewer${i}`, timestamp: '2026-10-31T10:00:00Z' }))
    const groups = groupQuestions(messages, {}, 'live', { broadcasterId: 'holdout', sessionId: 'holdout' })
    assert.equal(groups.length, 2, 'Related wording must never merge canonical questions')
    if (findRelatedQuestionSuggestions(groups).size) { suggestions += 1; if (related) correct += 1 }
  }
  context.diagnostic(JSON.stringify({ relatedPairs: pairs.length, suggestions, correct, precision: suggestions ? correct / suggestions : null, canonicalFalseMerges: 0 }))
  assert.equal(correct, suggestions)
})
