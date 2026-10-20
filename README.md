# gekko_10

AWS Lambda の **Event Functions**（関数URL）と **Web Functions** を、**Aurora DSQL** をバックエンドにして比べた検証のリポジトリ。

**読み手:** AWS を使うが、この検証を知らない技術者。

## 答え
- **待ちが長い処理ほど、Web の方が安い。** 外部 API を 1 秒待つ処理では、100 万件あたり約 12 分の 1 だった。
- **短い処理では、コストはほぼ同じ。** Web の方が、応答が数 ms 速い。
- **Web は、プール上限が先に詰まる。** 上限 10 のプールは、250 ms の集計を毎秒 400 件で受けると飽和した。

条件と根拠は [報告書](docs/report.md)。使い分けの目安は、その 2-5 節。

## 何を調べたか
Web は、1 つの実行環境で複数のリクエストを同時に処理する。Event は、1 つの環境が同時に 1 つだけ処理する。この違いが、実際のアプリに近い 4 つの使い方（外部 API を待つ、混在した API、急なスパイク、重い集計）で、コスト・速さ・負荷への強さにどう出るかを、同じ DSQL と東京の条件で測った。

## 読む順番
| 知りたいこと | 読む文書 |
|---|---|
| 結論と使い分けの目安 | [docs/report.md](docs/report.md) |
| 何を、なぜ、どう測ったか | [docs/plan.md](docs/plan.md) |
| 構成とエンドポイントの仕様 | [docs/architecture.md](docs/architecture.md)（設計の理由は [docs/design-decisions.md](docs/design-decisions.md)） |
| 動かし方（デプロイ、測定、後片付け） | [docs/runbook.md](docs/runbook.md) |
| 確かめた個別の事実（単価、クォータ、挙動） | [docs/findings.md](docs/findings.md) |
| 経過と費用の実績、次の候補 | [docs/log.md](docs/log.md) |
| 用語 | [docs/glossary.md](docs/glossary.md) |
| Web Functions の仕様の調査メモ（出典つき） | [docs/web-functions-notes.md](docs/web-functions-notes.md) |

## 最短の使い方
前提は Node.js 24、npm、Docker、AWS CLI v2（`lambda-web` コマンドが使える新しい版）、AWS の認証情報と、ap-northeast-1 での `cdk bootstrap`。詳しい手順は [runbook](docs/runbook.md)。

```sh
npm install && npm test                                          # ローカルでの確認
npx cdk deploy Gekko10DbStack                                    # DSQL クラスタ
npm run db-setup -- <出力された Endpoint>                         # テーブル
npx cdk deploy Gekko10EventStack Gekko10WebStack Gekko10LoadStack # 関数と負荷生成
npm run suite-start -- --suite measurement --seed <数値> --dry-run # 測定の計画と費用の確認
```

## 費用の注意
- **負荷をかけると、Lambda・DSQL・Fargate の料金が発生する。** 実行前に、規模と費用を見積もる。1 回の測定（27 回）は、定価で約 $6.4 だった。
- 関数は、呼ばれない限り費用が発生しない。DSQL は、使った分（DPU とストレージ）の課金。
- `cdk deploy` は、CDK のブートストラップ用の ECR と S3 に成果物を残す。不要になったら `cdk gc --unstable=gc` で整理する（先に `--action print` で対象を確かめる）。
- AI（Claude Code）向けの作業の約束事は [CLAUDE.md](CLAUDE.md)。
