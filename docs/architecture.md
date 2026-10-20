# 構成と仕様

**この文書の読み手:** このリポジトリのコードと AWS の構成を、調べに来た人。「何が、どう作られているか」の事実の一覧。

関連する文書:
- 設計の理由: [design-decisions.md](internal/design-decisions.md)
- 動かし方: [runbook.md](runbook.md)
- 測定の設計: [plan.md](internal/plan.md)
- 確かめた事実: [findings.md](findings.md)
- 用語: [用語集](glossary.md)

## 1. 全体像
同じ Hono アプリを、Lambda の 2 つの形態（Event Functions + 関数URL、Web Functions）で動かし、Aurora DSQL に接続する構成を比較する。リージョンは ap-northeast-1。

```
 東京の Fargate タスク (invoke.ts, SigV4)
        │
        ├─▶ Event Functions + 関数URL ─┐
        │      (noop / dsql-each / dsql-reuse)
        │                              ├─▶ Aurora DSQL (パブリックエンドポイント)
        └─▶ Web Functions エンドポイント ─┘
               (noop / dsql-each / dsql-pool)
```

## 2. アプリ
| パス | 役割 |
|---|---|
| `src/app.ts` | 共通の Hono アプリ。`/noop`, `/wait?ms=N`, `/db/ping`, `/db/read`, `/app/*`。環境の識別情報を返す |
| `src/scenarios.ts` | アプリの形のエンドポイント（`/app/*`）の中身 |
| `src/db.ts` | DSQL への接続層。`each` / `reuse` / `pool` の 3 モード（公式コネクタを使う） |
| `src/entry-web.ts` | Web Functions 用。`@hono/node-server` で `AWS_LAMBDA_HTTP_ENDPOINT` に listen |
| `src/entry-event.ts` | Event Functions 用。`hono/aws-lambda` の `handle()` |
| `scripts/bundle.mjs` | 両方を同じ esbuild 設定でバンドル（`dist/web`, `dist/event`） |

- LWA（Lambda Web Adapter）は使わない。

## 3. 関数の一覧
| 関数 | 形態 | `DB_MODE` | 接続の持ち方 |
|---|---|---|---|
| `gekko10-event-noop` | Event (1 GB) | なし | DB なし |
| `gekko10-event-dsql-each` | Event (1 GB) | `each` | リクエストごとに接続して閉じる |
| `gekko10-event-dsql-reuse` | Event (1 GB) | `reuse` | 環境内で 1 接続を保持して再利用（55 分で張り直す。切れていたら 1 回だけ再接続して再試行） |
| `gekko10-web-noop` | Web | なし | DB なし |
| `gekko10-web-dsql-each` | Web | `each` | リクエストごとに接続して閉じる |
| `gekko10-web-dsql-pool` | Web | `pool` | 環境内で `AuroraDSQLPool` を共有（`DB_POOL_MAX` = 64 = maxConcurrencyPerEnvironment。プールの待ちが起きない対照） |
| `gekko10-web-dsql-pool10` | Web | `pool` | 同上で `DB_POOL_MAX` = 10（node-postgres の既定値、AWS の推奨範囲 10〜20 の下限。実際のアプリに近い設定） |

- Web は構成ごとに別の関数にする。メトリクスにリビジョンの次元がなく、動的な同時実行数の学習が関数単位だから。
- Event に `reuse` を入れるのは、「Web で接続を共有する効果」と「単に接続を使い回す効果」を切り分ける対照のため。Event は 1 環境が同時に 1 リクエストしか処理しないので、プールは実質 1 接続になる。
- Event のメモリ違い（512 MB / 3.5 GB）と Web の maxConcurrency 違い（16 / 128）は、まだ作っていない（[plan.md](internal/plan.md) §2）。

## 4. スタック
| スタック | 内容 |
|---|---|
| `Gekko10DbStack` | DSQL クラスタ（L1 の `CfnCluster`、単一リージョン、パブリックエンドポイント、削除保護なし）。状態（テーブルと 1,000 行）を持つので、関数と分ける |
| `Gekko10EventStack` | Event の全関数（`lib/event-stack.ts` の構成リスト） |
| `Gekko10WebStack` | Web の全関数（`lib/web-stack.ts` の構成リスト）。関数ごとに専用の S3 バケット（バージョニング有効） |
| `Gekko10LoadStack` | 負荷生成の Fargate タスク定義（§7）。他のスタックに依存しない |

