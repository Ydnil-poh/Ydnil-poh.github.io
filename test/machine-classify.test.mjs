import assert from 'node:assert/strict';
import test from 'node:test';

import { classify } from '../functions/_middleware.js';

// User-Agent strings below are taken verbatim from observed machine_events rows.

test('preview unfurlers classify as preview, not unknown', () => {
  assert.deepEqual(classify('Twitterbot/1.0'), { agent: 'Twitterbot', category: 'preview', confidence: 0.6 });
  assert.equal(classify('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)').category, 'preview');
  assert.equal(classify('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)').category, 'preview');
  assert.equal(classify('TelegramBot (like TwitterBot)').agent, 'TelegramBot');
  assert.equal(classify('LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)').category, 'preview');
  assert.equal(classify('WhatsApp/2.23.20.0').category, 'preview');
});

test('KakaoTalk scrap wins over the facebookexternalhit token in its own UA', () => {
  const hit = classify('facebookexternalhit/1.1; kakaotalk-scrap/1.0; +https://devtalk.kakao.com/t/scrap/33984');
  assert.equal(hit.agent, 'KakaoTalk-Scrap');
  assert.equal(hit.category, 'preview');
  assert.equal(classify('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)').agent, 'FacebookExternalHit');
});

test('existing categories are unaffected by the preview group', () => {
  assert.equal(classify('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)').category, 'crawler');
  assert.equal(classify('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)').category, 'ai');
  assert.equal(classify('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').category, 'search');
});

test('generic bots and plain browsers keep their fallback behavior', () => {
  const sleepBot = classify('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; SleepBot/1.0; +http://sleepbot.com/) Chrome/131.0.0.0 Safari/537.36');
  assert.equal(sleepBot.category, 'unknown');
  assert.equal(sleepBot.confidence, 0.3);
  assert.equal(classify('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'), null);
  assert.equal(classify(''), null);
});

test('Naver Blueno wins over the facebookexternalhit token in its own UA', () => {
  // UA taken verbatim from an observed machine_events row (post19 share)
  const hit = classify('facebookexternalhit/1.1 (compatible; Blueno/1.0; +https://naver.me/scrap)');
  assert.equal(hit.agent, 'Naver-Blueno');
  assert.equal(hit.category, 'preview');
});

test('Korean search engines and BingPreview classify as search, not unknown', () => {
  assert.equal(classify('Yeti/1.1 (Naver Corp.; +http://help.naver.com/robots/)').agent, 'Yeti');
  assert.equal(classify('Yeti/1.1 (Naver Corp.; +http://help.naver.com/robots/)').category, 'search');
  assert.equal(classify('Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Daumoa/4.0)').category, 'search');
  assert.equal(classify('Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/534+ (KHTML, like Gecko) BingPreview/1.0b').agent, 'BingPreview');
});

test('Mistral user fetcher scores as ai, Cohere training crawler observes only', () => {
  assert.equal(classify('Mozilla/5.0 (compatible; MistralAI-User/1.0; +https://mistral.ai/bot)').category, 'ai');
  assert.equal(classify('Mozilla/5.0 (compatible; cohere-training-data-crawler/1.0; +https://cohere.com)').category, 'crawler');
});

test('Gemini-side fetchers classify as ai, GoogleOther as crawler', () => {
  assert.equal(classify('Mozilla/5.0 (compatible; Gemini-Deep-Research; +https://gemini.google.com)').category, 'ai');
  assert.equal(classify('Mozilla/5.0 (compatible; Google-NotebookLM; +https://notebooklm.google.com)').category, 'ai');
  assert.equal(classify('Mozilla/5.0 (compatible; GoogleAgent-Mariner; +https://google.com)').category, 'ai');
  assert.equal(classify('GoogleOther').category, 'crawler');
  // Googlebot stays search — the new Google entries must not shadow it
  assert.equal(classify('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').category, 'search');
  assert.equal(classify('Google-CloudVertexBot').category, 'crawler');
});

test('newly observed search and AI crawlers classify correctly without scoring', () => {
  assert.equal(classify('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; KeenableBot/1.0; +https://keenable.ai/bot)').category, 'search');
  assert.equal(classify('Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai/)').category, 'search');
  assert.equal(classify('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ShapBot/0.1.0').category, 'search');
  assert.equal(classify('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Reflectionbot/1.0; +https://reflection.ai/bot) Chrome/151.0.0.0 Safari/537.36').category, 'crawler');
  assert.equal(classify('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app) Chrome/W.X.Y.Z Safari/537.36').category, 'preview');
  assert.equal(classify('AgentTrustBot/1.0 (id=84966d45bf44; +https://agenttru.st/crawler; purpose=AI agent directory; contact=admin@agenttru.st)').category, 'crawler');
});
