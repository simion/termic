import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, highlightingFor, syntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { languages as registry } from "@codemirror/language-data";
import {
  OVERLAY, PICKER_COMMON, isKnownLanguage, langForId, langForPath, languageIdForPath, matchLanguage, pickerLanguages,
} from "./languageExts";
import { PLAIN_TEXT } from "./languages";
import { resolveEditorTheme } from "./editorTheme";

const id = languageIdForPath;

describe("languageIdForPath", () => {
  it("matches by extension", () => {
    expect(id("src/main.ts")).toBe("TypeScript");
    expect(id("build.js")).toBe("JavaScript");
    expect(id("main.rs")).toBe("Rust");
    expect(id("a/b/c.yml")).toBe("YAML");
    expect(id("icon.svg")).toBe("XML");
  });

  it("lights up languages nobody registered here", () => {
    // The whole point of the swap: none of these has an entry anywhere in
    // termic, and adding another needs no edit either.
    expect(id("index.php")).toBe("PHP");
    expect(id("init.lua")).toBe("Lua");
    expect(id("Main.hs")).toBe("Haskell");
    expect(id("script.ps1")).toBe("PowerShell");
    expect(id("Cargo.nix")).toBeNull(); // …and it still declines to guess
  });

  it("is case-insensitive about the extension", () => {
    // LanguageDescription.matchFilename compares the RAW extension, which is
    // why this module does its own matching. Do not swap it back.
    expect(id("README.MD")).toBe("Markdown");
    expect(id("MAIN.PY")).toBe("Python");
  });

  it("matches special filenames before extensions", () => {
    expect(id("Makefile")).toBe("Makefile");
    expect(id("GNUmakefile")).toBe("Makefile");
    expect(id("build/Makefile.local")).toBe("Makefile");
    expect(id("common.mk")).toBe("Makefile");
    // `Dockerfile.dev` is a Dockerfile, not a ".dev" file. The registry's own
    // pattern is anchored `/^Dockerfile$/`, so this is the overlay's.
    expect(id("Dockerfile")).toBe("Dockerfile");
    expect(id("docker/Dockerfile.dev")).toBe("Dockerfile");
    expect(id("justfile")).toBe("Shell");
    expect(id(".env")).toBe("Properties files");
    expect(id(".env.production")).toBe("Properties files");
  });

  it("keeps the shells and dialects the registry only lists as aliases", () => {
    expect(id("run.zsh")).toBe("Shell");
    expect(id("config.fish")).toBe("Shell");
    expect(id("nginx.conf")).toBe("Nginx"); // upstream's rule wins on its own turf
    expect(id("app.conf")).toBe("Properties files");
    expect(id("tasks.rake")).toBe("Ruby");
    expect(id("types.pyi")).toBe("Python");
    expect(id("post.mdx")).toBe("Markdown");
  });

  it("covers the JVM/Apple build files people actually open", () => {
    expect(id("StockApp.swift")).toBe("Swift");
    expect(id("Package.swift")).toBe("Swift");
    expect(id("app/build.gradle")).toBe("Groovy");
    // The Kotlin DSL flavour is Kotlin, and the registry knows the difference.
    expect(id("app/build.gradle.kts")).toBe("Kotlin");
    expect(id("Main.kt")).toBe("Kotlin");
    // …while gradle.properties is a properties file, not a build script.
    expect(id("gradle.properties")).toBe("Properties files");
  });

  it("keeps the grammars the registry cannot serve", () => {
    expect(id("service.proto")).toBe("ProtoBuf");
    expect(id("lib/mix.ex")).toBe("Elixir");
    expect(id("test/foo_test.exs")).toBe("Elixir");
  });

  it("recognizes Terraform and HCL files without stealing their JSON variants", () => {
    for (const path of ["main.tf", "MAIN.TF", "terraform.tfvars", "prod.auto.tfvars", "terragrunt.hcl"])
      expect(id(path), path).toBe("HCL");
    for (const path of ["main.tf.json", "terraform.tfvars.json", "prod.auto.tfvars.json"])
      expect(id(path), path).toBe("JSON");
  });

  it("gives the component formats a real grammar where one exists", () => {
    // These three each have a parser that knows the format. Svelte and Astro
    // used to fall back to HTML here, which read the tags and left every line
    // of actual code, `{#if}` blocks and Astro frontmatter alike, grey.
    expect(id("App.vue")).toBe("Vue");
    expect(id("App.svelte")).toBe("Svelte");
    expect(id("page.astro")).toBe("Astro");
    // JSX and TSX are the registry's, and are why React needs nothing here.
    expect(id("App.jsx")).toBe("JSX");
    expect(id("App.tsx")).toBe("TSX");
  });

  it("still falls back to HTML for the formats with no grammar at all", () => {
    expect(id("row.hbs")).toBe("HTML");
    expect(id("index.ejs")).toBe("HTML");
    expect(id("page.njk")).toBe("HTML");
  });

  it("gives up rather than guessing", () => {
    expect(id("notes")).toBeNull();
    expect(id("notes.txt")).toBeNull();
    expect(id("")).toBeNull();
    expect(id(undefined)).toBeNull();
  });
});

