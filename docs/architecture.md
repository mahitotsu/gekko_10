# アーキテクチャと運用

何を、どう作っているか。なぜそう作ったか。どう動かすか。
検証の目的と測定の設計は [plan.md](plan.md)、実機で確かめた事実は [findings.md](findings.md)、Web Functions の仕様は [web-functions-notes.md](web-functions-notes.md)。

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
| `src/app.ts` | 共通の Hono アプリ。`/noop`, `/wait?ms=N`, `/db/ping`, `/db/read`。環境の識別情報を返す |
| `src/db.ts` | DSQL への接続層。`each` / `reuse` / `pool` の 3 モード（公式コネクタを使う） |
| `src/entry-web.ts` | Web Functions 用。`@hono/node-server` で `AWS_LAMBDA_HTTP_ENDPOINT` に listen |
| `src/entry-event.ts` | Event Functions 用。`hono/aws-lambda` の `handle()` |
| `scripts/bundle.mjs` | 両方を同じ esbuild 設定でバンドル（`dist/web`, `dist/event`） |

- LWA（Lambda Web Adapter）は使わない。
- 結果の解釈に影響する差: リクエストの変換層が異なる（Web は Node の `IncomingMessage` → `Request`、Event は関数URLのイベント JSON → `Request`）。どちらも小さい見込みだが、DB なしの `/noop` で差を把握し、DSQL の結果に注記する。

## 3. 関数の一覧
| 関数 | 形態 | `DB_MODE` | 接続の持ち方 |
|---|---|---|---|
| `gekko10-event-noop` | Event (1 GB) | なし | DB なし |
| `gekko10-event-dsql-each` | Event (1 GB) | `each` | リクエストごとに接続して閉じる |
| `gekko10-event-dsql-reuse` | Event (1 GB) | `reuse` | 環境内で 1 接続を保持して再利用（55 分で張り直す。切れていたら 1 回だけ再接続して再試行） |
| `gekko10-web-noop` | Web | なし | DB なし |
| `gekko10-web-dsql-each` | Web | `each` | リクエストごとに接続して閉じる |
| `gekko10-web-dsql-pool` | Web | `pool` | 環境内で `AuroraDSQLPool` を共有（`DB_POOL_MAX` = 64 = maxConcurrencyPerEnvironment） |

- Web は構成ごとに別の関数にする。メトリクスにリビジョンの次元がなく、動的な同時実行数の学習が関数単位だから。
- Event に `reuse` を入れるのは、「Web で接続を共有する効果」と「単に接続を使い回す効果」を切り分ける対照のため。Event は 1 環境が同時に 1 リクエストしか処理しないので、プールは実質 1 接続になる。
- Event のメモリ違い（512 MB / 3.5 GB）と Web の maxConcurrency 違い（16 / 128）は、まだ作っていない（[plan.md](plan.md) の段階 3）。

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

失敗したときは 503 で、`ok:false`、`error`、`code`（上の 3 分類）、`sqlstate`、`phase`（`connect` / `query`）を返し、同じ内容を 1 行の JSON ログ（`"event":"db_error"`）にも出す。成功したリクエストはログに出さない（負荷試験でのログ量を抑えるため）。DSQL が接続の拒否を SQLSTATE `53400` / `53300` で返すかは未確認なので、メッセージ（`rate exceeded` / `too many open connections`）でも判定している。

## 6. DSQL の接続層（`src/db.ts`）
- 3 モードとも公式コネクタ `@aws/aurora-dsql-node-postgres-connector` を使い、実装の差を作らない。違いは接続の持ち方だけ。
- `each`: リクエストごとに `AuroraDSQLClient` を作り、`connect()` → 問い合わせ → `end()`。
- `reuse`: 環境内で `AuroraDSQLClient` を 1 つ保持する。`error` / `end` イベント、または 55 分を超えたら破棄して次のリクエストで接続し直す。接続が切れていた場合は 1 回だけ再接続して再試行し、`reconnected: true` を返す。
- `pool`: 環境内で `AuroraDSQLPool` を 1 つ共有する（初回の使用時に作る）。アイドルは 60 秒で閉じ、接続の最長は 3,300 秒。`error` イベントのリスナーを必ず登録する（登録しないとプロセスが落ちる）。
- 認証は admin ロール（`dsql:DbConnectAdmin`）。認証情報はコネクタの既定（`fromNodeProviderChain`）に任せる。
- テーブルは `items (id integer PRIMARY KEY, payload text)` に 1,000 行（payload 100 バイト）。`scripts/db-setup.ts` が冪等に作る。
- テストでは、DB へのアクセスを `createApp({ db })` に注入して偽の実装を使う（`test/db.test.ts`）。

