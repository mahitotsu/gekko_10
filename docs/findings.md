# 実機で確かめた事実

実際に動かして確かめたこと、ドキュメントと食い違ったこと、取得した単価をまとめる。各項目は **結論** と **根拠**（コマンド・出典・取得日）に分けて書く。
日付は 2026 年、リージョンは ap-northeast-1。検証の設計は [plan.md](plan.md)、構成は [architecture.md](architecture.md)。

## 1. Web Functions

### 1-1. 環境あたりの同時処理数は、最初は 1〜3 にしかならず、持続負荷で約 25 まで上がる（上がるまで 1〜2 分）
**結論**
- `maxConcurrencyPerEnvironment`（64）は上限にすぎず、動的な上限が保守的に始まる。最初の短い負荷では、環境あたりの同時処理は 1〜3、環境数は並行数の半分程度になる。
- 持続負荷（I/O 待ち）では上限が上がり、**わずか 4 環境で 100 並行を処理**した（環境あたり約 25）。仮説の前提（1 環境が複数リクエストを同時処理する）は成り立つが、上がるまでに 1〜2 分かかる。
- 測定ではこのウォームアップを捨てる。DSQL の測定では、上限がどこまで上がるかを先に調べる必要がある。

**根拠**（10-18、DB なしの `/wait`、手元の WSL から。性能の比較ではない）
- 50 並行の `/wait?ms=1000` を 1 回ずつ（最初の呼び出し直後）: Event は環境 38、最大同時処理 1。Web は環境 24、最大同時処理 2（3 回続けても 24〜26 環境、最大 1〜2）。
- 1,000 件・50 並行の `/wait?ms=500`（Web）: 環境 26、最大同時処理 3、コールドスタート 0。
- 持続負荷（`/wait?ms=1000`、並行 100、180 秒、約 1.7 万リクエスト、Web）: 最初の 10 秒は環境 13・環境あたりの最大同時処理 約 10。80 秒以降は 4 環境で、環境あたり約 25。レイテンシは 1,017 ms（待機 1,000 ms）で安定。エラーはクライアント側の接続タイムアウト 1 件のみ。
- ドキュメントの記述（[web-functions-notes.md](web-functions-notes.md) §6）と一致する。 https://docs.aws.amazon.com/lambda/latest/dg/web-functions-scaling.html

### 1-2. CloudWatch のメトリクスは、アプリ側の観測と一致する
**結論**: `EndpointActiveEnvironments`、`EnvironmentConcurrentRequests`、`ExecutedRequests` は、クライアントとアプリの観測と一致した。ただし 1 分より短い変化は見えない。

**根拠**（10-18）
- 1,000 件・50 並行で `EndpointActiveEnvironments` = 26、`EnvironmentConcurrentRequests` の最大 = 3。アプリ側と一致。
- 180 秒の持続負荷（並行 100）で、1 分ごとの `EndpointActiveEnvironments` が 13 → 10 → 4 → 4、`EnvironmentConcurrentRequests` の最大が 11 → 26 → 26 → 26。アプリ側（環境 13 → 10 → 4、環境あたりの最大 約 10 → 約 25）と一致。`ExecutedRequests` の合計 17,289 は、クライアントが送った件数と一致。
- 次元: `AWS/Lambda/Web/Usage` の `EndpointActiveEnvironments` は FunctionName, EndpointName, ExecutionRegion。`AWS/Lambda/Web` の `EnvironmentConcurrentRequests` は FunctionName のみ。
- コスト計算に使う値（同じ負荷の時間帯、1 時間の集計）: `EnvironmentCPUTime` の Sum = 40,105 ms（1 リクエストあたり約 2.3 ms）、`EnvironmentActiveTime` の Sum = 1,832,869 ms（約 1,833 環境秒）、`EnvironmentMaxMemoryUsage` の最大 = 206 MB。us-east-1 の単価で概算すると約 $0.008（リクエスト $0.0052 + CPU $0.0011 + メモリ 最大でも $0.0014）。

