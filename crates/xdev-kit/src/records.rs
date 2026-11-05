//! The few fields the session and transcript readers take from a log line,
//! read without building the line's JSON tree. Fields not named here (tool
//! output, images, usage, …) are skipped as they are parsed, and kept text
//! is cut, so a line costs little more than the fields it gives.
//!
//! Every type is lenient: a field of an unexpected JSON type reads as absent
//! instead of failing the line, as `serde_json::Value::get` did.

use std::fmt;
use std::marker::PhantomData;

use serde::Deserialize;
use serde::de::value::MapAccessDeserializer;
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};

use crate::transcripts::TEXT_CHARS_MAX;

/// A string field, absent when the JSON value is not a string. A long string
/// keeps its leading whitespace and the `TEXT_CHARS_MAX` chars after it: what
/// a trim and a cut to that length read the same.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Str(Option<String>);

impl Str {
    /// The string, `None` when absent or empty.
    pub(crate) fn get(&self) -> Option<&str> {
        self.0.as_deref().filter(|s| !s.is_empty())
    }

    /// The string, empty or not.
    pub(crate) fn raw(&self) -> Option<&str> {
        self.0.as_deref()
    }

    pub(crate) fn is(&self, want: &str) -> bool {
        self.0.as_deref() == Some(want)
    }
}

fn cut(s: &str) -> String {
    let lead = s.len() - s.trim_start().len();
    match s[lead..].char_indices().nth(TEXT_CHARS_MAX) {
        Some((end, _)) => s[..lead + end].to_string(),
        None => s.to_string(),
    }
}

/// Visits any JSON value; `on_str` and `on_bool` give the value of those, the
/// rest (drained) gives `Default`.
struct Any<T, S, B> {
    on_str: S,
    on_bool: B,
    _t: PhantomData<T>,
}

