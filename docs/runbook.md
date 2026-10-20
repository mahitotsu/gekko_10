# 運用の手順

**この文書の読み手:** このリポジトリを動かす人（ローカルでの確認、デプロイ、較正と測定、回収、後片付け）。構成の事実は [architecture.md](architecture.md)、測定の設計は [plan.md](plan.md)、用語は [用語集](glossary.md)。

**費用の約束**
- AWS に負荷をかける前に、費用の見積もり（リクエスト数・並行数・時間、単価、クォータへの影響）を出して、承認を得る。
- 常設で課金されるリソース（NAT Gateway、ロードバランサ、常駐のサービス）は作らない。
- `cdk deploy` と `cdk destroy` は、`cdk diff` を見せて、承認を得てから実行する。

## 前提
- Node.js 24、npm、Docker（負荷生成のイメージのビルド）
- AWS CLI v2 の新しいバージョン（`lambda-web` コマンドが必要。2.31.35 では使えず、2.38.1 で動作を確認した。apt 版は古いので公式インストーラで入れる）
- AWS の認証情報と、ap-northeast-1 での `cdk bootstrap`

## ローカルでの確認
```sh
npm install
npm test            # vitest
npm run typecheck
npm run bundle      # dist/web と dist/event を作る

# Web 側をローカルで起動
AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node dist/web/index.js
curl localhost:3000/noop
curl "localhost:3000/wait?ms=500"
```

## デプロイ
```sh
npx cdk synth                         # 4 スタックを合成（bundle も自動で走る）
npx cdk deploy Gekko10DbStack         # 先に DSQL クラスタだけを作る
npm run db-setup -- <Gekko10DbStack の Endpoint>   # テーブルと 1,000 行
npx cdk deploy Gekko10EventStack Gekko10WebStack
npx cdk deploy Gekko10LoadStack       # 負荷生成が必要になったとき。イメージが ECR に push される
```
- 他の `cdk` コマンドが動いている間は、`cdk.out` が競合して `Other CLIs ... are currently reading from cdk.out` で失敗する。並行して `synth` / `diff` したいときは `--output <別ディレクトリ>` を付ける。
- デプロイの前に、バンドルを実クラスタにつないで確かめられる。先に、`eval "$(aws configure export-credentials --format env)"` で認証情報を出しておく。
  ```sh
  DB_MODE=each|pool DSQL_ENDPOINT=<Endpoint> AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node dist/web/index.js
  ```
- `cdk synth` で `Unknown resource type 'AWS::Lambda::WebFunction'`（F3006）の警告が出るが、CDK 側の検証スキーマが新しいリソースタイプを知らないだけで、合成は成功する。
- Web スタックは関数ごとに専用の S3 バケット（バージョニング有効）にコードを置く。Web Functions は S3 のコードしか受け付けず、バケットポリシーで Lambda サービスに読み取りを許可する必要があるため。コードを変えると新しいリビジョンが作られ、古いリビジョンは削除される。
- デプロイ後の出力: Event は `Url`（関数URL）、Web は `EndpointUrl`・`EndpointArn`。
- 認証はどちらも IAM。署名なしのリクエストは 403 になる。

## アカウントのクォータ確認（Web Functions）
```sh
aws lambda-web get-web-account-settings --region ap-northeast-1
```
`accountQuotas.maxTotalArmVCpus`（環境 1 つ = 2 vCPU）と `maxTotalRateLimit`（RPS）を確認する。新しいアカウントは低いことがある（このアカウントの実測は [findings.md](findings.md)）。