### 1-3. このアカウントの Web のクォータは、ドキュメントの既定より低い
**結論**: 100 環境（200 vCPU）、10,000 RPS。負荷試験の前に、引き上げの申請が要る。環境あたりの同時処理が 2〜3 だと、100 環境で約 200〜300 同時、500 ms の処理なら約 400〜600 RPS が上限になり、スループットの上限を測る前にクォータに当たる。

**根拠**（10-18）
- `aws lambda-web get-web-account-settings --region ap-northeast-1`: `maxTotalArmVCpus` = 200、`maxTotalRateLimit` = 10,000、`maxEndpointsPerFunction` = 10、`maxRevisionsPerFunction` = 50。
- ドキュメントの既定: 100,000 RPS / 2,000 vCPU。新しいアカウントでは低く設定される。 https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html

### 1-4. IamAuth への直接の SigV4 が通る。関数URLと Web Functions で `UNSIGNED-PAYLOAD` の扱いが違う
**結論**
- IamAuth のエンドポイントは、署名なしが 403、サービス名 `lambda` の SigV4 署名付きが 200。ブログは認証を CloudFront の OAC のように読める書き方だが、ドキュメントの直接の SigV4 が正しい。
- Web Functions は `x-amz-content-sha256` が必須。**関数URLは `UNSIGNED-PAYLOAD` を付けると署名不一致で 403 になる**（付けない、または空ボディの実際の SHA-256 `e3b0c442…b855` なら 200）。両方に通る値として、空ボディの実際の SHA-256 を使う。

**根拠**（10-18、実機）: `scripts/invoke.ts` と curl（`--aws-sigv4`）で確認。仕様は https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html

### 1-5. CloudFormation / CDK で Web Functions をデプロイできる。S3 のキーに注意
**結論**
- `AWS::Lambda::WebFunction` / `WebFunctionRevision` / `WebFunctionEndpoint` と S3 バケットの構成で、デプロイは成功する（Revision と Endpoint は Active）。CDK の検証の `Unknown resource type 'AWS::Lambda::WebFunction'`（F3006）の警告は、CDK 側のスキーマが古いだけで、デプロイには影響しない。
- `BucketDeployment`（`extract: false`）の `objectKeys` が返すのは zip の**ファイル名だけ**。`destinationKeyPrefix` を付けると、Revision が存在しないキーを探して失敗する。プレフィックスを付けずバケット直下に置く。
- CloudFormation のロググループの `Arn` 属性は `:*` で終わる。IAM に使うときは `:*` を足さない。

**根拠**（10-18）: 初回のデプロイで、プレフィックスを付けた場合に Revision が失敗し、外すと成功した。

### 1-6. 手元の WSL から東京への接続は不安定で、レイテンシは使えない
**結論**: IPv6 の到達不能と TCP 接続のタイムアウトが散発する。手元からのレイテンシは新規 TLS 接続の確立を含み、p50 が 2 秒前後になった（持続負荷では約 516 ms、待機 500 ms）。比較は東京の Fargate タスクから行う。

**根拠**（10-18）: 同じ `/noop` への p50 は、手元の WSL で 28 ms、Fargate タスクで 13 ms。

## 2. Aurora DSQL

### 2-1. 公式コネクタの依存関係は、ドキュメントの記述と異なる
**結論**: `@aws-sdk/credential-providers`、`@aws-sdk/dsql-signer`、`@smithy/types` は通常の依存で、ピア依存は `pg ^8.16.3` と `pg-connection-string ^2.7.0`。ドキュメントのページはこの 3 つ（credential-providers, dsql-signer, pg）をピア依存として書いているが、実際と異なる。オプション名は、ドキュメントの表が `username`、型とサンプルは `user`。型を採った。

**根拠**: `npm view @aws/aurora-dsql-node-postgres-connector@0.1.9`、`dist/index.d.cts`（https://unpkg.com/@aws/aurora-dsql-node-postgres-connector@0.1.9/）。ドキュメント: https://docs.aws.amazon.com/aurora-dsql/latest/userguide/SECTION_program-with-dsql-connector-for-node-postgres.html

