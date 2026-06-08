import { visit } from 'unist-util-visit';

export default function remarkYoutube() {
  return (tree) => {
    visit(tree, 'paragraph', (node, index, parent) => {
      if (!parent || !node.children?.length) return;

      const first = node.children[0];

      if (
        first.type !== 'text' ||
        !first.value.trim().startsWith('!youtube')
      ) {
        return;
      }

      const link = node.children.find(
        (child) => child.type === 'link'
      );

      if (!link?.url) return;

      const match = link.url.match(
        /(?:youtu\.be\/|youtube\.com\/watch\?v=)([^?&/]+)/
      );

      if (!match) return;

      const videoId = match[1];

      parent.children[index] = {
        type: 'html',
        value: `
<div class="youtube-embed">
  <iframe
    src="https://www.youtube.com/embed/${videoId}"
    title="YouTube video"
    loading="lazy"
    allowfullscreen>
  </iframe>
</div>`
      };
    });
  };
}
