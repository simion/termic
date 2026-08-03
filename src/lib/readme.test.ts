import { describe, it, expect } from "vitest";
import { findReadme } from "@/lib/readme";
import type { FileEntry } from "@/lib/types";

const f = (name: string): FileEntry => ({ name, is_dir: false });
const d = (name: string): FileEntry => ({ name, is_dir: true });

describe("findReadme", () => {
  it("matches README.md whatever the case", () => {
    expect(findReadme([f("README.md")])).toBe("README.md");
    expect(findReadme([f("readme.md")])).toBe("readme.md");
    expect(findReadme([f("ReadMe.MD")])).toBe("ReadMe.MD");
  });

  it("matches the other markdown extensions and a bare README", () => {
    expect(findReadme([f("README.markdown")])).toBe("README.markdown");
    expect(findReadme([f("readme.mdown")])).toBe("readme.mdown");
    expect(findReadme([f("README.mkd")])).toBe("README.mkd");
    expect(findReadme([f("README")])).toBe("README");
  });

  it("returns null when the folder has no README", () => {
    expect(findReadme([f("index.ts"), d("src"), f("notes.md")])).toBeNull();
  });

  it("ignores non-markdown READMEs and near-misses", () => {
    // .txt / .rst are not markdown; rendering them through the markdown
    // pipeline would mangle them, so they are deliberately not READMEs here.
    expect(findReadme([f("README.txt")])).toBeNull();
    expect(findReadme([f("README.rst")])).toBeNull();
    expect(findReadme([f("readme-old.md"), f("readmes.md"), f("my-readme.md")])).toBeNull();
  });

  it("ignores a DIRECTORY named readme", () => {
    expect(findReadme([d("readme"), d("README.md")])).toBeNull();
  });

  it("picks deterministically when several candidates exist", () => {
    // Extension order wins first (.md beats .markdown beats bare), then the
    // first name in code-unit order — so re-reading the same folder never
    // swaps which README renders, whatever order readdir hands them back.
    expect(findReadme([f("README"), f("README.markdown"), f("readme.md")])).toBe("readme.md");
    expect(findReadme([f("README"), f("README.markdown")])).toBe("README.markdown");
    expect(findReadme([f("readme.md"), f("README.md")])).toBe("README.md");
    expect(findReadme([f("README.md"), f("readme.md")])).toBe("README.md");
  });
});
