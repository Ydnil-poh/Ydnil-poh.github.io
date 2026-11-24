import { getCollection } from 'astro:content';

// Shared by the RSS feed and the /mobile list so both agree on what is
// public, how it is ordered, and where each record lives.
export const recordSlug = (id) => id.replace(/\.(md|markdown|mdx)$/i, '').toLowerCase();

export async function getPublicRecordsNewestFirst() {
  const records = await getCollection('records', ({ data }) => data.visibility !== 'private');
  return records
    .map((record) => ({
      slug: recordSlug(record.id),
      title: record.data.title,
      date: record.data.date,
      excerpt: record.data.excerpt,
    }))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}
