//! End-to-end tests of the library against a fake Kindle folder.

use crate::formats::{Format, Light};
use crate::kindle::Kindle;
use crate::library::*;
use crate::mobi::tests::{sample_mobi, sample_mobi_drm};
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
    assert_eq!(id, "Zola, Émile/Germinal", "filed in its author's folder");
    assert!(lib
        .root()
        .join("Zola, Émile")
        .join("Germinal.epub")
        .is_file());
    assert_eq!(lib.needs_conversion(), vec![id.clone()]);
    let b = &lib.pc_books()[0];
    assert!(b.converting && !b.ready);
    assert_eq!(b.kindle_name, "Zola, Emile/Germinal.mobi");
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

    let folder = k.documents().join("Zola, Emile");
    assert!(folder.join("Germinal.mobi").is_file());
    assert_eq!(side.books[0].id, "Zola, Emile/Germinal.mobi");
    lib.put_on_kindle(&id, &k).unwrap();
    assert_eq!(
        lib.kindle_books(&k).len(),
        1,
        "putting it twice does nothing"
    );

    // she reads a bit: a Kindle 4 writes files next to the book,
    // newer firmwares a .sdr folder
    fs::write(folder.join("Germinal.mbp"), b"page 42").unwrap();
    fs::write(folder.join("Germinal.apnx"), b"pages").unwrap();
    let sdr = folder.join("Germinal.sdr");
    fs::create_dir_all(&sdr).unwrap();
    fs::write(sdr.join("x.mbp"), b"page 42").unwrap();

    let back = lib
        .take_from_kindle("Zola, Emile/Germinal.mobi", &k)
        .unwrap();
    assert_eq!(back, id);
    assert!(
        !folder.exists(),
        "nothing left behind, empty folder removed"
    );
    assert_eq!(lib.pc_books().len(), 1, "no duplicate on the PC");

    // next trip: the reading position comes back, at the same place
    lib.put_on_kindle(&id, &k).unwrap();
    assert_eq!(fs::read(folder.join("Germinal.mbp")).unwrap(), b"page 42");
    assert_eq!(fs::read(folder.join("Germinal.apnx")).unwrap(), b"pages");
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
    assert_eq!(id, "Saint-Exupéry/Le Petit Prince");
    assert!(lib
        .root()
        .join("Saint-Exupéry")
        .join("Le Petit Prince.azw")
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
    assert_eq!(new, "Dumas, Alexandre/Le Comte de Monte-Cristo");
    assert!(b.ready, "the Kindle copy followed");
    assert!(!lib.root().join("pg17989-images.epub").exists());
    assert_eq!(
        lib.rename(&new, "Le Comte de Monte-Cristo - Alexandre Dumas")
            .unwrap(),
        new
    );
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
    assert!(lib.share_file(&id).unwrap().ends_with("Candide.epub"));
    assert_eq!(lib.share_file("nope").unwrap_err().code, "missing");
}

#[test]
fn amazon_protected_books_are_listed_kept_and_flagged() {
    let sb = Sandbox::new("amazon");
    let lib = sb.lib();
    let k = sb.kindle(500_000_000);
    fs::write(
        k.documents().join("B01XYZ_EBOK.azw"),
        sample_mobi_drm("L'Étranger", "Albert Camus", true),
    )
    .unwrap();
    let side = lib.overview(Some(&k)).kindle.unwrap();
    assert_eq!(side.books[0].title, "L'Étranger");
    assert!(side.books[0].protected);

    let id = lib.take_from_kindle("B01XYZ_EBOK.azw", &k).unwrap();
    let b = lib.pc_books().into_iter().find(|b| b.id == id).unwrap();
    assert!(b.protected);
    assert!(b.advice.contains("seulement sur votre liseuse"));
    assert_eq!(b.light, Light::Vert, "still fine on her own Kindle");

    assert_eq!(lib.share_file(&id).unwrap_err().code, "protected");

    lib.put_on_kindle(&id, &k).unwrap();
    assert!(lib.overview(Some(&k)).pc[0].on_kindle);
}

// ---------------------------------------------------------------- her real Kindle
// Layout from the sort of her Kindle on 2026-10-31 (1 002 books, 308 authors):
// documents/Nom, Prenom/Titre.mobi with .mbp/.apnx next to each book,
// dictionaries, "Mes extraits.txt" and Amazon "-asin_" files at the top.

