// the markdown-it plugins ship no types; each is a plain (md) => void.
declare module "markdown-it-footnote" {
  const plugin: (md: import("markdown-it").default) => void;
  export default plugin;
}
declare module "markdown-it-deflist" {
  const plugin: (md: import("markdown-it").default) => void;
  export default plugin;
}
declare module "markdown-it-mark" {
  const plugin: (md: import("markdown-it").default) => void;
  export default plugin;
}
