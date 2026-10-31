//! Author names and file names, following the layout Mom's Kindle already
//! uses (see ADR-0006): one folder per author, named "Nom, Prénom", with
//! plain ASCII names so the Kindle 4 and every Windows version agree.

/// Plain-ASCII spelling of one character, or `None` when there is none.
fn ascii_of(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' => "A",
        'ç' | 'ć' | 'č' => "c",
        'Ç' | 'Ć' | 'Č' => "C",
        'ď' | 'đ' => "d",
        'Ď' | 'Đ' => "D",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => "e",
        'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ė' | 'Ę' | 'Ě' => "E",
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' | 'ı' => "i",
        'Ì' | 'Í' | 'Î' | 'Ï' | 'Ī' | 'Į' | 'İ' => "I",
        'ł' | 'ľ' => "l",
        'Ł' | 'Ľ' => "L",
        'ñ' | 'ń' | 'ň' => "n",
        'Ñ' | 'Ń' | 'Ň' => "N",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => "o",
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'Ō' | 'Ő' => "O",
        'ř' => "r",
        'Ř' => "R",
        'ś' | 'š' | 'ş' => "s",
        'Ś' | 'Š' | 'Ş' => "S",
        'ť' | 'ţ' => "t",
        'Ť' | 'Ţ' => "T",
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => "u",
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ū' | 'Ů' | 'Ű' => "U",
        'ý' | 'ÿ' => "y",
        'Ý' | 'Ÿ' => "Y",
        'ź' | 'ż' | 'ž' => "z",
        'Ź' | 'Ż' | 'Ž' => "Z",
        'æ' => "ae",
        'Æ' => "AE",
        'œ' => "oe",
        'Œ' => "Oe",
        'ß' => "ss",
        '’' | '‘' | '´' | '`' => "'",
        '«' | '»' | '“' | '”' | '„' => "",
        '–' | '—' | '‐' => "-",
        '…' => "...",
        '\u{a0}' | '\u{202f}' => " ",
        _ => return None,
    })
}

/// Lowercase ASCII used to compare names ("Émile" = "emile").
pub fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii() {
            out.push(c.to_ascii_lowercase());
        } else if let Some(a) = ascii_of(c) {
            out.push_str(&a.to_ascii_lowercase());
        } else {
            out.extend(c.to_lowercase());
        }
    }
    out
}

/// A file or folder name for the Kindle, with the same rules as the sort
/// already done on her Kindle: accents removed, `<>:"/\|?*` → `_`, at most
/// `max` characters, no trailing dot or space.
pub fn ascii_name(s: &str, max: usize) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => out.push('_'),
            c if c.is_control() => out.push(' '),
            c if c.is_ascii() => out.push(c),
            c => out.push_str(ascii_of(c).unwrap_or("")),
        }
    }
    let mut out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.len() > max {
        out.truncate(max); // ASCII only, so any byte index is a char boundary
    }
    let out = out.trim_start().trim_end_matches(['.', ' ']).to_string();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2", "LPT3",
    ];
    if out.is_empty() || reserved.contains(&out.to_ascii_uppercase().as_str()) {
        "Livre".to_string()
    } else {
        out
    }
}

/// Only the first author of "A & B", "A et B", "A; B".
fn first_author(a: &str) -> &str {
    let mut end = a.len();
    for sep in [" & ", " et ", " and ", ";", " / "] {
        if let Some(i) = a.find(sep) {
            end = end.min(i);
        }
    }
    a[..end].trim()
}

/// Particles that follow the first name in a sorted name
/// ("Guy de Maupassant" → "Maupassant, Guy de").
const TRAILING_PARTICLES: &[&str] = &["de", "d'", "von", "van"];
/// Particles that stay with the surname ("Jean de La Fontaine" →
/// "La Fontaine, Jean de", "Joachim Du Bellay" → "Du Bellay, Joachim").
const LEADING_PARTICLES: &[&str] = &[
    "du", "des", "le", "la", "di", "da", "del", "della", "der", "ten", "ter",
];

