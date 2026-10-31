/** Synthetic Twitch-style examples only; this is an evaluation aid, not live-chat data. */
export type QuestionEvaluationCase = {
  text: string
  expected: boolean | null
  category: 'direct' | 'informal' | 'conversational' | 'command' | 'spam' | 'ambiguous' | 'multilingual' | 'url'
  semanticGroup?: string
}

export const questionDetectionDataset: QuestionEvaluationCase[] = [
  { text: 'When is the next tournament?', expected: true, category: 'direct', semanticGroup: 'tournament-timing' },
  { text: 'WHEN is the next tournament?!', expected: true, category: 'informal', semanticGroup: 'tournament-timing' },
  { text: 'Any update on the tournament?', expected: true, category: 'direct', semanticGroup: 'tournament-timing' },
  { text: 'Are you hosting another tournament soon?', expected: true, category: 'direct', semanticGroup: 'tournament-timing' },
  { text: 'gg that was insane', expected: false, category: 'conversational' },
  { text: '!vote 2', expected: false, category: 'command' },
  { text: 'bro what was that play', expected: false, category: 'conversational' },
  { text: 'when next stream', expected: true, category: 'informal', semanticGroup: 'stream-timing' },
  { text: 'Can you explain that strategy?', expected: true, category: 'direct' },
  { text: 'POGGERS', expected: false, category: 'conversational' },
  { text: 'Is this game even real lol', expected: false, category: 'conversational' },
  { text: 'What a play!', expected: false, category: 'conversational' },
  { text: '??????', expected: false, category: 'spam' },
  { text: 'Anyone know the boss weakness', expected: true, category: 'informal' },
  { text: 'Is the boss weak to ice', expected: true, category: 'informal' },
  { text: 'Why is the boss immune?', expected: true, category: 'direct' },
  { text: 'The map looks great; what a run', expected: false, category: 'conversational' },
  { text: 'cuando empieza el torneo', expected: true, category: 'multilingual', semanticGroup: 'tournament-timing' },
  { text: 'Tu joues à quoi ?', expected: true, category: 'multilingual' },
  { text: '次の配信はいつですか', expected: true, category: 'multilingual' },
  { text: 'hello chat how are yall', expected: false, category: 'conversational' },
  { text: '@pixel what build are you using?', expected: null, category: 'ambiguous' },
  { text: "Where's the VOD?", expected: true, category: 'direct' },
  { text: 'This game is hard lol', expected: false, category: 'conversational' },
  { text: 'how do i get that skin', expected: true, category: 'informal' },
  { text: 'what was that lol', expected: null, category: 'ambiguous' },
  { text: 'so we just ignore the objective huh', expected: false, category: 'conversational' },
  { text: 'https://example.com/watch?v=xyz', expected: false, category: 'url' },
  { text: 'Can you open this link? https://example.com/guide', expected: true, category: 'url' },
  { text: 'does anyone know?', expected: null, category: 'ambiguous' },
  { text: 'why', expected: null, category: 'ambiguous' },
  { text: 'Kappa Kappa Kappa', expected: false, category: 'spam' },
  { text: '!uptime', expected: false, category: 'command' },
  { text: 'Could you share a detailed explanation of how this shield interaction works against the final boss?', expected: true, category: 'direct' },
  { text: 'need a healer?', expected: null, category: 'ambiguous' },
  { text: 'is anyone here from Brazil', expected: false, category: 'conversational' },
  { text: 'cuando es la proxima live', expected: true, category: 'multilingual', semanticGroup: 'stream-timing' },
  { text: 'What build is that?', expected: true, category: 'direct', semanticGroup: 'game-build' },
  { text: 'Can you share the build?', expected: true, category: 'direct', semanticGroup: 'game-build' },
  { text: 'Where is the VOD?', expected: true, category: 'direct' },
  { text: 'Where is the stream?', expected: true, category: 'direct' },
]
