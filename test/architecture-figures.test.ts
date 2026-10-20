import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { figures } from "../scripts/architecture-figures.js";

describe("architecture figures", () => {
  it.each(Object.entries(figures()))("%s: is well-formed and matches the committed file", (name, svg) => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<title");
    expect(svg).toContain("prefers-color-scheme: dark");
    expect(readFileSync(`docs/figures/${name}`, "utf8")).toBe(svg);
  });
});
