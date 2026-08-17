<img src="media/icon.png" width="88" align="right" alt="CodeLight" />

# CodeLight

Shared highlights and comments for VS Code, kept beside your code instead of inside it.

## Why

VS Code stopped being only a code editor a long time ago. People draft documents in it, read specifications in it, and work through unfamiliar repositories in it, and almost all of that time is spent reading rather than typing.

That balance tipped further once code started arriving generated, with its comments already written. The typing is increasingly done for us, so what is left is reading, deciding whether what came back is right, and saying what should happen next. We now spend relatively more time reading code than writing it.

Generated comments explain what the code does. They say nothing about what you noticed while reading it, what looked wrong, or what you wanted a colleague to confirm.

Reading notes have nowhere good to live today. Put them in the source and they become part of the product, they show up in everyone's diff, and someone has to remember to take them out. Put them in a pull request and they are trapped in a branch that may sit unmerged for weeks, invisible to anyone not reviewing it, and gone the moment the branch is.

CodeLight makes commenting a layer of its own. Highlight anything, attach a note, and share it with your team through the repository you already share, without touching a single line of code.

## What it does

* Highlight any selection in a colour of your choice, with a palette you can redefine.
* Attach comments to a highlight and reply to your colleagues, each one attributed to a verified GitHub account.
* Read a whole thread by hovering the highlight, with the latest note shown inline at the end of the line.
* Browse every annotation in the project from the activity bar, grouped by file, filtered by colour, and click to jump straight to the text.
* Keep everything in `.vscode/codelight.json`, so annotations travel through git exactly like the code does. Commit the file to share them, or add it to `.gitignore` to keep them to yourself.

Highlights follow your edits. Insert lines above one and it moves with the text. Delete the text it marks and CodeLight looks for it elsewhere in the file before giving up, and if the text comes back the highlight returns with it.

## Using it

| Action | Shortcut |
| --- | --- |
| Highlight the selection | `cmd alt K` on macOS, `ctrl K ctrl H` elsewhere |
| Comment on the selection | `cmd alt M` on macOS, `ctrl K ctrl M` elsewhere |

Everything else lives in the command palette under **CodeLight**, in the editor right click menu, and in the panel behind the CodeLight icon in the activity bar.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `codelight.palette` | built in colours | The colours offered in the picker |
| `codelight.highlightOpacity` | `0.3` | How strong the highlight background is |
| `codelight.inlineComments` | `preview` | Show the latest comment, a count, or nothing |

## Installing

CodeLight is not on the marketplace yet. Build it and install the package locally.

```
npm install
npx @vscode/vsce package
code --install-extension codelight-0.0.1.vsix
```

## License

MIT
