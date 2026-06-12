import { glob } from 'astro/loaders';
import { defineCollection, z } from 'astro:content';

const records = defineCollection({
  loader: glob({ base: './src/content/records', pattern: '**/*.{md,markdown,mdx}' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    location: z.string().optional().default(''),
    excerpt: z.string(),
    type: z.enum(['standard', 'mediaRail']).default('standard'),
    visibility: z.enum(['public', 'private']).default('public'),
    semanticScore: z.number().min(0).max(1).optional(),
    tags: z.array(z.string()).optional().default([]),
    source: z.string().optional(),
  }),
});

export const collections = { records };
