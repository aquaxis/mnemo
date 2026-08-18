//! Turning a chat message into a scheduled task (FR-CHAT-9), mirroring
//! `server/src/agent/task-proposal.ts`.

use serde_json::Value;

use crate::jobs::Cron;

pub struct JobProposal {
    pub name: String,
    pub cron: String,
    pub instruction: String,
    pub category: String,
}

/// Words suggesting the user wants something *recurring*. Only such messages
/// pay for the extra AI round-trip: an ordinary question must not become
/// slower because the feature exists.
pub fn mentions_cadence(text: &str) -> bool {
    let lower = text.to_lowercase();
    const EN: [&str; 12] = [
        "every day", "every morning", "every evening", "every night", "every week",
        "every month", "every hour", "daily", "weekly", "monthly", "hourly", "recurring",
    ];
    if EN.iter().any(|w| lower.contains(w)) {
        return true;
    }
    if lower.contains("schedule") || lower.contains("cron") || lower.contains("periodically") {
        return true;
    }
    const JA: [&str; 12] = [
        "毎日", "毎朝", "毎晩", "毎夜", "毎週", "毎月", "毎時", "毎年",
        "定期的", "定期実行", "スケジュール", "おきに",
    ];
    JA.iter().any(|w| text.contains(w))
        || ["月曜", "火曜", "水曜", "木曜", "金曜", "土曜", "日曜"].iter().any(|w| text.contains(w))
}

pub fn proposal_prompt(message: &str) -> String {
    format!(
        "Decide whether the following user message asks for a RECURRING, SCHEDULED task \
         (something to be run again and again on a schedule), as opposed to a one-off question.\n\n\
         Reply with JSON only - no prose, no code fences - in exactly this shape:\n\
         {{\"isTask\": true|false, \"name\": \"...\", \"cron\": \"...\", \"instruction\": \"...\", \"category\": \"...\"}}\n\n\
         Rules:\n\
         - \"isTask\" is false for anything that is not a recurring scheduled task.\n\
         - \"instruction\" must be a self-contained task description an AI agent can execute on its \
         own later, written in the imperative. Drop the scheduling words from it (they belong in \
         \"cron\") and keep every detail about WHAT to do.\n\
         - \"cron\" is a 5-field cron expression for the cadence asked for. Use 8am if they say \
         \"morning\" without a time, and \"0 8 * * *\" when the cadence is vague.\n\
         - \"name\" is a short title (at most 60 characters).\n\
         - \"category\" is the notes folder for results; use \"collected\" unless one is named.\n\n\
         User message:\n{message}"
    )
}

/// Validate the model's answer: it must claim a task, carry an instruction, and
/// name a schedule the cron parser accepts. Anything else is rejected so a
/// stray reply cannot create a bogus job.
pub fn parse_proposal(raw: &str) -> Option<JobProposal> {
    let json = extract_json(raw)?;
    let value: Value = serde_json::from_str(&json).ok()?;
    if value.get("isTask")? != &Value::Bool(true) {
        return None;
    }
    let instruction = value.get("instruction")?.as_str()?.trim().to_string();
    if instruction.is_empty() {
        return None;
    }
    let cron = value.get("cron")?.as_str()?.trim().to_string();
    Cron::parse(&cron)?;

    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| instruction.lines().next().unwrap_or("Scheduled task").to_string());
    let category = value
        .get("category")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().trim_matches('/'))
        .filter(|s| !s.is_empty())
        .unwrap_or("collected")
        .to_string();

    Some(JobProposal {
        name: name.chars().take(60).collect(),
        cron,
        instruction,
        category,
    })
}

/// Pull the first JSON object out of a reply that may carry prose or fences.
fn extract_json(raw: &str) -> Option<String> {
    let text = match raw.find("```") {
        Some(start) => {
            let after = &raw[start + 3..];
            let after = after.strip_prefix("json").unwrap_or(after);
            match after.find("```") {
                Some(end) => &after[..end],
                None => after,
            }
        }
        None => raw,
    };
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(text[start..=end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_recurring_requests_only() {
        for text in [
            "毎朝8時にAIニュースを調べてまとめて",
            "毎週月曜に競合の価格を確認して",
            "every morning, summarize the AI news",
            "Check the release notes daily and save a summary",
            "定期的にRustのリリース情報を集めて",
        ] {
            assert!(mentions_cadence(text), "should match: {text}");
        }
        for text in ["Fastifyの最新版を教えて", "What is the capital of France?", "ありがとう"] {
            assert!(!mentions_cadence(text), "should not match: {text}");
        }
    }

    #[test]
    fn accepts_a_valid_proposal() {
        let raw = "```json\n{\"isTask\":true,\"name\":\"AI news\",\"cron\":\"0 8 * * *\",\
                   \"instruction\":\"Research the latest AI news.\",\"category\":\"/collected/\"}\n```";
        let p = parse_proposal(raw).expect("accepted");
        assert_eq!(p.cron, "0 8 * * *");
        assert_eq!(p.category, "collected");
    }

    #[test]
    fn rejects_non_tasks_and_bad_schedules() {
        for (why, raw) in [
            ("not a task", "{\"isTask\":false,\"cron\":\"0 8 * * *\",\"instruction\":\"x\"}"),
            ("no instruction", "{\"isTask\":true,\"cron\":\"0 8 * * *\",\"instruction\":\"  \"}"),
            ("invalid cron", "{\"isTask\":true,\"cron\":\"every morning\",\"instruction\":\"x\"}"),
            ("missing cron", "{\"isTask\":true,\"instruction\":\"x\"}"),
            ("not JSON", "Sure! I have scheduled that for you."),
        ] {
            assert!(parse_proposal(raw).is_none(), "should reject: {why}");
        }
    }

    #[test]
    fn reads_a_proposal_wrapped_in_prose() {
        let raw = "Here you go:\n{\"isTask\":true,\"name\":\"Weekly\",\"cron\":\"0 9 * * 1\",\
                   \"instruction\":\"Check pricing.\"}\nHope that helps!";
        assert_eq!(parse_proposal(raw).unwrap().cron, "0 9 * * 1");
    }
}
