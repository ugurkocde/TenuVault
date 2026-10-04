/**
 * Renders the `faq` frontmatter array as a visible "Frequently asked questions" section, placed
 * before "Related pages" when the page has that heading and at the end otherwise. The Head
 * override emits the same strings as FAQPage JSON-LD, so visible and structured text cannot drift.
 */
export default function remarkFaq() {
	return (tree, file) => {
		const faq = file.data.astro?.frontmatter?.faq;
		if (!Array.isArray(faq) || faq.length === 0) return;

		const text = (value) => [{ type: 'text', value }];
		const nodes = [{ type: 'heading', depth: 2, children: text('Frequently asked questions') }];
		for (const { question, answer } of faq) {
			nodes.push({ type: 'heading', depth: 3, children: text(question) });
			nodes.push({ type: 'paragraph', children: text(answer) });
		}

		const related = tree.children.findIndex(
			(node) =>
				node.type === 'heading' &&
				node.depth === 2 &&
				node.children.length === 1 &&
				node.children[0].value === 'Related pages'
		);
		tree.children.splice(related === -1 ? tree.children.length : related, 0, ...nodes);
	};
}