fn her_kindle(sb: &Sandbox) -> Kindle {
    let k = sb.kindle(40_000_000);
    let d = k.documents();
    let put = |rel: &str, bytes: &[u8]| {
        let p = d.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    };
    put(
        "Hugo, Victor/Les Miserables.mobi",
        &sample_mobi("Les Misérables", "Hugo, Victor"),
    );
    put("Hugo, Victor/Les Miserables.mbp", b"page 812");
    put("Hugo, Victor/Les Miserables.apnx", b"pages");
    put(
        "Asimov, Isaac/L'aube de Fondation.mobi",
        &sample_mobi("L'aube de Fondation", "Asimov, Isaac"),
    );
    put(
        "Damasio, Alain/La Horde du Contrevent (283)/La Horde du Contrevent.mobi",
        &sample_mobi("La Horde du Contrevent", "Alain Damasio"),
    );
    put(
        "Notes de voyage-asin_B0TEST-type_PDOC-v_0.azw",
        &sample_mobi("Notes de voyage", "Noëlle"),
    );
    put(
        "B01XYZ_EBOK.azw",
        &sample_mobi_drm("L'Étranger", "Camus, Albert", true),
    );
    put("Mes extraits.txt", b"- Votre surlignement");
    put(
        "Dictionnaire_Larousse.mobi",
        &sample_mobi("Dictionnaire", "Larousse"),
    );
    put(
        "Oxford_Dictionary_of_English.azw",
        &sample_mobi("Oxford", "Oxford"),
    );
    put("screen_shot-1234.gif", b"gif");
    fs::write(
        k.root.join("system/collections.json"),
        br#"{"Noelle@fr-FR":{"items":["*abc"]}}"#,
    )
    .unwrap();
    k
}

fn tree(dir: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    let mut v = Vec::new();
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            v.extend(
                tree(&p)
                    .into_iter()
                    .map(|(n, b)| (format!("{}/{n}", e.file_name().to_string_lossy()), b)),
            );
        } else {
            v.push((
                e.file_name().to_string_lossy().into_owned(),
                fs::read(&p).unwrap(),
            ));
        }
    }
    v.sort();
    v
}

#[test]
fn her_sorted_kindle_is_listed_and_left_untouched() {
    let sb = Sandbox::new("her-kindle");
    let lib = sb.lib();
    let k = her_kindle(&sb);
    let before = tree(&k.root);

    let side = lib.overview(Some(&k)).kindle.unwrap();
    let ids: Vec<&str> = side.books.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "Asimov, Isaac/L'aube de Fondation.mobi",
            "B01XYZ_EBOK.azw",
            "Damasio, Alain/La Horde du Contrevent (283)/La Horde du Contrevent.mobi",
            "Hugo, Victor/Les Miserables.mobi",
            "Notes de voyage-asin_B0TEST-type_PDOC-v_0.azw",
        ],
        "sorted by author like on the Kindle; notes, dictionaries, screenshots and position files hidden"
    );
    let hugo = side
        .books
        .iter()
        .find(|b| b.id.starts_with("Hugo"))
        .unwrap();
    assert_eq!(
        hugo.title, "Les Misérables",
        "title with accents, from inside the book"
    );
    assert_eq!(hugo.author.as_deref(), Some("Hugo, Victor"));
    assert!(
        side.books
            .iter()
            .find(|b| b.id == "B01XYZ_EBOK.azw")
            .unwrap()
            .protected
    );
    assert_eq!(side.level, "plein");

    assert_eq!(tree(&k.root), before, "looking never changes anything");

    for protected in [
        "Mes extraits.txt",
        "Dictionnaire_Larousse.mobi",
        "../system/collections.json",
        "Hugo, Victor/Les Miserables.mbp",
        "Hugo, Victor/../B01XYZ_EBOK.azw",
    ] {
        assert_eq!(
            lib.take_from_kindle(protected, &k).unwrap_err().code,
            "missing",
            "{protected}"
        );
    }
    assert_eq!(tree(&k.root), before);
}

#[test]
fn whole_kindle_is_saved_on_the_pc_without_touching_it() {
    let sb = Sandbox::new("backup-all");
    let lib = sb.lib();
    let k = her_kindle(&sb);
    let before = tree(&k.root);

    for b in lib.kindle_books(&k) {
        lib.save_to_pc(&b.id, &k).unwrap();
    }
    assert_eq!(
        tree(&k.root),
        before,
        "a backup leaves the Kindle as it was"
    );
    let ov = lib.overview(Some(&k));
    assert_eq!(ov.pc.len(), 5);
    assert!(ov.kindle.unwrap().books.iter().all(|b| b.on_pc));
    assert!(ov.pc.iter().all(|b| b.on_kindle && b.kindle_id.is_some()));
    assert!(
        lib.root()
            .join("Hugo, Victor")
            .join("Les Misérables.mobi")
            .is_file(),
        "PC names keep their accents"
    );
    assert!(lib
        .root()
        .join("Camus, Albert")
        .join("L'Étranger.azw")
        .is_file());

    // saving again copies nothing
    for b in lib.kindle_books(&k) {
        lib.save_to_pc(&b.id, &k).unwrap();
    }
    assert_eq!(lib.pc_books().len(), 5);
}

