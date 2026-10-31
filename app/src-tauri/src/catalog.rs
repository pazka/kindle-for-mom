//! HTTP side of "Trouver un livre" (ADR-0008). Everything the server says is
//! checked by `liseuse_core::catalog`; this file only moves bytes, with
//! timeouts and size limits, so a slow or broken server never hangs the app.

use liseuse_core::catalog::{self, Page};
use liseuse_core::formats::Format;
use liseuse_core::library::OpError;
use reqwest::redirect::Policy;
use reqwest::{Client, Response};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

type Res<T> = Result<T, OpError>;

/// Catalogue pages and answers are small; anything bigger is not for us.
const MAX_PAGE: usize = 2 * 1024 * 1024;

fn offline(e: reqwest::Error) -> OpError {
    eprintln!("catalogue: {e}");
    OpError::new("offline", catalog::OFFLINE)
}

fn client(redirect: Policy) -> Res<Client> {
    Client::builder()
        .user_agent(concat!("MaLiseuse/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .redirect(redirect)
        .build()
        .map_err(offline)
}

async fn body(mut resp: Response, max: usize) -> Res<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(offline)? {
        if out.len() + chunk.len() > max {
            return Err(OpError::new("catalog", catalog::error_message(0, b"")));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// GET on livres.hosh.it, the answer must be a success.
async fn get(url: &str) -> Res<Vec<u8>> {
    let resp = client(Policy::none())?
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(offline)?;
    let status = resp.status();
    let bytes = body(resp, MAX_PAGE).await?;
    if !status.is_success() {
        return Err(OpError::new(
            "catalog",
            catalog::error_message(status.as_u16(), &bytes),
        ));
    }
    Ok(bytes)
}

/// The first page (`url` None), a search, or a next/previous/suggestion link.
pub async fn page(url: Option<String>, query: Option<String>) -> Res<Page> {
    let url = match (url, query.filter(|q| !q.trim().is_empty())) {
        (_, Some(q)) => catalog::search_url(&q),
        (Some(u), None) if catalog::is_catalog_url(&u) => u,
        (Some(_), None) => return Err(OpError::new("catalog", catalog::error_message(0, b""))),
        (None, None) => catalog::catalog_url(),
    };
    let bytes = get(&url).await?;
    catalog::parse_page(&bytes)
        .ok_or_else(|| OpError::new("catalog", catalog::error_message(0, b"")))
}

/// Download a book into `to`, only from a host the server vouches for (also
/// after redirects), never bigger than `max`, and only if it really is a
/// book of the promised format.
pub async fn download(url: &str, format: Format, to: &Path, max: u64) -> Res<()> {
    let refused = || {
        OpError::new(
            "catalog",
            "Ce livre ne peut pas être téléchargé depuis cet endroit.",
        )
    };
    let hosts = catalog::parse_hosts(&get(&catalog::hosts_url()).await?);
    if !catalog::download_allowed(url, &hosts) {
        return Err(refused());
    }
    let allowed = hosts.clone();
    let policy = Policy::custom(move |a| {
        if a.previous().len() < 5 && catalog::download_allowed(a.url().as_str(), &allowed) {
            a.follow()
        } else {
            a.stop()
        }
    });
    let mut resp = client(policy)?.get(url).send().await.map_err(offline)?;
    let status = resp.status();
    if !status.is_success() {
        let bytes = body(resp, MAX_PAGE).await.unwrap_or_default();
        return Err(OpError::new(
            "catalog",
            catalog::error_message(status.as_u16(), &bytes),
        ));
    }
    if resp.content_length().is_some_and(|n| n > max) {
        return Err(OpError::new(
            "too_big",
            "Ce fichier est trop gros pour être un livre.",
        ));
    }
    let mut file = std::fs::File::create(to)?;
    let mut head = Vec::new();
    let mut total: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(offline)? {
        total += chunk.len() as u64;
        if total > max {
            return Err(OpError::new(
                "too_big",
                "Ce fichier est trop gros pour être un livre.",
            ));
        }
        if head.len() < 68 {
            head.extend_from_slice(&chunk[..chunk.len().min(68 - head.len())]);
        }
        file.write_all(&chunk)?;
    }
    file.sync_all()?;
    if !catalog::looks_like(format, &head) {
        return Err(OpError::new(
            "catalog",
            "Le fichier reçu n'est pas un livre. Réessayez plus tard, ou choisissez un autre livre.",
        ));
    }
    Ok(())
}

/// "Demander un livre": Alexandre receives the request.
pub async fn request(title: &str, author: &str, message: &str) -> Res<()> {
    let resp = client(Policy::none())?
        .post(catalog::requests_url())
        .header("content-type", "application/json")
        .body(catalog::request_body(title, author, message))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(offline)?;
    let status = resp.status();
    let bytes = body(resp, MAX_PAGE).await?;
    if !status.is_success() {
        return Err(OpError::new(
            "catalog",
            catalog::error_message(status.as_u16(), &bytes),
        ));
    }
    Ok(())
}

/// Against the real server (CI job "Live catalogue"; not run by default
/// because it needs the internet). Never sends a request to Alexandre.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore = "needs internet: cargo test -p liseuse -- --ignored"]
    fn livres_hosh_it_answers_like_the_contract() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        tauri::async_runtime::block_on(async {
            let home = page(None, None).await.expect("first page");
            assert!(!home.suggestions.is_empty(), "author ideas");
            let found = page(None, Some("hugo".into())).await.expect("search");
            assert!(!found.books.is_empty(), "results for hugo");
            let book = found
                .books
                .iter()
                .find(|b| b.download.is_some())
                .expect("a downloadable book");
            let d = book.download.as_ref().unwrap();
            let to = std::env::temp_dir().join(format!("live-book.{}", d.format.ext()));
            download(&d.url, d.format, &to, 300 * 1024 * 1024)
                .await
                .expect("download");
            assert!(std::fs::metadata(&to).unwrap().len() > 1000);
            let _ = std::fs::remove_file(&to);
            if let Some(next) = &found.next {
                page(Some(next.clone()), None).await.expect("next page");
            }
        });
    }
}