- Event と Web は Db スタックの出力（エンドポイントと ARN）を参照する。CDK が依存を付ける。Event と Web の間に依存はない。デプロイは Db → Event/Web、削除は Event/Web → Db の順。
- 構成を足すときは、構成リストに 1 行足す。
- Web Functions の CDK は L1（`CfnWebFunction`, `CfnWebFunctionRevision`, `CfnWebFunctionEndpoint`）。L2 はない。

## 5. エンドポイントとレスポンス
`/noop` と `/wait` は次の JSON を返す。

| フィールド | 意味 |
|---|---|
| `variant` | 環境変数 `APP_VARIANT`（関数名から `gekko10-` を除いたもの） |
| `envId` | 実行環境の起動時に作る UUID。同じ環境なら同じ値 |
| `coldStart` | この環境で最初のリクエストなら true |
| `requestCount` | この環境で受け付けた通算のリクエスト数（今回の分を含む） |
| `inFlight` | 受け付けた時点の同時処理数（今回の分を含む） |
| `maxInFlight` | この環境での同時処理数の最大値（`/wait` は完了時点） |
| `requestId` | Web Functions の `lambda-web-request-id`（Event では null） |
| `waitedMs` | `/wait` のみ |
| `appMs` | ハンドラの中で使った時間（応答を作る直前まで）。クライアントの時間から引くと、経路の時間（ネットワーク・入口の処理・関数の呼び出し）が出る |
| `bootMs` | プロセスの開始からアプリの読み込みが終わるまでの時間（環境ごとに一定） |
| `build` | この関数のコードの版。`src/`・`scripts/bundle.mjs`・`scripts/build-id.mjs`・`package-lock.json` を最後に変えたコミットの SHA（未コミットの変更があれば末尾に `-dirty`）。`scripts/build-id.mjs` が計算し、`scripts/bundle.mjs` が埋め込む |

`/wait?ms=N` の N は 0〜25000 の整数。範囲外・不正は 400。

### アプリの形のエンドポイント（`/app/*`、`src/scenarios.ts`）
実際のアプリのリクエストに近い形。どれも複数の `db.run` を呼ぶ（プールは 1 文ごとに貸し借りする。一般的な `pool.query` の使い方）。

応答の `db` には、合算したトレースを載せる。`acquireMs`・`queryMs`・`releaseMs` は合計、`queries` は文の数、`queryMaxMs` は最長の 1 文。パラメータは、再デプロイなしで較正するために、リクエストで渡す。

| パス | 中身 | パラメータ |
|---|---|---|
| `/app/item` | 主キーの読み取り 1 回 | なし |
| `/app/detail` | 読み取りを順に n 回（N+1 の画面） | `n`（1〜100、既定 11） |
| `/app/report` | `items` の先頭 k 行の自己結合の集計 1 回（重いクエリ） | `k`（1〜1000、既定 300） |
| `/app/render` | 読み取り 1 回のあとに、SHA-256 を w 回連ねる CPU 処理（固定の仕事量） | `w`（0〜1,000,000、既定 10,000） |
| `/app/write` | `events` への INSERT 1 回（UUID の主キー） | なし |
| `/app/external` | 読み取り → ms の待ち（外部 API・LLM の代わり。待ち中は接続を返す）→ INSERT | `ms`（0〜25000、既定 1000） |

不正なパラメータは DB に触れる前に 400、未知のパスは 404、DB のない関数は 501。`events` は `npm run db-setup -- <エンドポイント>` が作り、測定のあとに `--reset-events` で消す。

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
| `queries`, `queryMaxMs` | 1 リクエストで実行した文の数、最長の 1 文（`/app/*` で複数の文を実行したとき。この場合 `acquireMs`・`queryMs`・`releaseMs` は合計） |
| `connectionAgeMs` | 使った接続の経過時間（reuse, pool） |
| `pool` | `{ total, idle, waiting }`（pool のみ） |
| `envConnectionsCreated` | この環境が作った接続の通算数 |
| `envConnectErrors` | この環境での接続エラーの通算数。`53400`（接続レート）/ `53300`（接続の総数）/ `other` |