## 呼び出す側の IAM 権限
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "lambda:InvokeFunctionUrl",
      "Resource": "arn:aws:lambda:ap-northeast-1:<account>:function:gekko10-event-noop" },
    { "Effect": "Allow", "Action": "lambda:InvokeWebFunctionEndpoint",
      "Resource": "arn:aws:lambda:ap-northeast-1:<account>:web-function/gekko10-web-noop/endpoint/main" }
  ]
}
```
関数ごとに Resource を足す（Web は `web-function/gekko10-web-dsql-each/endpoint/main` など）。

## 動作確認（デプロイ後）
1. 署名なしは拒否される
   ```sh
   curl -i "<Event の Url>noop"          # 403
   curl -i "<Web の EndpointUrl>/noop"   # 403
   ```
2. SigV4 署名付きリクエスト。`scripts/invoke.ts` は、両方に使える。
   - サービス名は `lambda`。`x-amz-content-sha256` を常に付ける（Web Functions では必須）。
   - ヘッダの値は、空ボディの SHA-256 にする。関数URLは、`UNSIGNED-PAYLOAD` を付けると 403 になるため（[findings.md](findings.md) §1-4）。
   ```sh
   npm run invoke -- https://<id>.lambda-url.ap-northeast-1.on.aws --path /noop
   npm run invoke -- https://<id>.<...>.lambda-web.ap-northeast-1.on.aws --path /noop
   npm run invoke -- <url> --path "/wait?ms=500"
   ```
   curl で試す場合（SSO なら `eval "$(aws configure export-credentials --format env)"` で認証情報を環境変数に出す。一時認証情報なので `x-amz-security-token` が必要）:
   ```sh
   curl --aws-sigv4 "aws:amz:ap-northeast-1:lambda" \
     --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
     -H "x-amz-security-token: $AWS_SESSION_TOKEN" \
     -H "x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" \
     "<url>/noop"
   ```
3. 同時処理と環境の共有を観測する。同じ `/wait` を並行 50 件で送り、出力の `distinctEnvironments`（使われた環境の数）と `maxInFlightObserved`（環境内の最大同時処理数）を見る。
   ```sh
   npm run invoke -- <url> --path "/wait?ms=1000" --count 50 --concurrency 50
   ```
   | | 期待 |
   |---|---|
   | Web Functions | 環境内で同時に処理される（`maxInFlightObserved` が 1 より大きい）。ただし最初は動的な上限が保守的で、上がるまで 1〜2 分かかる（[findings.md](findings.md)） |
   | Event Functions | 環境が並行数に近い数に増え、`maxInFlightObserved` は常に 1 |

   手元の WSL からのレイテンシは、新規接続の確立と通信の揺れを含むので比較には使えない。

## 負荷をかける
```sh
scripts/load-run.sh [--max-seconds N] -- <invoke.ts の引数>
scripts/load-run.sh -- https://<endpoint> --path /db/read --duration 300 --concurrency 100
```
出力の `loadgenCoresUsed` が `loadgenCoresAvailable`（2）に近いときは、生成側が飽和しているので、その結果は採用しない。

## 較正と測定を流す（数時間かかる実行）
測定の定義は `scripts/protocol.ts`。1 つのタスクが、待ち・負荷・メトリクスと `REPORT` の収集・分析・合否の判定まで、最後まで実行する。**PC がスリープしても、AWS の認証が切れても止まらない。**

**順序**
1. コードと文書を変える（AWS には触れない）。`npm test`、`npm run typecheck`、`npx cdk synth`、`npx cdk diff`。実クラスタにつないだ単体起動で、新しい SQL を確かめる。生成側を変えたら、本番と同じ件数の最終段まで、ローカルで通す。
2. コミットして、デプロイする（`cdk diff` を見せて承認）。
3. 較正を流す。合格基準 a・b を確かめ、パラメータと DPU を決める。
4. 決めた値をコミットし、`--dry-run` で費用を見積もり、承認を得て起動する。以降、PC を閉じてよい。
5. 回収し、`npm run analyze` で同じ結果を再現し、合格基準を判定する。通れば [report.md](report.md) に、結論と根拠を分けて書く。測定の後に、`events` テーブルの行を消す。翌日、Cost Explorer で請求と照合する。

**コマンド**
```sh
npm run suite-start -- --suite calibration --dry-run                    # 較正（小さな計画）の確認
npm run suite-start -- --suite measurement --seed 20261020 --dry-run   # 順序・待ち・終了の目安・費用の確認
npm run suite-start -- --suite measurement --seed 20261020             # 起動（タスク ID が表示される）
aws sso login                                                          # 回収のときに必要
npm run suite-fetch -- --task <タスク ID> --wait                       # 終了を待って回収（results/<日付>/）
npm run analyze -- results/<日付>                                      # 手元で同じ結果を再現し、表と合否を見る
npm run report-figures -- results/<日付>                               # 報告書の図を作り直す
```
- 起動の前に、作業ツリーをクリーンにし（コミットしてから）、そのコミットをデプロイしておく。起動時に、各関数が計画の `build` で応答することを確かめる。
- 1 セット（4 ケース、9 回）は約 2.5 時間。3 セットで約 5.4 時間（Fargate は約 $0.7）。
- 途中で止めるとき: `suite-start` が表示した `aws ecs stop-task ...`。
- 「毎回接続」の実行の後は、DSQL の接続の枠の回復が遅いので 15 分あける（計画に組み込み済み）。

## 結果のファイルの構成
実行ごとの結果は `results/<名前>/` に保存する。
- 回ごとに、`<ケース>-set<セット>-<順>-<構成>` を名前にした 5 つのファイルがある。
  - `.log`: 出力。
  - `.json`: 段ごとの集計（エンドポイント別を含む）。
  - `.meta.json`: タスク ID、時刻、終了コード。
  - `.metrics.json`: CloudWatch のメトリクス。
  - `.reports.json`: Event の `REPORT` 行の集計。
- セットごとの `suite-set<N>.manifest.jsonl`、計画の `suite.plan.json`、起動時の記録 `suite-<タスク ID>.start.json`（コミット・版・クォータ）、集計の `analysis.json`。
- ログは 30 日（`Gekko10LoadStack` のロググループは 1 か月）。

## ログとメトリクス
- Event のログ: `/aws/lambda/<関数名>`（`REPORT` 行に Init Duration）
- Web のログ: `/aws/lambda/web/<関数名>`（ホームリージョンへの集約は数十秒〜数分遅れる）と、`.local` 付きのグループ。保持期限は 1 週間に設定済み
- Web のメトリクス: 名前空間 `AWS/Lambda/Web`（FunctionName）と `AWS/Lambda/Web/Usage`（`EndpointActiveEnvironments` など）。リビジョンの次元はない。
- DSQL のメトリクス: 名前空間 `AWS/Usage`（`CallCount`, `ClusterConnectionCount`）と `AWS/AuroraDSQL`（DPU など）。次元と挙動は [findings.md](findings.md)。
- 失敗時: レスポンスヘッダ `lambda-web-error-type` を見る。Web Functions はデプロイが Active でもサーバーが起動していないことがあるので、まずログを確認する。

## 後片付け
```sh
npx cdk destroy Gekko10WebStack Gekko10EventStack   # 先に関数
npx cdk destroy Gekko10LoadStack                    # 負荷生成の定義（ECR のイメージは残る）
npx cdk destroy Gekko10DbStack                      # 最後にクラスタ（テーブルごと消える）
```
- Db スタックは Event / Web から参照されているので、先には消せない。Web のコード用バケットは `autoDeleteObjects` で中身ごと削除される。
- Web の動的な同時実行数の学習は関数に保持される。測定の期間中は Web スタックを destroy しない。
- CDK のブートストラップ用の ECR / S3 には、使われなくなった成果物が溜まる。`cdk gc --unstable=gc --type ecr`（または `s3`）で整理できる。まず `--action print` で対象を確かめる。
