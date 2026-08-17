# Changelog

## 0.4.0

Interface work, so the extension looks and behaves like the demo.

* A marker button in the editor toolbar. Turn it on, pick a colour, and everything you select gets highlighted until you turn it off. The status bar shows the colour and turns it off with a click.
* Custom CodeLight icons in the toolbar rather than borrowed built in ones, so they are not mistaken for VS Code's own buttons.
* A coloured mark in the gutter for every highlight, so you can see where your notes are while scrolling. Turn it off with `codelight.gutterMarks` if it crowds your breakpoints.
* Real colour swatches in the picker, including palettes you define yourself.
* A status bar count of the highlights and comments in the file you are reading.
* A walkthrough on install, and welcome content in the panel when a project has no notes yet.
* A setting for where the comment button appears in the gutter, on every line as before, only on highlighted lines, or nowhere.
* An eye button that hides every highlight and comment thread at once, and shows them again.

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
