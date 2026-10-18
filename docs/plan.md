# 検証計画: Lambda Web Functions × Aurora DSQL

仕様と出典は [web-functions-notes.md](web-functions-notes.md)。リージョンは ap-northeast-1。

## 1. 目的と仮説
Aurora DSQL をバックエンドにしたときの、レイテンシ・スループット・コストを、Event Functions + 関数URL と Web Functions で比較する。

仮説: Web Functions は 1 つの実行環境で複数リクエストを同時に処理するので、DSQL の接続プールを共有できる。その結果、
1. 接続確立のコスト（TLS + IAM 認証トークンの生成）が減り、レイテンシが下がる
2. DSQL 側の接続数と接続レートが大きく減る
3. I/O 待ちの間は CPU 課金がほぼ発生しないので、DB 待ちが長いほどコストが有利になる

反証される場合も想定する。たとえば、Web Functions のメモリ課金（環境が存在する間ずっと）が支配的になる低負荷では、Event Functions の方が安くなりうる。

## 2. アプリの構成
- Hono アプリ 1 つ（`src/app.ts`）を共通にする。Web は `@hono/node-server` で `AWS_LAMBDA_HTTP_ENDPOINT` に listen し、Event は `hono/aws-lambda` の `handle()` で包む。LWA は使わない。
- 両方を同じ esbuild 設定でバンドルする（`scripts/bundle.mjs`）。
- **結果の解釈に影響する要因**: リクエストの変換層が異なる。Web は Node の IncomingMessage → Request、Event は関数URLのイベント JSON → Request。どちらも小さい（ms 未満の見込み）が、DB なしの `/noop` で測って差を把握し、DSQL の結果から差し引くか注記する。

## 3. 比較する構成

| | DB なし | DSQL・毎回接続 | DSQL・プール共有 |
|---|---|---|---|
| Event + 関数URL | ○ | ○ | ○（環境内で 1 接続を再利用） |
| Web Functions | ○ | ○ | ○ |

- Event のメモリ: 512 MB / 1 GB / 約 3.5 GB。Web は 2 vCPU / 2 GB 固定。**Event の約 3.5 GB は CPU は揃うがメモリは揃わない**。コストの比較ではこの違いを明記する。
- Web の maxConcurrencyPerEnvironment: 64（デフォルト）→ 後で 16 と 128。
- **構成ごとに別の Web Function を作る**（例 `gekko10-web-noop`, `gekko10-web-dsql-each`, `gekko10-web-dsql-pool`）。理由:
  - メトリクスにリビジョンの次元がなく、環境系のメトリクス（CPU・メモリ・同時実行）にはエンドポイントの次元もない。同じ関数に複数の構成を載せると分けて測れない。
  - 動的な同時実行数の上限は関数ごとに学習・保持される。構成を混ぜると互いに影響する。
- 今回は `gekko10-web-noop` と `gekko10-event-noop`（1 GB）だけを作る。
- Event の「DSQL・プール共有」（決定済み）: 環境内で 1 接続を再利用する。Event は 1 環境が同時に 1 リクエストしか処理しないので、プールは実質 1 接続になる。これが「Web で共有する効果」と「接続を使い回す効果」を切り分ける対照になる。接続は最長 60 分で切れるので、再接続と、IAM 認証トークンの期限切れを処理する。

## 4. 負荷パターン
1. 段階的に負荷を上げる定常負荷（上限スループットと、どの制限が先に効くかを見る）
2. ゼロからのバースト（コールドスタート・初期化の 429）
3. アイドル後の単発（スケールインしたあとの最初のリクエスト）
4. 長時間の一定負荷（接続の寿命。DSQL の接続は最長 60 分）

手順上の注意:
- **ウォームアップ回を捨てる**。Web は動的な同時実行数を最初は保守的に置き、学習する。最初の負荷試験は環境が多めになる。同一構成で 2 回以上実行し、2 回目以降を採用する。 [DG web-functions-scaling.html]
- 構成の測定順序を固定せず、ランダム化するか、交互に実行する（時間帯・アカウントの枠の変化の影響を避ける）。
- アイドル後の単発は、環境が回収されるまでの時間より長く空ける。(第三者) 4.5〜10.5 分、未使用のものは約 5 分。余裕を見て 15 分以上空ける。
- 429 は `lambda-web-error-type` ヘッダで分類する（レート上限・環境数上限・アカウントの vCPU・同時初期化）。同時初期化の 429 はスロットルのメトリクスに出ない。ヘッダの無い 503 は別に数える。
- k6 は EC2（ap-northeast-1）から実行。負荷のレートが 1 エンドポイント 10,000 RPS、アカウント全体 100,000 RPS 以下になることを確認する。

