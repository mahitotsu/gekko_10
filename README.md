# gekko_10

Lambda Web Functions と Event Functions（関数URL）を、Aurora DSQL をバックエンドにして比較する検証リポジトリ。
目的・仮説・計測項目は [docs/plan.md](docs/plan.md)、Web Functions の仕様は [docs/web-functions-notes.md](docs/web-functions-notes.md)。

現在の範囲: DB なしのエンドポイント（`/noop`, `/wait`）と、Aurora DSQL につなぐエンドポイント（`/db/ping`, `/db/read`）を、両方の形態で動かす。リージョンは ap-northeast-1。

## 構成
| パス | 役割 |
|---|---|
| `src/app.ts` | 共通の Hono アプリ。`/noop`, `/wait?ms=N`, `/db/ping`, `/db/read`。環境の識別情報を返す |
| `src/db.ts` | DSQL への接続層。`each` / `reuse` / `pool` の 3 モード（公式コネクタを使う） |
| `src/entry-web.ts` | Web Functions 用。`AWS_LAMBDA_HTTP_ENDPOINT` で listen |
| `src/entry-event.ts` | Event Functions 用。`hono/aws-lambda` の `handle()` |
| `scripts/bundle.mjs` | 両方を同じ設定でバンドル（`dist/web`, `dist/event`） |
| `scripts/invoke.ts` | SigV4 署名付きリクエストを送る。並行実行と集計に対応（失敗の内訳、新規接続の割合、接続取得時間） |
| `scripts/db-setup.ts` | `items` テーブルの作成と 1,000 行の投入（冪等） |
| `lib/constructs/*` | Event / Web それぞれの Construct。Web は L1 |
| `lib/load-stack.ts` | `Gekko10LoadStack`: 負荷生成用の Fargate タスク定義（常設のリソースなし） |
| `load/Dockerfile`, `scripts/bundle-load.mjs` | 負荷生成イメージ（`invoke.ts` を 1 ファイルにバンドル） |
| `scripts/load-run.sh` | 東京の Fargate タスクとして `invoke.ts` を実行し、結果を表示する |
| `lib/db-stack.ts` | `Gekko10DbStack`: DSQL クラスタ（`CfnCluster`、パブリックエンドポイント、削除保護なし） |
| `lib/event-stack.ts`, `lib/web-stack.ts` | `Gekko10EventStack`, `Gekko10WebStack`: 構成のリストから関数を作る。構成を足すときはリストに 1 行足す |

### 関数の一覧
| 関数 | `DB_MODE` | 接続の持ち方 |
|---|---|---|
| `gekko10-event-noop`, `gekko10-web-noop` | なし | DB なし |
| `gekko10-event-dsql-each`, `gekko10-web-dsql-each` | `each` | リクエストごとに接続して閉じる |
| `gekko10-event-dsql-reuse` | `reuse` | 環境内で 1 接続を保持して再利用（60 分の上限の前に張り直す。切れていたら 1 回だけ再接続して再試行） |
| `gekko10-web-dsql-pool` | `pool` | 環境内で `AuroraDSQLPool` を共有（`DB_POOL_MAX` = 64 = maxConcurrencyPerEnvironment） |

Web の関数を構成ごとに分けているのは、メトリクスにリビジョンの次元がなく、動的な同時実行数の学習が関数単位だから。

### レスポンス
`/noop` と `/wait` は次の JSON を返す。

| フィールド | 意味 |
|---|---|
| `variant` | 環境変数 `APP_VARIANT`（`event-noop` / `web-noop`） |
| `envId` | 実行環境の起動時に作る UUID。同じ環境なら同じ値 |
| `coldStart` | この環境で最初のリクエストなら true |
| `requestCount` | この環境で受け付けた通算のリクエスト数（今回の分を含む） |
| `inFlight` | 受け付けた時点の同時処理数（今回の分を含む） |
| `maxInFlight` | この環境での同時処理数の最大値（`/wait` は完了時点） |
| `requestId` | Web Functions の `lambda-web-request-id`（Event では null） |
| `waitedMs` | `/wait` のみ |

`/wait?ms=N` の N は 0〜25000 の整数。範囲外・不正は 400。

