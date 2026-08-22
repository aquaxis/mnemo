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

// --- Web search (FR-AGENT-7) -------------------------------------------------

/// One result from the web-search endpoint.
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Query a curl-accessible search endpoint (the configured Jina `s.jina.ai` URL
/// by default) and parse the JSON into search hits (FR-AGENT-7).
///
/// The URL-encoded query is appended to `endpoint` and the request carries
/// `Accept: application/json`; a non-empty `api_key` is sent as
/// `Authorization: Bearer …` (the default Jina `s.jina.ai` endpoint requires
/// one — without it the endpoint answers `401`). An empty `endpoint` means
/// search is disabled and yields no hits (not an error). The call is bounded by
/// `timeout_ms` so a slow endpoint cannot wedge a run (FR-REL-1); any failure is
/// returned as `Err` for the caller to log and skip (FR-AI-5, FR-REL-6).
pub async fn web_search(
    endpoint: &str,
    api_key: &str,
    query: &str,
    timeout_ms: u64,
) -> Result<Vec<SearchHit>, String> {
    if endpoint.trim().is_empty() || query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{endpoint}{}", encode_query(query));
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_millis(timeout_ms.max(1)))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(&url).header("Accept", "application/json");
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let res = request
        .send()
        .await
        .map_err(|e| format!("web search failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("web search returned {}", res.status()));
    }
    let body = res.text().await.map_err(|e| format!("web search read failed: {e}"))?;
    parse_search_results(&body)
}

/// The result of querying every configured search provider (FR-AGENT-7).
pub struct SearchOutcome {
    /// Merged hits, de-duplicated by URL, capped at the requested limit.
    pub hits: Vec<SearchHit>,
    /// One message per provider that failed (the run is not aborted).
    pub errors: Vec<String>,
}

/// Query each provider `(url, api_key)` in order and **merge** the hits,
/// de-duplicated by URL, up to `limit` (update #26). A provider that fails is
/// **skipped** — its error is collected, not fatal — so the others are still
/// used (FR-AI-5). An empty provider list or a blank query yields nothing.
pub async fn web_search_all(
    providers: &[(&str, &str)],
    query: &str,
    timeout_ms: u64,
    limit: usize,
) -> SearchOutcome {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    if query.trim().is_empty() {
        return SearchOutcome { hits, errors };
    }
    for (url, api_key) in providers {
        if hits.len() >= limit {
            break;
        }
        match web_search(url, api_key, query, timeout_ms).await {
            Ok(found) => {
                for hit in found {
                    if !hits.iter().any(|h| h.url == hit.url) {
                        hits.push(hit);
                        if hits.len() >= limit {
                            break;
                        }
                    }
                }
            }
            Err(message) => errors.push(format!("{url}: {message}")),
        }
    }
    SearchOutcome { hits, errors }
}

/// Parse the search endpoint's JSON. Tolerant of the two shapes seen in
/// practice: `{ "data": [ … ] }` (Jina) and a bare top-level array. Each item
/// contributes a hit when it has a `url`; the snippet is taken from
/// `description` / `content` / `snippet`, whichever is present.
fn parse_search_results(body: &str) -> Result<Vec<SearchHit>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("bad search JSON: {e}"))?;
    let items = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.get("results").and_then(|d| d.as_array()))
        .or_else(|| v.as_array())
        .cloned()
        .unwrap_or_default();
    let hits = items
        .iter()
        .filter_map(|it| {
            let url = it.get("url").and_then(|u| u.as_str())?.trim().to_string();
            if url.is_empty() {
                return None;
            }
            let title = it.get("title").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
            let snippet = ["description", "content", "snippet"]
                .iter()
                .find_map(|k| it.get(*k).and_then(|d| d.as_str()))
                .unwrap_or("")
                .chars()
                .take(500)
                .collect::<String>();
            Some(SearchHit { title, url, snippet })
        })
        .collect();
    Ok(hits)
}

/// Percent-encode a query value (RFC 3986 unreserved set kept as-is).
fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
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

    #[test]
    fn encodes_query_for_the_url() {
        assert_eq!(encode_query("Model Context Protocol"), "Model%20Context%20Protocol");
        // Reserved and non-ASCII bytes are percent-encoded; unreserved are kept.
        assert_eq!(encode_query("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_query("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(encode_query("日"), "%E6%97%A5");
    }

    #[test]
    fn parses_jina_data_array() {
        let body = r#"{"code":200,"status":20000,"data":[
            {"title":"MCP spec","url":"https://example.com/mcp","description":"the protocol"},
            {"title":"No url item"},
            {"title":"Second","url":"https://example.com/2","content":"body text"}
        ]}"#;
        let hits = parse_search_results(body).unwrap();
        assert_eq!(hits.len(), 2, "items without a url are skipped");
        assert_eq!(hits[0].url, "https://example.com/mcp");
        assert_eq!(hits[0].title, "MCP spec");
        assert_eq!(hits[0].snippet, "the protocol");
        assert_eq!(hits[1].snippet, "body text", "falls back to content");
    }

    #[test]
    fn parses_bare_array_and_rejects_garbage() {
        let hits = parse_search_results(r#"[{"url":"https://x.test","title":"X"}]"#).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://x.test");
        assert!(parse_search_results("not json").is_err());
    }

    #[tokio::test]
    async fn disabled_or_empty_query_yields_no_hits() {
        // No network is touched: an empty endpoint or blank query short-circuits.
        assert!(web_search("", "", "anything", 1000).await.unwrap().is_empty());
        assert!(web_search("https://s.jina.ai/?q=", "", "   ", 1000).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn web_search_all_skips_failing_providers() {
        // No providers, or a blank query, yields nothing without a panic.
        let out = web_search_all(&[], "mcp", 500, 5).await;
        assert!(out.hits.is_empty() && out.errors.is_empty());
        let out = web_search_all(&[("http://127.0.0.1:9/?q=", "")], "   ", 500, 5).await;
        assert!(out.hits.is_empty() && out.errors.is_empty(), "blank query short-circuits");
        // Two unreachable providers: each failure is reported, the run is not aborted.
        let out = web_search_all(
            &[("http://127.0.0.1:9/?q=", ""), ("http://127.0.0.1:9/?q=", "")],
            "mcp",
            500,
            5,
        )
        .await;
        assert!(out.hits.is_empty());
        assert_eq!(out.errors.len(), 2, "each failing provider is reported, not fatal");
    }
}
