// Draws the diagrams of docs/architecture.md as SVG files (docs/figures/arch-*.svg). The layouts are written by hand below;
// the output is deterministic, so the figures can be regenerated and checked. Usage: npm run architecture-figures [docs/figures]
// Colours: the same tokens as scripts/report-figures.ts (light, and dark under prefers-color-scheme).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const W = 720;
const STYLE = `<style>
  svg { font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
  .bg { fill: #fcfcfb; } .ink { fill: #0b0b0b; } .ink2 { fill: #52514e; }
  .box { fill: #ffffff; stroke: #c9c8c3; stroke-width: 1; } .grp { fill: #f4f3f0; stroke: #e6e5e1; stroke-width: 1; }
  .ev { fill: #e8f0fb; stroke: #2a78d6; stroke-width: 1.5; } .wb { fill: #fdeee7; stroke: #eb6834; stroke-width: 1.5; }
  .line { stroke: #52514e; stroke-width: 1.5; fill: none; } .dash { stroke: #9a9992; stroke-width: 1; stroke-dasharray: 4 3; fill: none; }
  .head { fill: #52514e; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #1a1a19; } .ink { fill: #f0efec; } .ink2 { fill: #c3c2b7; }
    .box { fill: #242422; stroke: #4a4a46; } .grp { fill: #20201f; stroke: #2e2e2c; }
    .ev { fill: #17263a; stroke: #3987e5; } .wb { fill: #3a2218; stroke: #d95926; }
    .line { stroke: #c3c2b7; } .dash { stroke: #7a7972; } .head { fill: #c3c2b7; }
  }
</style>`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const t = (x: number, y: number, s: string, cls = "ink", size = 12, anchor = "middle", weight = 400) =>
  `<text x="${x}" y="${y}" class="${cls}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}">${esc(s)}</text>`;

/** A box with centred lines of text (the first line bold). Returns [svg, anchors]. */
function box(x: number, y: number, w: number, h: number, lines: string[], cls = "box") {
  const lh = 16;
  const y0 = y + h / 2 - ((lines.length - 1) * lh) / 2 + 4;
  const svg =
    `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>` +
    lines.map((l, i) => t(x + w / 2, y0 + i * lh, l, i === 0 ? "ink" : "ink2", i === 0 ? 12 : 11, "middle", i === 0 ? 600 : 400)).join("");
  return svg;
}
const group = (x: number, y: number, w: number, h: number, label: string) =>
  `<rect class="grp" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>` + t(x + 10, y + 18, label, "ink2", 11, "start", 600);
