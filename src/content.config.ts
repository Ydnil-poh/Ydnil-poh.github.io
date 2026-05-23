import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

const records = defineCollection({
  loader: glob({ base: './src/content/records', pattern: '**/*.{md,markdown,mdx}' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    location: z.string(),
    excerpt: z.string(),
    tags: z.array(z.string()).default([]),
    cover: z.string().optional(),
    coverAlt: z.string().default('archive image'),
    type: z.enum(['writing', 'image', 'place', 'idea', 'note']).default('writing'),
    visibility: z.enum(['public', 'private']).default('public'),
    manualCluster: z.number().int().nonnegative().optional(),
    manualScore: z.number().nonnegative().optional(),
    source: z.string().optional(),
    views: z.number().int().nonnegative().default(0),
  }),
});

export const collections = { records };
