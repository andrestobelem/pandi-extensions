import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

import { escapeHtml, safeRelativeHref } from "./safe-html.js";

function safeMarkdownHref(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const href = raw.trim();
	if (!href) return undefined;
	if (href.startsWith("#")) {
		return /^#[A-Za-z0-9_-]+$/.test(href) ? href : undefined;
	}
	if (href.startsWith("//")) return undefined;
	return safeRelativeHref(href);
}

const markdown = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		html(token) {
			return escapeHtml(token.text);
		},
		image(token) {
			return `<span class="md-image-alt">[image: ${escapeHtml(token.text)}]</span>`;
		},
	},
});

function sanitizeRenderedMarkdown(html: string): string {
	return sanitizeHtml(html, {
		allowedTags: [
			"p",
			"br",
			"strong",
			"em",
			"del",
			"code",
			"pre",
			"blockquote",
			"ul",
			"ol",
			"li",
			"table",
			"thead",
			"tbody",
			"tr",
			"th",
			"td",
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"h6",
			"a",
			"span",
		],
		allowedAttributes: {
			a: ["href", "title"],
			code: ["class"],
			span: ["class"],
		},
		allowedClasses: {
			code: [/^language-[A-Za-z0-9_-]+$/],
			span: ["md-image-alt", "md-link-text"],
		},
		allowedSchemes: [],
		allowProtocolRelative: false,
		disallowedTagsMode: "discard",
		transformTags: {
			a: (tagName, attribs) => {
				const href = safeMarkdownHref(attribs.href);
				if (!href) return { tagName: "span", attribs: { class: "md-link-text" } };
				const safeAttribs: Record<string, string> = { href };
				if (attribs.title) safeAttribs.title = attribs.title;
				return { tagName, attribs: safeAttribs };
			},
		},
	});
}

export function renderRunReportMarkdown(source: string): string {
	const rendered = markdown.parse(source, { async: false });
	return sanitizeRenderedMarkdown(typeof rendered === "string" ? rendered : String(rendered));
}
