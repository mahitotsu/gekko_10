# 実機で確かめた事実

実際に動かして確かめたこと、ドキュメントと食い違ったこと、取得した単価をまとめる。各項目は **結論** と **根拠**（コマンド・出典・取得日）に分けて書く。
日付は 2026 年、リージョンは ap-northeast-1。検証の設計は [plan.md](plan.md)、構成は [architecture.md](architecture.md)。

> **予備測定のデータについて**: 根拠に挙げた `results/2026-10-18/`、`results/2026-10-19/`（予備測定。測定の定義を作り直す前のもの）は、リポジトリから削除した。必要なときは、コミット 5a769a1 から取り出せる（`git show 5a769a1:results/2026-10-18/<ファイル>`、または `git checkout 5a769a1 -- results/2026-10-18 results/2026-10-19`）。

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

### 1-3. このアカウントの Web のクォータは、使用実績に応じて自動で引き上げられた
**結論**
- 最初は 100 環境（200 vCPU）、10,000 RPS で、ドキュメントの既定より低かった。**同じ日のうちに、400 環境（800 vCPU）、40,000 RPS に上がっていた**（申請はしていない）。ドキュメントの「使用実績に応じて自動で引き上げられる」と一致する。
- クォータは変わるので、負荷試験の前に毎回確認する。1 エンドポイントの上限 10,000 RPS は引き上げ不可（変わらない）。

**根拠**（`aws lambda-web get-web-account-settings --region ap-northeast-1`）
- 10-18 の朝: `maxTotalArmVCpus` = 200、`maxTotalRateLimit` = 10,000。
- 10-18 の夜（B0 の後）: `maxTotalArmVCpus` = 800、`maxTotalRateLimit` = 40,000、`maxEndpointsPerFunction` = 10、`maxRevisionsPerFunction` = 50。
- 引き上げの時期は不明。B0 で 198 環境が同時に動いた（§1-7）ので、その時点では 100 環境を超える上限だった。
- ドキュメントの既定: 100,000 RPS / 2,000 vCPU。 https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html

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

### 1-7. ゼロからの 400 RPS では、環境が約 200 個に増える。環境は負荷の後も約 5 分残る
**結論**
- 一度も負荷をかけていない関数に、いきなり 400 RPS を送ると（同時に必要なのは 4 程度）、環境が **198 個**（`pool`）と **176 個**（`each`）に増えた。環境あたりの同時処理は最大 2。コールドスタート中の要求が溜まり、その分だけ新しい環境が作られるためと考えられる（ドキュメントも「急な増加はコールドスタートを待つ」と書く）。
- 環境は負荷が終わった後も、約 5 分残って課金される（メモリは環境が存在する間ずっと課金）。この 1 回（60 秒）の `pool` の実行だけで、環境の存在時間は約 67,600 環境秒、メモリ分の費用は約 $0.05 で、リクエスト・CPU の費用（約 $0.015）を上回る。
- `pool` は全件成功、スロットルなし。遅延は p50 10 ms、p95 15 ms、p99 235 ms（コールドスタートの尾）。接続取得は p50 0.5 ms。ただし接続は **約 291 本**（環境 198 個 + 同時処理 2 の環境で追加）作られた。環境が多いと、接続を共有する効果（接続数の削減）は薄れる。公平な比較は、同じレートの段階的な負荷（P1）で行う。
- `each` は、400 RPS で成功 7,080 件（118/秒）、失敗 16,920 件（すべて `503 db:53400/connect`）。7,080 は「バースト 1,000 + 100/秒 × 60 秒 = 7,000」に一致し、Web でも §2-7 のモデルが成り立つ。

**根拠**（10-18 23:01〜23:07 JST、`results/2026-10-18/b0-*`（5a769a1））
- `pool`: 24,000 件、全件成功、`EndpointActiveEnvironments` 198、`EnvironmentConcurrentRequests` 最大 2、4XX・5XX・スロットル 0、`CallCount` 291、`ClusterConnectionCount` 最大 355（Event の `reuse` の 64 本を含む）。`EnvironmentActiveTime` の合計が約 6,760 万 ms（67,600 環境秒）。
- `each`: 24,000 件、`EndpointActiveEnvironments` 176、5XX 16,920（アプリが返した 503）、スロットル 0、`CallCount` 24,000（失敗した試行を含む）。
- 費用の実績の概算（Price List 東京の単価、§3-3）: `pool` 約 $0.07、`each` 約 $0.03。

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

