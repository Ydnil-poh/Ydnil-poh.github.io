import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

const posts = defineCollection({
  loader: glob({ base: './src/content/posts', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    location: z.string(),
    excerpt: z.string(),
    tags: z.array(z.string()).default([]),
    cover: z.string().optional(),
    coverAlt: z.string().default('포토에세이 이미지'),
    views: z.number().int().nonnegative().default(0),
    trackbacks: z.number().int().nonnegative().default(0),
  }),
});

export const collections = { posts };
