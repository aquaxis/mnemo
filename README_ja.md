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
- **AI チャット** — 設定した AI エージェントと対話（agent-cli などWeb対応バックエンドは応答時にWeb検索やノート検索も行います）。会話はノートとして自動保存されます。
- **AI ノート検索** — エージェントが全ノートを横断して検索できます（FR-FILE-6）。
- **AI エージェントの選択** — バックエンドを選択可能：agent-cli、Claude Code（CLI）。Claude API は使用しません。
- **設定ページ** — 使用する AI バックエンドの選択、AI 出力言語の設定、バックエンドごとの設定（コマンド・引数・モデル）の編集ができます。
- **Cron スケジューリング** — 日時や曜日ごとにタスクを定期実行。各タスクは AI エージェントに実行指示（instruction）を与えて実行します（ソースはエージェントが自分で探します）。単なる固定クロールではありません。
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

## ファイル構成

```
data/
├── notes/         # すべての Markdown。カテゴリごとに分類
│   ├── inbox/
│   ├── wiki/
│   └── collected/ # AI が収集したノート
├── assets/        # バイナリのみ（画像 / 音声 / 動画）
├── config.json
└── jobs/          # スケジュールジョブの定義と実行履歴
```

## 技術スタック

全面的に TypeScript。サーバー：Fastify。Web：React + Vite + Tailwind。エディタ：
CodeMirror 6。検索：FlexSearch。スケジューリング：node-cron。

## ライセンス

MIT