### 2-7. 接続レートの上限は効く。使い切った後の回復は、ドキュメントの「100/秒」より遅い
**結論**
- 「毎回接続」で上限に当たると、超えた分の接続は `53400` で失敗する。SQLSTATE は `53400`、メッセージは `unable to accept connection, rate exceeded`。アプリの判定は、SQLSTATE とメッセージのどちらでも一致した。失敗は速く返り（Lambda の `Duration` は全体の平均 45 ms）、タイムアウトまで長引かない。
- 300 RPS を 20 秒送ると、成功は 2,920 件で、ドキュメントの「バースト 1,000 + 100/秒 × 20 秒 = 3,000」にほぼ一致した。
- 失敗した接続の試行も `CallCount` に数えられる。
- **枠を使い切った後の回復は、ドキュメントの「100/秒」から期待する時間より遅い**。使い切って 2 分 18 秒後には、コールドスタート 63 回（2 秒間、毎秒 約 30 本）の接続のうち 19 件が失敗した。9 分後と 15 分後には失敗しなかった。回復の曲線（何分で戻るか）は測っていない。原因は確定していない。
- 測定への含意: 「毎回接続」の実行（高いレートの段）の後は、DSQL に新しく接続する実行（コールドスタートを含む）の前に、十分な間隔をあける。

**根拠**（10-18、東京の Fargate から。`results/2026-10-18/`（5a769a1））
- A2: `gekko10-event-dsql-each` に 300 RPS を 20 秒（6,000 件）。成功 2,920、失敗 3,080（すべて `503 db:53400/connect`）。`CallCount` 合計 6,000。ログの 220 行はすべて SQLSTATE `53400`。
- A3: `gekko10-event-dsql-reuse` に 100 RPS を 5 分（30,000 件）。開始は A2 の終了から 2 分 18 秒後。成功 29,981、失敗 19（`53400`）。失敗はすべて開始直後の 2 秒間（コールドスタート 63 回）。
- A5: `gekko10-web-dsql-each` に 100 RPS を 10 秒（接続 1,000 回）。A2 の約 9 分後。全件成功。
- A6: 15 分休ませた後、`gekko10-event-dsql-reuse` に 100 RPS を 30 秒（3,000 件）。コールドスタート 64 回（2 秒間）。全件成功。
- ドキュメントの値: 接続レート 100/秒、バースト 1,000、補充 100/秒（§2-6）。
- 未確認: `53300`（接続の総数）の実際のメッセージ。10,000 本には届かない設計のため、発生させていない。

### 2-8. DSQL の DPU は、接続の確立が大きい
**結論**
- 接続を使い回すと、読み取り 1 件あたり約 **0.005 DPU**（読み取り 0.0038、計算 0.0011）。1 リクエストが約 1 トランザクション。
- 毎回接続では、成功 1 件あたり約 **0.032 DPU**（計算が約 0.023）。**接続の確立に、計算の DPU が約 0.02〜0.03 かかる**ように見える。失敗した試行が DPU を使うかは不明（使うなら、成功 1 件あたりの値は過大）。
- 1 リクエストあたりの DSQL 費用: 使い回しで約 $0.00000005、毎回接続で約 $0.0000003（$0.00001 / DPU）。

**根拠**（10-18、`AWS/AuroraDSQL` の `TotalDPU` など、1 分粒度）
- A3 の時間帯（22:35〜22:41）: `TotalDPU` 147.2（読み取り 113.9、計算 33.3）、`TotalTransactions` 30,083、成功 29,981 件。
- A2 の 2 分間: `TotalDPU` 93.7（計算 67.9、読み取り 25.8）、成功 2,920 件、失敗の試行 3,080 件。

## 3. 負荷生成（Fargate）

### 3-1. Fargate タスクから `invoke.ts` を実行でき、終了後に課金は止まる
**結論**: Web の noop と Event の DSQL（reuse）に、それぞれ 20 件・30 件を流して全件 200。タスクの終了後に `list-tasks` は空だった。生成側の CPU は 0.21 コア（利用可能 2）で余裕がある。

**根拠**（10-18）: `scripts/load-run.sh` の出力（終了コード 0）、`aws ecs list-tasks`。

### 3-1b. 生成側の能力（2 vCPU の Fargate タスク）
**結論**: 2 vCPU は、段階 4 の最大レート（1,600 RPS）に十分。1 コアで約 5,000 RPS を出せる。到着レート固定（`--rate`）の送信は、予定どおりに出る（遅れ 0%）。

