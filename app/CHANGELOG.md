# Changelog

All notable changes to Ma liseuse. Format: [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions: [SemVer](https://semver.org/).

## [0.1.0] - unreleased

### Added
- Library in `Documents\Mes livres` (plain files, EPUB kept as the master copy).
- Automatic Kindle 4 detection over USB, without choosing a drive.
- Fill gauge with "room for about N books", warnings under 15 % and 5 % free.
- Put a book on the Kindle / take it back, keeping the reading position (`.sdr`).
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