失敗したときは 503 を返す。本文は、`ok:false`、`error`、`code`（上の 3 分類）、`sqlstate`、`phase`（`connect` / `query`）。同じ内容を、1 行の JSON ログ（`"event":"db_error"`）にも出す。

- 成功したリクエストは、ログに出さない（負荷試験でのログ量を抑えるため）。
- DSQL が接続の拒否を SQLSTATE `53400` / `53300` で返すかは未確認。そのため、メッセージ（`rate exceeded` / `too many open connections`）でも判定している。

## 6. DSQL の接続層（`src/db.ts`）
- 3 モードとも公式コネクタ `@aws/aurora-dsql-node-postgres-connector` を使い、実装の差を作らない。違いは接続の持ち方だけ。
- `each`: リクエストごとに `AuroraDSQLClient` を作り、`connect()` → 問い合わせ → `end()`。
- `reuse`: 環境内で `AuroraDSQLClient` を 1 つ保持する。`error` / `end` イベント、または 55 分を超えたら破棄して次のリクエストで接続し直す。接続が切れていた場合は 1 回だけ再接続して再試行し、`reconnected: true` を返す。
- `pool`: 環境内で `AuroraDSQLPool` を 1 つ共有する（初回の使用時に作る）。アイドルは 60 秒で閉じ、接続の最長は 3,300 秒。`error` イベントのリスナーを必ず登録する（登録しないとプロセスが落ちる）。
- 認証は admin ロール（`dsql:DbConnectAdmin`）。認証情報はコネクタの既定（`fromNodeProviderChain`）に任せる。
- テーブルは `items (id integer PRIMARY KEY, payload text)` に 1,000 行（payload 100 バイト）。`scripts/db-setup.ts` が冪等に作る。
- テストでは、DB へのアクセスを `createApp({ db })` に注入して偽の実装を使う（`test/db.test.ts`）。

## 7. 負荷生成の仕組み

### 7-1. 負荷をかける Fargate タスク（`Gekko10LoadStack`、`scripts/invoke.ts`）
東京の Fargate タスクから、`scripts/invoke.ts` を実行する。常設のリソースを持たず、使うときだけ `run-task` で起動する。

| 部品 | 内容 |
|---|---|
| ネットワーク | デフォルト VPC を `Vpc.fromLookup` で参照する。VPC、サブネット、NAT、VPC エンドポイント、ロードバランサ、サービスは作らない。セキュリティグループは入口なし |
| タスク定義 | 2 vCPU / 4 GB（x86_64） |
| ロググループ | 1 か月保持（測定の結果を、ログから回収するため） |
| イメージ | `load/Dockerfile`。`scripts/bundle-load.mjs` が、`invoke.ts` と `suite-runner.ts` を 1 ファイルずつにまとめる（`load/*.mjs`。生成物で git には入れない）。CDK のブートストラップ用 ECR に push される |

**タスクロール**
- 測定する関数に絞った `lambda:InvokeFunctionUrl`（Event）と `lambda:InvokeWebFunctionEndpoint`（Web）。
- タスクの中の後処理（7-2）のための、読み取り専用の権限。
  - `cloudwatch:GetMetricData`（リソースの指定ができない）。
  - Event のロググループ（`/aws/lambda/gekko10-event-*`）への `logs:StartQuery`。
  - `logs:GetQueryResults` と `StopQuery`。

**生成側の挙動**
- 接続は `undici` の `Agent` で、上限を設ける（`--max-connections`、既定 256）。keep-alive は 60 秒、接続のタイムアウトは 30 秒。上限がないと、一時的な遅延が新規接続の集中を招き、生成側が詰まる（[findings.md](findings.md) §3-4）。
- 同時に飛んでいる要求の上限は、`--max-inflight`（既定 2,000）。2 つの上限は、ケースごとに指定できる（[findings.md](findings.md) §3-7）。
- 生成側が飽和していないかは、出力の `loadgenCoresUsed` / `loadgenCoresAvailable` で確認する。
- `scripts/load-run.sh`（使い方は [runbook.md](runbook.md)）は、単発の負荷用。スタックの出力からクラスタとサブネットを取り、`assignPublicIp=ENABLED` で起動して、終了を待ち、ログを表示する。
  - 最大実行時間（既定は `--duration` + 180 秒、なければ 600 秒）を超えたとき、Ctrl-C のとき、エラーのときは、`stop-task` で止める。

