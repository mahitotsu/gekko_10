# gekko_10

Lambda Web Functions と Event Functions（関数URL）を、Aurora DSQL をバックエンドにして比較する検証リポジトリ。
目的・仮説・計測項目は [docs/plan.md](docs/plan.md)、Web Functions の仕様は [docs/web-functions-notes.md](docs/web-functions-notes.md)。

現在の範囲: DB なしのエンドポイント（`/noop`, `/wait`）を、両方の形態で動かす。リージョンは ap-northeast-1。

## 構成
| パス | 役割 |
|---|---|
| `src/app.ts` | 共通の Hono アプリ。`/noop`, `/wait?ms=N`。環境の識別情報を返す |
| `src/entry-web.ts` | Web Functions 用。`AWS_LAMBDA_HTTP_ENDPOINT` で listen |
| `src/entry-event.ts` | Event Functions 用。`hono/aws-lambda` の `handle()` |
| `scripts/bundle.mjs` | 両方を同じ設定でバンドル（`dist/web`, `dist/event`） |
| `scripts/invoke.ts` | SigV4 署名付きリクエストを送る。並行実行と集計に対応 |
| `lib/constructs/*` | Event / Web それぞれの Construct。Web は L1 |
| `lib/event-stack.ts`, `lib/web-stack.ts` | `Gekko10EventStack`, `Gekko10WebStack` |

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
npx cdk synth          # 両スタックを合成（bundle も自動で走る）
npx cdk deploy Gekko10EventStack
npx cdk deploy Gekko10WebStack
```
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

## 後片付け
```sh
npx cdk destroy Gekko10WebStack Gekko10EventStack
```
Web のコード用バケットは `autoDeleteObjects` で中身ごと削除される。
