//! End-to-end tests of the library against a fake Kindle folder.

use crate::formats::{Format, Light};
use crate::kindle::Kindle;
use crate::library::*;
use crate::mobi::tests::sample_mobi;
use std::fs;
use std::path::PathBuf;

struct Sandbox {
    dir: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Sandbox {
        let dir = std::env::temp_dir().join(format!("liseuse-{name}-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(dir.join("kindle/documents")).unwrap();
        fs::create_dir_all(dir.join("kindle/system")).unwrap();
        fs::create_dir_all(dir.join("dl")).unwrap();
        Sandbox { dir }
    }
    fn lib(&self) -> Library {
        Library::open(self.dir.join("Mes livres")).unwrap()
    }
    fn kindle(&self, free: u64) -> Kindle {
        Kindle {
            root: self.dir.join("kindle"),
            label: "Kindle".into(),
            total_bytes: 1_400_000_000,
            free_bytes: free,
        }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.dir).ok();
    }
}

#[test]
fn safe_names() {
    assert_eq!(
        safe_name("Les Misérables : Tome 1/5"),
        "Les Misérables Tome 1 5"
    );
    assert_eq!(safe_name("  ..Contes.. "), "Contes");
    assert_eq!(safe_name("CON"), "Livre");
    assert_eq!(safe_name(""), "Livre");
    assert_eq!(
        split_title("Germinal - Émile Zola"),
        ("Germinal".into(), Some("Émile Zola".into()))
    );
    assert_eq!(split_title("Germinal"), ("Germinal".into(), None));
}

#[test]
fn epub_lifecycle_put_and_take_back_with_reading_position() {
    let sb = Sandbox::new("epub");
    let lib = sb.lib();
    let k = sb.kindle(500_000_000);

    let id = lib
        .add_bytes("Germinal - Émile Zola", Format::Epub, b"PK fake epub")
        .unwrap();
    assert_eq!(id, "Germinal - Émile Zola");
    assert_eq!(lib.needs_conversion(), vec![id.clone()]);
    let b = &lib.pc_books()[0];
    assert!(b.converting && !b.ready);
    assert_eq!(b.kindle_name, "Germinal - Émile Zola.mobi");
    assert_eq!(lib.put_on_kindle(&id, &k).unwrap_err().code, "not_ready");

    lib.save_kindle_copy(&id, &sample_mobi("Germinal", "Émile Zola"))
        .unwrap();
    assert!(lib.needs_conversion().is_empty());
    lib.put_on_kindle(&id, &k).unwrap();

    let ov = lib.overview(Some(&k));
    assert!(ov.pc[0].on_kindle);
    let side = ov.kindle.unwrap();
    assert_eq!(side.books.len(), 1);
    assert_eq!(side.books[0].title, "Germinal");
    assert!(side.books[0].on_pc);

    // she reads a bit: the Kindle writes a .sdr folder
    let sdr = k.documents().join("Germinal - Émile Zola.sdr");
    fs::create_dir_all(&sdr).unwrap();
    fs::write(sdr.join("x.mbp"), b"page 42").unwrap();

    let back = lib
        .take_from_kindle("Germinal - Émile Zola.mobi", &k)
        .unwrap();
    assert_eq!(back, id);
    assert!(!k.documents().join("Germinal - Émile Zola.mobi").exists());
    assert!(!sdr.exists());
    assert_eq!(lib.pc_books().len(), 1, "no duplicate on the PC");

    // next trip: the reading position comes back
    lib.put_on_kindle(&id, &k).unwrap();
    assert_eq!(fs::read(sdr.join("x.mbp")).unwrap(), b"page 42");
}

#[test]
fn book_only_on_kindle_is_saved_before_removal() {
    let sb = Sandbox::new("only-kindle");
    let lib = sb.lib();
    let k = sb.kindle(500_000_000);
    fs::write(
        k.documents().join("B00ABC_EBOK.azw"),
        sample_mobi("Le Petit Prince", "Saint-Exupéry"),
    )
    .unwrap();
    fs::write(k.documents().join("My Clippings.txt"), b"notes").unwrap();

    let side = lib.overview(Some(&k)).kindle.unwrap();
    assert_eq!(side.books.len(), 1, "clippings are hidden");
    assert!(!side.books[0].on_pc);

    let id = lib.take_from_kindle("B00ABC_EBOK.azw", &k).unwrap();
    assert_eq!(id, "Le Petit Prince - Saint-Exupéry");
    assert!(lib
        .root()
        .join("Le Petit Prince - Saint-Exupéry.azw")
        .is_file());
    assert!(!k.documents().join("B00ABC_EBOK.azw").exists());
    assert!(k.documents().join("My Clippings.txt").exists());
}

#[test]
fn refuses_when_kindle_is_full_and_on_drm() {
    let sb = Sandbox::new("full");
    let lib = sb.lib();
    let id = lib
        .add_bytes("Gros livre", Format::Pdf, &vec![0u8; 1024])
        .unwrap();
    let err = lib.put_on_kindle(&id, &sb.kindle(1_000_000)).unwrap_err();
    assert_eq!(err.code, "no_space");
    assert!(err.needed.unwrap() > err.free.unwrap());
    assert_eq!(lib.pc_books()[0].light, Light::Orange);

    let drm = lib.add_bytes("Protégé", Format::Epub, b"x").unwrap();
    lib.save_conversion_error(&drm, "drm").unwrap();
    let b = lib.pc_books().into_iter().find(|b| b.id == drm).unwrap();
    assert_eq!(b.light, Light::Rouge);
    assert_eq!(
        lib.put_on_kindle(&drm, &sb.kindle(500_000_000))
            .unwrap_err()
            .code,
        "drm"
    );
}

#[test]
fn duplicate_names_get_a_number_and_trash_restores() {
    let sb = Sandbox::new("trash");
    let lib = sb.lib();
    let a = lib.add_bytes("Livre", Format::Txt, b"a").unwrap();
    let b = lib.add_bytes("livre", Format::Txt, b"b").unwrap();
    assert_eq!((a.as_str(), b.as_str()), ("Livre", "livre (2)"));

    let t = lib.delete(&a).unwrap();
    assert_eq!(lib.pc_books().len(), 1);
    assert_eq!(lib.restore(&t).unwrap(), "Livre");
    assert_eq!(lib.pc_books().len(), 2);
    assert!(lib.restore("../x").is_err());
}

#[test]
fn offers_new_downloads_once() {
    let sb = Sandbox::new("dl");
    let lib = sb.lib();
    let dl = sb.dir.join("dl");
    fs::write(dl.join("Candide.epub"), b"epub").unwrap();
    fs::write(dl.join("facture.pdf.part"), b"x").unwrap();
    fs::write(dl.join("photo.jpg"), b"x").unwrap();
    let mut st = lib.load_state();
    let c = lib.new_downloads(&dl, &st);
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].file_name, "Candide.epub");
    st.downloads_seen.push(c[0].key.clone());
    lib.save_state(&st).unwrap();
    assert!(lib.new_downloads(&dl, &lib.load_state()).is_empty());

    lib.add_path(&dl.join("Candide.epub"), None).unwrap();
    assert_eq!(lib.pc_books()[0].id, "Candide");
}

