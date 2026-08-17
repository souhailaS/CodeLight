<img src="media/icon.png" width="88" align="right" alt="CodeLight" />

# CodeLight

Shared highlights and comments for VS Code, kept beside your code instead of inside it.

## Why

**We read more than we write.** VS Code stopped being only a code editor long ago. People draft documents in it, read specifications in it, and work through unfamiliar repositories in it.

**Generated code tipped the balance.** Code now arrives written, with its comments already attached. The typing is increasingly done for us, so what is left is reading it and deciding whether it is right.

**Generated comments say the wrong things.** They explain what the code does. They say nothing about what you noticed, what looked wrong, or what you wanted a colleague to confirm.

**Those notes have nowhere to go.** Put them in the source and they become part of the product and part of everyone's diff. Put them in a pull request and they sit in a branch that may never merge, invisible to anyone not reviewing it.

**So make commenting its own layer.** Highlight anything, attach a note, and share it through the repository you already share, without touching a line of code. Or keep it to yourself. Add `.vscode/codelight.json` to your `.gitignore` and nothing you jot down while reading ever becomes someone else's diff.

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