## 7. 負荷生成の仕組み
- 東京の Fargate タスクから `scripts/invoke.ts` を実行する（`Gekko10LoadStack`、`scripts/load-run.sh`）。常設のリソースを持たず、使うときだけ `run-task` で起動する。
- `lib/load-stack.ts`: デフォルト VPC を `Vpc.fromLookup` で参照し、`ecs.Cluster` に渡す（VPC は作らない）。セキュリティグループ（入口なし）、ロググループ（1 週間）、2 vCPU / 4 GB（x86_64）のタスク定義。VPC・サブネット・NAT・VPC エンドポイント・ロードバランサ・サービスは作らない。
- タスクロール: 6 つの関数に絞った `lambda:InvokeFunctionUrl`（Event）と `lambda:InvokeWebFunctionEndpoint`（Web）のみ。
- イメージ: `load/Dockerfile`。`scripts/bundle-load.mjs` が `invoke.ts` を 1 ファイル（`load/invoke.mjs`）にまとめる。CDK のブートストラップ用 ECR に push される。
- `scripts/load-run.sh [--max-seconds N] -- <invoke.ts の引数>`: スタックの出力からクラスタ・サブネットなどを取り、`assignPublicIp=ENABLED` で起動して、終了を待ち、CloudWatch Logs の出力を表示する。最大実行時間（既定は `--duration` + 180 秒、なければ 600 秒）を超えたとき、Ctrl-C のとき、エラーのときは `stop-task` で止める。
- 接続は `undici` の `Agent` で上限を設ける（`--max-connections`、既定 256。keep-alive 60 秒、接続のタイムアウト 30 秒）。上限がないと、一時的な遅延が新規接続の集中を招き、生成側が詰まる（[findings.md](findings.md) §3-4）。
- 生成側が飽和していないかは、`invoke.ts` の出力（`loadgenCoresUsed` / `loadgenCoresAvailable`、`--duration` では `load generator:` 行）で確認する。

## 8. 設計の判断と理由
| 判断 | 理由 |
|---|---|
| Web の関数を構成ごとに分ける | メトリクスにリビジョンの次元がなく、動的な同時実行数の学習が関数単位のため |
| Event に「環境内で 1 接続を再利用」の構成を足す | 「共有する効果」と「使い回す効果」を切り分けるため |
| 「毎回接続」で DSQL の接続レート 100/秒の上限に達したら、回避せず結果として記録する | 仮説を支持する結果であり、上限を避けるとその差が見えなくなるため。クラスタを分けたり負荷を絞ったりしない。53400（接続レート）と Lambda 側の制限（429 など）を区別して記録する |
| VPC を使わず、DSQL のパブリックエンドポイントに接続する | Event も Web もネットワーク設定が不要になる（Web の VPC 接続はネットワークコネクタが必要で、HomeRegion のみ） |
| `DbStack` を関数のスタックと分ける | クラスタだけ先に作り、テーブルを用意して、バンドルを手元から実クラスタにつないで確かめてから関数をデプロイできる。クラスタを関数の作り直しから切り離す |
| Event と Web でスタックを分け、構成はリストから作る | 更新の失敗のロールバックを分ける。構成の追加が 1 行で済む |
| `pool` の `max` は 64（= maxConcurrencyPerEnvironment） | `max` が同時処理数より小さいと、プールの待ちが接続共有の効果に混ざるため。実際の接続数は観測した同時処理（約 25）程度に収まる見込み。maxConcurrency を変えるときは `DB_POOL_MAX` も揃える |
| 検証のクエリは主キーでの 1 行の読み取りと `SELECT 1`。書き込みは入れない | 書き込みは commit のレイテンシと OCC の競合が支配的になり、接続のコストが見えにくくなるため |
| admin ロールで接続する | 検証用で、独自ロールの作成手順を増やさないため。リソースはクラスタの ARN のみ |
| コネクタの `customCredentialsProvider` を渡さない | 渡さない場合のコネクタの既定は `fromNodeProviderChain({profile})`（ソースで確認）で、Lambda では環境変数の認証情報が使われるため |
| 負荷生成は `invoke.ts` を Fargate で実行する。k6 と EC2 は使わない | 署名の実装がすでにある。常設のリソースを持たない。k6 の利点は到着レート固定（open model）だが、`invoke.ts` は並行数固定（closed model）。必要になったら `--rate` を足すか k6 を検討する |
| 負荷生成のタスクは public IP を付け、NAT Gateway を作らない | ECR からのイメージの取得と CloudWatch Logs への出力にインターネットへの経路が要るため。NAT Gateway は常設の課金になる |
| 東京の単価は AWS Price List API で取得する | 公式ページには東京の単価が載っていない。取得した値は [findings.md](findings.md) に出典つきで記録する |

## 9. 運用の手順
### 前提
- Node.js 24、npm、Docker（負荷生成のイメージのビルド）
- AWS CLI v2 の新しいバージョン（`lambda-web` コマンドが必要。2.31.35 では使えず、2.38.1 で動作を確認した。apt 版は古いので公式インストーラで入れる）
- AWS の認証情報と、ap-northeast-1 での `cdk bootstrap`

### ローカルでの確認
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

