# ADR-0006: Follow the author-folder layout already on her Kindle

Date: 2026-10-31 · Status: accepted · Amends ADR-0003

## Context
On 2026-10-31 her Kindle 4 was sorted by hand-run scripts (1 002 books, 308
authors): `documents/Nom, Prenom/Titre.mobi`, ASCII names (accents removed,
`<>:"/\|?*` → `_`, titles cut at 90 characters), author written "Nom, Prénom"
inside each MOBI (EXTH 100), duplicates moved off the Kindle, and the hashes
in `system/collections.json` remapped. She can now sort by author on the
Kindle and it is reliable. Her Kindle is nearly full.

The v0.1 app only looked at the top of `documents`, so it would have seen
none of these books.

## Decision
1. **Kindle side.** The app lists books in author folders (up to
   `documents/Auteur/Série/livre`). It never lists or touches notes
   ("Mes extraits", clippings), dictionaries, screenshots, `system/`, or
   reading-position files.
2. **Existing files never move.** The app adds books and removes books;
   it never renames or moves a file already on the Kindle, and it never edits
   `collections.json`. A book that leaves the Kindle remembers its path
   (`.liseuse/positions/<id>.kindle-path`) and goes back to exactly that path,
   so the collection hash (`sha1("/mnt/us/documents/" + path)`) still matches.
3. **New books follow the same rules**: `Nom, Prenom/Titre.ext`, the same
   ASCII rules, into her existing folder for that author when there is one
   (matched by the words of the name, so "Victor Hugo" joins "Hugo, Victor").
   Author spellings fixed by hand during the sort (`map.js`) are built in
   (`core/src/authors.rs` `ALIASES`). Nothing on the Kindle is ever replaced:
   a different book with the same name gets " (2)".
4. **Reading positions on a Kindle 4** are files next to the book with its
   name (`.mbp`, `.apnx`, `.eal`, `.ea`, `.han`, `.pdr`); older firmwares use a
   `.sdr` folder. Both leave and come back with the book.
5. **PC side mirrors it**, with accents kept (Windows handles them):
   `Mes livres/Nom, Prénom/Titre.ext`. Books without an author stay at the
   top. Old flat "Titre - Auteur" files keep working where they are.
6. **Same book on both sides** = back at the path it left from, or the same
   title + author (accent-, case- and order-insensitive,
   `authors::book_key`). A file that merely has the name the book would get
   is not assumed to be the same book.
7. **Space strategy**: "Tout sauvegarder sur l'ordinateur" copies every book
   that is only on the Kindle to the PC without changing the Kindle. Once the
   PC holds everything, she can unload what she won't read soon and the
   Kindle holds a selection.

## Consequences
- Rolling back to v0.1 loses nothing: books in author folders are still
  files on disk; v0.1 just doesn't list them.
- Converted books carry one author written "Nom, Prénom" inside the file
  (EXTH 100), because the Kindle sorts by that field. The converter takes the
  rule as an option (`sortAuthor`); the app passes the core's
  `authors::author_sort`, so the alias table lives in one place.
- Rewriting the author inside existing files is not needed: the sort already
  did it for her current books. Duplicate detection is a follow-up.
