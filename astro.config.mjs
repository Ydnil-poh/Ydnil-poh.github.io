// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import remarkYoutube from './src/plugins/remark-youtube.js';

export default defineConfig({
  site: 'https://ydnil-poh.pages.dev',

  integrations: [
    // /posts/ pages are legacy redirects to /records/; listing them doubles
    // every crawler's pass over the archive for no benefit.
    sitemap({ filter: (page) => !page.includes('/posts/') })
  ],

  markdown: {
    remarkPlugins: [remarkYoutube]
  }
});
