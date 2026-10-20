# Lambda Web Functions 調査メモ

**この文書の読み手:** Web Functions の仕様を、出典つきで確かめたい人。実機で確かめた事実は [findings.md](findings.md)、用語は [用語集](glossary.md)。この文書は、公式ドキュメントなどの仕様の調査メモで、自分たちの観測は書かない。

**目次:** 1 概要、2 リソースモデル、3 ランタイムとパッケージ、4 デプロイ方法、5 HTTP、6 スケーリング、7 認証とアクセス制御、8 メトリクスとログ、9 クォータと確認方法、10 料金、11 確認状況。

調査日: 2026-10-17。優先順位は 公式ドキュメント（Developer Guide・API リファレンス・CloudFormation リファレンス）＞ AWS ブログ ＞ 第三者ブログ。
第三者情報には「(第三者)」と付けた。実機で未確認のものは「未確認」と書いた。

出典の略称:
- [DG] https://docs.aws.amazon.com/lambda/latest/dg/ （以下、ページ名を併記）
- [API] https://docs.aws.amazon.com/lambda/latest/lambda-web/Welcome.md
- [CFN] https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/
- [Blog] https://aws.amazon.com/blogs/aws/announcing-aws-lambda-web-functions-for-fast-consistent-web-app-performance-anywhere/
- [Steele] https://awsteele.com/blog/2026/10/12/some-notes-on-lambda-web-functions.html (第三者)

## 1. 概要
- Web Functions は、ポートで listen する HTTP サーバーをそのままデプロイする Lambda の形態。
  - ハンドラやイベント変換は不要。
  - zip でデプロイし、Lambda が HTTPS エンドポイントを作る。
  - 0 台までスケールインする。 [DG web-functions.html]
- 課金はリクエスト数、アクティブな CPU 時間、環境が存在する間のメモリ、データ転送。 [DG web-functions.html]
- 現時点の対応は Node.js のみ（`nodejs24.x`、arm64）。 [DG web-functions-runtimes.html]
- 東京（ap-northeast-1）で利用可能（us-east-1/us-east-2/us-west-2/eu-west-1 も）。 [Blog]
- 他の形態: Event Functions（従来型）、MicroVMs（隔離されたステートフルな実行環境）。 [Blog]

## 2. リソースモデル
[DG web-functions-how-it-works.html]

| リソース | 内容 |
|---|---|
| Web Function | 最上位。名前・ARN・状態（Pending/Active/Failed/Deleting）。ここにタグとリソースポリシーを付ける |
| Revision | コードと設定の不変スナップショット。timeout、maxConcurrencyPerEnvironment、環境変数、実行ロールを持つ。設定を変えると新しいリビジョンになる。関数ごとに 50 個が自動削除の目安 |
| Endpoint | 固有のドメイン名（TLS 付き）、authType、スケーリング設定（maxEnvironments, rateLimit）、リビジョンの重み（最大 2 リビジョン）。関数あたり 10 個まで |

- リビジョンの状態: Pending → Active / Failed（Failed は戻らない）。エンドポイントは `state` と `updateStatus`（InProgress/Successful/Failed）の 2 つを持つ。
- **Active でもサーバーが起動する保証はない**。Lambda は listen の確認をしない。デプロイ後に必ずリクエストを送る。
- エンドポイントの種類: HomeRegion / MultiRegion / PerRegion。作成後に変更できない。今回は HomeRegion のみ。
- エンドポイントの autoDeploymentMode（LatestRevision / Disabled）は API・CLI にあるが、CloudFormation の `AWS::Lambda::WebFunctionEndpoint` にはない（下記 4）。