#[test]
fn fill_level() {
    let sb = Sandbox::new("level");
    let lib = sb.lib();
    let side = lib.overview(Some(&sb.kindle(50_000_000))).kindle.unwrap();
    assert_eq!(side.level, "plein");
    let side = lib
        .overview(Some(&sb.kindle(1_000_000_000)))
        .kindle
        .unwrap();
    assert_eq!(side.level, "ok");
    assert!(side.books_left > 1000);
}

#[test]
fn rename_moves_kindle_copy() {
    let sb = Sandbox::new("rename");
    let lib = sb.lib();
    let id = lib.add_bytes("pg17989-images", Format::Epub, b"x").unwrap();
    lib.save_kindle_copy(&id, b"mobi").unwrap();
    let new = lib
        .rename(&id, "Le Comte de Monte-Cristo - Alexandre Dumas")
        .unwrap();
    let b = &lib.pc_books()[0];
    assert_eq!(b.id, new);
    assert!(b.ready);
    assert_eq!(lib.rename(&new, &new).unwrap(), new);
}

#[test]
fn share_link_is_a_ready_written_email() {
    let m = share_mailto("Candide & co", Some("Voltaire"));
    assert!(
        m.starts_with("mailto:?subject=Un%20livre%20pour%20toi%20%3A%20Candide%20%26%20co&body=")
    );
    assert!(m.contains("Voltaire"));
    assert!(!m.contains(' ') && !m.contains('\n'));
    let sb = Sandbox::new("share");
    let lib = sb.lib();
    let id = lib
        .add_bytes("Candide - Voltaire", Format::Epub, b"x")
        .unwrap();
    assert!(lib
        .share_file(&id)
        .unwrap()
        .ends_with("Candide - Voltaire.epub"));
    assert_eq!(lib.share_file("nope").unwrap_err().code, "missing");
}
