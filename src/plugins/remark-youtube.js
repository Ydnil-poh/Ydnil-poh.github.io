import { visit } from 'unist-util-visit';

const YOUTUBE_RE = /^!youtube\s+(?:https?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/watch\?v=)([\w-]+)/;

export default function remarkYoutube() {
  return (tree) => {
    visit(tree, 'paragraph', (node) => {
      const text = node.children?.[0]?.value;
      if (!text) return;

      const match = text.match(YOUTUBE_RE);
      if (!match) return;

      node.type = 'html';
      node.value = `<YouTubeEmbed videoId="${match[1]}" />`;
    });
  };
}