/** A line with an arrowhead at the end (points: x1,y1,x2,y2,...; orthogonal polylines are given by the caller). */
function arrow(pts: number[], dashed = false): string {
  const p = [];
  for (let i = 0; i < pts.length; i += 2) p.push(`${pts[i]},${pts[i + 1]}`);
  const n = pts.length;
  const [x1, y1, x2, y2] = [pts[n - 4], pts[n - 3], pts[n - 2], pts[n - 1]];
  const a = Math.atan2(y2 - y1, x2 - x1);
  const hx = (d: number) => Math.round((x2 - 8 * Math.cos(a + d)) * 10) / 10;
  const hy = (d: number) => Math.round((y2 - 8 * Math.sin(a + d)) * 10) / 10;
  return (
    `<polyline class="${dashed ? "dash" : "line"}" points="${p.join(" ")}"/>` +
    `<polygon class="head" points="${x2},${y2} ${hx(0.4)},${hy(0.4)} ${hx(-0.4)},${hy(-0.4)}"/>`
  );
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

export function overview(): string {
  const body = [
    group(16, 56, 188, 128, "Gekko10LoadStack"),
    box(32, 84, 156, 76, ["Fargate タスク", "invoke.ts（SigV4 署名）", "2 vCPU / 4 GB"]),
    group(252, 20, 224, 100, "Gekko10EventStack"),
    box(268, 44, 192, 62, ["Event Functions", "関数URL（1 環境 1 リクエスト）"], "ev"),
    group(252, 128, 224, 100, "Gekko10WebStack"),
    box(268, 152, 192, 62, ["Web Functions", "エンドポイント（1 環境 64 まで）"], "wb"),
    group(520, 56, 184, 128, "Gekko10DbStack"),
    box(536, 84, 152, 76, ["Aurora DSQL", "パブリックエンドポイント", "ap-northeast-1"]),
    arrow([188, 112, 220, 112, 220, 75, 268, 75]),
    arrow([188, 132, 220, 132, 220, 183, 268, 183]),
    arrow([460, 75, 492, 75, 492, 112, 536, 112]),
    arrow([460, 183, 492, 183, 492, 132, 536, 132]),
    t(16, 262, "矢印は、リクエスト（負荷）と DB アクセスの向き。リージョンはすべて ap-northeast-1。", "ink2", 11, "start"),
  ].join("");
  return frame("全体の構成", "東京の Fargate タスクが、Event と Web の関数に負荷をかけ、両方が 1 つの Aurora DSQL につなぐ。", 276, body);
}

export function build(): string {
  const body = [
    box(24, 76, 168, 56, ["src/app.ts", "共通の Hono アプリ"]),
    box(264, 24, 192, 56, ["src/entry-web.ts", "@hono/node-server"], "wb"),
    box(264, 128, 192, 56, ["src/entry-event.ts", "hono/aws-lambda"], "ev"),
    box(528, 24, 168, 56, ["dist/web", "Web Functions のコード"], "wb"),
    box(528, 128, 168, 56, ["dist/event", "Event のコード"], "ev"),
    arrow([192, 96, 228, 96, 228, 52, 264, 52]),
    arrow([192, 112, 228, 112, 228, 156, 264, 156]),
    arrow([456, 52, 528, 52]),
    arrow([456, 156, 528, 156]),
    t(492, 44, "esbuild", "ink2", 11),
    t(492, 148, "esbuild", "ink2", 11),
    t(24, 214, "scripts/bundle.mjs が、両方を同じ設定でまとめる。応答の build（コードの版）は、このときに埋め込む。", "ink2", 11, "start"),
  ].join("");
  return frame("アプリのビルド", "共通の Hono アプリを、Web 用と Event 用の入口から esbuild でまとめ、dist/web と dist/event を作る。", 232, body);
}

export function stacks(): string {
  const body = [
    box(24, 84, 176, 64, ["Gekko10DbStack", "DSQL クラスタ（状態を持つ）"]),
    box(320, 24, 176, 64, ["Gekko10EventStack", "Event の全関数"], "ev"),
    box(320, 144, 176, 64, ["Gekko10WebStack", "Web の全関数"], "wb"),
    box(540, 84, 160, 64, ["Gekko10LoadStack", "Fargate タスク定義"]),
    arrow([200, 106, 260, 106, 260, 56, 320, 56]),
    arrow([200, 126, 260, 126, 260, 176, 320, 176]),
    t(262, 20, "出力（エンドポイントと ARN）を渡す", "ink2", 11, "end"),
    t(24, 246, "矢印は、出力を渡す向き（Event と Web が参照する）。Load は他に依存しない。デプロイは Db → Event/Web、削除は Event/Web → Db の順。", "ink2", 11, "start"),
  ].join("");
  return frame("スタックの依存", "Event と Web のスタックは、Db スタックの出力を参照する。Load スタックは他に依存しない。", 262, body);
}

export function modes(): string {
  const row = (y: number, name: string, sub: string, steps: string[], cls: string, loop = "") => {
    const bw = 116, gap = 24, x0 = 112;
    const parts = [t(16, y + 22, name, "ink", 13, "start", 600), t(16, y + 40, sub, "ink2", 11, "start")];
    steps.forEach((s, i) => {
      const x = x0 + i * (bw + gap);
      parts.push(box(x, y, bw, 52, s.split("/"), cls));
      if (i > 0) parts.push(arrow([x - gap, y + 26, x, y + 26]));
    });
    if (loop) parts.push(t(x0, y + 72, loop, "ink2", 11, "start"));
    return parts.join("");
  };
  const body = [
    row(20, "each", "Event / Web", ["リクエスト", "接続を作る", "問い合わせ", "閉じる"], "box"),
    row(120, "reuse", "Event", ["リクエスト", "環境の 1 接続/を使う", "問い合わせ"], "ev", "55 分で張り直す。切れていたら 1 回だけ再接続して再試行"),
    row(220, "pool", "Web", ["リクエスト", "環境のプールから/借りる", "問い合わせ", "プールに返す"], "wb", "上限は 10（実際のアプリに近い）または 64（待ちが起きない対照）"),
  ].join("");
  return frame("接続の持ち方 3 モード", "each は毎回接続し、reuse は環境で 1 接続を使い回し、pool は環境のプールを借りて返す。", 316, body);
}

export function sequence(): string {
  const cols = [
    { x: 100, name: "ローカル PC" },
    { x: 360, name: "Fargate タスク" },
    { x: 620, name: "AWS" },
  ];
  const sub = ["", "（suite-runner / suite-post）", "（関数・DSQL・CloudWatch）"];
  const top = 20, line0 = 72;
  const msgs: { y: number; from: number; to: number; text: string; dashed?: boolean }[] = [
    { y: 100, from: 0, to: 0, text: "suite-start：計画を作り、版と条件を確かめる" },
    { y: 140, from: 0, to: 1, text: "タスクを起動（ここで PC を閉じてよい）" },
    { y: 190, from: 1, to: 1, text: "suite-runner：計画の時刻まで待つ" },
    { y: 220, from: 1, to: 2, text: "invoke.ts：段を上げて負荷をかける" },
    { y: 270, from: 1, to: 2, text: "suite-post：メトリクスと REPORT を集める" },
    { y: 310, from: 1, to: 1, text: "分析して合否を判定（SUITE_VERDICT）" },
    { y: 360, from: 0, to: 1, text: "suite-fetch：ログを読み、回ごとのファイルに分ける", dashed: true },
  ];
  const H = 392;
  const parts: string[] = [];
  for (const c of cols) {
    parts.push(box(c.x - 80, top, 160, 40, [c.name, ...(sub[cols.indexOf(c)] ? [sub[cols.indexOf(c)]] : [])]));
    parts.push(`<line class="dash" x1="${c.x}" y1="${line0}" x2="${c.x}" y2="${H - 12}"/>`);
  }
  // a loop frame around the repeated part (wait + load)
  parts.push(`<rect class="grp" x="248" y="164" width="400" height="76" rx="6" fill-opacity="0.5"/>` + t(256, 180, "計画の回ごとに繰り返す", "ink2", 11, "start", 600));
  for (const m of msgs) {
    const a = cols[m.from].x, b = cols[m.to].x;
    if (a === b) {
      parts.push(t(a + 10, m.y + 4, m.text, "ink", 12, "start"));
      parts.push(`<circle class="head" cx="${a}" cy="${m.y}" r="3"/>`);
    } else {
      parts.push(arrow(a < b ? [a, m.y, b, m.y] : [a, m.y, b, m.y], m.dashed));
      parts.push(t((a + b) / 2, m.y - 8, m.text, "ink", 12));
    }
  }
  return frame("測定の進行", "ローカルで計画を作ってタスクを起動すると、以後は Fargate タスクが最後まで進める。終了後にローカルがログを回収する。", H, parts.join(""));
}

export const figures = (): Record<string, string> => ({
  "arch-overview.svg": overview(),
  "arch-build.svg": build(),
  "arch-stacks.svg": stacks(),
  "arch-modes.svg": modes(),
  "arch-suite.svg": sequence(),
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = process.argv[2] ?? "docs/figures";
  mkdirSync(outDir, { recursive: true });
  for (const [name, svg] of Object.entries(figures())) {
    writeFileSync(path.join(outDir, name), svg);
    console.log(`wrote ${path.join(outDir, name)}`);
  }
}
