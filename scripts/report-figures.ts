// Draws the figures of docs/report.md as SVG files from a measurement's analysis.json (npm run analyze writes it), so the figures
// can be regenerated from the results. Same input, same output.
// Usage: npm run report-figures -- results/measurement-20261020 [docs/figures]
// Colours: categorical slots 1-3 and 3-5 of the validated palette (light and dark steps), checked with the dataviz validator.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Analysis, RunOut, StepOut } from "./analyze.js";

// ---- data ----
type Run = RunOut;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const measured = (runs: Run[], c: string, name: string) => runs.filter((r) => r.set !== 1 && r.case === c && r.name === name);

/** Cost per million requests: the mean cost of a run over its mean request count (Event: from the billed durations). */
export function costPerMillion(runs: Run[], c: string, name: string): number {
  const rs = measured(runs, c, name);
  return (mean(rs.map((r) => (r.total.costBilled ?? r.total.cost).total)) / mean(rs.map((r) => r.total.sent))) * 1e6;
}
const stepMean = (runs: Run[], c: string, name: string, i: number, pick: (s: StepOut) => number | undefined) =>
  mean(measured(runs, c, name).map((r) => pick(r.steps[i]) ?? NaN));

// ---- drawing ----
const W = 720;
const STYLE = `<style>
  svg { font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  .bg { fill: #fcfcfb; } .ink { fill: #0b0b0b; } .ink2 { fill: #52514e; } .grid { stroke: #e6e5e1; stroke-width: 1; } .axis { stroke: #c9c8c3; stroke-width: 1; }
  .s1 { fill: #2a78d6; } .s2 { fill: #eb6834; } .s3 { fill: #1baf7a; } .s4 { fill: #eda100; } .s5 { fill: #e87ba4; } .onfill { fill: #0b0b0b; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #1a1a19; } .ink { fill: #f0efec; } .ink2 { fill: #c3c2b7; } .grid { stroke: #2e2e2c; } .axis { stroke: #4a4a46; }
    .s1 { fill: #3987e5; } .s2 { fill: #d95926; } .s3 { fill: #199e70; } .s4 { fill: #c98500; } .s5 { fill: #d55181; }
  }
</style>`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r1 = (n: number) => Math.round(n * 10) / 10;
const text = (x: number, y: number, s: string, cls = "ink", size = 12, anchor = "start", weight = 400) =>
  `<text x="${r1(x)}" y="${r1(y)}" class="${cls}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}">${esc(s)}</text>`;

/** A bar from the baseline up, with a 4px rounded data end and a square base. */
function column(x: number, base: number, h: number, w: number, cls: string): string {
  if (!(h > 0)) return "";
  const r = Math.min(4, h / 2, w / 2);
  const y = base - h;
  return `<path class="${cls}" d="M${r1(x)},${r1(base)} L${r1(x)},${r1(y + r)} A${r},${r} 0 0 1 ${r1(x + r)},${r1(y)} L${r1(x + w - r)},${r1(y)} A${r},${r} 0 0 1 ${r1(x + w)},${r1(y + r)} L${r1(x + w)},${r1(base)} Z"/>`;
}