**根拠**（10-18、Web の noop）
- 並行 50 の closed を 60 秒: 約 29.4 万件、約 4,900 RPS、使用 1.08 コア、全件成功。
- `--rate` の open: 400 RPS（使用 0.18 コア）と 1,600 RPS（使用 0.41 コア）を各 20 秒。送信の遅れ 0%、全件成功（8,000 件、32,000 件）。
- 同じ時間帯の Web 側: `ExecutedRequests` 334,403、4XX・5XX・スロットル 0。

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
- Lambda と DSQL の単価は §3-3。

### 3-3. Lambda と DSQL の単価（東京、AWS Price List API）
| 項目 | 単価 | 出典（usagetype） |
|---|---|---|
| Event（arm64）リクエスト | $0.20 / 100 万 | `APN1-Request-ARM`（`--service-code AWSLambda`） |
| Event（arm64）時間 | $0.0000133334 / GB・秒（最初の階層） | `APN1-Lambda-GB-Second-ARM` |
| Web リクエスト | $0.30 / 100 万 | `APN1-Lambda-Web-Request-ARM` |
| Web CPU | $0.0000322421 / vCPU・秒 | `APN1-Lambda-Web-vCPU-Second-ARM` |
| Web メモリ | $0.0000042688 / GB・秒 | `APN1-Lambda-Web-Memory-GB-Second-ARM` |
| DSQL | $0.00001 / DPU、ストレージ $0.40 / GB・月 | `APN1-DSQL-DistributedProcessingUnits`、`APN1-DSQL-Storage-ByteHrs`（`--service-code AuroraDSQL`） |
| CloudWatch Logs 取り込み | $0.76 / GB | `APN1-DataProcessing-Bytes`（`--service-code AmazonCloudWatch`） |

- 取得日 10-18。価格表の公開日は Lambda が 10-16、DSQL が 09-11、CloudWatch が 10-07。
- 東京の Web の単価は、us-east-1 の値（CPU $0.0000276944、メモリ $0.0000036667、リクエスト $0.30 / 100 万）より高い（CPU +16%、メモリ +16%）。コスト比較は東京の単価で行う。
- Event の同時実行数のクォータは 1,000（`aws lambda get-account-settings`）。
- DSQL の 1 リクエスト（読み取り）あたりの DPU は §2-8。

### 3-4. 生成側の接続数に上限がないと、高いレートの段で接続が詰まる
**結論**
- 接続数に上限のない生成側（`fetch` の既定）で、25〜800 RPS の段は安定していたが、**800 → 1,600 RPS に倍増した 1,600 RPS の段で、構成によらず接続が詰まった**（Event・Web、DB の有無にかかわらず再現）。失敗はすべて TCP 接続の段階（`UND_ERR_CONNECT_TIMEOUT`、`ETIMEDOUT`）で、**Lambda には届いていない**。サーバー側の遅延・スロットル・エラーは正常だった。
- 考えられる経緯（仮説。直接の原因は特定していない）: Lambda の環境の増加が一時的に追いつかず要求が約 1 秒待つ → 生成側が待つ要求ごとに新しい接続を張る（数百〜2,000 本）→ 単一の公開 IP からの新規接続の集中が詰まる → タイムアウトが連鎖し、環境も急増する（Event 366、Web 159）。
- ローカルでの再現: 応答を 2 秒間だけ 1.5 秒遅らせるサーバーに対して、接続数に上限がないと 759 本の接続が開き、上限 256 だと 256 本で止まった。
- 対応: 生成側に接続数の上限（`--max-connections`、既定 256）、長い keep-alive（60 秒）、接続のタイムアウト 30 秒を設けた。待つ要求は生成側のキューで待ち、その待ちは「予定時刻からの遅延」に含まれる（遅れを隠さない）。
- **AWS 上で解消を確認した**: 同じ条件（`web-noop`、25 → 1,600 RPS、各 90 秒）で、1,600 RPS の段が 144,000 / 144,000 件成功、失敗 0、ドロップ 0、送信の遅れ 0%、p99 35.5 ms、環境 50（前回は p99 10.9 秒、失敗 3,034、ドロップ 2,736、環境 159）。直接の原因（SYN の欠落か、DNS か、入口の制限か）は特定していないが、接続数に上限を設ければ再現しない。
- 1,600 RPS の段の結果（P1 セット 1）は、構成の比較には使わない。25〜800 RPS の 6 段は有効。

