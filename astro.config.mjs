// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import remarkYoutube from './src/plugins/remark-youtube.js';

export default defineConfig({
  site: 'https://ydnil-poh.pages.dev',

  integrations: [
    sitemap()
  ],

  markdown: {
    remarkPlugins: [remarkYoutube]
  }
});
