import { Panel } from "@codemirror/view";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView } from "@codemirror/view";

/** 中文搜索 + 替换面板，替换默认英文面板 */
export function createChineseSearchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "jot-search-panel";

  // ── DOM 结构 ──────────────────────────────────────────
  dom.innerHTML = `
    <div class="jot-search-row">
      <input class="jot-search-input" type="text" placeholder="查找…" autofocus>
      <span class="jot-search-count"></span>
      <button class="jot-search-btn" data-action="prev" title="上一个 (Shift+Enter)">◂</button>
      <button class="jot-search-btn" data-action="next" title="下一个 (Enter)">▸</button>
      <label class="jot-search-check"><input type="checkbox" data-opt="case">Aa</label>
      <label class="jot-search-check"><input type="checkbox" data-opt="word">Ab</label>
      <label class="jot-search-check"><input type="checkbox" data-opt="regex">.*</label>
      <button class="jot-search-btn jot-search-toggle" data-action="toggle" title="替换">↔</button>
      <button class="jot-search-btn jot-search-close" data-action="close" title="关闭 (Escape)">✕</button>
    </div>
    <div class="jot-search-replace-row" hidden>
      <input class="jot-search-input jot-replace-input" type="text" placeholder="替换为…">
      <button class="jot-search-btn jot-replace-btn" data-action="replace">替换</button>
      <button class="jot-search-btn jot-replace-btn" data-action="replaceAll">全部替换</button>
    </div>
  `;

  // ── 元素引用 ──────────────────────────────────────────
  const input = dom.querySelector(".jot-search-input") as HTMLInputElement;
  const replaceRow = dom.querySelector(".jot-search-replace-row") as HTMLDivElement;
  const replaceInput = dom.querySelector(".jot-replace-input") as HTMLInputElement;
  const toggleBtn = dom.querySelector(".jot-search-toggle") as HTMLButtonElement;
  const countEl = dom.querySelector(".jot-search-count") as HTMLSpanElement;
  const caseCb = dom.querySelector('[data-opt="case"]') as HTMLInputElement;
  const wordCb = dom.querySelector('[data-opt="word"]') as HTMLInputElement;
  const regexCb = dom.querySelector('[data-opt="regex"]') as HTMLInputElement;

  // ── 匹配计数 ──────────────────────────────────────────
  function updateCount() {
    const q = getSearchQuery(view.state);
    if (!q.valid || !q.search) {
      countEl.textContent = "";
      return;
    }
    let count = 0;
    const doc = view.state.doc.toString();
    if (q.regexp) {
      try {
        const re = new RegExp(q.search, q.caseSensitive ? "g" : "gi");
        count = (doc.match(re) || []).length;
      } catch { /* 非法正则不计 */ }
    } else {
      const needle = q.caseSensitive ? q.search : q.search.toLowerCase();
      const haystack = q.caseSensitive ? doc : doc.toLowerCase();
      if (q.wholeWord) {
        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(
          `\\b${escaped}\\b`,
          q.caseSensitive ? "g" : "gi",
        );
        count = (haystack.match(re) || []).length;
      } else {
        let idx = 0;
        while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx++; }
      }
    }
    countEl.textContent = count > 0 ? `${count} 个匹配` : "无匹配";
  }

  // ── 面板 ← SearchQuery ───────────────────────────────
  function syncFromQuery() {
    const q = getSearchQuery(view.state);
    if (input.value !== q.search) input.value = q.search;
    if (replaceInput.value !== q.replace) replaceInput.value = q.replace;
    caseCb.checked = q.caseSensitive;
    wordCb.checked = q.wholeWord;
    regexCb.checked = q.regexp;
    updateCount();
  }

  // ── 面板 → SearchQuery ───────────────────────────────
  function applyQuery() {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: input.value,
          caseSensitive: caseCb.checked,
          wholeWord: wordCb.checked,
          regexp: regexCb.checked,
          replace: replaceInput.value,
        }),
      ),
    });
    updateCount();
  }

  // ── 替换 ──────────────────────────────────────────────
  function doReplace() { replaceNext(view); updateCount(); }
  function doReplaceAll() { replaceAll(view); updateCount(); }

  // ── 事件绑定 ──────────────────────────────────────────
  input.addEventListener("input", applyQuery);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // 替换行可见时 Enter 执行替换；否则查找下一个
      if (replaceRow.hidden) {
        e.shiftKey ? findPrevious(view) : findNext(view);
      } else {
        e.shiftKey ? findPrevious(view) : replaceNext(view);
      }
      updateCount();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
    }
  });

  replaceInput.addEventListener("input", applyQuery);
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceNext(view);
      updateCount();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
    }
  });

  dom.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "prev") findPrevious(view);
      else if (action === "next") findNext(view);
      else if (action === "replace") replaceNext(view);
      else if (action === "replaceAll") replaceAll(view);
      else if (action === "close") closeSearchPanel(view);
      else if (action === "toggle") {
        replaceRow.hidden = !replaceRow.hidden;
        toggleBtn.classList.toggle("active", !replaceRow.hidden);
        if (!replaceRow.hidden) replaceInput.focus();
        applyQuery(); // 打开替换时把 replace 字段写进 SearchQuery
      }
      updateCount();
    });
  });

  caseCb.addEventListener("change", applyQuery);
  wordCb.addEventListener("change", applyQuery);
  regexCb.addEventListener("change", applyQuery);

  return {
    dom,
    mount() {
      input.focus();
      input.select();
    },
    update() {
      syncFromQuery();
    },
  };
}
