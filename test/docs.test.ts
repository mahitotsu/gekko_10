import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Documents are read by people who follow links: a link or an anchor that points nowhere is a bug. The pages people read first
// (README, report) must also keep their tables narrow (docs/internal/plan.md, CLAUDE.md "文書の書き方").
const files = ["README.md", "CLAUDE.md", ...["docs", "docs/internal"].flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => `${d}/${f}`))];
const text = (f: string) => readFileSync(f, "utf8");

/** The anchor GitHub makes of a heading: lower case, punctuation removed, spaces to hyphens. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(f: string): Set<string> {
  const out = new Set<string>();
  let fence = false;
  for (const line of text(f).split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*)$/.exec(line);
    if (m) out.add(slug(m[1]));
  }
  return out;
}

function links(f: string): { target: string; line: number }[] {
  const out: { target: string; line: number }[] = [];
  let fence = false;
  text(f).split("\n").forEach((line, i) => {
    if (line.startsWith("```")) fence = !fence;
    if (fence) return;
    for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) out.push({ target: m[1], line: i + 1 });
  });
  return out;
}

describe("slug", () => {
  it("follows GitHub: punctuation goes, spaces become hyphens, Japanese stays", () => {
    expect(slug("2-5. 使い分けの目安")).toBe("2-5-使い分けの目安");
    expect(slug("B. 条件と採用")).toBe("b-条件と採用");
    expect(slug("アプリの形のエンドポイント（`/app/*`、`src/scenarios.ts`）")).toBe("アプリの形のエンドポイントappsrcscenariosts");
  });
});

describe("links", () => {
  it.each(files)("%s: every relative link and anchor points somewhere", (f) => {
    const broken: string[] = [];
    for (const { target, line } of links(f)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [rel, anchor] = target.split("#");
      const dest = rel ? path.normalize(path.join(path.dirname(f), rel)) : f;
      if (!existsSync(dest)) broken.push(`${f}:${line} -> ${target} (no such file)`);
      else if (anchor && dest.endsWith(".md") && !anchors(dest).has(decodeURIComponent(anchor))) broken.push(`${f}:${line} -> ${target} (no such heading)`);
    }
    expect(broken).toEqual([]);
  });
});

describe("the pages people read first", () => {
  it.each(["README.md", "docs/report.md"])("%s: no table wider than 5 columns", (f) => {
    const wide: string[] = [];
    let fence = false;
    text(f).split("\n").forEach((line, i) => {
      if (line.startsWith("```")) fence = !fence;
      if (fence || !line.startsWith("|")) return;
      const cols = line.replace(/\\\|/g, "").split("|").length - 2;
      if (cols > 5) wide.push(`${f}:${i + 1} has ${cols} columns`);
    });
    expect(wide).toEqual([]);
  });

  it("report.md says who reads it and gives the answer within its first lines", () => {
    const head = text("docs/report.md").split("\n").slice(0, 14).join("\n");
    expect(head).toContain("読み手");
    expect(head).toContain("## 要旨");
  });
});