**根拠**（10-18 23:42〜10-19 00:13 JST、`results/2026-10-18/set1-stopped/`（5a769a1））
- `event-dsql-reuse`: 1,600 RPS の段は、144,000 件のうち 142,161 件を送信（1,839 件は生成側の同時リクエスト上限 2,000 に達してドロップ）、成功 140,887、失敗 1,274（`UND_ERR_CONNECT_TIMEOUT`）、p99 10.4 秒、環境 366。同じ時間の Lambda 側は、`Duration` 平均 5〜6 ms・最大 535 ms、スロットル 0、エラー 0。`Invocations` の合計 282,637 は、生成側の送信数 283,911 から失敗 1,274 を引いた数に**一致**した。
- `web-noop`: 1,600 RPS の段は、141,264 件を送信（2,736 件ドロップ）、成功 138,230、失敗 3,034（`UND_ERR_CONNECT_TIMEOUT` 2,689、`ETIMEDOUT` 345）、p99 10.9 秒、環境 159（直前の段は 19）。Web 側は 4XX・5XX・スロットル 0。
- 800 RPS までは両方とも全件成功（p99 は Event/DSQL 約 30 ms、Web/noop 約 13 ms）。
- 事前の確認（A1b、`web-noop` を 400 → 1,600 RPS、各 20 秒）では詰まらなかった。段が長いほど（90 秒）、きっかけとなる一時的な遅延が起きる確率が上がると考えられる。
- 見落としの経緯: 事前の確認は 20 秒の段までだった。
- 修正後の確認（10-19 00:45〜00:55 JST、`results/2026-10-19/check-b/`（5a769a1））: 全 7 段が全件成功（25 → 800 RPS の p99 は 6〜24 ms）。同じ時間の Web 側は、`ExecutedRequests` 286,050（= 送信 285,750 + 直前の確認 A の 300）、4XX・5XX・スロットル 0、環境の最大 66。

### 3-5. 進行役を AWS 側のタスクに移しても、同じ結果が得られる
**結論**: 1 つの Fargate タスクが、計画どおりに待ち、複数の構成を順に実行し、記録を残した。PC がスリープしても、AWS の認証が切れても、実行は止まらない（ローカルは、開始と、終了後の回収だけ）。回収したファイルは、従来のローカル進行と同じ形式。ログは 30 日、1 分粒度のメトリクスは約 15 日以内に回収する。

**根拠**（10-19、`results/2026-10-19/check-a/`、`check-b/`（5a769a1））
- 確認 A: `event-noop` と `web-noop` の 2 回（20 / 40 RPS × 5 秒、回の間は 300 秒）。待ち時間が計画どおり（10 秒、300 秒）。全件成功。ファイル（`.log` / `.json` / `.meta.json` / マニフェスト）が従来と同じ形式で作られた。タスクは終了後に残っていない。
- 確認 B: 上の §3-4（`web-noop` の全段）。回収時にメトリクスの保存も実行され、結果が Web 側の件数と一致した。
- ローカルでの確認: 実行側を本番規模（1,600 RPS・2,500 RPS の段）で通し、SIGTERM で `P1_ABORTED` を出して止まること、子プロセスが残らないことを確認した。
- 実績の費用: 確認 A が約 $0.01、確認 B が約 $0.14（リクエスト $0.086、CPU $0.011、メモリ $0.009、Fargate $0.03。単価は §3-3）。

### 3-6. 較正: 時間の内訳、アプリの形のエンドポイントの重さ、DPU
**結論**
- **Web と Event の DB なしの差（p50 で約 6 ms）は、アプリの中にはない**。`/db/read` のハンドラ内の時間（`appMs`）は Event 2.3〜2.5 ms、Web 2.5〜3.1 ms でほぼ同じ。クライアントの時間からそれを引いた「アプリの外」が、Event 12.3〜14.5 ms、Web 5.7〜6.3 ms で、差のほぼすべてがここにある。リクエストの変換（アプリの中の処理）の差ではなく、関数URL と Web のエンドポイントの入口・経路の差と読める（原因の特定まではしていない）。
- CPU 処理（`/app/render`、SHA-256 を 10,000 回）は、Event（1 GB）で 26.9 ms、Web で 15.9 ms。同じ仕事量でも、Event の 1 GB は約 0.57 vCPU 分しかないため遅い（原因は推定）。
- 重い集計（`/app/report`）は、k を大きくすると時間と DPU がほぼ比例して増える（下表）。約 250 ms にするには k=800 で、DPU は 0.58 / 件（k=300 の 3.5 倍）。DPU が費用の主因になる。
- Event の初期化時間（`Init Duration`）の p50 は 225〜270 ms（`REPORT` 行から）。
- 1 リクエストあたりの DPU: detail（11 文）0.050、write 0.061、external（読み取り + INSERT）0.070、render 0.005。