### デプロイ
```sh
npx cdk synth                         # 4 スタックを合成（bundle も自動で走る）
npx cdk deploy Gekko10DbStack         # 先に DSQL クラスタだけを作る
npm run db-setup -- <Gekko10DbStack の Endpoint>   # テーブルと 1,000 行
npx cdk deploy Gekko10EventStack Gekko10WebStack
npx cdk deploy Gekko10LoadStack       # 負荷生成が必要になったとき。イメージが ECR に push される
```
- 他の `cdk` コマンドが動いている間は、`cdk.out` が競合して `Other CLIs ... are currently reading from cdk.out` で失敗する。並行して `synth` / `diff` したいときは `--output <別ディレクトリ>` を付ける。
- デプロイの前に、バンドルを実クラスタにつないで確かめられる: `DB_MODE=each|pool DSQL_ENDPOINT=<Endpoint> AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node dist/web/index.js`（`eval "$(aws configure export-credentials --format env)"` で認証情報を出しておく）。
- `cdk synth` で `Unknown resource type 'AWS::Lambda::WebFunction'`（F3006）の警告が出るが、CDK 側の検証スキーマが新しいリソースタイプを知らないだけで、合成は成功する。
- Web スタックは関数ごとに専用の S3 バケット（バージョニング有効）にコードを置く。Web Functions は S3 のコードしか受け付けず、バケットポリシーで Lambda サービスに読み取りを許可する必要があるため。コードを変えると新しいリビジョンが作られ、古いリビジョンは削除される。
- デプロイ後の出力: Event は `Url`（関数URL）、Web は `EndpointUrl`・`EndpointArn`。
- 認証はどちらも IAM。署名なしのリクエストは 403 になる。

### アカウントのクォータ確認（Web Functions）
```sh
aws lambda-web get-web-account-settings --region ap-northeast-1
```
`accountQuotas.maxTotalArmVCpus`（環境 1 つ = 2 vCPU）と `maxTotalRateLimit`（RPS）を確認する。新しいアカウントは低いことがある（このアカウントの実測は [findings.md](findings.md)）。

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
関数ごとに Resource を足す（Web は `web-function/gekko10-web-dsql-each/endpoint/main` など）。

### 動作確認（デプロイ後）
1. 署名なしは拒否される
   ```sh
   curl -i "<Event の Url>noop"          # 403
   curl -i "<Web の EndpointUrl>/noop"   # 403
   ```
2. SigV4 署名付きリクエスト。`scripts/invoke.ts` は両方に使える（サービス名は `lambda`、`x-amz-content-sha256` を常に付ける。Web Functions では必須）。ヘッダの値は空ボディの SHA-256 にする。関数URLは `UNSIGNED-PAYLOAD` を付けると署名不一致で 403 になるので、両方に通る実際のハッシュを使っている（[findings.md](findings.md)）。
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

### 負荷をかける
```sh
scripts/load-run.sh [--max-seconds N] -- <invoke.ts の引数>
scripts/load-run.sh -- https://<endpoint> --path /db/read --duration 300 --concurrency 100
```
出力の `loadgenCoresUsed` が `loadgenCoresAvailable`（2）に近いときは、生成側が飽和しているので、その結果は採用しない。

### ログとメトリクス
- Event のログ: `/aws/lambda/<関数名>`（`REPORT` 行に Init Duration）
- Web のログ: `/aws/lambda/web/<関数名>`（ホームリージョンへの集約は数十秒〜数分遅れる）と、`.local` 付きのグループ。保持期限は 1 週間に設定済み
- Web のメトリクス: 名前空間 `AWS/Lambda/Web`（FunctionName）と `AWS/Lambda/Web/Usage`（`EndpointActiveEnvironments` など）。リビジョンの次元はない。
- DSQL のメトリクス: 名前空間 `AWS/Usage`（`CallCount`, `ClusterConnectionCount`）と `AWS/AuroraDSQL`（DPU など）。次元と挙動は [findings.md](findings.md)。
- 失敗時: レスポンスヘッダ `lambda-web-error-type` を見る。Web Functions はデプロイが Active でもサーバーが起動していないことがあるので、まずログを確認する。

### 後片付け
```sh
npx cdk destroy Gekko10WebStack Gekko10EventStack   # 先に関数
npx cdk destroy Gekko10LoadStack                    # 負荷生成の定義（ECR のイメージは残る）
npx cdk destroy Gekko10DbStack                      # 最後にクラスタ（テーブルごと消える）
```
- Db スタックは Event / Web から参照されているので、先には消せない。Web のコード用バケットは `autoDeleteObjects` で中身ごと削除される。
- Web の動的な同時実行数の学習は関数に保持される。測定の期間中は Web スタックを destroy しない。
- CDK のブートストラップ用の ECR / S3 には、使われなくなった成果物が溜まる。`cdk gc --unstable=gc --type ecr`（または `s3`）で整理できる。まず `--action print` で対象を確かめる。
