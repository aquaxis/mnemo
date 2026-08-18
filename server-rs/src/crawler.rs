//! Lightweight web crawler (FR-AGENT-1): fetch a URL and pull the readable
//! text out of the HTML, mirroring `server/src/agent/crawler.ts`.

use std::time::Duration;

pub struct CrawlResult {
    pub url: String,
    pub title: String,
    pub text: String,
}

const USER_AGENT: &str = "MnemoBot/0.1 (+https://github.com/aquaxis/mnemo)";

pub async fn crawl(url: &str) -> Result<CrawlResult, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(url).send().await.map_err(|e| format!("Failed to fetch {url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Failed to fetch {url}: {}", res.status()));
    }
    let html = res.text().await.map_err(|e| format!("Failed to read {url}: {e}"))?;
    Ok(CrawlResult {
        url: url.to_string(),
        title: extract_title(&html).unwrap_or_else(|| url.to_string()),
        text: extract_text(&html),
    })
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let end = lower[open_end..].find("</title>")? + open_end;
    let title = decode_entities(html[open_end..end].trim());
    if title.is_empty() { None } else { Some(title) }
}

/// Drop scripts, styles and comments, turn block ends into newlines, then strip
/// the remaining tags.
fn extract_text(html: &str) -> String {
    let mut cleaned = String::with_capacity(html.len());
    let mut rest = html;
    // Remove <script>/<style>/<noscript> blocks and comments.
    loop {
        let lower = rest.to_lowercase();
        let next = ["<script", "<style", "<noscript", "<!--"]
            .iter()
            .filter_map(|tag| lower.find(tag).map(|i| (i, *tag)))
            .min_by_key(|(i, _)| *i);
        let Some((idx, tag)) = next else {
            cleaned.push_str(rest);
            break;
        };
        cleaned.push_str(&rest[..idx]);
        cleaned.push(' ');
        let close = match tag {
            "<!--" => "-->",
            "<script" => "</script>",
            "<style" => "</style>",
            _ => "</noscript>",
        };
        match lower[idx..].find(close) {
            Some(rel) => rest = &rest[idx + rel + close.len()..],
            None => break,
        }
    }

    let mut out = String::with_capacity(cleaned.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for c in cleaned.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                // Block-level ends become paragraph breaks.
                let t = tag.trim_start_matches('/').split_whitespace().next().unwrap_or("").to_lowercase();
                if matches!(
                    t.as_str(),
                    "p" | "div" | "section" | "article" | "li" | "br" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                ) {
                    out.push('\n');
                }
            }
            c if in_tag => tag.push(c),
            c => out.push(c),
        }
    }

    let decoded = decode_entities(&out);
    decoded
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_title_and_text() {
        let html = "<html><head><title>Hello &amp; World</title><style>b{}</style></head>\
                    <body><script>var x=1;</script><h1>Head</h1><p>First para</p>\
                    <p>Second &quot;para&quot;</p><!-- note --></body></html>";
        assert_eq!(extract_title(html).unwrap(), "Hello & World");
        let text = extract_text(html);
        assert!(text.contains("Head"), "{text}");
        assert!(text.contains("First para"), "{text}");
        assert!(text.contains("Second \"para\""), "{text}");
        assert!(!text.contains("var x"), "scripts are dropped: {text}");
        assert!(!text.contains("note"), "comments are dropped: {text}");
        assert!(!text.contains("b{}"), "styles are dropped: {text}");
    }
}