| `/app/report` の k | クエリ（p50） | DPU / 件 |
|---|---|---|
| 300 | 38.8 ms | 0.166 |
| 450 | 81.7 ms | 0.264 |
| 600 | 141.5 ms | 0.388 |
| 800 | 247.2 ms | 0.578 |

**根拠**（10-19 23:17〜10-20 00:44 JST と 00:20〜01:06 JST、東京の Fargate から。ビルド 7afe79f…）
- `npm run suite-start -- --suite calibration --seed 20261020`（タスク `bb0127b8…`）と `--suite calibration-report`（タスク `d721390e…`）。結果は `results/calibration-20261020/`、`results/calibration-report-20261020/`（`npm run analyze -- <dir>` で再現できる）。
- 内訳: K（`/db/read`、50〜200 RPS）の各段の `appMs` / `outsideMs` の p50。Event は `event-dsql-reuse`、Web は `web-dsql-pool`。
- DPU: 各回の `TotalDPU`（`AWS/AuroraDSQL`）の合計を成功件数で割った値。Q1〜Q5 は 20 RPS × 60 秒（1,200 件）、R1〜R3 は 20 RPS × 45 秒（900 件）。
- 合格基準 (a)〜(f) は通過。(a) は event-dsql-reuse 15.8 ms（参考 15.7）、web-dsql-pool 9.4 ms（参考 8.6、許容 ±1）。

### 3-7. 生成側の接続数の上限（既定 256）は、同時実行が 256 を超える段を無効にする
**結論**
- 生成側（`invoke.ts`）は、接続数の上限（`--max-connections`、既定 256）と、同時に飛んでいる要求の上限（`--max-inflight`、既定 2,000）を持つ。必要な同時実行（RPS × 応答時間）が上限に近づくと、要求は生成側で待たされ、その段は生成側の能力を測ってしまう。
- 1 秒かかる処理（`/app/external?ms=1000`）の 400 RPS（同時実行 約 420）で、Event も Web も同じ結果になった: 送信が予定の約 72%、p50 約 7.9 秒、完了は約 290 RPS（理論上限 256 ÷ 1.03 秒 ≒ 248 RPS と合う）。Event の環境数がちょうど 256 になった。Web の環境は 6 で、プール待ちは 0 の回もあり、Web 側の限界ではない。
- `lateRate`（予定した送信に 100 ms 超遅れた割合）は 0% のまま。待ちは生成側の HTTP クライアントの中（接続待ち）で起きるため、送信の遅れには出ない。見つけるには、環境数が接続数の上限と一致していること、`dropped`（同時実行の上限 2,000 に当たって送れなかった要求）、`latencyMs` の異常な増加を見る。
- 対応: ケースごとに上限を指定できるようにし（`maxConnections`、`maxInflight`）、計画の段階で「最大 RPS × 想定の応答時間」が上限の 6 割（接続）・8 割（同時実行）を超えるケースを拒否する（`capacityProblems`）。

**根拠**（10-20、測定 `results/measurement-20261020/`、ケース A の 400 RPS の段、全構成・全セット）
- Event: 送信 12,910〜12,916 / 予定 18,000、環境数 256、p50 7,918〜7,934 ms。Web: 送信 13,060〜13,072、環境数 6、p50 7,851〜7,889 ms。
- 同じ測定のケース C の最初のスパイク（1,500 RPS、コールドスタートで要求が約 0.7 秒待つ）でも、Event の同時実行が 256 で止まった（254〜256）。この環境数は下限値。