### 2-2. `AuroraDSQLPool.connect()` は、空き接続を再利用するときも毎回トークンを署名する
**結論**: プールには、接続の確立は省けても、取得ごとのローカル署名（トークンの生成。AWS への呼び出しはない）が残る。実測ではこのコストは約 1 ms 以下。`AuroraDSQLClient` は `connect()` の 1 回だけ。比較の注記に入れる。

**根拠**: コネクタ 0.1.9 の `dist/index.mjs`（`connect()` が毎回 `getDSQLToken` を呼ぶ）。`customCredentialsProvider` を渡さない場合は `fromNodeProviderChain({profile})` を使う。実測は §2-3。

### 2-3. 3 つの接続モードは実クラスタで動く
**結論**: `each` は毎回新しい接続、`reuse` は 2 回目以降の接続取得が約 0.02 ms、`pool` は空き接続の取得が約 1 ms 以下（20 並行で接続 19 本、待ち 0）。

**根拠**（10-18）
- ローカルのバンドルを実クラスタにつないで確認。Lambda の 4 つの関数にも数回ずつ呼んで確認（全件成功）。
- 接続の確立: 手元の WSL から約 120〜300 ms、Lambda から約 130〜270 ms（コールドスタート）、2 回目以降の each で 17〜116 ms。性能の比較には使えない。

### 2-4. DSQL 側の接続数は、`AWS/Usage` の `CallCount` と `ClusterConnectionCount` で見られる。粒度は 1 分
**結論**
- `CallCount`（Resource=`DbConnectAdmin`）は**接続の試行回数と一致**した。接続レート（100/秒）の消費量として使える。時間粒度は 1 分で、`Period=1` を指定しても 1 分境界の点しか返らない。
- `ClusterConnectionCount` は、**接続が開いている間だけ現れ、1 分に 1 サンプルの瞬間値**。接続が閉じた分には点が出ない。短命の接続（each）は、ほとんど見えない。each の接続数は `CallCount` で見る。
- 短いピークを見逃すので、アプリ側（`db.pool`、`envConnectionsCreated`）でも記録する。

**根拠**（10-18、`aws cloudwatch get-metric-statistics`）
- `CallCount`: ローカルでの確認の合計 25（each 4 + pool 19 + reuse 1 + db-setup 1）が 25。Lambda への 8 回の接続が 6 + 2（2 つの分に分かれて）で 8。
- `ClusterConnectionCount`: 開いていた接続は reuse と pool の 2 本で、`Maximum` = 2、`SampleCount` = 1。
- 次元（`CallCount`）: `Type=API`, `ResourceId=cluster/<id>`, `Resource=DbConnectAdmin`, `Service=AuroraDSQL`, `Class=None`。`ClusterConnectionCount`: 名前空間 `AWS/Usage`、メトリクス名 `ResourceCount`、`Type=Resource`、`Resource=ClusterConnectionCount` ほか同じ。DPU 系は名前空間 `AWS/AuroraDSQL`、次元 `ClusterId`（`TotalDPU`, `ComputeDPU`, `ReadDPU`, `WriteDPU`, `CommitLatency` など）。
- その他のメトリクス（名前空間 `AWS/AuroraDSQL`）: `MultiRegionWriteDPU`, `TotalTransactions`, `OccConflicts`, `QueryTimeouts`, `CommitLatency`（P50）, `ComputeTime`。
- ドキュメント: https://docs.aws.amazon.com/aurora-dsql/latest/userguide/cloudwatch-monitoring.html

### 2-5. CDK では L1 の `CfnCluster` で作る（L2 はない）
**結論**
- プロパティは `deletionProtectionEnabled`, `kmsEncryptionKey`, `multiRegionProperties`, `policyDocument`, `tags`。単一リージョンで、`deletionProtectionEnabled: false` にして検証後に消せるようにした。
- 属性は `attrEndpoint`（接続先ホスト名 `<id>.dsql.<region>.on.aws`）、`attrIdentifier`、`attrResourceArn`、`attrStatus`。
- 実行ロールには、admin ロールで接続する場合は `dsql:DbConnectAdmin`、独自のデータベースロールの場合は `dsql:DbConnect` を付ける。