## 3. ランタイムとパッケージ
[DG web-functions-runtimes.html, web-functions-env-lifecycle.html, web-functions-revisions-env-vars.html, web-functions-code-s3.html]
- サーバーは環境変数 `AWS_LAMBDA_HTTP_ENDPOINT`（`host:port`）で listen する。**起動から 10 秒以内**。この変数は設定できない。
- エントリはパッケージ直下の `index.js`。変えるなら環境変数 `AWS_LAMBDA_NODEJS_ENTRYPOINT`。`package.json` の main は見ない。
- 環境は **2 vCPU / 2 GB 固定**、`/tmp` 512 MB、ファイル記述子 1,024、プロセス/スレッド 1,024。V8 のヒープのデフォルトは 1,024 MB（`NODE_OPTIONS` で変更）。
- パッケージは展開後 512 MB まで。arm64 向けにビルドする（ネイティブ依存がある場合）。
- 停止: 新規リクエストを止め、実行中を best-effort で待ち、SIGTERM を送る。**SIGTERM の後は 1 秒**で終了させられる。
- 予約済みの環境変数: `AWS_REGION`、`AWS_ACCESS_KEY_ID` 系、`AWS_LAMBDA_HTTP_ENDPOINT`、`AWS_LAMBDA_METADATA_*` など。
- メタデータエンドポイント（`AWS_LAMBDA_METADATA_API` + トークン）で AZ ID が取れる。 [DG web-functions-configuration-metadata-endpoint.html]
- (第三者) 関数名・リビジョン ID・ロググループは環境変数になく、ランタイム内部の `/load` レスポンスにしかない。`AWS_LAMBDA_FUNCTION_NAME` もない。 [Steele] → 環境の識別にはアプリ側の `envId` を使い、構成の識別には `APP_VARIANT` を環境変数で渡す。

## 4. デプロイ方法
[DG web-functions-create.html, web-functions-code-s3.html, CFN AWS::Lambda::WebFunction*]
- **コードは S3 からのみ**。
  - バケットは **バージョニング必須**。
  - バケットポリシーで `lambda.amazonaws.com` に `s3:GetObject`/`s3:GetObjectVersion` を許可し、`aws:SourceArn` を `arn:aws:lambda:<region>:<account>:web-function/<name>/revision/*` に絞る。
  - SSE-KMS ならキーポリシーにも許可が要る。
- リビジョンは S3 のオブジェクトバージョンに固定される。**そのバージョンを消すとリビジョンは Failed になり、復旧できない**。
- CLI: `aws lambda-web deploy --name X --code ./dir [--auth-type IamAuth] [--create]`。
  - バケットとロールは自動作成（デフォルト）。
  - デフォルトの認証は **ApplicationManaged（公開）** なので、非公開にするには `--auth-type IamAuth` が必要。
  - 低レベルの API は `create-web-function` / `create-web-function-revision` / `update-web-function-endpoint`。
- `lambda-web` コマンドは AWS CLI の新しいバージョンが必要。このマシンは 2.31.35 で、(第三者) 2.37.12 では `get-web-account-settings` しかなく 2.37.13 から全コマンドがある。 [Steele]
- **CloudFormation**: `AWS::Lambda::WebFunction`（名前とタグのみ）、`AWS::Lambda::WebFunctionRevision`、`AWS::Lambda::WebFunctionEndpoint` の 3 つに分かれる。
  - Revision の全プロパティは「更新で置き換え」。
  - Endpoint の `RevisionWeights` は更新で無停止。`AutoDeploymentMode` は CFN にない。
  - (第三者) コードを変えると CFN は新しいリビジョンを作ってエンドポイントを付け替え、古いリビジョンを削除する。ネイティブの重み付き（カナリア）は使いにくい。 [Steele]
  - 実機の確認（デプロイの成功、F3006 の警告、`BucketDeployment` の `objectKeys` とキーのプレフィックス、ロググループの `Arn` が `:*` で終わること）は [findings.md](findings.md) の §1-5。
- **CDK**: aws-cdk-lib 2.273.0 に L1 の `CfnWebFunction` / `CfnWebFunctionRevision` / `CfnWebFunctionEndpoint` がある。
  - L2 はない。
  - SAM には `AWS::Serverless::WebFunction` がある（第三者）。
  - このリポジトリは L1 で書いた。

## 5. HTTP
[DG web-functions-http.html]
- HTTP/1.1 のみ（1.0 は 505）。メソッドは GET/HEAD/POST/PUT/PATCH/OPTIONS/DELETE。WebSocket は不可（第三者で確認、[Steele]）。ストリーミングは設定なしで使える。
- リクエストヘッダの合計は 128 KiB まで。リクエストのタイムアウトは 3〜900 秒（デフォルト 30）。
- 追加されるリクエストヘッダ: `lambda-web-request-id`、`lambda-web-endpoint-name`。`X-Forwarded-For` は末尾に追記。
- IamAuth では署名した `Authorization` ヘッダを取り除いてからアプリに渡す。
- レスポンスヘッダ: `lambda-web-request-id`、`lambda-web-logstream`（どの環境のログかが分かる）、`lambda-web-error-type`（例 `Platform.EndpointRequestThrottle`、`Runtime.RequestTimeout`。内部エラーと認可エラーでは付かない）。
- 429: レート上限・環境数上限・アカウント上限・同時初期化の上限。`rateLimit = 0` のときは 503 + `Platform.EndpointDisabled`。

