import rss from '@astrojs/rss';
import { getPublicRecordsNewestFirst } from '../lib/publicRecords.js';

// Bots have been probing for a feed since day one (LivelapBot walked ~30
// guessed feed paths, twice) — this is the standing discovery channel they
// were looking for. Public records only, newest first.
export async function GET(context) {
  const records = await getPublicRecordsNewestFirst();

  return rss({
    title: 'Ydnil-poh Archive Field',
    description: '개인 기록을 의미 기반 지형 위에 배치하는 아카이브 필드',
    site: context.site,
    items: records.map((record) => ({
      title: record.title,
      pubDate: record.date,
      description: record.excerpt,
      link: `/records/${record.slug}/`,
    })),
    customData: '<language>ko</language>',
  });
}