### `/db/*`
- `/db/ping`: `SELECT 1`。接続のコストだけを見る基準。
- `/db/read?id=N`: `SELECT id, payload FROM items WHERE id = $1`（N は 1〜1000、省略するとランダム）。
- `DB_MODE` が未設定の関数（noop）では 501。

上のフィールドに加えて、`rows` と `db` を返す。

| `db` のフィールド | 意味 |
|---|---|
| `mode` | `each` / `reuse` / `pool` |
| `newConnection` | このリクエストで接続を新しく作ったか。pool では「プールの接続の初回の使用」 |
| `reconnected` | reuse のみ。共有していた接続が切れていて、再接続して再試行した |
| `acquireMs` | 接続が使えるようになるまで。each は接続の確立、reuse は 0（再接続時のみ確立）、pool は `pool.connect()`（トークンの署名を含む） |
| `queryMs`, `releaseMs` | 問い合わせ、解放（each は `end()`、pool は `release()`） |
| `connectionAgeMs` | 使った接続の経過時間（reuse, pool） |
| `pool` | `{ total, idle, waiting }`（pool のみ） |
| `envConnectionsCreated` | この環境が作った接続の通算数 |
| `envConnectErrors` | この環境での接続エラーの通算数。`53400`（接続レート）/ `53300`（接続の総数）/ `other` |

失敗したときは 503 で、`ok:false`、`error`、`code`（上の 3 分類）、`sqlstate`、`phase`（`connect` / `query`）を返し、同じ内容を 1 行の JSON ログ（`"event":"db_error"`）にも出す。成功したリクエストはログに出さない。DSQL が接続の拒否を SQLSTATE `53400` / `53300` で返すかは未確認なので、メッセージ（`rate exceeded` / `too many open connections`）でも判定している。

## 前提
- Node.js 24、npm
- AWS CLI v2 の新しいバージョン（`lambda-web` コマンドが必要。2.31.35 では使えず、2.38.1 で動作を確認した。apt 版は古いので、公式インストーラで入れる）
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

## synth とデプロイ
```sh
npx cdk synth          # 3 スタックを合成（bundle も自動で走る）
npx cdk deploy Gekko10DbStack     # 先に DSQL クラスタだけを作る
npm run db-setup -- <Gekko10DbStack の Endpoint>   # テーブルと 1,000 行
npx cdk deploy Gekko10EventStack Gekko10WebStack
```
- Event と Web は Db スタックの出力を参照する（CDK が依存を付ける）。Event と Web の間に依存はない。
- 他の `cdk` コマンドが動いている間は、`cdk.out` が競合して `Other CLIs ... are currently reading from cdk.out` で失敗する。並行して `synth` / `diff` したいときは `--output <別ディレクトリ>` を付ける。
- デプロイの前に、バンドルを実クラスタにつないで確かめられる: `DB_MODE=each|pool DSQL_ENDPOINT=<Endpoint> AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node dist/web/index.js`（`eval "$(aws configure export-credentials --format env)"` で認証情報を出しておく）。
- `cdk synth` で `Unknown resource type 'AWS::Lambda::WebFunction'`（F3006）の警告が出るが、CDK 側の検証スキーマが新しいリソースタイプを知らないだけで、合成は成功する。
- Web スタックは専用の S3 バケット（バージョニング有効）にコードを置く。Web Functions は S3 のコードしか受け付けず、バケットポリシーで Lambda サービスに読み取りを許可する必要があるため。コードを変えると新しいリビジョンが作られ、古いリビジョンは削除される。
- デプロイ後の出力: Event は `Url`（関数URL）、Web は `EndpointUrl`・`EndpointArn`。
- 認証はどちらも IAM。署名なしのリクエストは 403 になる。

### アカウントのクォータ確認（Web Functions）
```sh
aws lambda-web get-web-account-settings --region ap-northeast-1
```
`accountQuotas.maxTotalArmVCpus`（環境 1 つ = 2 vCPU）と `maxTotalRateLimit`（RPS）を確認する。新しいアカウントは低いことがある。

## 動作確認（デプロイ後）
### 呼び出す側の IAM 権限
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

DSQL 用の関数が増えたので、上の例の Resource は関数ごとに足す（Web は `web-function/gekko10-web-dsql-each/endpoint/main` など）。

### 1. 署名なしは拒否される
```sh
curl -i "<Event の Url>noop"          # 403
curl -i "<Web の EndpointUrl>/noop"   # 403
```

