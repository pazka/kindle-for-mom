//! What each file format means for a Kindle 4 (D01100), in words Mom understands.

use serde::Serialize;

/// Traffic light shown next to every book.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Light {
    /// Ideal for the Kindle.
    Vert,
    /// Works, but heavy or hard to read.
    Orange,
    /// Can't go on the Kindle.
    Rouge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Epub,
    Mobi,
    Azw,
    Azw3,
    Prc,
    Pdf,
    Txt,
}

/// PDFs bigger than this are flagged as really heavy for 1.2 GB of space.
pub const HEAVY_PDF: u64 = 20 * 1024 * 1024;

impl Format {
    pub fn from_path(path: &std::path::Path) -> Option<Format> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        Format::from_ext(&ext)
    }

    pub fn from_ext(ext: &str) -> Option<Format> {
        Some(match ext.to_ascii_lowercase().as_str() {
            "epub" => Format::Epub,
            "mobi" => Format::Mobi,
            "azw" => Format::Azw,
            "azw3" => Format::Azw3,
            "prc" => Format::Prc,
            "pdf" => Format::Pdf,
            "txt" => Format::Txt,
            _ => return None,
        })
    }

    pub fn ext(self) -> &'static str {
        match self {
            Format::Epub => "epub",
            Format::Mobi => "mobi",
            Format::Azw => "azw",
            Format::Azw3 => "azw3",
            Format::Prc => "prc",
            Format::Pdf => "pdf",
            Format::Txt => "txt",
        }
    }

    /// The Kindle 4 reads it as-is (EPUB must be converted first).
    pub fn kindle_native(self) -> bool {
        !matches!(self, Format::Epub)
    }

    /// Formats with a MOBI/PalmDB header we can read the title from.
    pub fn palmdb(self) -> bool {
        matches!(
            self,
            Format::Mobi | Format::Azw | Format::Azw3 | Format::Prc
        )
    }

    /// Light and a one-line French explanation for the guide.
    pub fn advice(self, size: u64) -> (Light, &'static str) {
        match self {
            Format::Epub => (Light::Vert, "Livre au format EPUB : il est transformé automatiquement pour la liseuse."),
            Format::Mobi | Format::Prc => (Light::Vert, "Format idéal pour la liseuse : léger et confortable à lire."),
            Format::Azw | Format::Azw3 => (Light::Vert, "Format Kindle : parfait pour la liseuse."),
            Format::Txt => (Light::Vert, "Texte simple : très léger, mais sans chapitres ni mise en page."),
            Format::Pdf if size > HEAVY_PDF => (
                Light::Orange,
                "PDF très lourd : il prend beaucoup de place et le texte sera tout petit sur la liseuse.",
            ),
            Format::Pdf => (
                Light::Orange,
                "PDF : il s'affiche en tout petit sur la liseuse. Préférez un EPUB si vous le trouvez.",
            ),
        }
    }
}

pub const SUPPORTED_EXTS: &[&str] = &["epub", "mobi", "azw", "azw3", "prc", "pdf", "txt"];

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn recognises_extensions_case_insensitively() {
        assert_eq!(Format::from_path(Path::new("a/B.EPUB")), Some(Format::Epub));
        assert_eq!(Format::from_path(Path::new("x.azw3")), Some(Format::Azw3));
        assert_eq!(Format::from_path(Path::new("x.docx")), None);
        assert_eq!(Format::from_path(Path::new("noext")), None);
    }

    #[test]
    fn pdf_is_orange() {
        assert_eq!(Format::Pdf.advice(1000).0, Light::Orange);
        assert_eq!(Format::Mobi.advice(1000).0, Light::Vert);
        assert!(!Format::Epub.kindle_native());
    }
}