## 5. 計測項目と取得元

| 項目 | Event + 関数URL | Web Functions |
|---|---|---|
| p50/p95/p99 | k6（クライアント側） | k6 |
| スループットの上限 | k6 の到達 RPS、429/5xx の発生点 | 同左 + `EndpointRequestThrottles` など |
| コールドスタートの数 | `REPORT` ログの `Init Duration`、レスポンスの `coldStart` | ログの `platform.initStart`、レスポンスの `coldStart` |
| 環境数 | 同時実行数（`ConcurrentExecutions`）、レスポンスの `envId` の種類 | `EndpointActiveEnvironments`、`envId` の種類 |
| 環境あたりの同時処理 | 常に 1 | `EnvironmentConcurrentRequests`、レスポンスの `maxInFlight` |
| CPU・メモリ | `REPORT` の Billed Duration と Max Memory Used | `EnvironmentCPUTime`, `EnvironmentActiveTime`, `EnvironmentMaxMemoryUsage` |
| DSQL 側の接続数 | `AWS/Usage` の `ClusterConnectionCount`（アクティブ接続）と `CallCount`（`DbConnect*`、接続の試行）。§8 の調査結果を参照 | 同左 |
| コスト | §6 | §6 |

## 6. コストの計算
- Event: リクエスト数 × リクエスト単価 + 課金時間（GB 秒）× 単価。arm64。関数URLに追加料金はない（未確認）。
- Web: リクエスト数 × $0.30/100 万 + CPU 時間（vCPU 秒）× $0.0000276944 + **環境が存在した時間 × 消費メモリ（GB）** × $0.0000036667。
  - CPU 時間は `EnvironmentCPUTime` の Sum、環境の存在時間は `EnvironmentActiveTime` の Sum で近似する。
  - メモリは環境が存在する間ずっと課金される。アイドル中の環境も課金されるため、負荷パターン（特にバースト後の残り時間）で結果が変わる。
- 上の単価は us-east-1。**東京の単価は AWS Price List API で取得する**。
- 100 万リクエストあたりのコスト = 総コスト ÷ リクエスト数 × 100 万。実測の請求（Cost Explorer）と突き合わせる。
- DSQL の費用（DPU）は両構成で別に集計し、Lambda の費用と分けて報告する。

## 7. 計画に影響する制約
- **アカウントのクォータ**: Web のドキュメント上の既定は 100,000 RPS / 2,000 vCPU（= 1,000 環境）だが、**このアカウントの実測は 200 vCPU（= 100 環境）/ 10,000 RPS**（`get-web-account-settings`、2026-10-18）。負荷試験の前に引き上げを申請する。たとえば環境あたりの同時実行が 2〜3 だと、100 環境で約 200〜300 同時、500 ms の処理なら約 400〜600 RPS が上限になり、スループットの上限を測る前にクォータに当たる。Event の同時実行数も確認する（既定 1,000）。
- **メトリクスにリビジョンの次元がない**。リビジョン別に比較する設計にしない（構成ごとに関数を分ける理由）。
- **DSQL の接続レートは 1 クラスタあたり 100/秒（バースト 1,000）で、引き上げ不可**。最大接続数は 10,000。したがって「毎回接続」の構成は、新規接続が 100/秒を超えるあたりで頭打ちになる可能性が高い。これは仮説を支持する結果だが、スループットの比較には「どの制限で止まったか」を区別して記録する。
- 接続の最長は 60 分。長時間の一定負荷ではプールの再接続を含める。
- Web の環境は fd が 1,024 まで。プールの上限と同時実行数の設計に関わる。
- 環境あたりの同時実行数は動的。64 を設定しても 64 にはならない場合がある。`maxInFlight` を実測する。
- エンドポイントごとに 10,000 RPS が上限。それ以上を測る場合は複数エンドポイント（同一関数の最大 10 個）を使うが、構成を混ぜないよう注意する。
- Web のメモリは 2 GB 固定。
- CloudFormation でコードを変えるとリビジョンが置き換わる。比較の途中でコードを変えると、動的同時実行数の学習は関数に残るが、環境は入れ替わる。