/// Spellings found in her books, fixed by hand when her Kindle was sorted
/// (2026-10-31, `map.js` of the sorting scripts): raw author → "Nom, Prénom".
/// Extend it when a new spelling shows up; the rule below handles the rest.
const ALIASES: &[(&str, &str)] = &[
    ("Christina Alonso", "Alonso, Cristina"),
    (
        "André, Christophe & Jollien, Alexandre & Ricard, Matthieu",
        "André, Christophe",
    ),
    ("Auel,Jean M", "Auel, Jean M."),
    ("Auel,Jean M.", "Auel, Jean M."),
    ("Ayerdhal-Dunyach", "Ayerdhal"),
    ("Bachman,Richard(King,Stephen)", "Bachman, Richard"),
    ("Baraton & Alain Baraton", "Baraton, Alain"),
    ("Borges,J.L.", "Borges, Jorge Luis"),
    (
        "Marion Zimmer Bradley & Paul Edwin Zimmer Bradley Bradley",
        "Bradley, Marion Zimmer",
    ),
    ("Zimmer Bradley,Marion", "Bradley, Marion Zimmer"),
    ("Adolfo Bioy Casares", "Bioy Casares, Adolfo"),
    ("Camut,Jerome(feat Hug,Nathalie)", "Camut, Jérôme"),
    ("Carrisi & Carrisi Donato", "Carrisi, Donato"),
    ("Chattam,Maxim", "Chattam, Maxime"),
    ("MAXIME CHATTAM", "Chattam, Maxime"),
    ("Carol Higgins Clark", "Higgins Clark, Carol"),
    ("Mary Higgins Clark", "Higgins Clark, Mary"),
    ("Arthur C Clarke", "Clarke, Arthur C."),
    ("Clarke,Arthur C.-Lee,Gentry", "Clarke, Arthur C."),
    ("suzanne collins", "Collins, Suzanne"),
    ("Courtemanche, gil", "Courtemanche, Gil"),
    (
        "Cussler Clive, Du Brul Jack, Cussler Clive, Du Brul Jack, CLIVE CUSSLER, JACK DU BRUL",
        "Cussler, Clive",
    ),
    ("Jean d'Ormesson", "Ormesson, Jean d'"),
    ("David et Leigh Eddings", "Eddings, David"),
    ("Eddings David et Leigh", "Eddings, David"),
    ("Eddings,David et Leigh", "Eddings, David"),
    ("Nicholls David", "Nicholls, David"),
    ("Général de Caulaincourt", "Caulaincourt, Armand de"),
    ("Antoine de Caunes", "Caunes, Antoine de"),
    (
        "Donatien Alphonse François de Sade & Gilbert Lély",
        "Sade, Marquis de",
    ),
    ("de Vigan,Delphine", "Vigan, Delphine de"),
    ("Delphine de Vigan", "Vigan, Delphine de"),
    ("De Villiers,Gérard", "Villiers, Gérard de"),
    ("Gérard DeNerval", "Nerval, Gérard de"),
    ("Gary Devon & France-Marie Watkins", "Devon, Gary"),
    ("Paul Doherty", "Doherty, Paul C."),
    ("Paul.C Doherty", "Doherty, Paul C."),
    ("Fédor Mikhaïlivitch Dostoïevski", "Dostoïevski, Fiodor"),
    ("Kennedy Douglas", "Kennedy, Douglas"),
    ("Ellory,R.J", "Ellory, R.J."),
    ("Follet,Ken", "Follett, Ken"),
    ("Forsyth", "Forsyth, Frederick"),
    ("Christopher Fowler & Daniel Lemoine", "Koontz, Dean R."),
    ("Thilliez Franck", "Thilliez, Franck"),
    ("FRANCK THILLIEZ", "Thilliez, Franck"),
    ("Patrick Rambaud de l’académie Goncourt", "Rambaud, Patrick"),
    ("PATRICK RAMBAUD", "Rambaud, Patrick"),
    ("rambault,patrick", "Rambaud, Patrick"),
    ("Goscinny & Sempé", "Goscinny, René"),
    ("Sempé-Goscinny", "Goscinny, René"),
    ("Musso Guillaume", "Musso, Guillaume"),
    ("Homère & Victor Bérard", "Homère"),
    ("Howard,Robert", "Howard, Robert E."),
    ("Rowling J.K.", "Rowling, J.K."),
    ("J. K. Rowling", "Rowling, J.K."),
    ("Japp,Andréa", "Japp, Andrea H."),
    ("Andrea H. Japp", "Japp, Andrea H."),
    ("Jonquet Thierry", "Jonquet, Thierry"),
    ("Kawabata Yasunari", "Kawabata, Yasunari"),
    ("Keith Abott", "Abbott, Keith"),
    ("Dean Koontz", "Koontz, Dean R."),
    ("Dean Koontz & Michel Pagel", "Koontz, Dean R."),
    ("Dean Koontz & Polanis & Quadruppani", "Koontz, Dean R."),
    ("Koontz,Dean", "Koontz, Dean R."),
    ("Koontz, Dean R", "Koontz, Dean R."),
    ("Dean-R Koontz", "Koontz, Dean R."),
    ("R Koontz Book", "Koontz, Dean R."),
    ("Lenormand,Frederic", "Lenormand, Frédéric"),
    ("Logue, Mark & Conradi, Peter", "Logue, Mark"),
    ("Robert Ludlum & Gayle Lynds", "Ludlum, Robert"),
    ("MacDonald", "MacDonald, Patricia"),
    (
        "Patricia J. MacDonald & Françoise Cartano",
        "MacDonald, Patricia",
    ),
    ("Georges R.R. Martin", "Martin, George R.R."),
    ("Smith, Alexander McCall", "McCall Smith, Alexander"),
    ("Byrnes Michael", "Byrnes, Michael"),
    ("Murakami Ryû", "Murakami, Ryû"),
    ("Amelie Nothomb", "Nothomb, Amélie"),
    ("Nothomb,Amelie", "Nothomb, Amélie"),
    ("K. J. Parker", "Parker, K.J."),
    ("Parker, K. J.", "Parker, K.J."),
    ("Pelletier, Jean Jacques", "Pelletier, Jean-Jacques"),
    ("Bordage Pierre", "Bordage, Pierre"),
    ("PUÉRTOLAS Romain", "Puértolas, Romain"),
    ("Toute une Vie Bien Ratee", "Autin-Grenier, Pierre"),
    ("Delage Samuel & SAMUEL DELAGE", "Delage, Samuel"),
    ("Schmitt", "Schmitt, Éric-Emmanuel"),
    ("Schmitt,Eric-Emmanuel", "Schmitt, Éric-Emmanuel"),
    ("SHARPE, Tom", "Sharpe, Tom"),
    ("Silverberg,Robert-Haber,Karen", "Silverberg, Robert"),
    ("Edouard Elmer", "Smith, Edward Elmer"),
    ("Smith,Edouard Elmer", "Smith, Edward Elmer"),
    (
        "José Carlos Somoza & Marianne Millon",
        "Somoza, José Carlos",
    ),
    ("Somoza, José-Carlos", "Somoza, José Carlos"),
    ("Somoza,José-Carlos", "Somoza, José Carlos"),
    ("Stine", "Stine, R.L."),
    (
        "Strougatski, Arkadi et Boris",
        "Strougatski, Arkadi et Boris",
    ),
    ("Stuart,W. J.", "Stuart, W.J."),
    ("Suskind,Patrick", "Süskind, Patrick"),
    ("Didier van Cauwelaert", "Van Cauwelaert, Didier"),
    ("A. E. van Vogt", "Van Vogt, A.E."),
    ("Van Vogt,Alfred E", "Van Vogt, A.E."),
    ("Kurt Jr Vonnegut", "Vonnegut, Kurt"),
    ("Vonnegut,Kurt.Jr", "Vonnegut, Kurt"),
    ("S. J. Watson", "Watson, S.J."),
    ("Werber", "Werber, Bernard"),
    ("Wilson,Paul", "Wilson, F. Paul"),
    ("Zola,Emile", "Zola, Émile"),
    ("Disch,Thomas", "Disch, Thomas M."),
    ("Thomas Disch", "Disch, Thomas M."),
    ("Schmitt, Eric-Emmanuel", "Schmitt, Éric-Emmanuel"),
    ("J.G. Ballard", "Ballard, J.G."),
    ("R.L. Stine", "Stine, R.L."),
    ("Wodehouse,P.G.", "Wodehouse, P.G."),
    ("Tolkien,J.R.R.", "Tolkien, J.R.R."),
    ("J.R.R. Tolkien", "Tolkien, J.R.R."),
    ("J.K. Rowling", "Rowling, J.K."),
    ("Rowling,J.K.", "Rowling, J.K."),
    ("Harrison,M. John", "Harrison, M. John"),
    ("Hunter S. Thompson", "Thompson, Hunter S."),
];

