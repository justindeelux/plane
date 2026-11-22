/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { hasLossyHtml, htmlToMarkdown, markdownToHtml } from "./index";

const TASK_HTML =
  '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li></ul>';

describe("markdownToHtml", () => {
  it("emits TipTap task list structure", () => {
    const html = markdownToHtml("* [x] done\n* [ ] todo");
    expect(html).toMatchInlineSnapshot(
      `"<ul data-type="taskList">\n<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked /><span></span></label><div><p>done</p></div></li>\n<li data-type="taskItem" data-checked="false"><label><input type="checkbox" /><span></span></label><div><p>todo</p></div></li>\n</ul>"`
    );
  });

  it("keeps nested lists inside task items", () => {
    const html = markdownToHtml("* [ ] a\n  * [x] b");
    expect(html).toContain('<div><p>a</p><ul data-type="taskList">');
    expect(html).toContain('data-checked="true"');
  });

  it("emits code block language, tables, images", () => {
    expect(markdownToHtml("```ts\nconst a = 1;\n```")).toContain('<pre><code class="language-ts">');
    expect(markdownToHtml("|a|b|\n|-|-|\n|1|2|")).toContain("<table>");
    expect(markdownToHtml("![alt](https://x.io/a.png)")).toContain('<img src="https://x.io/a.png" alt="alt" />');
  });

  it("sanitizes scripts and js: links", () => {
    const html = markdownToHtml("<script>alert(1)</script>\n\n[x](javascript:alert(1))");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });
});

describe("round trip md -> html -> md", () => {
  const fixtures = [
    "# Title\n\nSome **bold**, _italic_, ~~strike~~ and `code`.",
    "* a\n* b\n  * nested",
    "1. one\n2. two",
    "* [x] done\n* [ ] todo",
    "> quote",
    "```ts\nconst a = 1;\n```",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "[link](https://example.com)",
    "![alt](https://example.com/a.png)",
  ];
  it.each(fixtures)("is stable: %s", (md) => {
    expect(htmlToMarkdown(markdownToHtml(md))).toBe(md);
  });
});

describe("htmlToMarkdown (TipTap fixtures)", () => {
  it("task lists", () => expect(htmlToMarkdown(TASK_HTML)).toBe("* [x] done\n* [ ] todo"));
  it("nested lists", () =>
    expect(htmlToMarkdown("<ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul>")).toBe("* a\n  * b"));
  it("code blocks", () =>
    expect(htmlToMarkdown('<pre><code class="language-js">let a;</code></pre>')).toBe("```js\nlet a;\n```"));
  it("tables", () =>
    expect(htmlToMarkdown("<table><tbody><tr><th><p>a</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>")).toBe(
      "| a |\n| - |\n| 1 |"
    ));
});

describe("fix round 1", () => {
  it("keeps multi-paragraph list items as separate blocks", () => {
    const md = htmlToMarkdown("<ul><li><p>a</p><p>para</p></li></ul>");
    expect(md).not.toContain("a para");
    expect(md).toMatch(/a\n\n\s+para/);
  });
  it("converts ordered task lists to a taskList ul", () => {
    const html = markdownToHtml("1. [x] a\n2. [ ] b");
    expect(html).toContain('<ul data-type="taskList">');
    expect(html).not.toContain("<ol");
    expect(html.match(/data-type="taskItem"/g)).toHaveLength(2);
  });
  it("falls back to alt text when an image src is stripped", () => {
    const md = htmlToMarkdown(markdownToHtml("![a](data:image/png;base64,AAAA)"));
    expect(md).toBe("a");
    expect(md).not.toContain("undefined");
    expect(htmlToMarkdown("<p><img></p>")).toBe("[image]");
  });
});

describe("lossy HTML", () => {
  it("keeps text for underline/color", () => {
    expect(htmlToMarkdown('<p><u>under</u> <span style="color: red">red</span></p>')).toBe("under red");
  });
  it("keeps a placeholder for mentions and embeds", () => {
    const md = htmlToMarkdown(
      '<p>hi <mention-component entity_name="user_mention" entity_identifier="1"></mention-component></p>'
    );
    expect(md).toContain("@mention");
    expect(htmlToMarkdown('<issue-embed-component entity_identifier="abc"></issue-embed-component>')).toBe(
      "[work item abc]"
    );
  });
  it("hasLossyHtml", () => {
    for (const html of [
      "<p><u>x</u></p>",
      '<p><span style="color: red">x</span></p>',
      '<mention-component entity_name="user_mention"></mention-component>',
      '<div data-type="calloutComponent"><p>x</p></div>',
      '<issue-embed-component entity_identifier="a"></issue-embed-component>',
    ])
      expect(hasLossyHtml(html), html).toBe(true);
    for (const html of [TASK_HTML, "<p>a <strong>b</strong></p>", '<pre><code class="language-js">x</code></pre>'])
      expect(hasLossyHtml(html), html).toBe(false);
  });
});