### 7-2. 測定を 1 つのタスクで最後まで流す仕組み
数時間かかる測定を、ローカル PC のスリープや AWS の認証の期限に左右されずに行うための仕組み。測定の定義は `scripts/protocol.ts`（ケース × 構成 × 段）、計画は `scripts/suite-plan.ts`。使い方は [runbook.md](runbook.md) の「較正と測定を流す」。

| スクリプト | 動く場所 | 役割 |
|---|---|---|
| `suite-start.ts` | ローカル | 定義から計画を作り、Fargate タスクとして起動する |
| `suite-runner.ts` | タスクの中 | 計画どおりに待ち、`invoke.mjs` を回ごとに実行する |
| `suite-post.ts` | タスクの中（最後の回の後） | メトリクスと `REPORT` を集め、分析して、合否を出す |
| `suite-fetch.ts` | ローカル | 終了後にログを読み、回ごとのファイルに分ける |

**`suite-start.ts`**
- 計画の順序は、seed つきの乱数で決める。待ちは 5 分。毎回接続の後は 15 分。**同じ関数は、前回の終了から 16 分に満たなければ、延ばす。**
- 起動の条件は 3 つ。作業ツリーがクリーンであること、各関数が計画の `build` で応答すること（1 件ずつ呼んで確かめる）、すでにタスクが動いていないこと（DSQL を共有するため）。
- 起動すると、タスク ID と、停止・回収のコマンドを表示する。コミット、`build`、アカウントのクォータ、計画を、`results/<日付>/suite-<タスク ID>.start.json` に保存する。
- `--dry-run` は、順序・待ち・終了の目安・費用だけを表示する。`--suite calibration` は、較正用の小さな計画。

**`suite-runner.ts`**
- 出力を CloudWatch Logs に残す。各回は、`SUITE_RUN_BEGIN` と `SUITE_RUN_END` で囲む。
- 全体の締め切り（所要時間 + 後処理 + 15 分）と、各回の締め切り（段の合計 + 3 分）で、自分で止まる。
- SIGTERM（`aws ecs stop-task`）でも、実行中の回を止めて終了する。

**`suite-post.ts`**
- 最後の回の窓（終了の 8 分後）と、メトリクスの遅れが過ぎるのを待つ。
- 各回の CloudWatch メトリクス（`metrics-lib.ts`）と、Event の `REPORT` 行の集計（Logs Insights、`reports-lib.ts`）を集め、ログに出す（`SUITE_METRICS` / `SUITE_REPORTS`。1 行 256 KB の制限に収まるよう分割）。
- 回収後と同じ形のファイルを作り、`analyze.ts` で合格基準を判定して、`SUITE_VERDICT` を出す。
- 失敗しても、測定は終わりまで進む。`SUITE_POST_FAILED` が残る。

**`suite-fetch.ts`**
- ログを、回ごとのファイル（`<ケース>-set<セット>-<順>-<構成>.{log,json,meta.json,metrics.json,reports.json}`）、セットごとの manifest、`suite.plan.json` に分ける。
- AWS のメトリクスは呼ばない。後処理が失敗した回だけ、AWS CLI で集める。
- `--wait` で、タスクの終了を待ってから実行できる。

**回収の期限と注意**
- ログは 30 日（`Gekko10LoadStack` のロググループは ONE_MONTH）。回収には `aws sso login` が要る。
- esbuild は、モジュールを 1 つのファイルにまとめる。そのため、バンドルに入るモジュールに、「直接実行されたときだけ動く」判定（`import.meta.url`）を置かない。置くのは入口のスクリプトだけ（`test/entrypoints.test.ts` が確かめる）。
