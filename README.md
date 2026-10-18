# gekko_10

AWS Lambda の **Web Functions** と **Event Functions（関数URL）** を、**Aurora DSQL** をバックエンドにして比較する検証リポジトリです。

> 問い: Web Functions は 1 つの実行環境で複数のリクエストを同時に処理できる。DSQL の接続を環境内で共有すると、レイテンシ・DSQL 側の接続数・コストは、Event Functions と比べてどう変わるか。

同じ [Hono](https://hono.dev/) アプリを両方の形態で動かし、DSQL への接続の持ち方（毎回接続 / 再利用 / プール共有）を変えて測ります。リージョンは ap-northeast-1（東京）、IaC は AWS CDK（TypeScript）です。

## 現在の状況
- 完了: DB なしの関数、DSQL クラスタ、DSQL につなぐ 4 つの関数、負荷生成の仕組み（東京の Fargate タスク）。
- 次: 負荷試験の設計と実行。結果は [docs/findings.md](docs/findings.md) と報告にまとめる予定です。
- 検証の途中で、結論はまだ出ていません。設計は [docs/plan.md](docs/plan.md) にあります。

## 比較する関数
| 関数 | 形態 | DB の接続 |
|---|---|---|
| `gekko10-event-noop` / `gekko10-web-noop` | Event / Web | なし（基準） |
| `gekko10-event-dsql-each` / `gekko10-web-dsql-each` | Event / Web | リクエストごとに接続する |
| `gekko10-event-dsql-reuse` | Event | 環境内で 1 接続を再利用する |
| `gekko10-web-dsql-pool` | Web | 環境内のプールを共有する |

詳しい構成、エンドポイントの仕様、設計の判断は [docs/architecture.md](docs/architecture.md) にあります。

## 前提
- Node.js 24、npm、Docker
- AWS CLI v2 の新しいバージョン（`lambda-web` コマンドが必要。2.38.1 で動作を確認）
- AWS の認証情報と、ap-northeast-1 での `cdk bootstrap`

## 使い方
### ローカルで確認する
```sh
npm install
npm test
npm run typecheck
npm run bundle
AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node dist/web/index.js   # 別のターミナルで curl localhost:3000/noop
```

### デプロイする
```sh
npx cdk deploy Gekko10DbStack                     # DSQL クラスタ
npm run db-setup -- <出力された Endpoint>          # テーブルと 1,000 行
npx cdk deploy Gekko10EventStack Gekko10WebStack  # 関数
```
認証はどちらも IAM です。署名なしのリクエストは 403 になります。呼び出し方（SigV4）は [docs/architecture.md](docs/architecture.md) の「運用の手順」にあります。

```sh
npm run invoke -- <URL> --path /db/read --count 20 --concurrency 4
```

### 負荷をかける
手元からは通信が不安定でレイテンシも使えないので、東京の Fargate タスクから実行します。使うときだけ起動し、終われば課金が止まります。
```sh
npx cdk deploy Gekko10LoadStack   # 初回のみ
scripts/load-run.sh -- <URL> --path /db/read --duration 300 --concurrency 100
```
数時間かかる負荷試験は、1 つの Fargate タスクが最後まで実行するので、**PC がスリープしても、AWS の認証が切れても止まりません**。
```sh
npm run p1-start -- --sets 1,2 --seed 20261019 --dry-run   # 計画・終了の目安・費用の確認
npm run p1-start -- --sets 1,2 --seed 20261019             # 起動
npm run p1-fetch -- --task <タスク ID> --wait              # 後日、回収（ログは 30 日、メトリクスは約 15 日以内に）
```
**負荷をかけると Lambda・DSQL・Fargate の料金が発生します。** 実行前に規模と費用を見積もってください。

### 片付ける
```sh
npx cdk destroy Gekko10WebStack Gekko10EventStack Gekko10LoadStack   # 先に関数
npx cdk destroy Gekko10DbStack                                       # 最後にクラスタ（データも消える）
```

## 費用の注意
- 関数は呼ばれない限り費用が発生しません。**DSQL クラスタは使った分（DPU とストレージ）の課金**です。
- `cdk deploy` は、CDK のブートストラップ用の ECR と S3 に成果物を残します。不要になったら `cdk gc --unstable=gc` で整理できます（まず `--action print` で対象を確認してください）。
- Web Functions のアカウント上限は新しいアカウントで低く設定され、使用実績に応じて自動で引き上げられます（このアカウントは当初 100 環境 / 10,000 RPS、現在は 400 環境 / 40,000 RPS）。負荷試験の前に確認してください。

## 文書
| 文書 | 内容 |
|---|---|
| [docs/plan.md](docs/plan.md) | 目的、仮説、比較する構成、負荷パターン、計測項目、コストの計算、段階 |
| [docs/architecture.md](docs/architecture.md) | 構成、エンドポイントの仕様、設計の判断、運用の手順 |
| [docs/findings.md](docs/findings.md) | 実機で確かめた事実（結論と根拠）、未確認の一覧 |
| [docs/web-functions-notes.md](docs/web-functions-notes.md) | Web Functions の仕様の調査メモ（出典つき） |
| [CLAUDE.md](CLAUDE.md) | AI（Claude Code）向けの作業の約束事 |
