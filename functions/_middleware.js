// Machine Attention Layer — edge observation point.
//
// Runs on every request served by Cloudflare Pages. Classifies the
// User-Agent into search / crawler / ai / unknown and records the
// observation in Supabase without blocking the response.
//
// Principle (see supabase/archive-schema.sql): store observations, not
// interpretations. The raw User-Agent is always stored; agent/category/
// confidence are derived labels that can be recomputed later.

// Order matters: more specific patterns must precede broader ones
// (e.g. Applebot-Extended before Applebot, Perplexity-User before PerplexityBot).
const KNOWN_AGENTS = [
  // ai — fetches made on behalf of a user's live question.
  { pattern: /ChatGPT-User/i, agent: 'ChatGPT-User', category: 'ai' },
  { pattern: /Claude-User/i, agent: 'Claude-User', category: 'ai' },
  { pattern: /Perplexity-User/i, agent: 'Perplexity-User', category: 'ai' },
  { pattern: /Meta-ExternalFetcher/i, agent: 'Meta-ExternalFetcher', category: 'ai' },
  { pattern: /DuckAssistBot/i, agent: 'DuckAssistBot', category: 'ai' },
  { pattern: /Gemini-Deep-Research/i, agent: 'Gemini-Deep-Research', category: 'ai' },
  { pattern: /Google-NotebookLM/i, agent: 'Google-NotebookLM', category: 'ai' },
  { pattern: /GoogleAgent-Mariner/i, agent: 'GoogleAgent-Mariner', category: 'ai' },
  { pattern: /MistralAI-User/i, agent: 'MistralAI-User', category: 'ai' },

  // preview — link unfurlers acting on a human paste. Not machine interest in
  // the content but the mechanical echo of a human share; observed, not scored.
  // Ordering: kakaotalk-scrap and Blueno (Naver's scraper, observed in
  // machine_events as "facebookexternalhit/1.1 (compatible; Blueno/1.0)")
  // must precede facebookexternalhit, whose token their UAs also carry.
  // TelegramBot precedes Twitterbot (Telegram's UA is literally
  // "TelegramBot (like TwitterBot)").
  { pattern: /kakaotalk-scrap/i, agent: 'KakaoTalk-Scrap', category: 'preview' },
  { pattern: /Blueno/i, agent: 'Naver-Blueno', category: 'preview' },
  { pattern: /facebookexternalhit/i, agent: 'FacebookExternalHit', category: 'preview' },
  { pattern: /TelegramBot/i, agent: 'TelegramBot', category: 'preview' },
  { pattern: /Twitterbot/i, agent: 'Twitterbot', category: 'preview' },
  { pattern: /Slackbot/i, agent: 'Slackbot', category: 'preview' },
  { pattern: /Discordbot/i, agent: 'Discordbot', category: 'preview' },
  { pattern: /LinkedInBot/i, agent: 'LinkedInBot', category: 'preview' },
  { pattern: /WhatsApp/i, agent: 'WhatsApp', category: 'preview' },

  // search — index crawlers, classical and AI search alike.
  { pattern: /OAI-SearchBot/i, agent: 'OAI-SearchBot', category: 'search' },
  { pattern: /Claude-SearchBot/i, agent: 'Claude-SearchBot', category: 'search' },
  { pattern: /PerplexityBot/i, agent: 'PerplexityBot', category: 'search' },
  { pattern: /Googlebot/i, agent: 'Googlebot', category: 'search' },
  { pattern: /bingbot/i, agent: 'Bingbot', category: 'search' },
  { pattern: /DuckDuckBot/i, agent: 'DuckDuckBot', category: 'search' },
  { pattern: /YandexBot/i, agent: 'YandexBot', category: 'search' },
  { pattern: /Baiduspider/i, agent: 'Baiduspider', category: 'search' },
  // Korean engines: Yeti is Naver Search (registered in Search Advisor, so
  // expected imminently), Daumoa is Kakao's Daum. Neither UA carries a
  // bot/crawl token in its name, so without entries they land in unknown.
  { pattern: /Yeti/i, agent: 'Yeti', category: 'search' },
  { pattern: /Daumoa/i, agent: 'Daumoa', category: 'search' },
  // BingPreview renders page snapshots for Bing results (and Copilot rides
  // Bing's index); no bot token, so it needs an explicit entry.
  { pattern: /BingPreview/i, agent: 'BingPreview', category: 'search' },
  { pattern: /Applebot-Extended/i, agent: 'Applebot-Extended', category: 'crawler' },
  { pattern: /Applebot/i, agent: 'Applebot', category: 'search' },

  // crawler — corpus / training collection.
  { pattern: /GPTBot/i, agent: 'GPTBot', category: 'crawler' },
  { pattern: /ClaudeBot/i, agent: 'ClaudeBot', category: 'crawler' },
  { pattern: /CCBot/i, agent: 'CCBot', category: 'crawler' },
  { pattern: /Amazonbot/i, agent: 'Amazonbot', category: 'crawler' },
  { pattern: /Bytespider/i, agent: 'Bytespider', category: 'crawler' },
  { pattern: /Meta-ExternalAgent/i, agent: 'Meta-ExternalAgent', category: 'crawler' },
  { pattern: /Google-CloudVertexBot/i, agent: 'Google-CloudVertexBot', category: 'crawler' },
  { pattern: /cohere-training-data-crawler/i, agent: 'Cohere-Training-Data-Crawler', category: 'crawler' },
  // GoogleOther is Google's shared crawler for non-Search product teams,
  // including AI corpus collection. No "bot" token, so the generic fallback
  // never catches it — it needs an explicit entry.
  { pattern: /GoogleOther/i, agent: 'GoogleOther', category: 'crawler' },
];

