# Mnemo

[English](./README.md) | 日本語

**Mnemo** は Markdown を基盤とした統合型ナレッジデータベースであり、記憶と知識
の万能アーカイブです。ノート作成（Obsidian ライクな Markdown ライブ編集）、
Wiki、AI エージェントによる Web 情報収集、定期タスク実行を兼ね備え、すべての
データをポータブルな Markdown ファイルとして保存します。

名称はギリシャ神話の記憶の女神 **Mnemosyne（ムネモシュネ）** に由来します。

## 特長

- **3 ペイン UI**（ナビゲーション・ノート一覧・エディタ）。shadcn Mail のレイアウトを参考。左・中央ペインは折りたたみ可能。
- **ライブ Markdown エディタ** — Obsidian 風のインライン・ライブプレビュー（CodeMirror 6 + [codemirror-live-markdown](https://codemirror-live-markdown.vercel.app/)）。
- **AI 情報収集** — Web ページをクロールし要点を抽出してノートとして保存。
- **AI チャット（調査モード）** — 質問すると、エージェントがWebを網羅的に調査し（複数のクエリで検索し、複数の情報源を突き合わせ）、出典付きで詳細に回答します。ノートの検索も行えます。会話はノートとして自動保存され、応答待ちの経過秒数表示とキャンセルに対応。**Schedule task** から定期タスクにもできます。
- **AI ノート検索** — エージェントが全ノートを横断して検索できます（FR-FILE-6）。
- **AI エージェントの選択** — バックエンドを選択可能：agent-cli、Claude Code（CLI）。Claude API は使用しません。
- **設定ページ** — 使用する AI バックエンドの選択、AI 出力言語の設定、バックエンドごとの設定（コマンド・引数・モデル）の編集ができます。
- **Cron スケジューリング** — 日時や曜日ごとにタスクを定期実行。各タスクは AI エージェントに実行指示（instruction）を与えて実行します（ソースはエージェントが自分で探します）。単なる固定クロールではありません。タスクはスケジューラ画面から、またはチャットから直接作成できます。
- **Markdown 優先ストレージ** — 知識はすべて Markdown として、入れ子（階層）フォルダ（カテゴリ）で整理。バイナリは別ディレクトリに保存。

## 動作要件

- Node.js >= 18（Python は一切使用しません）。

## インストール（ワンライナー）

```bash
curl -fsSL https://raw.githubusercontent.com/aquaxis/mnemo/main/install.sh | sh
```

ディレクトリを指定する場合：

```bash
curl -fsSL https://raw.githubusercontent.com/aquaxis/mnemo/main/install.sh | sh -s -- my-mnemo
```

## アップデート（データは破壊されません）

インストール済みのディレクトリ内で実行します：

```bash
npm run update
```

既存のインストールに対してワンライナーを再実行しても、再インストールではなく
アップデートになります：

```bash
curl -fsSL https://raw.githubusercontent.com/aquaxis/mnemo/main/install.sh | sh -s -- my-mnemo
```

アップデートはソースの更新と再ビルドのみを行い、**`data/` には一切書き込み・
移動・削除を行いません**。ノート（下位階層のフォルダを含む）、バイナリ資産、
`data/config.json`、スケジュールタスクとその実行履歴はすべてそのまま保持されます。
新しいリリースで追加された設定キーは、既存の設定値を壊さずデフォルトから補完
されます。

アップデートは安全側に倒しています。git チェックアウトの場合は
`git pull --ff-only` のみを行うため、ローカル変更やブランチの分岐があるときは
上書きせずメッセージを表示して中断します。git が無い場合は一時ディレクトリに
ダウンロードし、ソースのパスだけをコピーします。対象ディレクトリが Mnemo の
インストールでない場合は、何も変更せず中断します。

## 手動セットアップ

```bash
git clone https://github.com/aquaxis/mnemo.git
cd mnemo
npm install
npm start           # Web アプリをビルドしサーバーを起動
```

その後 <http://localhost:3000> を開きます。

### 開発

```bash
npm run dev         # Vite 開発サーバー (5173) + API サーバー (3000)、プロキシ付き
```

## 設定

初回起動時に `data/` が `templates/` から初期化されます。`data/config.json` を編集します：

```json
{
  "port": 3000,
  "ai": {
    "type": "agent-cli",
    "outputLanguage": "ja",
    "timeoutMs": 300000,
    "maxOutputBytes": 2000000,
    "maxConcurrentRuns": 2,
    "backends": {
      "agent-cli": { "command": "agent-cli", "args": ["run", "--auto-approve-tools"] },
      "claude-code": { "command": "claude", "args": ["-p"] }
    }
  }
}
```

`ai.type` で使用する AI エージェントのバックエンドを、`ai.outputLanguage`
（例：`en`、`ja`）で AI 要約の出力言語を指定します。デフォルトは **agent-cli** と
**日本語** 出力です。アプリの
**設定（Settings）ページ**から切り替えやバックエンドごとの設定編集もできます：

- `agent-cli` — [agent-cli](https://github.com/aquaxis/agent-cli) コマンド（デフォルト。`agent-cli run --auto-approve-tools` で起動、agent-cli 側の設定プロバイダを使用）。
- `claude-code` — Claude Code CLI（print モード）。Claude API は使用しません。
- `local` — オフラインの簡易処理。API やインストール不要（内部フォールバック）。

CLI エージェントはノートディレクトリを作業ディレクトリとして起動されるため、
全ノートを検索・参照して回答できます。

選択したバックエンドが利用できない場合は、収集が失敗しないよう自動的にローカル
簡易処理へフォールバックします。

### 安定動作のための設定

| キー | 既定値 | 意味 |
|------|--------|------|
| `ai.timeoutMs` | `300000` | この時間内に応答しないバックエンドは停止し、失敗として通知します。チャットやタスクが無応答のままになりません。既定値は数分かかる調査型の回答に合わせています。設定ページからも変更できます。 |
| `ai.maxOutputBytes` | `2000000` | バックエンドから受け取る出力の上限。暴走した CLI がメモリを食い潰すことを防ぎます。 |
| `ai.maxConcurrentRuns` | `2` | 同時に実行できるエージェント実行数（チャット・収集・定期タスク）。超過分は待機します。 |

### ログ

ログは `data/logs/mnemo.log` に出力され、コンソールには起動行のみ表示します。
これは意図的な仕様です。Linux / macOS では Node の端末への書き込みは
**ブロッキング**であるため、起動した端末を閉じた場合（あるいは SSH が切断され
端末が読み出されなくなった場合）にサーバーが停止してしまいます
（プロセスは生きているのにリクエストに応答しなくなる）。ファイルへ出力すること
で、端末の状態に関係なくサーバーが動き続けます。

コンソールに出力したい場合（開発時など）は `MNEMO_LOG=stdout` を指定するか、
`config.json` に `"logTarget": "stdout"` を設定します。

端末を閉じても動かし続けるには、デタッチして起動してください：

```bash
nohup npm start >/dev/null 2>&1 &
```

### トラブルシューティング：チャットが応答しない

1. **設定（Settings）ページ**を開きます。コマンドが見つからないバックエンドは
   警告表示されます。
2. `data/logs/mnemo.log` を確認します。失敗したバックエンド実行は、コマンド・
   終了状態・所要時間・エラー出力とともに記録されます。
3. チャットの返信には失敗理由（コマンド未検出・タイムアウト・混雑）が表示され
   るため、無言のまま止まることはありません。

## ファイル構成

```
data/
├── notes/         # すべての Markdown。カテゴリごとに分類
│   ├── inbox/
│   ├── wiki/
│   └── collected/ # AI が収集したノート
├── assets/        # バイナリのみ（画像 / 音声 / 動画）
├── config.json
├── logs/          # サーバーログ（mnemo.log）
└── jobs/          # スケジュールジョブの定義と実行履歴
```

## 技術スタック

全面的に TypeScript。サーバー：Fastify。Web：React + Vite + Tailwind。エディタ：
CodeMirror 6。検索：FlexSearch。スケジューリング：node-cron。

## ライセンス

MIT
