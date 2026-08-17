# Changelog

## 0.2.0

Comments now open a real threaded widget in the editor instead of a single line prompt.

* Write multi line comments with markdown, reply, edit and delete in place, with avatars and dates.
* Start a note from the gutter on any line, or from a selection with cmd alt M.
* Choose Highlight Without Comment to keep just the mark, or Delete Highlight to remove the whole thread.
* Notes are placed by their anchor text, so a file changing while the widget is open no longer misplaces them.
* Comment text is copied to the clipboard whenever a save cannot complete.

## 0.1.1

Fix the logo not loading on the Marketplace page.
Relicense under PolyForm Noncommercial 1.0.0.

## 0.1.0

First release.

* Highlight any selection in a colour from a palette you can redefine.
* Attach comments and replies to a highlight, attributed to a verified GitHub account.
* Read a thread by hovering the highlight, with the latest note shown inline.
* Browse every annotation from the activity bar, grouped by file and filtered by colour.
* Delete a highlight, a whole file's highlights, or every orphaned highlight, with confirmation when comments would be lost.
* Highlights follow your edits and find their text again when it moves.
* Everything is stored in `.vscode/codelight.json`, shared through git or kept private with `.gitignore`.