#[test]
fn a_book_goes_back_to_its_exact_place_so_collections_still_find_it() {
    let sb = Sandbox::new("same-place");
    let lib = sb.lib();
    let k = her_kindle(&sb);
    let d = k.documents();
    // collections.json identifies books by their path: an Amazon personal
    // document keeps its "-asin_" name, a sorted book its folder and name.
    for rel in [
        "Notes de voyage-asin_B0TEST-type_PDOC-v_0.azw",
        "Hugo, Victor/Les Miserables.mobi",
    ] {
        let bytes = fs::read(d.join(rel)).unwrap();
        let id = lib.take_from_kindle(rel, &k).unwrap();
        assert!(!d.join(rel).exists());
        assert!(
            !lib.overview(Some(&k))
                .pc
                .iter()
                .find(|b| b.id == id)
                .unwrap()
                .on_kindle
        );
        lib.put_on_kindle(&id, &sb.kindle(40_000_000)).unwrap();
        assert_eq!(
            fs::read(d.join(rel)).unwrap(),
            bytes,
            "{rel} is back, same name, same bytes"
        );
    }
    assert_eq!(
        fs::read(d.join("Hugo, Victor/Les Miserables.mbp")).unwrap(),
        b"page 812"
    );
    assert_eq!(
        fs::read(d.join("Hugo, Victor/Les Miserables.apnx")).unwrap(),
        b"pages"
    );
    assert_eq!(
        fs::read(k.root.join("system/collections.json")).unwrap(),
        br#"{"Noelle@fr-FR":{"items":["*abc"]}}"#,
        "the app never edits collections"
    );
}

#[test]
fn new_books_join_her_author_folders_and_never_replace_a_file() {
    let sb = Sandbox::new("join-folder");
    let lib = sb.lib();
    let k = her_kindle(&sb);
    let k = Kindle {
        free_bytes: 500_000_000,
        ..k
    };
    let d = k.documents();

    // "Victor Hugo" from the EPUB goes into her existing "Hugo, Victor" folder
    let id = lib
        .add_bytes("Notre-Dame de Paris - Victor Hugo", Format::Epub, b"PK")
        .unwrap();
    lib.save_kindle_copy(&id, &sample_mobi("Notre-Dame de Paris", "Victor Hugo"))
        .unwrap();
    lib.put_on_kindle(&id, &k).unwrap();
    assert!(d.join("Hugo, Victor/Notre-Dame de Paris.mobi").is_file());

    // an author she doesn't have yet gets a new "Nom, Prenom" folder, ASCII
    let id = lib
        .add_bytes("Thérèse Raquin - Émile Zola", Format::Epub, b"PK")
        .unwrap();
    lib.save_kindle_copy(&id, &sample_mobi("Thérèse Raquin", "Émile Zola"))
        .unwrap();
    lib.put_on_kindle(&id, &k).unwrap();
    assert!(d.join("Zola, Emile/Therese Raquin.mobi").is_file());

    // a different book already has the name: a number is added, nothing replaced
    fs::write(
        d.join("Asimov, Isaac/Les Robots.mobi"),
        sample_mobi("Les Robots (recueil)", "Asimov, Isaac"),
    )
    .unwrap();
    let id = lib
        .add_bytes(
            "Les Robots - Isaac Asimov",
            Format::Mobi,
            &sample_mobi("Les Robots", "Isaac Asimov"),
        )
        .unwrap();
    lib.put_on_kindle(&id, &k).unwrap();
    assert_eq!(
        fs::read(d.join("Asimov, Isaac/Les Robots.mobi")).unwrap(),
        sample_mobi("Les Robots (recueil)", "Asimov, Isaac")
    );
    assert!(d.join("Asimov, Isaac/Les Robots (2).mobi").is_file());
}

#[test]
fn same_book_is_recognised_whatever_its_file_is_called() {
    let sb = Sandbox::new("match");
    let lib = sb.lib();
    let k = her_kindle(&sb);
    // a v0.1 library: flat "Titre - Auteur" files
    let id = lib.add_bytes("x", Format::Epub, b"PK").unwrap();
    lib.rename(&id, "Les Misérables - Victor Hugo").unwrap();
    fs::write(
        lib.root().join("L'aube de Fondation - Isaac Asimov.epub"),
        b"PK",
    )
    .unwrap();

    let ov = lib.overview(Some(&k));
    let fondation = ov
        .pc
        .iter()
        .find(|b| b.title == "L'aube de Fondation")
        .unwrap();
    assert_eq!(
        fondation.kindle_id.as_deref(),
        Some("Asimov, Isaac/L'aube de Fondation.mobi")
    );
    let hugo = ov.pc.iter().find(|b| b.title == "Les Misérables").unwrap();
    assert!(hugo.on_kindle);

    // taking it off doesn't make a second copy on the PC
    lib.take_from_kindle("Asimov, Isaac/L'aube de Fondation.mobi", &k)
        .unwrap();
    assert_eq!(lib.pc_books().len(), 2);
}

#[test]
fn trash_restores_into_the_author_folder() {
    let sb = Sandbox::new("trash-folder");
    let lib = sb.lib();
    let id = lib
        .add_bytes("Germinal - Émile Zola", Format::Epub, b"PK")
        .unwrap();
    lib.save_kindle_copy(&id, b"mobi").unwrap();
    let t = lib.delete(&id).unwrap();
    assert!(lib.pc_books().is_empty());
    assert!(
        !lib.root().join("Zola, Émile").exists(),
        "empty author folder removed"
    );
    assert_eq!(lib.restore(&t).unwrap(), id);
    let b = &lib.pc_books()[0];
    assert_eq!(b.id, id);
    assert!(b.ready, "the Kindle copy came back too");
}
