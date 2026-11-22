/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Element, ElementContent, Root } from "hast";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import sanitizeHtml from "sanitize-html";
import { unified } from "unified";

const isTaskInput = (node: ElementContent): node is Element =>
  node.type === "element" && node.tagName === "input" && node.properties?.type === "checkbox";

const BLOCK_TAGS = new Set(["p", "ul", "ol", "pre", "blockquote", "table", "h1", "h2", "h3", "h4", "h5", "h6", "hr"]);

const hasClass = (node: Element, name: string) =>
  Array.isArray(node.properties?.className) && node.properties.className.includes(name);

// remark-rehype emits GFM task lists; rewrite them to the structure TipTap parses:
// <ul data-type="taskList"><li data-type="taskItem" data-checked><label><input><span></span></label><div><p>..</p></div></li></ul>
const toTipTapTaskLists = () => (tree: Root) => {
  const visit = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      visit(child);
      if ((child.tagName === "ul" || child.tagName === "ol") && hasClass(child, "contains-task-list")) {
        // taskItem only exists inside a taskList, so ordered task lists become bullet task lists
        child.tagName = "ul";
        child.properties = { dataType: "taskList" };
      } else if (child.tagName === "li" && hasClass(child, "task-list-item")) {
        // loose items nest the checkbox inside the first <p>
        const first = child.children.find((c): c is Element => c.type === "element" && c.tagName === "p");
        const holder = child.children.some(isTaskInput) ? child : (first ?? child);
        const input = holder.children.find(isTaskInput);
        const checked = Boolean(input?.properties?.checked);
        holder.children = holder.children.filter((c) => c !== input);
        const content: ElementContent[] = [];
        let run: ElementContent[] = [];
        const flush = () => {
          const text = run.filter((c) => !(c.type === "text" && !c.value.trim()));
          if (text.length) content.push({ type: "element", tagName: "p", properties: {}, children: run });
          run = [];
        };
        for (const c of child.children) {
          if (c.type === "element" && BLOCK_TAGS.has(c.tagName)) {
            flush();
            content.push(c);
          } else if (!(c.type === "text" && !c.value.trim())) {
            run.push(c.type === "text" ? { ...c, value: run.length ? c.value : c.value.replace(/^\s+/, "") } : c);
          }
        }
        flush();
        child.properties = { dataType: "taskItem", dataChecked: checked ? "true" : "false" };
        child.children = [
          {
            type: "element",
            tagName: "label",
            properties: {},
            children: [
              { type: "element", tagName: "input", properties: { type: "checkbox", checked }, children: [] },
              { type: "element", tagName: "span", properties: {}, children: [] },
            ],
          },
          { type: "element", tagName: "div", properties: {}, children: content },
        ];
      }
    }
  };
  visit(tree);
};

// ponytail: the web app has no shared sanitize-html config (it only uses it to strip tags), so this is
// the library default allow-list plus the TipTap constructs we emit; tighten here if the server rules change.
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "input", "label", "span", "del", "s"],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    "*": ["data-type", "data-checked"],
    img: ["src", "alt", "title"],
    input: ["type", "checked"],
    th: ["align"],
    td: ["align"],
  },
  allowedClasses: { code: ["language-*"] },
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(toTipTapTaskLists)
  .use(rehypeStringify);

/**
 * @description Markdown -> sanitized TipTap-compatible HTML (task lists, code blocks, tables, ...)
 */
export const markdownToHtml = (markdown: string): string =>
  sanitizeHtml(String(processor.processSync(markdown)), SANITIZE_OPTIONS);
