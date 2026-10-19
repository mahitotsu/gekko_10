# CLAUDE.md

Lambda Web Functions と Event Functions を Aurora DSQL で比較する検証リポジトリ。概要は [README.md](README.md)、構成と運用は [docs/architecture.md](docs/architecture.md)。コードや git から分かることは書かない。ここには、作業の約束事と、つまずきやすい点だけを置く。

## 文書の役割（更新先を迷わないために）
- `README.md`: 訪れる人・使う人向けの入口。手順は最短にし、詳細は docs へ。
- `docs/plan.md`: 目的・仮説・測定の設計（ケース、予測、合格基準）・段階。
- `docs/architecture.md`: 構成、仕様、設計の判断と理由、運用の手順。
- `docs/findings.md`: 実機で確かめた事実。**結論**と**根拠（コマンド・出典 URL・取得日）**を分けて書く。
- `docs/web-functions-notes.md`: 仕様の調査メモ（出典つき）。自分たちの観測は findings に書く。
- 人が読む文書は日本語。AI を主語にしない（「私」「Claude」「ユーザー確認済み」と書かない）。

## 承認が要る操作
- `cdk deploy` / `cdk destroy`: 実行前に `cdk diff`（または内容）を見せて、承認を得る。ユーザーが自分で実行することもある。
- コミット: 区切りのよいところで、ユーザーに確認してから main に。
- ECR / S3 の削除（`cdk gc`）: まず `--action print` で対象を見せる。
- **AWS への負荷検証**: 実行前に見積もり（リクエスト数・並行数・時間、単価と出典、クォータへの影響）を出して承認を得る。少数のリクエストでの動作確認は不要。
- **常設で課金されるリソースは作らない**（NAT Gateway、ロードバランサ、常駐のサービスなど）。やむを得ない場合は、理由を示して承認を得る。
- 作り直しや destroy は、設計の選択肢として気軽に提案してよい（検証用で本番ではない）。実行は承認を得てから。

## デプロイ前の確認
CloudFormation のロールバックは時間がかかる。デプロイの前に、ローカルで次を確かめる。
- `npm test`、`npm run typecheck`、`cdk synth`、`cdk diff`
- バンドルしたコードの単体起動（DSQL は実クラスタにつないで確かめられる。手順は architecture.md）。新しい SQL は実クラスタで動くことを確かめる
- **負荷生成のコードを変えたら、本番と同じ件数の最終段まで、ローカルで通す**（例: `node load/invoke.mjs http://127.0.0.1:<port> --path /noop --steps 500,2500 --step-seconds 60`、手元で `dist/web` を起動）。小さい規模では出ない不具合がある（`Math.max(...配列)` は約 12 万要素で例外になり、P1 の 1 回目が失敗した）。
- IAM のリソース ARN の中身（意図したものだけに絞られているか）
- 既存リソースとの名前の衝突（`aws lambda get-function`、`aws lambda-web get-web-function`、`aws logs describe-log-groups` など。読み取りのみ）

## 調べ方
- ドキュメントとユーザーの説明が食い違うときは、ドキュメントを優先して報告する。
- API やプロパティ名を推測で書かない。`node_modules` の型定義や公式ドキュメントで確かめる。
- CDK は高水準の L2 を優先する（Web Functions と DSQL は L2 がないので L1）。VPC を渡せる構成には、新しく作らせず既存の VPC を渡す。

## Web Functions / CDK のつまずきやすい点
- コードは S3 のバージョニング有効バケットから。`BucketDeployment` の `objectKeys` はファイル名だけを返すので、`destinationKeyPrefix` は付けない。
- CloudFormation のロググループの `Arn` 属性は末尾が `:*`。IAM で `:*` を足さない。
- `cdk synth` の `Unknown resource type 'AWS::Lambda::WebFunction'`（F3006）の警告は、CDK 側のスキーマが古いだけ。無視してよい。
- 他の `cdk` コマンドが動いている間は `cdk.out` が競合する。並行するときは `--output <別ディレクトリ>`。
- 関数URLは `UNSIGNED-PAYLOAD` を拒否する。リクエストの署名は空ボディの実際の SHA-256 を使う（`scripts/invoke.ts`）。

## 測定の約束
- **測定の前に、関数のコードをすべて固める**。測定中に関数のコードを変えない（Web のリビジョンが置き換わり、条件がそろわない）。コードを変えたら、コミットして、デプロイして、測定をやり直す。
- **どの版で測ったかを結果に残す**。応答の `build`（コードを最後に変えたコミット。未コミットなら `-dirty`）を、`suite-start` が起動前に各関数で確かめ、分析が全応答で確かめる。作業ツリーがクリーンでないと起動しない。
- **ケースは、競合の点（同時実行の上限、課金、CPU の共有、スケールアウト、プールの待ち）に届くように作り、予測を測る前に書く**。届かなかったケースは「測れなかった」と書き、結論を出さない（合格基準 (g)）。
- 合格基準は流す前に決める（plan.md §8）。結果を見てから基準を変えない。
- Web の動的な同時実行数の学習は関数に保持される。**測定期間中は Web スタックを destroy しない**。コードを変えるとリビジョンが置き換わる。
- 構成ごとに別の関数にする（Web はメトリクスにリビジョンの次元がない）。構成は `lib/event-stack.ts` / `lib/web-stack.ts` のリストに 1 行足す。
- ウォームアップ回を捨てる。生成側が飽和した結果は採用しない（`loadgenCoresUsed` が `loadgenCoresAvailable` に近い）。
- 毎回接続で DSQL の接続レート（100/秒）に達したら、回避せず結果として記録する（53400 と 53300 を区別する）。

## 長い測定（suite）
- 数時間かかる実行は、`npm run suite-start`（1 つの Fargate タスクが、待ち・負荷・メトリクスと REPORT の収集・分析・合否の判定まで最後まで実行）で始める。測定の定義は `scripts/protocol.ts`。
- 起動前に `--dry-run` で、順序・待ち・終了の目安・費用を確認し、**費用の見積もりと承認を得てから**起動する。先に `--suite calibration` で較正し、パラメータを固定する。
- 終了後は `npm run suite-fetch -- --task <ID> --wait`（ログは 30 日）。回収には `aws sso login` が要る。手元の `npm run analyze -- results/<日付>` で同じ結果を再現できる。
- 「毎回接続」の実行の後は、DSQL の接続の枠の回復が遅いので 15 分あける。同じ関数は前回の終了から 16 分以上あける（計画に組み込み済み）。
- esbuild でまとめるモジュール（`scripts/analyze.ts` など）に、`import.meta.url` で「直接実行されたとき」を判定するコードを置かない。入口のスクリプトだけに置く（`test/entrypoints.test.ts`）。

## よく使うコマンド
- `npm test` / `npm run typecheck` / `npm run bundle`
- `npm run invoke -- <URL> --path /noop`（SigV4 署名つき。`--count` / `--concurrency` / `--duration`。`--steps` で段階的、`--mix "/a:70,/b:30"` で混在）
- `npm run db-setup -- <クラスタのエンドポイント>`
- `scripts/load-run.sh -- <URL> ...`（東京の Fargate タスクから `invoke.ts` を 1 回実行）
- `npm run suite-start` / `npm run suite-fetch` / `npm run analyze`（測定を 1 タスクで最後まで流す / 回収 / 分析）
- 認証情報: `eval "$(aws configure export-credentials --format env)"`
