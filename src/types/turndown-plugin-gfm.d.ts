// turndown-plugin-gfm 未发布官方类型，这里补充最小声明。
// gfm = tables + strikethrough，均注册到 TurndownService。
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function gfm(service: TurndownService): void;
}