fn alias(a: &str) -> Option<&'static str> {
    let a = a.trim();
    ALIASES.iter().find(|(raw, _)| *raw == a).map(|(_, c)| *c)
}

/// "Prénom Nom" → "Nom, Prénom", the order the Kindle sorts by.
/// Names already written "Nom, Prénom" are kept; with several authors only
/// the first is kept. Known spellings come from `ALIASES`.
pub fn author_sort(author: &str) -> String {
    if let Some(c) = alias(author) {
        return c.to_string();
    }
    let a = first_author(author);
    if let Some(c) = alias(a) {
        return c.to_string();
    }
    if let Some((last, first)) = a.split_once(',') {
        let (last, first) = (last.trim(), first.trim());
        return if first.is_empty() {
            last.to_string()
        } else {
            format!("{last}, {first}")
        };
    }
    let words: Vec<&str> = a.split_whitespace().collect();
    if words.len() < 2 {
        return words.join(" ");
    }
    let mut start = words.len() - 1;
    while start > 1 && LEADING_PARTICLES.contains(&words[start - 1].to_lowercase().as_str()) {
        start -= 1;
    }
    let mut first_end = start;
    while first_end > 1
        && TRAILING_PARTICLES.contains(&words[first_end - 1].to_lowercase().as_str())
    {
        first_end -= 1;
    }
    let first = words[..first_end].join(" ");
    let particles = words[first_end..start].join(" ");
    let last = words[start..].join(" ");
    if particles.is_empty() {
        format!("{last}, {first}")
    } else {
        format!("{last}, {first} {particles}")
    }
}

