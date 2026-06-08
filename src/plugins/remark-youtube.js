import { visit } from 'unist-util-visit';

export default function remarkYoutube() {
  return (tree) => {
    visit(tree, 'paragraph', (node) => {
      console.log(JSON.stringify(node, null, 2));
    });
  };
}