function frame(title: string, desc: string, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>
${STYLE}
<rect class="bg" width="${W}" height="${h}"/>
${body}
</svg>
`;
}

export interface ColumnSeries {
  name: string;
  cls: "s1" | "s2" | "s3";
  /** One value per group; null when the series has no bar in that group (the other bars are centred). */
  values: (number | null)[];
}
export interface ColumnChart {
  title: string;
  desc: string;
  yLabel: string;
  groups: string[][];
  series: ColumnSeries[];
  yMax: number;
  ticks: number[];
  fmt: (n: number) => string;
  note?: string;
}

/** Grouped columns: one group per category, one bar per series, the value at the cap, a legend above the plot. */
export function groupedColumns(c: ColumnChart): string {
  const H = 400;
  const left = 64, right = 24, top = 64, bottom = 78;
  const base = H - bottom;
  const plotW = W - left - right;
  const slot = plotW / c.groups.length;
  const bw = 24, gap = 8;
  const y = (v: number) => base - (v / c.yMax) * (base - top);
  let body = "";
  for (const t of c.ticks) body += `<line class="grid" x1="${left}" x2="${W - right}" y1="${r1(y(t))}" y2="${r1(y(t))}"/>` + text(left - 8, y(t) + 4, c.fmt(t), "ink2", 11, "end");
  body += `<line class="axis" x1="${left}" x2="${W - right}" y1="${base}" y2="${base}"/>`;
  body += text(left, 22, c.yLabel, "ink2", 12);
  // legend
  let lx = left;
  for (const s of c.series) {
    body += `<rect class="${s.cls}" x="${lx}" y="34" width="10" height="10" rx="2"/>` + text(lx + 16, 43, s.name, "ink", 12);
    lx += 16 + s.name.length * 13 + 24;
  }
  c.groups.forEach((lines, gi) => {
    const cx = left + slot * gi + slot / 2;
    const present = c.series.filter((s) => s.values[gi] !== null);
    const total = present.length * bw + (present.length - 1) * gap;
    present.forEach((s, si) => {
      const x = cx - total / 2 + si * (bw + gap);
      const v = s.values[gi] as number;
      body += column(x, base, (v / c.yMax) * (base - top), bw, s.cls);
      body += text(x + bw / 2, y(v) - 6, c.fmt(v), "ink", 11, "middle", 600);
    });
    lines.forEach((l, li) => (body += text(cx, base + 20 + li * 16, l, "ink2", 12, "middle")));
  });
  if (c.note) body += text(left, H - 10, c.note, "ink2", 11);
  return frame(c.title, c.desc, H, body);
}

export interface StackSegment {
  name: string;
  cls: "s3" | "s4" | "s5";
  ms: number;
}
export interface StackChart {
  title: string;
  desc: string;
  bars: { label: string; segments: StackSegment[] }[];
  xMax: number;
  note?: string;
}

/** Horizontal stacked bars (one per platform): the segments are the parts of one response time, a 2px gap between them. */
export function stackedBars(c: StackChart): string {
  const H = 90 + c.bars.length * 56 + (c.note ? 24 : 0);
  const left = 96, right = 64, top = 64;
  const pxPerMs = (W - left - right) / c.xMax;
  let body = text(left, 22, "応答時間の中央値（ms）の内訳", "ink2", 12);
  let lx = left;
  const names = [...new Map(c.bars.flatMap((b) => b.segments).map((s) => [s.name, s.cls])).entries()];
  for (const [name, cls] of names) {
    body += `<rect class="${cls}" x="${lx}" y="34" width="10" height="10" rx="2"/>` + text(lx + 16, 43, name, "ink", 12);
    lx += 16 + name.length * 13 + 24;
  }
  c.bars.forEach((b, bi) => {
    const y = top + bi * 56;
    body += text(left - 10, y + 17, b.label, "ink", 13, "end", 600);
    let x = left;
    b.segments.forEach((s, si) => {
      const w = Math.max(s.ms * pxPerMs - 2, 0);
      if (w > 0) {
        const last = si === b.segments.length - 1;
        body += last ? `<path class="${s.cls}" d="M${r1(x)},${y} L${r1(x + w - 4)},${y} A4,4 0 0 1 ${r1(x + w)},${y + 4} L${r1(x + w)},${y + 20} A4,4 0 0 1 ${r1(x + w - 4)},${y + 24} L${r1(x)},${y + 24} Z"/>` : `<rect class="${s.cls}" x="${r1(x)}" y="${y}" width="${r1(w)}" height="24"/>`;
        if (w > 44) body += text(x + w / 2, y + 16, s.ms.toFixed(1), "onfill", 12, "middle", 600);
      }
      x += s.ms * pxPerMs;
    });
    body += text(x + 6, y + 17, `${b.segments.reduce((n, s) => n + s.ms, 0).toFixed(1)} ms`, "ink", 12, "start", 600);
  });
  body += `<line class="axis" x1="${left}" x2="${left}" y1="${top - 6}" y2="${top + c.bars.length * 56 - 12}"/>`;
  if (c.note) body += text(left, H - 10, c.note, "ink2", 11);
  return frame(c.title, c.desc, H, body);
}

// ---- the figures of the report ----
export function figures(a: Pick<Analysis, "runs">): Record<string, string> {
  const runs = a.runs;
  const ev = "event-dsql-reuse", w10 = "web-dsql-pool10", w64 = "web-dsql-pool";
  const out: Record<string, string> = {};

  out["fig1-cost.svg"] = groupedColumns({
    title: "100 万件あたりのコスト",
    desc: "待ちが長い処理ほど、Web が Event より安い。ケース A は Web が約 12 分の 1、ケース D は約 3 分の 2。ケース B はほぼ同じ、ケース C は Event がわずかに安い。",
    yLabel: "100 万件あたりのコスト（USD、定価）",
    groups: [["A 外部 I/O を待つ API"], ["B 混在した API"], ["C 急なスパイク"], ["D 重い集計"]],
    series: [
      { name: "Event", cls: "s1", values: ["A", "B", "C", "D"].map((c) => costPerMillion(runs, c, ev)) },
      { name: "Web（プール 10）", cls: "s2", values: ["A", "B", "C", "D"].map((c) => costPerMillion(runs, c, w10)) },
      { name: "Web（プール 64）", cls: "s3", values: ["A", "B", "C", "D"].map((c) => (c === "D" ? costPerMillion(runs, c, w64) : null)) },
    ],
    yMax: 16,
    ticks: [0, 4, 8, 12, 16],
    fmt: (n) => `$${n >= 10 ? n.toFixed(1) : n.toFixed(2)}`,
    note: "プール 64 は、ケース D だけで測った。A は、400 RPS の段（無効）の途中までを含む。",
  });

  const item = (name: string, pick: (p: NonNullable<StepOut["byPath"]>[string]) => number | undefined) =>
    mean(measured(runs, "B", name).map((r) => pick(r.steps[r.steps.length - 1].byPath!["/app/item"]) ?? NaN));
  const seg = (name: string): StackSegment[] => [
    { name: "経路の時間", cls: "s3", ms: item(name, (p) => p.outsideP50) },
    { name: "アプリ内（DB 以外）", cls: "s4", ms: item(name, (p) => p.appOtherP50) },
    { name: "DB", cls: "s5", ms: item(name, (p) => (p.acquireP50 ?? 0) + (p.queryP50 ?? 0)) },
  ];
  out["fig2-latency.svg"] = stackedBars({
    title: "軽い読み取りの応答時間の内訳",
    desc: "同じ読み取りで、Web は Event より約 7 ms 短い。DB とアプリ内の時間は同じで、差はすべて経路の時間にある。",
    bars: [
      { label: "Event", segments: seg(ev) },
      { label: "Web", segments: seg(w10) },
    ],
    xMax: 18,
    note: "ケース B の item（400 RPS）、2 セットの平均。合計は各部分の中央値の和で、全体の中央値とは少し違う。",
  });

  out["fig3-saturation.svg"] = groupedColumns({
    title: "ケース D（重い集計）の応答時間の中央値",
    desc: "Web のプール上限 10 は、400 RPS で飽和し、応答時間が約 8 秒になった。Event と Web のプール 64 は、約 250 ms のまま。",
    yLabel: "応答時間の中央値（ms）",
    groups: [["100 RPS"], ["200 RPS"], ["400 RPS"]],
    series: [
      { name: "Event", cls: "s1", values: [0, 1, 2].map((i) => stepMean(runs, "D", ev, i, (s) => s.p50)) },
      { name: "Web（プール 10）", cls: "s2", values: [0, 1, 2].map((i) => stepMean(runs, "D", w10, i, (s) => s.p50)) },
      { name: "Web（プール 64）", cls: "s3", values: [0, 1, 2].map((i) => stepMean(runs, "D", w64, i, (s) => s.p50)) },
    ],
    yMax: 9000,
    ticks: [0, 3000, 6000, 9000],
    fmt: (n) => Math.round(n).toLocaleString("en-US"),
    note: "400 RPS のプール 10 は、接続取得の中央値が約 870 ms、プール待ち 41〜45。生成側の上限にも当たった段。",
  });

  const envs = (c: string, name: string, i: number) => stepMean(runs, c, name, i, (s) => s.environments);
  const picks: [string, number][] = [["A", 0], ["A", 1], ["B", 3], ["D", 2]];
  out["fig4-environments.svg"] = groupedColumns({
    title: "同じ負荷を処理した環境の数",
    desc: "Event は、同時実行数ぶんの環境を使う。Web は、同じ負荷を数個の環境で処理する。",
    yLabel: "その段で使われた環境の数",
    groups: [["A 外部 I/O", "25 RPS"], ["A 外部 I/O", "100 RPS"], ["B 混在", "400 RPS"], ["D 重い集計", "400 RPS"]],
    series: [
      { name: "Event", cls: "s1", values: picks.map(([c, i]) => envs(c, ev, i)) },
      { name: "Web（プール 10）", cls: "s2", values: picks.map(([c, i]) => envs(c, w10, i)) },
      { name: "Web（プール 64）", cls: "s3", values: picks.map(([c, i]) => (c === "D" ? envs(c, w64, i) : null)) },
    ],
    yMax: 160,
    ticks: [0, 40, 80, 120, 160],
    fmt: (n) => String(Math.round(n)),
    note: "2 セットの平均。プール 64 は、ケース D だけで測った。",
  });
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, outDir = "docs/figures"] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: report-figures <results dir> [out dir]");
    process.exit(2);
  }
  const analysis = JSON.parse(readFileSync(path.join(dir, "analysis.json"), "utf8")) as Analysis;
  mkdirSync(outDir, { recursive: true });
  for (const [name, svg] of Object.entries(figures(analysis))) {
    writeFileSync(path.join(outDir, name), svg);
    console.log(`wrote ${path.join(outDir, name)}`);
  }
}