## 6. スケーリング
[DG web-functions-scaling.html]

| 設定 | 場所 | 範囲 | デフォルト |
|---|---|---|---|
| maxConcurrencyPerEnvironment | Revision | 1〜128 | 64 |
| maxEnvironments | Endpoint | 2〜10,000 | なし |
| rateLimit | Endpoint | 0〜10,000 RPS（1,000 以下は 100 の倍数、超えるなら 1,000 の倍数） | なし |

- **maxConcurrencyPerEnvironment は上限にすぎない**。
  - 実際の同時実行数の上限は Lambda が資源の使用状況から動的に決める。
  - 新しい関数では保守的な値から始まり、学習した値は 0 台までスケールインしても保持される。
  - **最初の負荷試験は環境が多めになる**ので、2 回目以降を使うように書かれている。
- 環境の先行スケールアップ（headroom）がある。急激な増加では、既存環境に空きがなければコールドスタートを待つ。
- 上限（maxEnvironments・アカウントの vCPU）に達し、空きもなければ **キューせず即 429**。環境が初期化中のときだけキューされる。
- **スケールの 2 つの次元**: 環境の数（水平）と、環境あたりの同時リクエスト数（Lambda が動的に管理）。**環境のサイズ（vCPU・メモリ）を自動で変える仕組み（垂直スケール）は、ドキュメントにない**（環境は 2 vCPU / 2 GB 固定）。 [DG web-functions-scaling.html]
- **環境数の増減**: 既存の環境が動的な上限に近づくと増やす。
  - 余力（headroom）を保つよう需要の先回りで増やす。
  - トラフィックが減ると、利用率の低い環境をドレイン（新規の振り分けを止め、実行中を best-effort で待ち、SIGTERM）して取り除く。
  - 0 台まで下がる。 [DG web-functions-scaling.html の Scale up / Scale down]
- **動的な上限の調整**: 新しい関数は保守的な値から始まり、リソースの使用状況に基づいて素早く調整される。
  - 調整の**信号（CPU / メモリ / レイテンシのどれか）と速さの数値は、ドキュメントに書かれていない**。
  - 実測で確かめる（[findings.md](findings.md) §1-1）。
- `maxConcurrencyPerEnvironment` の選び方（ドキュメントの助言）: I/O 待ち中心なら、既定より高くすると環境あたりの利用率が上がり、費用が下がる可能性がある。
  - CPU 中心なら、低くすると競合が減りレイテンシが安定するが、コールドスタートが増えうる。
  - メモリ中心なら、低くすると挙動が予測しやすい。 [DG web-functions-scaling.html の Choosing scaling settings]
- (第三者) maxEnvironments を小さく設定すると、バーストで 429 が多く出た。設定しない方がよいという報告。 [Steele]
- (第三者) 環境の寿命は 4.5〜10.5 分、リクエストの来ない環境は約 5 分で回収された。 [Steele]
- スケールインは環境の利用率が低いとき。0 台になるまで下がる。

## 7. 認証とアクセス制御
[DG web-functions-endpoint-access-control.html, web-functions-permissions.html]
- `IamAuth`: SigV4（サービス名 `lambda`、リージョンはエンドポイントのもの）。
  - MultiRegion は SigV4a。
  - **`X-Amz-Content-SHA256` ヘッダが必須**（本文がなくても。
  - 署名しないなら `UNSIGNED-PAYLOAD`）。
  - なければ 403。
- 呼び出しの IAM アクションは `lambda:InvokeWebFunctionEndpoint`。
  - リソースは `arn:aws:lambda:<region>:<account>:web-function/<name>/endpoint/<endpoint>`。
  - 同一アカウントなら呼び出し側の IAM ポリシーだけでよい。
- `ApplicationManaged`: Lambda は認証しない（誰でも呼べる）。リソースポリシーも評価されない。
- 公開されたリソースポリシー（Principal `*` など）は付けられない。
- CloudFront を前に置く場合は OAC（origin type `lambda`、署名は `always-amz-auth`）。
- 食い違い: [Blog] は認証を CloudFront OAC のように読める書き方をしているが、[DG] には直接の SigV4 が書かれている。
  - **[DG] を採る**。
  - 実機の確認と、関数URLとの `UNSIGNED-PAYLOAD` の扱いの違いは [findings.md](findings.md) の §1-4。

