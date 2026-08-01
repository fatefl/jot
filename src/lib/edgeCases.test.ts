// @vitest-environment jsdom
// 边角语法压力测试：每段都是真实世界容易出事的写法，
// 目标是"不抛错、不白屏"（装饰冲突/非法区间在构造时即抛 RangeError）
import { describe, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { livePreview } from "./livePreview";

const CASES: Record<string, string> = {
  未闭合加粗: "这是 **未闭合的加粗\n",
  未闭合链接: "这是 [未闭合链接](https://a.com\n",
  未闭合代码: "这是 `未闭合代码\n",
  只有标记: "**\n*\n~~\n`\n",
  转义全集: "\\* \\_ \\` \\[ \\] \\( \\) \\# \\+ \\- \\. \\! \\| \\\\ \\~\n",
  多级嵌套引用: "> 一\n> > 二\n> > > 三\n",
  引用内列表: "> - a\n> - b\n",
  列表内代码块: "- item\n\n  ```js\n  code\n  ```\n",
  任务列表大小写: "- [X] done\n- [x] done2\n- [ ] todo\n",
  有序乱序: "3. three\n1. one\n9. nine\n",
  空列表项: "- \n- \n",
  表格无对齐: "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
  表格列数不齐: "| a | b |\n| --- | --- |\n| 1 | 2 | 3 | 4 |\n| 5 |\n",
  表格含转义: "| a \\| b | c |\n| --- | --- |\n| 1 | 2 |\n",
  表格内代码含管道: "| a | b |\n| --- | --- |\n| `x | y` | 2 |\n",
  表格后紧跟正文: "| a |\n| --- |\n| 1 |\n下一段\n",
  表格在文末无换行: "| a |\n| --- |\n| 1 |",
  分割线变体: "---\n***\n___\n- - -\n* * *\n",
  标题后紧跟分割线: "# 标题\n---\n",
  Setext变体: "标题\n===\n\n标题二\n---\n",
  图片带标题: '![alt](a.png "标题")\n',
  图片空alt: "![](a.png)\n",
  图片在表格里: "| a |\n| --- |\n| ![i](x.png) |\n",
  裸URL: "访问 https://example.com 和 www.example.com 看\n",
  尖括号自动链接: "<https://example.com> 和 <a@b.com>\n",
  行内HTML: "这是 <span class=\"x\">行内</span> HTML<br>换行\n",
  跨行注释: "<!-- 注释\n跨行 -->\n",
  HTML块: "<div>\n  <p>块级 HTML</p>\n</div>\n",
  链接引用定义: "[ref]: https://example.com \"标题\"\n\n用 [链接][ref] 引用\n",
  上下标: "H~2~O 和 X^2^\n",
  Emoji: ":smile: :+1:\n",
  硬换行反斜杠: "行尾反斜杠\\\n下一行\n",
  硬换行双空格: "行尾双空格  \n下一行\n",
  代码块无语言: "```\nplain\n```\n",
  代码块波浪线: "~~~python\nx = 1\n~~~\n",
  代码块嵌套标记: "```md\n**不是加粗**\n```\n",
  数学符号文本: "价格是 $100 和 $200\n",
  星号乘号: "3 * 4 = 12 和 a*b*c\n",
  下划线词内: "xcore_engine 和 foo_bar_baz\n",
  全角符号: "**中文加粗**、*中文斜体*、`中文代码`\n",
  混合段落: "**粗 *斜* `码` [链](u)~~** 混合 ~~删 **粗**~~\n",
  长行: "很长的行".repeat(200) + "\n",
  空文档: "",
  只有换行: "\n\n\n",
  // ---- 新增边界 ----
  空代码块: "```\n```\n",
  围栏空格后缀: "```js  \ncode\n```  \n",
  三连标记: "***bold-italic***\n",
  双星下划线组合: "**bold** and *italic* and __bold2__ and _italic2_\n",
  链接文本含标记: "[**粗链接**](https://a.com)\n",
  图片路径含编码: "![x](assets/%E4%B8%AD%E6%96%87.png)\n",
  图片路径含空格: "![x](assets/my%20photo.png)\n",
  引用内含代码: "> `code` in quote\n",
  引用内含标题: "> # 标题在引用里\n",
  表格含对齐全部类型: "| L | R | C | D |\n| :--- | ---: | :-: | --- |\n| a | b | c | d |\n",
  多分割线连续: "---\n\n***\n\n___\n",
  列表缩进多层: "- 一级\n  - 二级\n    - 三级\n",
  有序列表含代码: "1. step one\n2. `code` step two\n",
  Setext一级: "Title\n=\n",
  Setext二级: "Title\n-\n",
  作者常用符号: "© 2024 ® ™ — – … 'single' \"double\"\n",
  围栏内嵌空行: "```\nline1\n\nline3\n```\n",
  引用后紧跟正文: "> 引用\n正文无空行\n",
  表格空单元格: "| a |  | c |\n| --- | --- | --- |\n|  | 2 |  |\n",
};

function buildView(doc: string) {
  const view = new EditorView({
    doc,
    parent: document.body,
    extensions: [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      livePreview({ assetBase: "/tmp/notes" }),
      EditorView.lineWrapping,
    ],
  });
  // 触发一次完整更新与重绘
  view.dispatch({});
  return view;
}

describe("边角语法不白屏", () => {
  for (const [name, doc] of Object.entries(CASES)) {
    it(name, () => {
      const view = buildView(doc);
      view.destroy();
    });
  }

  it("组合压力：所有用例拼一个文档", () => {
    const view = buildView(Object.values(CASES).join("\n"));
    view.destroy();
  });
});
