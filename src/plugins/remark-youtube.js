import { visit } from 'unist-util-visit';

export default function remarkYoutube() {
  return (tree) => {
    visit(tree, 'paragraph', (node) => {
      const text = JSON.stringify(node);

      if (text.includes('!youtube')) {
        console.log('FOUND YOUTUBE NODE');
        console.log(JSON.stringify(node, null, 2));
      }
    });
  };
}