### 3-8. 請求との照合: 計算した数量は請求と合い、金額は無料枠のぶん低い
**結論**
- 分析の計算（メトリクスと `REPORT` の課金時間に、東京の単価を掛けたもの）は、請求の**数量**と 0.5% 以内で一致した。Web のメモリだけは、計算が 2.2% 少ない（環境の存在時間 × 環境あたりの平均最大メモリという近似のため）。**単価も、Price List API の値と一致**した。
- 請求の**金額**は、定価で計算した値より低い。月ごとの無料枠が効くため: Event の GB 秒（月 40 万 GB 秒）は、10 月の累計が約 14.3 万で、この日の約 $1.55 は 0 円になった。DSQL（月 10 万 DPU）は、10 月の累計 30.6 万 DPU のうち 10 万が無料で、この日の請求は定価の約 $2.92 に対し $2.06 だった。Event のリクエスト（月 100 万件）は、この日より前に使い切っていた。Web には無料枠がない。
- したがって、**Event と Web のコストの比較は、定価で行う**（分析の計算がこれにあたる）。実際の請求額は、無料枠のぶん低くなる。
- 計算に含まれない項目（この日）: Fargate のリージョン内のデータ転送 $0.086（8.6 GB）、ECR $0.008、CloudWatch $0.008。公開 IPv4（$0.031）は、Fargate の単価に含めてある。
- S3 の保管料（1 日 $0.27）は、この検証と関係がない。10-15 以降ずっと同額で、別の 325 GB のバケットと共用の CDK のアセット用バケット（11 GB）によるもの。この検証のバケット（Web のコード用）は 1 MB 未満。
- 請求の実額（UTC の日）: 10-18（予備測定）$3.58、10-19（較正と測定）$4.31（Lambda・DSQL・ECS・公開 IPv4・ECR・CloudWatch の合計。背景の約 $0.03 / 日を含む）。事前の見積もりに使った定価ベースの累計（約 $10.7）より低い。

| 項目 | 計算した数量 | 請求の数量 | 計算 / 請求 | 請求の金額 | 定価での計算 |
|---|---|---|---|---|---|
| Event のリクエスト | 1,465,390 | 1,465,398 | 100.0% | $0.293 | $0.293 |
| Event の GB 秒（`Billed Duration`） | 116,249 | 116,267 | 100.0% | $0（無料枠） | $1.55 |
| Web のリクエスト | 1,542,645 | 1,542,651 | 100.0% | $0.463 | $0.463 |
| Web の vCPU 秒 | 8,031 | 8,033 | 100.0% | $0.259 | $0.259 |
| Web のメモリ GB 秒 | 77,382 | 79,100 | 97.8% | $0.338 | $0.330 |
| DSQL の DPU | 293,963 | 292,470 | 100.5% | $2.06（無料枠 86,480 DPU） | $2.94 |
| Fargate（vCPU + メモリ + 公開 IPv4） | 約 6.2 時間 | 6.2 時間 | — | $0.795 | $0.795 |

**根拠**（取得 2026-10-20。請求のデータは `Estimated: true` で、後で少し変わりうる）
- 対象の日: UTC の 2026-10-19。較正と測定のタスクの実行（14:19〜20:37 UTC）がすべて収まる。この日の Lambda の数量が計算とほぼ一致したので、他の利用は混ざっていない。
- 請求: `aws ce get-cost-and-usage --region us-east-1 --time-period Start=2026-10-19,End=2026-10-20 --granularity DAILY --metrics UnblendedCost UsageQuantity --group-by Type=DIMENSION,Key=SERVICE`（サービス別）。使用タイプ別は `--filter` でサービスを絞り、`Key=USAGE_TYPE` でグループ化。月の累計は `Start=2026-10-01,End=2026-10-21`。
- 計算: `results/{calibration-20261020,calibration-report-20261020,measurement-20261020}/analysis.json`（`npm run analyze`）の各回の `total.cost` / `costBilled` を、単価（§3-3）で割って数量に戻した値。
- S3 のバケットの大きさ: CloudWatch の `AWS/S3` `BucketSizeBytes`（`StandardStorage`）。

## 4. 未確認
- DB 待ちが長いときの Web のコスト（P1 の読み取りは DB 待ちが約 3 ms で、Web の方が約 2 倍高かった。[report.md](report.md)）。
- `53300`（接続の総数）が実際にどの SQLSTATE とメッセージで返るか（`53400` は確認済み、§2-7）。
- `reuse` の再接続（凍結から復帰した後に接続が切れていた場合）の実機での挙動。単体テストでは確認済み。
- 関数URLに追加料金がないこと。
- CloudFormation でリビジョンを置き換えたときの、旧リビジョン削除とトラフィックの切り替え順序。
- Web のシステムログのイベント（`platform.*`）の実際の形式。