**根拠**: aws-cdk-lib 2.273.0 の `aws-cdk-lib/aws-dsql/lib/dsql.generated.d.ts`（`node_modules` を確認）。認証の仕様: https://docs.aws.amazon.com/aurora-dsql/latest/userguide/SECTION_authentication-token.html

### 2-6. クォータとエラーコード（ドキュメントの値）
| 項目 | 値 | 引き上げ | エラー |
|---|---|---|---|
| 接続の総数 | 10,000 / クラスタ | 可 | `TOO_MANY_CONNECTIONS(53300)` |
| 接続レート | 100 / 秒 | **不可** | `CONFIGURED_LIMIT_EXCEEDED(53400)` |
| 接続のバースト | 1,000 | 不可 | なし |
| 接続の最長 | 60 分 | 不可 | なし |
| トランザクションの最長 | 5 分 | 不可 | `54000` |
| 1 トランザクションで変更できる行 | 3,000 | 不可 | `54000` |

**根拠**: https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html 。認証トークンの生成はローカルの署名処理で、既定の有効期限は 15 分（最長 1 週間）。接続が確立した後は、トークンが失効しても接続は有効なまま（https://docs.aws.amazon.com/aurora-dsql/latest/userguide/SECTION_authentication-token.html ）。

## 3. 負荷生成（Fargate）

### 3-1. Fargate タスクから `invoke.ts` を実行でき、終了後に課金は止まる
**結論**: Web の noop と Event の DSQL（reuse）に、それぞれ 20 件・30 件を流して全件 200。タスクの終了後に `list-tasks` は空だった。生成側の CPU は 0.21 コア（利用可能 2）で余裕がある。

**根拠**（10-18）: `scripts/load-run.sh` の出力（終了コード 0）、`aws ecs list-tasks`。

### 3-2. 単価（東京、AWS Price List API）
| 項目 | 単価 | 出典（usagetype） |
|---|---|---|
| Fargate x86_64 vCPU | $0.05056 / 時間 | `APN1-Fargate-vCPU-Hours:perCPU`（`--service-code AmazonECS`） |
| Fargate x86_64 メモリ | $0.00553 / GB・時間 | `APN1-Fargate-GB-Hours` |
| public IPv4（使用中） | $0.005 / 時間 | `APN1-PublicIPv4:InUseAddress`（`--service-code AmazonVPC`） |
| ECR の保管 | $0.10 / GB・月 | `APN1-TimedStorage-ByteHrs`（`--service-code AmazonECR`） |

- 取得日 10-18、価格表の公開日 09-11。`aws pricing get-products --region us-east-1 --service-code <code> --filters Type=TERM_MATCH,Field=usagetype,Value=<usagetype>`
- 2 vCPU / 4 GB のタスク 1 つは、1 時間あたり約 $0.128（2 × 0.05056 + 4 × 0.00553 + 0.005）。
- Fargate On-Demand vCPU のクォータは 140（`aws service-quotas get-service-quota --service-code fargate --quota-code L-3032A538`）。2 vCPU のタスクは最大 70 並列。
- 東京の Lambda の単価と、DSQL の DPU 単価は、まだ取得していない。

## 4. 未確認
- `53400` / `53300` が実際にどの SQLSTATE とメッセージで返るか（負荷試験で接続レートに達したときに確認する）。
- `reuse` の再接続（凍結から復帰した後に接続が切れていた場合）の実機での挙動。単体テストでは確認済み。
- 東京の Lambda（リクエスト、Arm の GB 秒、Web Functions の CPU・メモリ）と DSQL の DPU の単価。
- 関数URLに追加料金がないこと。
- CloudFormation でリビジョンを置き換えたときの、旧リビジョン削除とトラフィックの切り替え順序。
- Web のシステムログのイベント（`platform.*`）の実際の形式。
