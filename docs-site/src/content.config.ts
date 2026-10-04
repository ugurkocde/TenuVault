import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: z.object({
				// Questions and answers in plain text. remark-faq renders them on the page and
				// the Head override emits the same strings as FAQPage structured data.
				faq: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
			}),
		}),
	}),
};
