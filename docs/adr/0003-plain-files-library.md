# ADR-0003: The library is plain files, the app keeps no database

Date: 2026-10-31 · Status: accepted

## Context
The app must outlive itself: if it breaks or is uninstalled, Mom's books must still be there and usable.

## Decision
Books live as normal files in `Documents\Mes livres`, named "Titre - Auteur.ext". The app's own data (converted MOBI copies, saved reading positions, trash, small state) lives in a hidden `.liseuse` folder and can be rebuilt from the books. The EPUB is the master copy; the MOBI is disposable.

## Consequences
- No database migrations or corruption; the folder can be backed up or copied by hand.
- A file renamed in Explorer becomes a "new" book for the app (its MOBI copy is rebuilt): acceptable.
- Any change to the `.liseuse` layout needs a migration and a test (STANDARDS §4).
