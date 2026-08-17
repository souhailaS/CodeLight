# Changelog

## 0.3.1

An optional compressed storage format, for projects with very large annotation files.

* Set `codelight.storage` to `compressed` and a store CodeLight creates is written as a gzipped file, roughly fifteen times smaller.
* The file on disk decides the format, so opening a project never rewrites or deletes what is already there.
* Convert Annotation Storage Format moves an existing store between the two, confirming first and only removing the old file once the new one reads back correctly.
* A local store is written to a temporary file that is renamed over the old one, so an interrupted save leaves the previous store intact. A store reached through a symlink or a hard link, or one on a remote filesystem, is written in place to keep the file itself, so an interrupted save there can still truncate it.

## 0.3.0

A second view in the activity bar lists the comments of the file you are reading, stacked as cards.

* Every commented highlight in the active file, in the order it appears, with its colour, snippet and line.
* Click a card to jump the editor to that highlight.
* Threads whose text was deleted stay visible, marked as orphaned rather than quietly dropped.
* Drag the view into the secondary side bar to keep the comments beside your code.

## 0.2.2

Fix the packaged extension including local working directories, which made the download 17 MB instead of 40 KB.

## 0.2.1

* Refuse to place a note when the file changed and its text cannot be found again, instead of attaching it to whatever moved into those coordinates.
* Copy your text to the clipboard when a note is closed or dropped, wherever the text is reachable.
* Stop closing another open note behind your back. Close a note yourself with the Close button.

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
