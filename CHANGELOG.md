# Changelog

## Unreleased

* **Go to Next Highlight** and **Go to Previous Highlight** step through the highlights of the open file in the order they sit in it, wrapping round at either end. The status bar says which one you landed on and how many comments it carries. A highlight this version of the file cannot place is skipped rather than jumped to blindly, and when none of them can be placed CodeLight says so instead of moving the cursor. The two commands sit as arrows above the **This File** panel and in the palette, and take no keyboard shortcut of their own.

## 0.7.0

Two things that made CodeLight untrustworthy in exactly the situation it was built for, a team sharing notes through git.

* **A merge conflict no longer wedges CodeLight.** Two people annotating on different branches always leave a conflict in the annotation file, even when they annotated different source files, and the markers land inside a note. CodeLight used to call that invalid JSON, keep whatever it had loaded, and then refuse every later save with a message that never mentioned the conflict. It now says what the file has, the panel says it too, and **Merge the Notes After a Conflict** puts both sides back together, keeping every note from each side, the newer version of any note you both touched, and the comments from both. When git left a record of what the file held before, a note either of you deleted stays deleted, and when git left no such record CodeLight says so rather than pretending.
* **A highlight is no longer painted over code it cannot recognise.** Switching branches changes the file with no save, so CodeLight used to fall back to the stored offsets and mark whatever now sat there, silently. A note it cannot place is left unpainted, labelled "not in this version" in the panel and the cards, kept out of the comment threads and the marker, and above all never written back, so a save on the wrong branch can no longer rewrite a note onto code it was never about.
* The two git commands and the panel now describe what CodeLight actually checked rather than what it hoped. Wording that claimed sharing, verification or a guarantee has been rewritten or removed throughout.
* The status bar and the This File panel say whether the notes are ignored by git, committed, or not committed yet, and say nothing at all when they cannot tell.

## 0.6.1

No change to what CodeLight does. This release exists so the tests that hold the last one in place ship with it.

* The webview that draws the comment cards is now covered by tests that pin the escaping, the content security policy and the messages it accepts back, so a hostile annotation committed to a repository stays inert.
* The marker, the status bar, the panel and the hover are covered too. Two hundred and eighty eight tests now run on every push.

## 0.6.0

Fixes for bugs found by reading the extension the way a stranger would, each one reproduced with a test before it was fixed.

* Comment on Selection stopped working for the rest of a file once any draft note was left open, because a check meant to reuse an overlapping draft matched every draft instead. It reuses only a draft that really overlaps now.
* A comment placed on the last line of a file that ends with a newline was saved with nothing to hold on to. It could never be replied to, and the next save turned it into an orphan and took it off the screen. CodeLight refuses that line now, keeps your text on the clipboard, and no longer offers the gutter button there.
* A comment you were part way through editing was only rescued to the clipboard when the whole highlight vanished. Hiding the notes, losing the text a highlight marked, or a colleague deleting the last comment all dropped what you had typed. Every one of them rescues it now.
* The same rescue now covers the command palette edit, which lost your rewrite whenever the save failed.
* The marker deleted a highlight you had finished with if you clicked away while the previous one was still being written to disk. It keeps track of that now.
* The marker recoloured into the wrong folder's file in a workspace with a folder inside another folder, and told you it could not save. It writes to the folder that owns the highlight, in one write per folder.
* The marker checks that the colour it is holding still exists in the palette of the file you are marking, and stops with an explanation rather than writing a colour that folder cannot render.
* The marker no longer warns on every selection that lands on a highlight it is not allowed to repaint, such as a colleague's.
* **ctrl K ctrl H** and **ctrl K ctrl M** were taking over VS Code's own Toggle Output and Toggle Maximize Editor Group on Windows and Linux. The shortcuts are **ctrl K ctrl Y** and **ctrl K ctrl G** now, both free on every platform and reachable on every keyboard layout. The macOS shortcuts are unchanged.
* Nothing waits for GitHub sign in any more except the act of writing a note, so the panel and the commands are ready as soon as the annotation file is read.
* The status bar counts the comments on stranded highlights too, and says how many are stranded, so it agrees with the panel beside it.
* Right clicking a comment in the panel offers Edit and Delete, which the tree claimed to support but no menu reached.

## 0.5.2

* The two git commands now replace `.gitignore` the way CodeLight replaces its own store, through a temporary file renamed over the old one. An interrupted save leaves the file exactly as it was rather than truncated, the permissions of the file are kept, a new file follows your umask, and CodeLight says so on the rare occasion it has to write in place instead.
* The comment cards in the This File view sit on their own surface, so they read as cards rather than loose text.

## 0.5.1

* Each folder of a multi root workspace now renders with its own palette, opacity, inline comment mode and gutter marks, rather than every folder borrowing whichever settings the window had. The colour picker offers the palette of the folder the file lives in.
* A file that changes hands between two nested folders no longer keeps the highlights of the folder it left.
* The two git commands say what happened before they name the file, so the message reads as an answer rather than a path.

## 0.5.0

Notes you keep to yourself, and workspaces with more than one folder.

* Every folder of the workspace gets its own annotation file now, rather than one folder winning and the rest going untracked. Annotations are read, written and deleted in the folder that holds the file they belong to, and a folder that leaves the workspace takes its notes with it.
* Keep the Notes Out of Git adds the annotation file to `.gitignore` in one command, and Let the Notes Go Into Git takes it back out. Both read the file the way git does, keep the line endings it already uses, and refuse to write over unsaved changes.
* The comment box no longer assumes the note is for somebody else. It says what is true instead, that a note travels with the annotation file if you commit it.
* An annotation file larger than 64 MB is refused on the way in as well as on the way out, in both formats rather than only the compressed one.
* A file whose version field is not a number is refused rather than read as if it had no version at all.
* A change that turns out to alter nothing no longer throws away what it just read from disk, so a window that is behind catches up instead of staying stale.
* A test suite, a hundred and thirty eight of them, run on every push.

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

## 0.3.1

An optional compressed storage format, for projects with very large annotation files.

* Set `codelight.storage` to `compressed` and a store CodeLight creates is written as a gzipped file, roughly fifteen times smaller.
* The file on disk decides the format, so opening a project never rewrites or deletes what is already there.
* Convert Annotation Storage Format moves an existing store between the two, confirming first and only removing the old file once the new one reads back correctly.
* A local store is written to a temporary file that is renamed over the old one, so an interrupted save leaves the previous store intact. A store reached through a symlink or a hard link, one on a remote filesystem, and one in a folder that does not allow new files are written in place to keep the file itself, so an interrupted save there can still truncate it. The last case says so once per session.

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