describe("the composed list", () => {
  it("has an overlay rule for every base still in the registry", () => {
    // A rule whose base language upstream renamed is silently dropped rather
    // than throwing at import (which would take the editor pane down with
    // it), so the count is what catches the rename.
    expect(OVERLAY).toHaveLength(8);
    for (const d of OVERLAY)
      expect(registry.some(r => r.name === d.name), `${d.name} is no longer upstream`).toBe(true);
  });

  it("replaces the registry's pre-proto3 ProtoBuf rather than shadowing it", () => {
    expect(pickerLanguages().filter(l => l.name === "ProtoBuf")).toHaveLength(1);
  });

  it("lists each language once, the common ones first, the rest alphabetical", () => {
    const rows = pickerLanguages();
    expect(rows.slice(0, 5).map(r => r.name)).toEqual(["Markdown", PLAIN_TEXT, "YAML", "JSON", "Shell"]);
    expect(rows.slice(0, PICKER_COMMON.length).map(r => r.name)).toEqual(PICKER_COMMON);
    expect(new Set(rows.map(r => r.name)).size).toBe(rows.length);
    const rest = rows.slice(PICKER_COMMON.length).map(r => r.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
    // Aliases are what makes the fuzzy search find a language by a name
    // nobody displays: "ini" has to reach "Properties files".
    expect(rows.find(r => r.name === "Properties files")?.keywords).toContain("ini");
  });

  it("offers HCL once and makes it searchable as Terraform", async () => {
    const rows = pickerLanguages().filter(l => l.name === "HCL");
    expect(rows).toHaveLength(1);
    expect(rows[0].keywords).toContain("terraform");
    expect(await langForId("HCL")).not.toBeNull();
  });

  it("knows the names it hands out, and only those", () => {
    expect(isKnownLanguage("Rust")).toBe(true);
    expect(isKnownLanguage("Makefile")).toBe(true);
    expect(isKnownLanguage(PLAIN_TEXT)).toBe(true);
    expect(isKnownLanguage("markdown")).toBe(true); // legacy id, translated
    expect(isKnownLanguage("Cobol-74")).toBe(false);
  });
});

describe("langForId", () => {
  it("loads a grammar for a name", async () => {
    expect(await langForId("JSON")).not.toBeNull();
    expect(await langForId("Makefile")).not.toBeNull();
    expect(await langForId("markdown")).not.toBeNull(); // legacy id, translated
  });

  it("returns null for plain text, nothing, and an unknown name", async () => {
    expect(await langForId(PLAIN_TEXT)).toBeNull();
    expect(await langForId(null)).toBeNull();
    expect(await langForId("")).toBeNull();
    // A pick persisted by a build that knew a language this one does not must
    // leave the buffer unhighlighted, not fail the file open.
    expect(await langForId("Cobol-74")).toBeNull();
  });
});

describe("matchLanguage", () => {
  it("returns the description, so callers can load it once", async () => {
    const desc = matchLanguage("src/App.tsx");
    expect(desc?.name).toBe("TSX");
    expect(await desc!.load()).toBeTruthy();
  });
});

describe("Terraform highlighting", () => {
  it("parses and styles HCL blocks, expressions, comments and heredocs", async () => {
    const doc = [
      "# Terraform fixture",
      'resource "example_service" "demo" {',
      '  name = "hello ${var.name}"',
      "  enabled = true",
      "  count = 2",
      "  labels = [for name in var.names : upper(name)]",
      "  script = <<-EOT",
      "    hello ${var.name}",
      "  EOT",
      "}",
      "",
    ].join("\n");
    const resolved = await langForPath("main.tf");
    expect(resolved?.id).toBe("HCL");
    const state = EditorState.create({ doc, extensions: [resolved!.ext, resolveEditorTheme("auto")] });
    // `ensureSyntaxTree`, not `syntaxTree`: HCL is a real Lezer LR parser, and
    // the parse that `EditorState.create` kicks off runs on a TIME budget. When
    // that budget expires the tree is partial, and a partial LR tree ends in
    // error nodes at the point it stopped, which is indistinguishable from a
    // grammar that cannot read the fixture. This went red on CI with errors at
    // offset 95 (the `=` of `enabled = true`, a third of the way in) while
    // passing on every developer machine, on a commit that touched neither the
    // parser, its version, nor the lockfile. Forcing the parse to completion
    // removes the machine's spare CPU from the assertion either way.
    const tree = ensureSyntaxTree(state, doc.length, 10_000) ?? syntaxTree(state);
    const errors: string[] = [];
    tree.iterate({ enter: node => {
      if (node.type.isError) errors.push(`${node.from}: ${JSON.stringify(doc.slice(Math.max(0, node.from - 10), node.from + 10))}`);
    } });
    // The coverage is part of the message: "errors, and the tree stops short of
    // the document" is a starved parse, "errors, and the tree covers it" is a
    // real grammar failure, and they need opposite fixes.
    expect(errors, `parsed ${tree.length}/${doc.length} chars`).toEqual([]);
    const classes = new Set<string>();
    highlightTree(tree, classHighlighter, (_from, _to, cls) => {
      for (const name of cls.split(" ")) classes.add(name);
    });
    expect(classes).toContain("tok-comment");
    expect(classes).toContain("tok-string");
    expect(classes).toContain("tok-number");
    expect(classes).toContain("tok-bool");
    // A parser tag alone is not enough: the default theme must actually
    // assign it a style, or blocks and booleans still look like plain text.
    const styled: string[] = [];
    highlightTree(tree, { style: tags => highlightingFor(state, tags) }, (from, to) => {
      styled.push(doc.slice(from, to));
    });
    expect(styled).toContain("resource");
    expect(styled).toContain("true");
    expect(styled).toContain('"example_service"');
  });
});