/// Where a book goes on the Kindle: `Nom, Prenom/Titre.ext`, or just
/// `Titre.ext` when the author is unknown. Same limits as the existing sort.
pub fn kindle_path(title: &str, author: Option<&str>, ext: &str) -> String {
    let file = format!("{}.{ext}", ascii_name(title, 90));
    match author.map(author_sort).filter(|a| !a.is_empty()) {
        Some(a) => format!("{}/{file}", ascii_name(&a, 90)),
        None => file,
    }
}

/// The words of an author's name, in any order ("Hugo, Victor" and
/// "Victor Hugo" give the same), to find the folder she already has.
pub fn author_words(author: &str) -> Vec<String> {
    let mut w: Vec<String> = fold(first_author(author))
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    w.sort();
    w
}

/// Identity of a book whatever its file is called: the same book on the
/// PC ("Victor Hugo", accents) and on the Kindle ("Hugo, Victor", ASCII,
/// title cut at 90 characters) gets the same key.
pub fn book_key(title: &str, author: Option<&str>) -> String {
    let words = |s: &str| -> Vec<String> {
        fold(s)
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_string)
            .collect()
    };
    let a = author.map(author_words).unwrap_or_default();
    let mut t = words(title).join(" ");
    if t.len() > 80 {
        let cut = (0..=80).rev().find(|&i| t.is_char_boundary(i)).unwrap_or(0);
        t.truncate(cut);
    }
    format!("{}|{}", a.join(" "), t.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_existing_kindle_sort() {
        assert_eq!(
            ascii_name("Les Misérables : Tome 1/5", 90),
            "Les Miserables _ Tome 1_5"
        );
        assert_eq!(
            ascii_name("Œuvres « complètes »… ", 90),
            "Oeuvres completes"
        );
        assert_eq!(ascii_name("  L’Étranger. ", 90), "L'Etranger");
        assert_eq!(ascii_name(&"a".repeat(200), 90).len(), 90);
        assert_eq!(ascii_name("", 90), "Livre");
        assert_eq!(ascii_name("CON", 90), "Livre");
    }

    #[test]
    fn authors_are_sorted_by_surname() {
        assert_eq!(author_sort("Émile Zola"), "Zola, Émile");
        assert_eq!(author_sort("Zola, Émile"), "Zola, Émile");
        assert_eq!(author_sort("Guy de Maupassant"), "Maupassant, Guy de");
        assert_eq!(author_sort("Jean de La Fontaine"), "La Fontaine, Jean de");
        assert_eq!(author_sort("Joachim Du Bellay"), "Du Bellay, Joachim");
        assert_eq!(author_sort("J.R.R. Tolkien"), "Tolkien, J.R.R.");
        assert_eq!(author_sort("Molière"), "Molière");
        assert_eq!(
            author_sort("Antoine de Saint-Exupéry"),
            "Saint-Exupéry, Antoine de"
        );
        assert_eq!(author_sort("Erckmann & Chatrian"), "Erckmann");
        assert_eq!(
            author_sort("Preston, Douglas & Child, Lincoln"),
            "Preston, Douglas"
        );
        // spellings fixed by hand during the sort of her Kindle
        assert_eq!(author_sort("Jean d'Ormesson"), "Ormesson, Jean d'");
        assert_eq!(author_sort("Dean Koontz & Michel Pagel"), "Koontz, Dean R.");
        assert_eq!(author_sort("Follet,Ken"), "Follett, Ken");
        assert_eq!(author_words("Victor Hugo"), author_words("Hugo, Victor"));
    }

    #[test]
    fn kindle_paths_and_keys() {
        assert_eq!(
            kindle_path("Le Comte de Monte-Cristo", Some("Alexandre Dumas"), "mobi"),
            "Dumas, Alexandre/Le Comte de Monte-Cristo.mobi"
        );
        assert_eq!(kindle_path("Notes", None, "txt"), "Notes.txt");
        assert_eq!(
            book_key("Les Misérables", Some("Victor Hugo")),
            book_key("Les Miserables", Some("Hugo, Victor"))
        );
        assert_ne!(
            book_key("Les Misérables", Some("Victor Hugo")),
            book_key("Les Misérables", Some("Alain Decaux"))
        );
        let long = "Un très long titre ".repeat(10);
        let cut = ascii_name(&long, 90);
        assert_eq!(book_key(&long, None), book_key(&cut, None));
    }
}
