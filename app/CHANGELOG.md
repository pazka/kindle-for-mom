# Changelog

All notable changes to Ma liseuse. Format: [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions: [SemVer](https://semver.org/).

## [Unreleased]

### Added
- "🔎 Trouver un livre": search the free, legal French books of livres.hosh.it, add one to her books in one click (EPUBs are converted for the Kindle as usual), and "Demander ce livre à Alexandre" when it isn't there.

## [0.2.1] - 2026-10-31

### Added
- "Tout cocher" on the Kindle side: put every book back on the computer in one go.
- When the Kindle is plugged in, "Liseuse détectée ! Je regarde quels livres elle contient…" shows at once instead of "Branchez votre liseuse" while its list is read.

### Changed
- Book titles are remembered between sessions, so a Kindle with 1 000 books is listed in seconds after the first time (it took about a minute every time).

## [0.2.0] - 2026-10-31

### Added
- Automatic, signed updates: a new version installs when she opens the app, with a short message, and the app reopens by itself. Without internet, the app starts as usual.

## [0.1.0] - not released (included in 0.2.0)

### Added
- Works with the Kindle as it was sorted on 2026-10-31: books in author folders ("Nom, Prénom") are listed with their real title, sorted by author; notes ("Mes extraits"), dictionaries and screenshots are left alone; nothing already on the Kindle is ever moved or renamed, so collections keep working.
- New books go into the author's folder on the Kindle (her existing folder when there is one) and on the PC; converted books carry their author as "Nom, Prénom" so the Kindle's sort by author files them with the others.
- Reading positions of the Kindle 4 (`.mbp`, `.apnx`… files) leave and come back with each book; a book comes back to exactly where it was.
- "Tout sauvegarder sur l'ordinateur": copies every book that is only on the Kindle to the PC, without changing the Kindle.
- Library in `Documents\Mes livres` (plain files, one folder per author, EPUB kept as the master copy).
- Automatic Kindle 4 detection over USB, without choosing a drive.
- Fill gauge with "room for about N books", warnings under 15 % and 5 % free.
- Put a book on the Kindle / take it back, keeping the reading position.
- Books only on the Kindle are saved on the PC before being removed.
- Background EPUB → MOBI conversion; DRM-protected books explained.
- Traffic light per book (vert / orange / rouge) with a plain explanation.
- Built for hundreds of books: compact list, accent-insensitive search, filters "Dans la liseuse" / "Pas dans la liseuse".
- Tick many books (or "Tout cocher") to load them for a long period; the bar says if they fit. Tick books on the Kindle to unload them in bulk. Progress bar with "Arrêter après ce livre".
- Converted books are sized for the Kindle 4: pictures at most 600×800, greyscale, ≤ 60 KB.
- "Envoyer à un ami": opens a ready-written email and shows the book file to drag into it.
- Laptop screens down to 1024×600.
- Books bought on Amazon (copy-protected AZW) are recognised: listed with their real title, kept on the PC as a backup, labelled "Acheté sur Amazon", and not offered for sharing.
- New ebooks in Téléchargements are offered once.
- Delete with undo (30-day trash).
- "J'ai fini, je débranche": ejects the Kindle safely.
- Built-in illustrated guide (first start + Aide button) and one-time tips.