const GENERIC_BOT = /bot|crawl|spider|slurp|fetch|scrape/i;

// Static assets carry no per-record attention signal; skip them to keep
// machine_events readable and Supabase writes low.
const ASSET_EXTENSIONS = /\.(css|js|mjs|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|map|mp4|webm)$/i;

export function classify(userAgent) {
  if (!userAgent) return null;
  for (const entry of KNOWN_AGENTS) {
    if (entry.pattern.test(userAgent)) {
      return { agent: entry.agent, category: entry.category, confidence: 0.6 };
    }
  }
  if (GENERIC_BOT.test(userAgent)) {
    return { agent: 'Unknown Bot', category: 'unknown', confidence: 0.3 };
  }
  return null;
}

function recordSlugFromPath(pathname) {
  const match = pathname.match(/^\/(?:posts|records)\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function logMachineEvent(env, request, hit, status) {
  const supabaseUrl = (env.SUPABASE_URL ?? '').replace(/\/$/, '');
  const supabaseKey = env.SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) return;

  const url = new URL(request.url);
  const cf = request.cf ?? {};

  // Cloudflare validates well-known bots against published IP ranges;
  // a verified hit upgrades confidence from "UA string matched" to
  // "UA matched and the source network checks out".
  const verifiedCategory = cf.verifiedBotCategory ?? null;
  const confidence = verifiedCategory ? 1.0 : hit.confidence;

  await fetch(`${supabaseUrl}/rest/v1/rpc/record_machine_event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({
      event_path: url.pathname,
      agent_name: hit.agent,
      agent_category: hit.category,
      agent_confidence: confidence,
      agent_user_agent: request.headers.get('user-agent') ?? '',
      record_slug: recordSlugFromPath(url.pathname),
      event_metadata: {
        status,
        referrer: request.headers.get('referer') ?? '',
        verifiedBotCategory: verifiedCategory,
        country: cf.country ?? null,
        asn: cf.asn ?? null,
      },
    }),
  });
}

export async function onRequest(context) {
  const { request, env, next, waitUntil } = context;
  const response = await next();

  try {
    const pathname = new URL(request.url).pathname;
    if (!ASSET_EXTENSIONS.test(pathname)) {
      let hit = classify(request.headers.get('user-agent'));
      // Safety net for fetchers we have never heard of: Cloudflare verifies
      // well-known bots against published IP ranges independently of the UA
      // string. A verified bot whose UA matches no pattern is still a bot —
      // observe it rather than dropping it, so brand-new AI fetchers appear
      // in machine_events without waiting for a classifier update.
      if (!hit && request.cf?.verifiedBotCategory) {
        hit = { agent: 'Unknown Bot', category: 'unknown', confidence: 0.3 };
      }
      if (hit) {
        waitUntil(logMachineEvent(env, request, hit, response.status).catch(() => {}));
      }
    }
  } catch {
    // Observation must never break serving.
  }

  return response;
}