### 初回の実機観測（DB なし、2026-10-18、手元の WSL から。性能の比較ではない）
- 50 並行の `/wait?ms=1000` を 1 回ずつ（最初の呼び出し直後）: Event は環境 38、最大同時処理 1。Web は環境 24、最大同時処理 2（3 回続けても 24〜26 環境、最大 1〜2）。
- 1,000 件・50 並行の `/wait?ms=500`（Web）: 環境 26、最大同時処理 3、コールドスタート 0。`EndpointActiveEnvironments` = 26、`EnvironmentConcurrentRequests` の最大 = 3 で、アプリ側の観測と一致した。
- 解釈: **Web の環境あたりの同時処理数は、最初はほとんど 1〜3 にしかならない**（`maxConcurrencyPerEnvironment` の 64 は上限にすぎず、動的な上限が保守的に始まる、というドキュメントの記述どおり）。仮説の「接続プールを共有できる」効果は、動的な上限が上がってから出る。DSQL の測定では、**上限がどこまで上がるかを先に調べる必要がある**（CPU をほとんど使わない I/O 待ちの負荷を長く流して、`EnvironmentConcurrentRequests` が増えるか）。増えなければ、`maxConcurrencyPerEnvironment` を変えても結果が変わらない可能性がある。
- クライアントのレイテンシ（p50 が 2 秒前後）は、新規 TLS 接続の確立を含むため、手元からの値は使えない。持続負荷では p50 が約 516 ms（待機 500 ms）だった。比較は EC2 の k6 で行う。
- 手元の WSL から東京への接続は、IPv6 の到達不能と TCP 接続のタイムアウトが散発する。測定は EC2 から行う。

## 8. 段階
1. **(今回)** 調査メモ、この計画、DB なしの `/noop` `/wait`、CDK（Event 1 GB と Web 1 つ、IAM 認証）、動作確認手順
2. DSQL クラスタの作成と接続処理（毎回接続、プール共有）
3. Event のメモリ違い（512 MB / 3.5 GB）、Web の maxConcurrency 違い（16 / 128）
4. 負荷試験（k6、EC2）、集計、コスト計算

### 決定事項（2026-10-17、ユーザー確認済み）
- **Event に「環境内で 1 接続を再利用」する構成を足す**。§3 の表のとおり。
- **「毎回接続」では DSQL の接続レート 100/秒の上限を結果として報告する**。上限を回避するためにクラスタを分けたり、負荷を絞ったりはしない。測定では、頭打ちの原因が接続レート（`CONFIGURED_LIMIT_EXCEEDED(53400)`）なのか Lambda 側の制限（429 など）なのかを区別して記録する。接続エラーはクライアント側とアプリのログの両方で数える。
- **VPC を使わず、DSQL のパブリックエンドポイントに接続する**。Event も Web もネットワーク設定は不要（Web の VPC 接続はネットワークコネクタが必要で、HomeRegion のみ）。
- **構成ごとに Web Function を分ける**（§3）。
- **東京の単価は AWS Price List API で取得する**。`AWSLambda` サービスから東京のリクエスト・Arm の GB 秒、Web Functions の CPU・メモリの単価を引き、取得日時と属性を `docs/` に記録する（DSQL の DPU 単価も別に取る）。

### DSQL の調査結果（2026-10-17）
**CDK での作成方法**
- aws-cdk-lib 2.273.0 の `aws-dsql` に L1 の `CfnCluster` がある。L2 はない（`node_modules` を確認した）。
- プロパティ: `deletionProtectionEnabled`, `kmsEncryptionKey`, `multiRegionProperties`, `policyDocument`, `tags`。今回は単一リージョンで、`deletionProtectionEnabled: false` にして検証後に消せるようにする。
- 属性: `attrEndpoint`（接続先ホスト名）、`attrIdentifier`、`attrResourceArn`、`attrStatus`。ホスト名は `<id>.dsql.<region>.on.aws`。
- 実行ロールには `dsql:DbConnectAdmin`（admin ロールで接続する場合）または `dsql:DbConnect`（独自のデータベースロールの場合）を付ける。検証では admin ロールが簡単だが、権限を絞るなら独自のロールを作る。
  - 出典: https://docs.aws.amazon.com/aurora-dsql/latest/userguide/SECTION_authentication-token.html