## 8. メトリクスとログ
[DG web-functions-monitoring.html, web-functions-monitoring-metrics.html]
無料。ホームリージョンに集約される（数分遅れ）。

| 名前空間 | メトリクス | 次元 |
|---|---|---|
| `AWS/Lambda/Web` | `ExecutedRequests`, `HTTPResponseStatusClass4XX`, `HTTPResponseStatusClass5XX`（Sum。4XX/5XX は疎） | FunctionName, EndpointName |
| `AWS/Lambda/Web` | `EnvironmentActiveTime`(ms), `EnvironmentCPUTime`(ms), `EnvironmentMaxMemoryUsage`(MB), `EnvironmentConcurrentRequests`(Max), `ResponseBytes`。環境ごとに 1 分に 1 回 | **FunctionName のみ**（EndpointName なし） |
| `AWS/Lambda/Web/Usage` | `ExecutedRequests`, `EndpointActiveEnvironments`(Max), `AccountRequestThrottles`, `EndpointRequestThrottles`, `AccountActiveVCPUArm64Throttles`, `EndpointActiveEnvironmentThrottles` | FunctionName, EndpointName, ExecutionRegion（集約されず、そのリージョンに残る） |

- **リビジョンの次元はない**。リビジョン別に見たいときは、環境変数でビルドを識別してログかカスタムメトリクス（EMF）に入れる。
- 同時初期化の 429 はどのスロットルメトリクスにも出ない。
- `EndpointActiveEnvironments` はリクエストがあるときだけ出る。
- ログ: `/aws/lambda/web/<name>.local`（各リージョン）→ `/aws/lambda/web/<name>`（ホームに集約）。
  - 実行ロールに両方への logs 権限が必要。
  - **どちらもデフォルトは保持期限なし**。 [DG web-functions-permissions.html]
- (第三者) システムログのイベント: `platform.initStart` / `initReport` / `invokeStart` / `invokeSummary`（1 分ごと。
  - リクエスト数・最大同時数・CPU・メモリ）/ `spinDownStart` / `spinDownReport`。
  - 環境の初期化は依存のないアプリで 253 ms。 [Steele]
- X-Ray のトレースヘッダは素通し。Lambda は追加しない。

## 9. クォータと確認方法
[DG gettingstarted-limits.html（Lambda Web Functions の節）, API GetWebAccountSettings]

| 項目 | 既定値 | 引き上げ |
|---|---|---|
| リクエスト/秒（アカウント、リージョンごと） | 100,000 | 可 |
| Arm64 vCPU（アカウント、リージョンごと。環境 1 つ = 2 vCPU） | 2,000（= 1,000 環境） | 可 |
| リクエスト/秒（エンドポイント） | 10,000 | 不可 |
| エンドポイント/関数 | 10 | 不可 |
| 1 エンドポイントが重みを割り当てるリビジョン | 2 | 不可 |

- **新規アカウントでは低く設定される**（使用実績に応じて自動で引き上げられる）。(第三者) 新しいアカウントで 200 vCPU（100 環境）/ 10,000 RPS だった。 [Steele]
- このアカウントの実測（ドキュメントの既定より低い）は [findings.md](findings.md) の §1-3。
- 確認: `aws lambda-web get-web-account-settings --region ap-northeast-1`（`GET /2025-03-07/web-account-settings`）。
  - レスポンスは `accountQuotas{maxEndpointsPerFunction, maxRevisionsPerFunction, maxTotalArmVCpus, maxTotalRateLimit}` と `accountUsage{functionCount}`。
  - Service Quotas のコンソールにも出る。

## 10. 料金
[https://aws.amazon.com/lambda/pricing/ ]（us-east-1）
- リクエスト $0.30 / 100 万
- CPU $0.0000276944 / vCPU 秒（実際に使った CPU 時間。1 ms 単位）
- メモリ $0.0000036667 / GB 秒（環境が存在する間の**消費メモリ**。アイドル中も課金される）
- データ転送は EC2 の料金に準ずる
- 東京の単価はページに載っていない。AWS Price List API（`AWSLambda` サービス）で取得する（取得した値は [findings.md](findings.md) に記録する）。

## 11. 確認状況
実機で確認したこと（IamAuth の SigV4、CloudFormation / CDK でのデプロイ、クォータ、メトリクスの一致、コスト計算に使う値）と、まだ確認していないことは [findings.md](findings.md) にまとめた。この文書は、仕様と出典の調査メモとして保つ。
