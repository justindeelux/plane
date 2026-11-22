/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Handle } from "hast-util-to-mdast";
// local imports
import { createTextNode } from "./common";
import { convertHTMLToMarkdown } from "./root";
import type { TCustomComponentsMetaData } from "./types";

const EMPTY_METADATA: TCustomComponentsMetaData = { file_assets: [], user_mentions: [] };

// keep readable placeholders instead of dropping unresolvable custom components
const placeholderHandlers = (metaData: TCustomComponentsMetaData): Record<string, Handle> => {
  const userName = (id: string) => metaData.user_mentions.find((user) => user.id === id)?.display_name;
  return {
    "mention-component": (_state, node) => {
      const props = node.properties ?? {};
      const name = props.entity_name === "user_mention" ? userName(String(props.entity_identifier)) : undefined;
      return createTextNode(`@${name ?? "mention"} `);
    },
    "image-component": (_state, node) => {
      const src = String(node.properties?.src ?? "");
      const asset = metaData.file_assets.find((a) => a.id === src);
      return createTextNode(asset ? `![${asset.name}](${asset.url})` : `[image: ${src}]`);
    },
    // images whose src was stripped (e.g. data: URIs) must not read back as "undefined"
    img: (_state, node) => {
      const src = node.properties?.src;
      const alt = String(node.properties?.alt ?? "");
      return createTextNode(src ? `![${alt || "Image"}](${String(src)})` : alt || "[image]");
    },
    "issue-embed-component": (_state, node) =>
      createTextNode(`[work item ${String(node.properties?.entity_identifier ?? "")}]`),
  };
};

/**
 * @description TipTap HTML -> Markdown. Unresolvable custom components become readable placeholders
 * (see hasLossyHtml to detect when information is lost)
 */
export const htmlToMarkdown = (html: string, metaData: TCustomComponentsMetaData = EMPTY_METADATA): string =>
  convertHTMLToMarkdown({
    description_html: html,
    metaData,
    compactLists: true,
    extraHandlers: placeholderHandlers(metaData),
  }).trim();