### 2. SigV4 署名付きリクエスト
`scripts/invoke.ts` は両方に使える（サービス名は `lambda`、`x-amz-content-sha256` を常に付ける。Web Functions では必須）。ヘッダの値は空ボディの SHA-256 にする。**関数URLは `UNSIGNED-PAYLOAD` を付けると署名不一致で 403 になる**（実機で確認）ので、両方に通る実際のハッシュを使っている。
```sh
npm run invoke -- https://<id>.lambda-url.ap-northeast-1.on.aws --path /noop
npm run invoke -- https://<id>.<...>.lambda-web.ap-northeast-1.on.aws --path /noop
npm run invoke -- <url> --path "/wait?ms=500"
```
curl で試す場合（関数URLで確認済み。SSO なら `eval "$(aws configure export-credentials --format env)"` で認証情報を環境変数に出す。一時認証情報なので `x-amz-security-token` が必要）:
```sh
curl --aws-sigv4 "aws:amz:ap-northeast-1:lambda" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  -H "x-amz-security-token: $AWS_SESSION_TOKEN" \
  -H "x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" \
  "<url>/noop"
```

### 3. 同時処理と環境の共有を観測する
同じ `/wait` を並行 50 件で送る。
```sh
npm run invoke -- <url> --path "/wait?ms=1000" --count 50 --concurrency 50
```
出力の `distinctEnvironments`（使われた環境の数）と `maxInFlightObserved`（環境内の最大同時処理数）を見る。

| | 期待 |
|---|---|
| Web Functions | 環境内で同時に処理される（`maxInFlightObserved` が 1 より大きい）。ただし最初は動的な上限が保守的で、環境数は並行数の半分程度、同時処理は 2〜3 程度だった（実測） |
| Event Functions | 環境が並行数に近い数に増え、`maxInFlightObserved` は常に 1 |

学習された同時実行数の上限は関数に保持されるので、繰り返すほど Web の環境数は減る可能性がある。実測では 3 回続けても 24〜26 環境だった（詳細は [docs/plan.md](docs/plan.md) の「初回の実機観測」）。
手元からのレイテンシは、新規接続の確立を含むので比較には使えない。

### 4. ログとメトリクス
- Event: `/aws/lambda/gekko10-event-noop`（`REPORT` 行に Init Duration）
- Web: `/aws/lambda/web/gekko10-web-noop`（ホームリージョンへの集約は数十秒〜数分遅れる）と、`.local` 付きのグループ。保持期限は 1 週間に設定済み
- Web のメトリクス: 名前空間 `AWS/Lambda/Web`（FunctionName=`gekko10-web-noop`）と `AWS/Lambda/Web/Usage`（`EndpointActiveEnvironments` など）。リビジョンの次元はない。
- 失敗時: レスポンスヘッダ `lambda-web-error-type` を見る。Web Functions はデプロイが Active でもサーバーが起動していないことがあるので、まずログを確認する。

## 負荷生成（東京の Fargate タスク）
手元の WSL からは通信が不安定でレイテンシも使えないので、東京の Fargate タスクから `invoke.ts` を実行する。使うときだけ起動し、終われば課金が止まる（詳細・費用・根拠は [docs/plan.md](docs/plan.md) の §9）。
```sh
npx cdk deploy Gekko10LoadStack     # 初回のみ。イメージが ECR に push される
scripts/load-run.sh -- https://<endpoint> --path /db/read --duration 300 --concurrency 100
```
- 出力の `loadgenCoresUsed` が `loadgenCoresAvailable`（2）に近いときは、生成側が飽和しているので、その結果は採用しない。
- 負荷の本番実行の前には、費用の見積もりを出して承認を得る。

## 後片付け
```sh
npx cdk destroy Gekko10WebStack Gekko10EventStack   # 先に関数
npx cdk destroy Gekko10LoadStack                    # 負荷生成の定義（ECR のイメージは残る）
npx cdk destroy Gekko10DbStack                      # 最後にクラスタ（テーブルごと消える）
```
Db スタックは Event / Web から参照されているので、先には消せない。Web のコード用バケットは `autoDeleteObjects` で中身ごと削除される。
Web の動的な同時実行数の学習は関数に保持される。測定の期間中は Web スタックを destroy しない。
