//! "Trouver un livre": the free, legal catalogue on livres.hosh.it
//! (OPDS 2.0, contract in `core/testdata/livres/`, copied from the server's
//! `contract/` folder). This module only reads and checks what the server
//! sends; the HTTP calls are made by the shell.
//!
//! Safety rules (ADR-0008):
//! - only `https://livres.hosh.it` is asked for pages, and `next`/`previous`
//!   links pointing anywhere else are dropped;
//! - books are downloaded only from the hosts the server lists in
//!   `/api/v1/download-hosts`, over HTTPS, and only EPUB, MOBI or PDF;
//! - every message shown to Mom is a French sentence.

use crate::formats::Format;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BASE: &str = "https://livres.hosh.it";

pub fn catalog_url() -> String {
    format!("{BASE}/opds/v2/catalog.json")
}
pub fn search_url(query: &str) -> String {
    format!("{BASE}/opds/v2/search?query={}", encode(query.trim()))
}
pub fn hosts_url() -> String {
    format!("{BASE}/api/v1/download-hosts")
}
pub fn requests_url() -> String {
    format!("{BASE}/api/v1/requests")
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The host of an `https://` URL, lowercase; `None` for anything else
/// (other schemes, user names, odd ports).
pub fn https_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = &rest[..end];
    if host.is_empty() || host.contains(['@', ':', '\\']) {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// A page of the catalogue the app may open (next/previous, suggestions).
pub fn is_catalog_url(url: &str) -> bool {
    https_host(url).as_deref() == https_host(BASE).as_deref()
        && url[BASE.len()..].starts_with("/opds/")
}

/// May a book be downloaded from this URL?
pub fn download_allowed(url: &str, hosts: &[String]) -> bool {
    https_host(url).is_some_and(|h| hosts.iter().any(|a| a.eq_ignore_ascii_case(&h)))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Acquisition {
    pub url: String,
    pub format: Format,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Found {
    /// Stable identifier from the server ("source:id").
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub description: Option<String>,
    /// Where the book comes from ("Ebooks libres et gratuits").
    pub source: Option<String>,
    /// The file to download: EPUB first (converted for the Kindle, and the
    /// best to share), else MOBI, else PDF. `None`: nothing she can use.
    pub download: Option<Acquisition>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Suggestion {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Page {
    pub title: String,
    pub books: Vec<Found>,
    /// Shortcuts offered on the catalogue's first page ("Victor Hugo"…).
    pub suggestions: Vec<Suggestion>,
    pub next: Option<String>,
    pub previous: Option<String>,
}

fn media_format(t: &str) -> Option<Format> {
    match t.split(';').next()?.trim() {
        "application/epub+zip" => Some(Format::Epub),
        "application/x-mobipocket-ebook" => Some(Format::Mobi),
        "application/pdf" => Some(Format::Pdf),
        _ => None,
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn link_with_rel(links: Option<&Value>, rel: &str) -> Option<String> {
    links?
        .as_array()?
        .iter()
        .find(|l| str_of(l, "rel") == Some(rel))
        .and_then(|l| str_of(l, "href"))
        .filter(|h| is_catalog_url(h))
        .map(str::to_string)
}

fn publication(p: &Value) -> Option<Found> {
    let m = p.get("metadata")?;
    let title = str_of(m, "title")?.to_string();
    let author = match m.get("author") {
        Some(Value::String(s)) => Some(s.trim().to_string()),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().or_else(|| str_of(x, "name")))
            .next()
            .map(|s| s.trim().to_string()),
        Some(o @ Value::Object(_)) => str_of(o, "name").map(str::to_string),
        _ => None,
    }
    .filter(|a| !a.is_empty());
    let source = m
        .get("belongsTo")
        .and_then(|b| b.get("collection"))
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| str_of(c, "name"))
        .map(str::to_string);
    let mut acquisitions: Vec<Acquisition> = p
        .get("links")
        .and_then(|l| l.as_array())
        .map(|links| {
            links
                .iter()
                .filter(|l| {
                    str_of(l, "rel").is_some_and(|r| r.contains("opds-spec.org/acquisition"))
                })
                .filter_map(|l| {
                    Some(Acquisition {
                        url: str_of(l, "href")?.to_string(),
                        format: media_format(str_of(l, "type")?)?,
                        size: l
                            .get("properties")
                            .and_then(|p| p.get("size"))
                            .and_then(|s| s.as_u64()),
                    })
                })
                .filter(|a| https_host(&a.url).is_some())
                .collect()
        })
        .unwrap_or_default();
    let rank = |f: Format| match f {
        Format::Epub => 0,
        Format::Mobi => 1,
        _ => 2,
    };
    acquisitions.sort_by_key(|a| rank(a.format));
    Some(Found {
        id: str_of(m, "identifier").unwrap_or(&title).to_string(),
        title,
        author,
        description: str_of(m, "description").map(|d| d.chars().take(600).collect()),
        source,
        download: acquisitions.into_iter().next(),
    })
}

/// Read a catalogue page (navigation or search results).
pub fn parse_page(body: &[u8]) -> Option<Page> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let books = v
        .get("publications")
        .and_then(|p| p.as_array())
        .map(|ps| ps.iter().filter_map(publication).collect())
        .unwrap_or_default();
    let suggestions = v
        .get("navigation")
        .and_then(|n| n.as_array())
        .map(|ns| {
            ns.iter()
                .filter_map(|n| {
                    let url = str_of(n, "href")?;
                    let title = str_of(n, "title")?.to_string();
                    is_catalog_url(url).then(|| Suggestion {
                        title,
                        url: url.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Page {
        title: v
            .get("metadata")
            .and_then(|m| str_of(m, "title"))
            .unwrap_or("Livres gratuits")
            .to_string(),
        books,
        suggestions,
        next: link_with_rel(v.get("links"), "next"),
        previous: link_with_rel(v.get("links"), "previous"),
    })
}

/// `{"hosts": [...]}` from `/api/v1/download-hosts`.
pub fn parse_hosts(body: &[u8]) -> Vec<String> {
    #[derive(Deserialize)]
    struct Hosts {
        hosts: Vec<String>,
    }
    serde_json::from_slice::<Hosts>(body)
        .map(|h| {
            h.hosts
                .into_iter()
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty() && !s.contains(['/', '@', ':']))
                .collect()
        })
        .unwrap_or_default()
}

/// The sentence to show when the server said no: its own French `error`
/// when there is one, else a sentence chosen from the status.
pub fn error_message(status: u16, body: &[u8]) -> String {
    let own = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| str_of(&v, "error").map(|s| s.chars().take(300).collect::<String>()));
    own.unwrap_or_else(|| match status {
        429 => "Beaucoup de recherches d'un coup : réessayez dans quelques minutes.".into(),
        401 | 403 => "Le service de livres refuse l'accès. Prévenez Alexandre.".into(),
        _ => "Le service de livres ne répond pas pour l'instant. Réessayez plus tard.".into(),
    })
}

pub const OFFLINE: &str =
    "Pas de connexion à internet pour l'instant. Vérifiez la connexion, puis réessayez.";

/// Does the start of a downloaded file look like the promised book? A page
/// saying "file not found" (or anything else) is never added as a book.
pub fn looks_like(format: Format, head: &[u8]) -> bool {
    match format {
        Format::Epub => head.starts_with(b"PK\x03\x04"),
        Format::Mobi => head
            .get(60..68)
            .is_some_and(|k| k == b"BOOKMOBI" || k == b"TEXtREAd"),
        Format::Pdf => head.starts_with(b"%PDF-"),
        _ => false,
    }
}

/// The body of a "Demander un livre" request.
pub fn request_body(title: &str, author: &str, message: &str) -> String {
    serde_json::json!({ "title": title.trim(), "author": author.trim(), "message": message.trim() })
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden(name: &str) -> Vec<u8> {
        std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/livres/").to_string() + name)
            .unwrap()
    }

    #[test]
    fn reads_the_catalogue_contract() {
        let home = parse_page(&golden("catalog.json")).unwrap();
        assert!(home.books.is_empty());
        assert!(home.suggestions.iter().any(|s| s.title == "Victor Hugo"));
        assert!(home.suggestions.iter().all(|s| is_catalog_url(&s.url)));

        let p1 = parse_page(&golden("search-page1.json")).unwrap();
        assert!(p1.title.contains("maupassant"));
        let bel_ami = &p1.books[0];
        assert_eq!(bel_ami.title, "Bel-Ami");
        assert_eq!(bel_ami.author.as_deref(), Some("Guy de Maupassant"));
        assert_eq!(bel_ami.source.as_deref(), Some("Ebooks libres et gratuits"));
        let d = bel_ami.download.as_ref().unwrap();
        assert_eq!(d.format, Format::Epub, "EPUB first");
        assert_eq!(d.size, Some(412345));
        assert!(p1.next.as_deref().unwrap().ends_with("page=2"));
        assert!(p1.previous.is_none());

        let p2 = parse_page(&golden("search-page2.json")).unwrap();
        assert!(p2.books.is_empty());
        assert!(p2.previous.is_some() && p2.next.is_none());
    }

    #[test]
    fn requests_and_errors_follow_the_contract() {
        assert_eq!(
            error_message(400, &golden("request-400-missing-title.json")),
            "Indiquez le titre du livre que vous cherchez."
        );
        assert!(error_message(400, &golden("request-400-bad-email.json")).contains("e-mail"));
        assert!(error_message(429, b"").contains("quelques minutes"));
        assert!(error_message(502, b"<html>").contains("ne répond pas"));
        let body: Value =
            serde_json::from_str(&request_body(" Le Horla ", "Maupassant", "")).unwrap();
        assert_eq!(body["title"], "Le Horla");
    }

    #[test]
    fn only_trusted_places() {
        let hosts = parse_hosts(
            br#"{"hosts":["www.ebooksgratuits.com"," Gutenberg.org ","evil.com/x","a@b"]}"#,
        );
        assert_eq!(hosts, vec!["www.ebooksgratuits.com", "gutenberg.org"]);
        assert!(download_allowed(
            "https://www.ebooksgratuits.com/x.epub",
            &hosts
        ));
        assert!(download_allowed(
            "https://GUTENBERG.org/ebooks/1.epub",
            &hosts
        ));
        assert!(
            !download_allowed("http://www.ebooksgratuits.com/x.epub", &hosts),
            "HTTPS only"
        );
        assert!(!download_allowed(
            "https://www.ebooksgratuits.com.evil.com/x",
            &hosts
        ));
        assert!(!download_allowed(
            "https://user@www.ebooksgratuits.com/x",
            &hosts
        ));
        assert!(!download_allowed(
            "https://www.ebooksgratuits.com:8443/x",
            &hosts
        ));
        assert!(is_catalog_url(
            "https://livres.hosh.it/opds/v2/search?query=a&page=2"
        ));
        assert!(!is_catalog_url("https://livres.hosh.it.evil.com/opds/"));
        assert!(!is_catalog_url("https://livres.hosh.it/admin"));
        assert_eq!(
            search_url("Émile Zola & co"),
            "https://livres.hosh.it/opds/v2/search?query=%C3%89mile%20Zola%20%26%20co"
        );
    }

    #[test]
    fn only_real_books_are_kept() {
        assert!(looks_like(Format::Epub, b"PK\x03\x04rest"));
        assert!(looks_like(Format::Pdf, b"%PDF-1.7"));
        let mobi = crate::mobi::tests::sample_mobi("T", "A");
        assert!(looks_like(Format::Mobi, &mobi));
        assert!(!looks_like(
            Format::Epub,
            b"<!doctype html><p>Fichier introuvable"
        ));
        assert!(!looks_like(Format::Txt, b"hello"));
    }

    #[test]
    fn a_page_from_elsewhere_cannot_send_her_away() {
        let page = br#"{"metadata":{"title":"x"},"links":[{"rel":"next","href":"https://evil.example/opds"}],
          "publications":[{"metadata":{"title":"T"},"links":[
            {"rel":"http://opds-spec.org/acquisition/open-access","type":"application/x-msdownload","href":"https://a/b.exe"},
            {"rel":"http://opds-spec.org/acquisition/open-access","type":"application/epub+zip","href":"http://a/b.epub"}]}]}"#;
        let p = parse_page(page).unwrap();
        assert!(p.next.is_none());
        assert_eq!(p.books[0].download, None, "no .exe, no plain HTTP");
        assert!(parse_page(b"not json").is_none());
    }
}
