// @ts-check
import { defineConfig } from 'astro/config';
import remarkYoutube from './src/plugins/remark-youtube.js';

// https://astro.build/config
export default defineConfig({
  site: 'https://ydnil-poh.github.io',
  markdown: {
    remarkPlugins: [remarkYoutube]
  }
});