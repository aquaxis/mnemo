import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

/**
 * Render Markdown text as formatted output (FR-CHAT-10).
 *
 * The AI agent answers in Markdown — the research prompt produces headings,
 * lists, links and a "Sources" list (FR-CHAT-8) — so a reply shown verbatim
 * would display raw `#` / `*` / `-` / `[text](url)` markup. This is the app's
 * display-only Markdown path: unified/remark parses the text and react-markdown
 * builds React elements (no `dangerouslySetInnerHTML`), and `rehype-sanitize`
 * strips any HTML/script the model may have emitted, so formatting a reply
 * cannot open an injection path. It is not the CodeMirror editor, which is for
 * authoring notes (FR-NOTE-2).
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          // The agent lists its sources as links; open them in a new tab and
          // never hand the opener to the target (FR-CHAT-8, FR-CHAT-10).
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          )
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
