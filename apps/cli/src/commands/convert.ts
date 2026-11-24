/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Command } from "commander";
import { htmlToMarkdown, markdownToHtml } from "@plane/markdown";
import { readText } from "../input";
import { print, run } from "../output";

type Conversion = "markdown-to-html" | "html-to-markdown";

const convert = (action: Conversion) => async (o: { file: string }) => {
  const source = (await readText(undefined, o.file, "--file")) ?? "";
  if (action === "markdown-to-html") {
    const html = markdownToHtml(source);
    print(html, { html });
  } else {
    const markdown = htmlToMarkdown(source);
    print(markdown, { markdown });
  }
};

export const registerConvert = (program: Command) => {
  const g = program.command("convert").description("Convert Markdown and HTML locally (no login needed)");
  g.command("markdown-to-html")
    .description("Convert Markdown to the rich HTML Plane stores")
    .option("--file <path>", "input file (`-` reads stdin)", "-")
    .action(run(convert("markdown-to-html")));
  g.command("html-to-markdown")
    .description("Convert Plane rich HTML to Markdown")
    .option("--file <path>", "input file (`-` reads stdin)", "-")
    .action(run(convert("html-to-markdown")));
};