impl<'de, T: Default, S: FnOnce(&str) -> T, B: FnOnce(bool) -> T> Visitor<'de> for Any<T, S, B> {
    type Value = T;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<T, E> {
        Ok((self.on_str)(v))
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<T, E> {
        Ok((self.on_bool)(v))
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<T, E> {
        Ok(T::default())
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<T, E> {
        Ok(T::default())
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<T, E> {
        Ok(T::default())
    }
    fn visit_unit<E: de::Error>(self) -> Result<T, E> {
        Ok(T::default())
    }
    fn visit_none<E: de::Error>(self) -> Result<T, E> {
        Ok(T::default())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<T, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(T::default())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<T, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(T::default())
    }
}

fn any<'de, D: Deserializer<'de>, T: Default>(
    d: D,
    on_str: impl FnOnce(&str) -> T,
    on_bool: impl FnOnce(bool) -> T,
) -> Result<T, D::Error> {
    d.deserialize_any(Any {
        on_str,
        on_bool,
        _t: PhantomData,
    })
}

impl<'de> Deserialize<'de> for Str {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        any(d, |s| Str(Some(cut(s))), |_| Str(None))
    }
}

/// `true` only for the JSON `true`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Flag(pub(crate) bool);

impl<'de> Deserialize<'de> for Flag {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        any(d, |_| Flag(false), Flag)
    }
}

/// An object read as `T`; any other JSON value is `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Obj<T>(pub(crate) Option<T>);

impl<T> Default for Obj<T> {
    fn default() -> Self {
        Obj(None)
    }
}

impl<T> Obj<T> {
    pub(crate) fn get(&self) -> Option<&T> {
        self.0.as_ref()
    }
}

struct ObjVisitor<T>(PhantomData<T>);

impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjVisitor<T> {
    type Value = Obj<T>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Obj<T>, A::Error> {
        T::deserialize(MapAccessDeserializer::new(map)).map(|t| Obj(Some(t)))
    }
    fn visit_str<E: de::Error>(self, _: &str) -> Result<Obj<T>, E> {
        Ok(Obj(None))
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Obj<T>, E> {
        Ok(Obj(None))
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Obj<T>, E> {
        Ok(Obj(None))
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Obj<T>, E> {
        Ok(Obj(None))
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Obj<T>, E> {
        Ok(Obj(None))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Obj<T>, E> {
        Ok(Obj(None))
    }
    fn visit_none<E: de::Error>(self) -> Result<Obj<T>, E> {
        Ok(Obj(None))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Obj<T>, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Obj(None))
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Obj<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(ObjVisitor(PhantomData))
    }
}

/// One item of a content array.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct Item {
    #[serde(rename = "type")]
    pub kind: Str,
    pub text: Str,
}

/// A message's `content`: a string, or an array of items (non-objects are
/// `None`).
#[derive(Debug, Default)]
pub(crate) enum Content {
    #[default]
    None,
    Text(Str),
    Items(Vec<Obj<Item>>),
}

struct ContentVisitor;

impl<'de> Visitor<'de> for ContentVisitor {
    type Value = Content;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Content, E> {
        Ok(Content::Text(Str(Some(cut(v)))))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Content, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<Obj<Item>>()? {
            items.push(item);
        }
        Ok(Content::Items(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Content, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(Content::None)
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Content, E> {
        Ok(Content::None)
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Content, E> {
        Ok(Content::None)
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Content, E> {
        Ok(Content::None)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Content, E> {
        Ok(Content::None)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Content, E> {
        Ok(Content::None)
    }
    fn visit_none<E: de::Error>(self) -> Result<Content, E> {
        Ok(Content::None)
    }
}

impl<'de> Deserialize<'de> for Content {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(ContentVisitor)
    }
}

impl Content {
    pub(crate) fn items(&self) -> &[Obj<Item>] {
        match self {
            Content::Items(items) => items,
            _ => &[],
        }
    }
}

/// A Claude Code log line.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct ClaudeLine {
    #[serde(rename = "type")]
    pub kind: Str,
    pub timestamp: Str,
    pub cwd: Str,
    #[serde(rename = "gitBranch")]
    pub git_branch: Str,
    #[serde(rename = "isSidechain")]
    pub is_sidechain: Flag,
    #[serde(rename = "isMeta")]
    pub is_meta: Flag,
    /// `Some` when the line has a `message` key, whatever its value.
    pub message: Option<Obj<ClaudeMessage>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct ClaudeMessage {
    pub id: Str,
    pub model: Str,
    pub content: Content,
}

/// A Codex rollout line.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct CodexLine {
    #[serde(rename = "type")]
    pub kind: Str,
    pub timestamp: Str,
    /// `Some` when the line has a `payload` key, whatever its value.
    pub payload: Option<Obj<CodexPayload>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct CodexPayload {
    #[serde(rename = "type")]
    pub kind: Str,
    pub id: Str,
    pub cwd: Str,
    pub git: Obj<CodexGit>,
    pub model: Str,
    pub role: Str,
    pub content: Content,
    pub message: Str,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct CodexGit {
    pub branch: Str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_string_keeps_its_lead_and_the_cap_after_it() {
        let long = format!("  {}", "é".repeat(TEXT_CHARS_MAX + 50));
        let s: Str = serde_json::from_str(&serde_json::to_string(&long).unwrap()).unwrap();
        let kept = s.get().unwrap();
        assert!(kept.starts_with("  é"));
        assert_eq!(kept.chars().count(), TEXT_CHARS_MAX + 2);
    }

    #[test]
    fn a_field_of_another_type_reads_as_absent() {
        let line: Obj<ClaudeLine> = serde_json::from_str(
            r#"{"type":1,"cwd":{"a":[1,2]},"isMeta":"yes","message":"text","timestamp":null}"#,
        )
        .unwrap();
        let line = line.get().unwrap();
        assert_eq!(line.kind.get(), None);
        assert_eq!(line.cwd.get(), None);
        assert!(!line.is_meta.0);
        assert!(line.message.as_ref().unwrap().get().is_none());
        let not_obj: Obj<ClaudeLine> = serde_json::from_str("[1,2]").unwrap();
        assert!(not_obj.get().is_none());
    }

    #[test]
    fn skipped_fields_are_not_kept() {
        let line: Obj<ClaudeLine> = serde_json::from_str(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"big"},{"type":"image","source":{"data":"AAAA"}}]}}"#,
        )
        .unwrap();
        let msg = line.get().unwrap().message.as_ref().unwrap().get().unwrap();
        let items = msg.content.items();
        assert_eq!(items.len(), 2);
        assert!(items[0].get().unwrap().kind.is("tool_result"));
        assert_eq!(items[0].get().unwrap().text.get(), None);
    }
}
