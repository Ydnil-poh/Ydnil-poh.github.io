import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

// Bots have been probing for a feed since day one (LivelapBot walked ~30
// guessed feed paths, twice) — this is the standing discovery channel they
// were looking for. Public records only, newest first.
export async function GET(context) {
  const records = await getCollection('records', ({ data }) => data.visibility !== 'private');
  const sorted = [...records].sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

  return rss({
    title: 'Ydnil-poh Archive Field',
    description: '개인 기록을 의미 기반 지형 위에 배치하는 아카이브 필드',
    site: context.site,
    items: sorted.map((record) => {
      const slug = record.id.replace(/\.(md|markdown|mdx)$/i, '').toLowerCase();
      return {
        title: record.data.title,
        pubDate: record.data.date,
        description: record.data.excerpt,
        link: `/records/${slug}/`,
      };
    }),
    customData: '<language>ko</language>',
  });
}