**接続とトークン**
- 認証トークンの生成は**ローカルの署名処理**で、AWS への呼び出しは発生しない。つまり「毎回接続」で増えるコストは、TCP/TLS のハンドシェイクと PostgreSQL の認証往復、トークンの署名計算である。計画の「接続確立コスト（TLS + IAM 認証トークン生成）」という表現はこの意味で正しい。
- トークンの既定の有効期限は 15 分、最長 1 週間。接続が確立した後は、トークンが失効しても接続は有効なまま。→ プールではトークンの期限切れは問題にならず、問題になるのは接続の最長 60 分の方。
- Node.js 向けに公式のコネクタ `@aws/aurora-dsql-node-postgres-connector`（npm の最新 0.1.9。`pg` のラッパー）がある。ピア依存は `@aws-sdk/credential-providers`, `@aws-sdk/dsql-signer`, `pg`。`AuroraDSQLClient`（1 接続）と `AuroraDSQLPool`（`max`, `idleTimeoutMillis` など `pg` のオプションが使える）。ユーザー名が `admin` なら admin 用トークンを自動で選ぶ。リージョンはホスト名から取れる。**接続ごとにトークンを生成する**。
  - 出典: https://docs.aws.amazon.com/aurora-dsql/latest/userguide/SECTION_program-with-dsql-connector-for-node-postgres.html
- 方針案（次の段階で確定）: 3 つの構成すべてでこのコネクタを使う（実装の差を作らない）。「毎回接続」は `AuroraDSQLClient` をリクエストごとに作って `end()` する。「プール共有」は Web では `AuroraDSQLPool`（`max` は検証パラメータ）、Event では環境内で `AuroraDSQLClient` を 1 つ保持して再利用（切断時に再接続）。

**CloudWatch メトリクス**（出典: https://docs.aws.amazon.com/aurora-dsql/latest/userguide/cloudwatch-monitoring.html）
- **アクティブな接続数**: 名前空間 `AWS/Usage`、`ResourceCount`、Resource=`ClusterConnectionCount`、ResourceId=`cluster/<cluster-id>`、Service=`AuroraDSQL`。
- **接続の試行回数**: 同じ名前空間の `CallCount`、Resource=`DbConnectAdmin` または `DbConnect`。新規接続の回数（= 接続レート 100/秒の消費量）の近似として使える。
- DPU: `WriteDPU`, `ReadDPU`, `ComputeDPU`, `MultiRegionWriteDPU`, `TotalDPU`（ResourceId=`<cluster-id>`）。コスト集計に使う。
- その他: `TotalTransactions`, `OccConflicts`, `QueryTimeouts`, `CommitLatency`(P50), `ComputeTime`。
- 名前空間 `AWS/Usage` のメトリクスの粒度（1 分か）と、接続数が瞬間値か最大値かは**未確認**。次の段階で `aws cloudwatch list-metrics` と実測で確認する。アクティブ接続数は 1 分間隔だと短いピークを見逃す可能性があるので、アプリ側（プールの接続数）でも記録する。
- 接続レートの上限（100/秒）に達したときは、DSQL のエラーコード `CONFIGURED_LIMIT_EXCEEDED(53400)`（接続レート）と `TOO_MANY_CONNECTIONS(53300)`（総数）で区別できる。アプリのログに残す。

### まだ決まっていないこと
- 「プール共有」の `max`（Web の環境あたりのプールサイズ）をいくつにするか。maxConcurrencyPerEnvironment（16/64/128）との関係で決める
- `AWS/Usage` の接続数メトリクスの粒度（実測で確認）
- 検証用の DB のテーブル設計とクエリ（`SELECT 1` 相当か、読み書きを含めるか）。次の段階の最初に決める
