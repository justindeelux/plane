/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Element, Root } from "hast";
import rehypeParse from "rehype-parse";
import { unified } from "unified";

// data-type values TipTap uses for constructs Markdown cannot express
const LOSSY_DATA_TYPES = new Set(["calloutComponent", "issue-embed-component"]);
const LOSSY_TAGS = new Set(["u", "sub", "sup", "mark", "iframe", "details", "summary", "video", "audio"]);

export const isLossyElement = (node: Element): boolean => {
  const props = node.properties ?? {};
  // custom components (mention-component, image-component, callout, embeds...) are the only hyphenated tags
  if (node.tagName.includes("-") && node.tagName !== "image-component") return true;
  if (LOSSY_TAGS.has(node.tagName)) return true;
  if (typeof props["dataType"] === "string" && LOSSY_DATA_TYPES.has(props["dataType"])) return true;
  const style = typeof props.style === "string" ? props.style : "";
  if (/(^|;)\s*(color|background(-color)?|text-align)\s*:/i.test(style)) return true;
  return (
    props["dataBackgroundColor"] !== undefined ||
    props["dataTextColor"] !== undefined ||
    props["dataColor"] !== undefined
  );
};

/**
 * @description true when the HTML has constructs (underline, colors, mentions, callouts, embeds, custom
 * components) that would be flattened by an HTML -> Markdown -> HTML round trip
 */
export const hasLossyHtml = (html: string): boolean => {
  const tree = unified().use(rehypeParse, { fragment: true }).parse(html) as Root;
  const walk = (node: Root | Element): boolean =>
    node.children.some((child) => child.type === "element" && (isLossyElement(child) || walk(child)));
  return walk(tree);
};
